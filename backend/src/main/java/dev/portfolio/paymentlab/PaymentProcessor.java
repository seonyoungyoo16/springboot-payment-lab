package dev.portfolio.paymentlab;

import static dev.portfolio.paymentlab.Db.*;
import static dev.portfolio.paymentlab.PspClient.n;

import java.time.*;
import java.util.*;
import org.springframework.stereotype.Service;

@Service
public class PaymentProcessor {
  private final PaymentService s;
  private final Db db;
  private final PspClient psp;
  private final Crypto crypto;
  private final TraceLog trace;
  private final Runs runs;
  private final Faults faults;

  public PaymentProcessor(PaymentService s) {
    this.s = s;
    db = s.db;
    psp = s.psp;
    crypto = s.crypto;
    trace = s.trace;
    runs = s.runs;
    faults = s.faults;
  }

  private UUID correlated(Map<String, Object> tx) {
    Object id = tx.get("operationId");
    if (id == null) return null;
    try {
      return UUID.fromString(id.toString());
    } catch (Exception e) {
      throw new Failure(422, "PG_RESPONSE_INVALID", "거래 작업 식별자를 확인할 수 없습니다.");
    }
  }

  private void outbox(UUID pid, String run) {
    var p = db.one("SELECT version FROM payments WHERE id=?", pid);
    db.sql.update(
        "INSERT INTO payment_outbox(id,realm_id,payment_id,aggregate_version,event_type) VALUES(?,?,?,?,'PAYMENT_CHANGED') ON CONFLICT DO NOTHING",
        UUID.randomUUID(),
        run,
        pid,
        p.get("version"));
  }

  // flow:PaymentProcessor.apply
  public void apply(UUID aid, List<Map<String, Object>> remote, Map<String, Object> evidence) {
    db.tx.executeWithoutResult(
        t -> {
          var a = db.one("SELECT * FROM payment_attempts WHERE id=?", aid);
          if (a == null) return;
          String run = a.get("realm_id").toString();
          var o = s.order(uuid(a, "order_id"), run, null, true);
          for (var v : remote) psp.validate(v, a, o);
          for (var v : remote) {
            if (n(v, "captured") == 0) continue;
            String raw = v.get("paymentKey").toString(), hash = crypto.hmac("provider", raw);
            var p = db.one("SELECT * FROM payments WHERE provider_hash=? FOR UPDATE", hash);
            boolean fresh = p == null;
            UUID pid = fresh ? UUID.randomUUID() : uuid(p, "id");
            if (fresh) {
              db.sql.update(
                  "INSERT INTO payments(id,realm_id,order_id,attempt_id,provider_hash,provider_ciphertext,approved_amount,currency,partial_cancelable,approved_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
                  pid,
                  run,
                  o.get("id"),
                  aid,
                  hash,
                  crypto.encrypt("provider", pid.toString(), raw),
                  number(o, "amount"),
                  o.get("currency"),
                  v.get("partialCancelable"),
                  stamp(Instant.parse(v.get("approvedAt").toString())));
              p = db.one("SELECT * FROM payments WHERE id=? FOR UPDATE", pid);
            }
            boolean changed = fresh;
            for (var tr : (List<Map<String, Object>>) v.get("transactions")) {
              UUID correlation = correlated(tr);
              if (correlation == null
                  && evidence != null
                  && "SUCCEEDED".equals(evidence.get("state"))
                  && tr.get("id").equals(evidence.get("transactionId"))
                  && raw.equals(evidence.get("paymentKey")))
                correlation = UUID.fromString(evidence.get("operationId").toString());
              var op =
                  correlation == null
                      ? null
                      : db.one(
                          "SELECT * FROM payment_operations WHERE id=? AND realm_id=? AND attempt_id=?",
                          correlation,
                          run,
                          aid);
              if (op != null) {
                String kind = tr.get("kind").toString();
                if (number(op, "amount") != n(tr, "amount")
                    || "CAPTURE".equals(kind) != "CONFIRM".equals(op.get("kind"))
                    || op.get("payment_id") != null && !pid.equals(op.get("payment_id")))
                  throw new Failure(
                      422, "PG_OPERATION_MISMATCH", "취소/승인 작업의 금액·대상·거래 대응이 일치하지 않습니다.");
              }
              int inserted =
                  db.sql.update(
                      "INSERT INTO payment_movements(id,realm_id,payment_id,operation_id,provider_transaction_id,kind,amount,occurred_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(provider_transaction_id) DO NOTHING",
                      UUID.randomUUID(),
                      run,
                      pid,
                      op == null ? null : op.get("id"),
                      tr.get("id"),
                      tr.get("kind"),
                      n(tr, "amount"),
                      stamp(Instant.parse(tr.get("occurredAt").toString())));
              changed |= inserted > 0;
              if (op != null) {
                db.sql.update(
                    "UPDATE payment_operations SET payment_id=?,state='SUCCEEDED',transaction_id=?,failure_code=NULL,updated_at=clock_timestamp() WHERE id=?",
                    pid,
                    tr.get("id"),
                    op.get("id"));
                db.sql.update(
                    "UPDATE cancel_reservations SET state='SETTLED' WHERE operation_id=? AND state IN('ACTIVE','REVIEW_HELD')",
                    op.get("id"));
              }
            }
            var sums =
                db.one(
                    "SELECT COALESCE(sum(amount) FILTER(WHERE kind='CAPTURE'),0) AS a,COALESCE(sum(amount) FILTER(WHERE kind='CANCEL'),0) AS c FROM payment_movements WHERE payment_id=?",
                    pid);
            long cap = number(sums, "a"),
                cancel = number(sums, "c"),
                reserved =
                    number(
                        db.one(
                            "SELECT COALESCE(sum(amount),0) AS n FROM cancel_reservations WHERE payment_id=? AND state IN('ACTIVE','REVIEW_HELD')",
                            pid),
                        "n");
            if (cap != number(o, "amount") || cancel < 0 || cancel > cap)
              throw new Failure(422, "LEDGER_MISMATCH", "원장 합계를 검증할 수 없습니다.");
            boolean held = cancel + reserved > cap;
            String sync = held ? "REVIEW" : reserved > 0 ? "PENDING" : "CURRENT";
            if (held) {
              db.sql.update(
                  "UPDATE cancel_reservations SET state='REVIEW_HELD' WHERE payment_id=? AND state='ACTIVE'",
                  pid);
              db.sql.update(
                  "UPDATE payment_operations SET state='REVIEW',failure_code='EXTERNAL_CANCEL_AMBIGUOUS' WHERE payment_id=? AND state IN('PENDING','IN_FLIGHT','UNKNOWN') AND kind<>'CONFIRM'",
                  pid);
              reviewCase(run, uuid(o, "id"), null, "EXTERNAL_CANCEL_AMBIGUOUS");
            }
            db.sql.update(
                "UPDATE payments SET canceled_amount=?,reserved_amount=?,money_state=?,sync_state=?,version=version+?,observed_at=clock_timestamp(),next_audit_at=clock_timestamp()+(? * interval '1 second') WHERE id=?",
                cancel,
                reserved,
                cancel == cap ? "CANCELED" : cancel > 0 ? "PARTIALLY_CANCELED" : "CAPTURED",
                sync,
                changed ? 1 : 0,
                runs.policy(run).audit(),
                pid);
            db.sql.update("UPDATE payment_attempts SET state='CAPTURED' WHERE id=?", aid);
            o = s.order(uuid(o, "id"), run, null, true);
            if (o.get("accepted_payment_id") == null
                && o.get("close_intent") == null
                && "OPEN".equals(o.get("state"))
                && time(o, "expires_at").isAfter(db.now())) {
              db.sql.update(
                  "UPDATE orders SET accepted_payment_id=?,state='ACCEPTED',version=version+1 WHERE id=?",
                  pid,
                  o.get("id"));
              o = s.order(uuid(o, "id"), run, null, true);
            } else if (o.get("accepted_payment_id") == null && o.get("close_intent") == null) {
              db.sql.update(
                  "UPDATE orders SET close_intent='EXPIRED',state='CLOSING',version=version+1 WHERE id=?",
                  o.get("id"));
              o = s.order(uuid(o, "id"), run, null, true);
            }
            if ((o.get("close_intent") != null || !pid.equals(o.get("accepted_payment_id")))
                && cancel < cap
                && !held) compensate(o, a, pid, cap - cancel, reserved);
            if (changed) {
              outbox(pid, run);
              var snapshot =
                  map(
                      "approved",
                      cap,
                      "canceled",
                      cancel,
                      "reserved",
                      reserved,
                      "sync",
                      sync,
                      "orderState",
                      o.get("state"));
              db.committed(
                  () ->
                      trace.step(
                          "DB",
                          "ledger_committed",
                          "검증한 PG 거래·원장·작업·주문·outbox 원자 반영",
                          "PaymentProcessor.apply",
                          snapshot));
            }
          }
          if (remote.stream().anyMatch(v -> n(v, "captured") > 0)
              && "hold-apply-commit".equals(faults.get(run))) throw Failure.unavailable();
          faults.check(run, "before-apply-commit");
          finishClosed(uuid(o, "id"));
        });
  }

  // flow:PaymentProcessor.compensate
  private void compensate(
      Map<String, Object> o, Map<String, Object> a, UUID pid, long balance, long reserved) {
    if (reserved > 0) return;
    String run = o.get("realm_id").toString();
    var old =
        db.one(
            "SELECT id FROM payment_operations WHERE payment_id=? AND (kind='COMPENSATE' OR kind='CANCEL' AND state IN('PENDING','IN_FLIGHT','UNKNOWN','REVIEW'))",
            pid);
    if (old != null) return;
    UUID op =
        s.operation(
            run,
            uuid(o, "account_id"),
            o,
            a,
            pid,
            "COMPENSATE",
            balance,
            "주문 종료 또는 예상 밖 추가 승인 보상",
            crypto.hmac("compensation", pid.toString()));
    db.sql.update("INSERT INTO cancel_reservations VALUES(?,?,?,'ACTIVE')", op, pid, balance);
    db.sql.update(
        "UPDATE payments SET reserved_amount=reserved_amount+?,sync_state='PENDING',version=version+1 WHERE id=?",
        balance,
        pid);
    db.committed(
        () ->
            trace.step(
                "DB",
                "compensation_queued",
                "늦은 승인·추가 승인의 별도 보상 취소 접수",
                "PaymentProcessor.compensate",
                map("amount", balance, "reserved", balance)));
  }

  void finishClosed(UUID oid) {
    var o = db.one("SELECT * FROM orders WHERE id=?", oid);
    long
        active =
            number(
                db.one(
                    "SELECT count(*) AS n FROM payment_operations WHERE order_id=? AND state IN('PENDING','IN_FLIGHT','UNKNOWN','REVIEW')",
                    oid),
                "n"),
        net =
            number(
                db.one(
                    "SELECT COALESCE(sum(approved_amount-canceled_amount),0) AS n FROM payments WHERE order_id=?",
                    oid),
                "n"),
        payments = number(db.one("SELECT count(*) AS n FROM payments WHERE order_id=?", oid), "n");
    if (active == 0 && net == 0 && (o.get("close_intent") != null || payments > 0))
      db.sql.update(
          "UPDATE orders SET state='CLOSED',version=CASE WHEN state<>'CLOSED' THEN version+1 ELSE version END WHERE id=?",
          oid);
  }

  public void reviewCase(String run, UUID order, UUID operation, String reason) {
    if (db.one(
            "SELECT id FROM reconciliation_cases WHERE order_id=? AND operation_id IS NOT DISTINCT FROM ? AND reason=? AND state='OPEN'",
            order,
            operation,
            reason)
        == null)
      db.sql.update(
          "INSERT INTO reconciliation_cases(id,realm_id,order_id,operation_id,reason) VALUES(?,?,?,?,?)",
          UUID.randomUUID(),
          run,
          order,
          operation,
          reason);
  }

  // flow:PaymentProcessor.failFinal
  public void failFinal(UUID opid, String code) {
    db.tx.executeWithoutResult(
        t -> {
          var initial = db.one("SELECT * FROM payment_operations WHERE id=?", opid);
          var o =
              s.order(uuid(initial, "order_id"), initial.get("realm_id").toString(), null, true);
          var op = db.one("SELECT * FROM payment_operations WHERE id=? FOR UPDATE", opid);
          if ("SUCCEEDED".equals(op.get("state"))) return;
          db.sql.update(
              "UPDATE payment_operations SET state='FAILED_FINAL',failure_code=?,updated_at=clock_timestamp() WHERE id=?",
              code,
              opid);
          db.sql.update(
              "UPDATE cancel_reservations SET state='RELEASED' WHERE operation_id=? AND state IN('ACTIVE','REVIEW_HELD')",
              opid);
          if ("CONFIRM".equals(op.get("kind")))
            db.sql.update(
                "UPDATE payment_attempts SET state='TERMINAL_NO_CHARGE' WHERE id=?",
                op.get("attempt_id"));
          else {
            UUID pid = uuid(op, "payment_id");
            db.sql.update(
                "UPDATE payments SET reserved_amount=(SELECT COALESCE(sum(amount),0) FROM cancel_reservations WHERE payment_id=? AND state IN('ACTIVE','REVIEW_HELD')),sync_state='CURRENT',version=version+1 WHERE id=?",
                pid,
                pid);
            if ("COMPENSATE".equals(op.get("kind"))) {
              db.sql.update("UPDATE payments SET sync_state='REVIEW' WHERE id=?", pid);
              reviewCase(op.get("realm_id").toString(), uuid(o, "id"), opid, "COMPENSATION_FAILED");
            }
          }
          finishClosed(uuid(o, "id"));
          db.committed(
              () ->
                  trace.step(
                      "DB",
                      "definite_failure",
                      "해당 PG 작업의 종결 비승인/취소 거절 확인 · 예약 해제",
                      "PaymentProcessor.failFinal",
                      map("state", "FAILED_FINAL", "code", code)));
        });
  }

  // flow:PaymentProcessor.review
  public void review(UUID opid, String code) {
    db.tx.executeWithoutResult(
        t -> {
          var op = db.one("SELECT * FROM payment_operations WHERE id=?", opid);
          var o = s.order(uuid(op, "order_id"), op.get("realm_id").toString(), null, true);
          db.sql.update(
              "UPDATE payment_operations SET state='REVIEW',failure_code=?,updated_at=clock_timestamp() WHERE id=? AND state NOT IN('SUCCEEDED','FAILED_FINAL')",
              code,
              opid);
          if (op.get("payment_id") != null)
            db.sql.update(
                "UPDATE payments SET sync_state='REVIEW' WHERE id=?", op.get("payment_id"));
          db.sql.update(
              "UPDATE cancel_reservations SET state='REVIEW_HELD' WHERE operation_id=? AND state='ACTIVE'",
              opid);
          reviewCase(op.get("realm_id").toString(), uuid(o, "id"), opid, code);
          db.committed(
              () ->
                  trace.step(
                      "DB",
                      "review_required",
                      "불명·예약을 보존하고 자동 변경 재전송 중지",
                      "PaymentProcessor.review",
                      map("state", "REVIEW", "reason", code)));
        });
  }
}
