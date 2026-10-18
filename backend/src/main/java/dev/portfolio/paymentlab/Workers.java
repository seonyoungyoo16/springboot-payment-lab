package dev.portfolio.paymentlab;

import static dev.portfolio.paymentlab.Db.*;

import java.time.*;
import java.util.*;
import java.util.concurrent.*;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

@Component
public class Workers {
  private final PaymentService s;
  private final PaymentProcessor processor;
  private final Db db;
  private final TraceLog trace;
  private final String instance;
  private final ExecutorService executor = Executors.newFixedThreadPool(4);
  private final Semaphore slots = new Semaphore(4);
  private volatile boolean recovering = false;

  public Workers(
      PaymentService s, PaymentProcessor processor, @Value("${lab.instance}") String instance) {
    this.s = s;
    this.processor = processor;
    db = s.db;
    trace = s.trace;
    this.instance = instance;
  }

  // flow:Workers.claim
  @Scheduled(fixedDelay = 250, initialDelay = 1500)
  public void poll() {
    try {
      var jobs =
          db.sql.queryForList(
              "SELECT o.id,o.realm_id FROM operation_jobs j JOIN payment_operations o ON o.id=j.operation_id WHERE o.state IN('PENDING','IN_FLIGHT','UNKNOWN') AND j.next_at<=clock_timestamp() AND (j.lease_until IS NULL OR j.lease_until<=clock_timestamp()) ORDER BY j.next_at LIMIT 8");
      for (var j : jobs) {
        String run = j.get("realm_id").toString();
        if (Set.of("hold-jobs", "hold-projection-only").contains(s.faults.get(run))) continue;
        if (!slots.tryAcquire()) break;
        executor.submit(
            () -> {
              try {
                process(uuid(j, "id"), run);
              } finally {
                slots.release();
              }
            });
      }
    } catch (Exception ignored) {
    }
  }

  // flow:Workers.process
  private void process(UUID id, String run) {
    UUID token = UUID.randomUUID();
    Policy policy = s.runs.policy(run);
    int status = 200;
    boolean started = false;
    try {
      var claimed =
          db.sql.queryForList(
              "UPDATE operation_jobs SET lease_token=?,lease_until=clock_timestamp()+(? * interval '1 second'),worker_id=? WHERE operation_id=? AND next_at<=clock_timestamp() AND (lease_until IS NULL OR lease_until<=clock_timestamp()) RETURNING *",
              token,
              policy.lease(),
              instance,
              id);
      if (claimed.isEmpty()) return;
      db.sql.update(
          "UPDATE payment_operations SET state='IN_FLIGHT',updated_at=clock_timestamp() WHERE id=? AND state IN('PENDING','IN_FLIGHT','UNKNOWN')",
          id);
      trace.begin(run, "WORKER", "/operations", UUID.randomUUID().toString());
      started = true;
      trace.operation(id);
      trace.step(
          "DB",
          "lease_claimed",
          "영속 작업 lease 선점 · 원격 전송 취소와 구분",
          "Workers.claim",
          map("worker", instance, "state", "IN_FLIGHT"));
      if ("hold-after-claim".equals(s.faults.get(run))) return;
      var op = db.one("SELECT * FROM payment_operations WHERE id=?", id);
      var a = db.one("SELECT * FROM payment_attempts WHERE id=?", op.get("attempt_id"));
      db.sql.update("UPDATE payment_operations SET queries=queries+1 WHERE id=?", id);
      var remote = s.psp.attempt(uuid(a, "id"), policy, id);
      if (!"hold-apply".equals(s.faults.get(run))) processor.apply(uuid(a, "id"), remote, null);
      else throw Failure.unavailable();
      op = db.one("SELECT * FROM payment_operations WHERE id=?", id);
      if (Set.of("SUCCEEDED", "FAILED_FINAL", "REVIEW").contains(op.get("state"))) return;
      var own = s.psp.operation(id, policy);
      if ("SUCCEEDED".equals(own.get("state"))) {
        var evidence = new LinkedHashMap<>(own);
        evidence.put("operationId", id.toString());
        processor.apply(uuid(a, "id"), remote, evidence);
        op = db.one("SELECT * FROM payment_operations WHERE id=?", id);
        if ("SUCCEEDED".equals(op.get("state"))) return;
      }
      if ("FAILED_FINAL".equals(own.get("state"))) {
        processor.failFinal(id, Objects.toString(own.get("failureCode"), "PG_DECLINED"));
        return;
      }
      if ("UNKNOWN".equals(own.get("state"))) throw Failure.unavailable();
      var o = db.one("SELECT * FROM orders WHERE id=?", op.get("order_id"));
      if ("CONFIRM".equals(op.get("kind"))
          && (o.get("close_intent") != null || !time(o, "expires_at").isAfter(db.now()))) {
        var result =
            s.psp.call("/v1/void", map("attemptId", a.get("id").toString()), policy, null, id);
        var checked = (List<Map<String, Object>>) result.get("payments");
        processor.apply(uuid(a, "id"), checked, null);
        if (checked.stream()
            .allMatch(
                p ->
                    PspClient.n(p, "captured") == 0
                        && Set.of("SEALED_DENIED", "CANCELED", "DECLINED", "EXPIRED")
                            .contains(p.get("authState")))) processor.failFinal(id, "ORDER_CLOSED");
        return;
      }
      if (number(op, "attempts") >= 5) {
        processor.review(id, "RETRY_LIMIT");
        return;
      }
      if (number(op, "queries") >= policy.maxQueries()) {
        processor.review(id, "RECONCILIATION_LIMIT");
        return;
      }
      final var before = op;
      boolean dispatch =
          db.tx.execute(
              t -> {
                var order = s.order(uuid(before, "order_id"), run, null, true);
                var current = db.one("SELECT * FROM payment_operations WHERE id=? FOR UPDATE", id);
                if (Set.of("SUCCEEDED", "FAILED_FINAL", "REVIEW").contains(current.get("state")))
                  return false;
                if ("CONFIRM".equals(current.get("kind"))
                    && (order.get("close_intent") != null
                        || !time(order, "expires_at").isAfter(db.now()))) return false;
                Instant now = db.now(),
                    first = time(current, "first_sent_at"),
                    safe = time(current, "safe_until");
                if (first == null) {
                  first = now;
                  safe = now.plusSeconds(Math.min(86400, policy.keyTtl() - policy.safeMargin()));
                }
                if (!safe.isAfter(now)) return false;
                int n =
                    db.sql.update(
                        "UPDATE payment_operations SET first_sent_at=?,safe_until=?,attempts=attempts+1,updated_at=clock_timestamp() WHERE id=? AND EXISTS(SELECT 1 FROM operation_jobs WHERE operation_id=? AND lease_token=?)",
                        stamp(first),
                        stamp(safe),
                        id,
                        id,
                        token);
                return n == 1;
              });
      if (!dispatch) {
        op = db.one("SELECT * FROM payment_operations WHERE id=?", id);
        if (time(op, "safe_until") != null && !time(op, "safe_until").isAfter(db.now()))
          processor.review(id, "PG_KEY_SAFETY_EXPIRED");
        return;
      }
      String raw;
      if ("CONFIRM".equals(op.get("kind")))
        raw =
            s.crypto.decrypt(
                "provider", a.get("id").toString(), a.get("provider_ciphertext").toString());
      else {
        var payment = db.one("SELECT * FROM payments WHERE id=?", op.get("payment_id"));
        raw =
            s.crypto.decrypt(
                "provider",
                payment.get("id").toString(),
                payment.get("provider_ciphertext").toString());
      }
      String key =
          s.crypto.decrypt("pg-key", id.toString(), op.get("provider_key_ciphertext").toString());
      var result =
          s.psp.call(
              "CONFIRM".equals(op.get("kind")) ? "/v1/confirm" : "/v1/cancel",
              map(
                  "operationId",
                  id.toString(),
                  "paymentKey",
                  raw,
                  "amount",
                  number(op, "amount"),
                  "currency",
                  o.get("currency"),
                  "reason",
                  op.get("reason")),
              policy,
              key,
              id);
      if ("hold-apply".equals(s.faults.get(run))) throw Failure.unavailable();
      if (result.get("payment") instanceof Map<?, ?> p) {
        var evidence =
            map(
                "state",
                result.get("state"),
                "transactionId",
                result.get("transactionId"),
                "paymentKey",
                raw,
                "operationId",
                id.toString());
        processor.apply(uuid(a, "id"), List.of((Map<String, Object>) p), evidence);
      }
      if ("FAILED_FINAL".equals(result.get("state")))
        processor.failFinal(id, Objects.toString(result.get("failureCode"), "PG_DECLINED"));
    } catch (Failure f) {
      status = f.status;
      try {
        if (f.status == 422) processor.review(id, f.code);
        else unknown(id, token, f.code, policy);
      } catch (Exception ignored) {
      }
    } catch (Exception error) {
      status = 503;
      try {
        unknown(id, token, "DEPENDENCY_UNAVAILABLE", policy);
      } catch (Exception ignored) {
      }
    } finally {
      if (started) {
        if (!"hold-after-claim".equals(s.faults.get(run)))
          try {
            db.sql.update(
                "UPDATE operation_jobs SET lease_until=NULL,next_at=clock_timestamp()+(? * interval '1 second') WHERE operation_id=? AND lease_token=?",
                policy.retryDelay(),
                id,
                token);
            db.sql.update(
                "UPDATE payment_operations SET state='UNKNOWN' WHERE id=? AND state='IN_FLIGHT' AND EXISTS(SELECT 1 FROM operation_jobs WHERE operation_id=? AND lease_token=?)",
                id,
                id,
                token);
          } catch (Exception ignored) {
          }
        trace.finish(status);
      }
    }
  }

  private void unknown(UUID id, UUID token, String code, Policy p) {
    var op = db.one("SELECT * FROM payment_operations WHERE id=?", id);
    if (op == null) return;
    if (number(op, "queries") >= p.maxQueries()) {
      processor.review(id, "RECONCILIATION_LIMIT");
      return;
    }
    db.sql.update(
        "UPDATE payment_operations SET state='UNKNOWN',failure_code=?,updated_at=clock_timestamp() WHERE id=? AND state IN('PENDING','IN_FLIGHT','UNKNOWN') AND EXISTS(SELECT 1 FROM operation_jobs WHERE operation_id=? AND lease_token=?)",
        code,
        id,
        id,
        token);
    trace.step(
        "Server", "unknown", "결과 확인 불가 · 같은 작업과 예약 유지", "Workers.process", map("state", "UNKNOWN"));
  }

  // flow:Workers.reconcile
  @Scheduled(fixedDelay = 650, initialDelay = 2200)
  public void recover() {
    if (recovering) return;
    recovering = true;
    try {
      db.sql.update(
          "UPDATE orders SET close_intent='EXPIRED',state='CLOSING',version=version+1 WHERE state='OPEN' AND expires_at<=clock_timestamp() AND close_intent IS NULL");
      var events =
          db.sql.queryForList(
              "SELECT id,realm_id,attempt_id FROM webhook_inbox WHERE state IN('PENDING','PROCESSING') AND next_at<=clock_timestamp() ORDER BY received_at LIMIT 4");
      for (var e : events) {
        int claimed =
            db.sql.update(
                "UPDATE webhook_inbox SET state='PROCESSING',next_at=clock_timestamp()+interval '5 seconds' WHERE id=? AND state IN('PENDING','PROCESSING') AND next_at<=clock_timestamp()",
                e.get("id"));
        if (claimed == 0) continue;
        String run = e.get("realm_id").toString();
        if ("hold-apply".equals(s.faults.get(run))) {
          db.sql.update("UPDATE webhook_inbox SET state='PENDING' WHERE id=?", e.get("id"));
          continue;
        }
        trace.begin(run, "WEBHOOK_WORK", "/webhooks/inbox", UUID.randomUUID().toString());
        try {
          processor.apply(
              uuid(e, "attempt_id"),
              s.psp.attempt(uuid(e, "attempt_id"), s.runs.policy(run), null),
              null);
          db.sql.update("UPDATE webhook_inbox SET state='APPLIED' WHERE id=?", e.get("id"));
          trace.finish(200);
        } catch (Exception ex) {
          db.sql.update("UPDATE webhook_inbox SET state='PENDING' WHERE id=?", e.get("id"));
          trace.finish(503);
        }
      }
      var payments =
          db.sql.queryForList(
              "SELECT id,attempt_id,realm_id FROM payments WHERE next_audit_at<=clock_timestamp() ORDER BY next_audit_at LIMIT 3");
      for (var p : payments) {
        String run = p.get("realm_id").toString();
        if ("hold-apply".equals(s.faults.get(run))) continue;
        int claimed =
            db.sql.update(
                "UPDATE payments SET next_audit_at=clock_timestamp()+(? * interval '1 second') WHERE id=? AND next_audit_at<=clock_timestamp()",
                s.runs.policy(run).audit(),
                p.get("id"));
        if (claimed == 0) continue;
        trace.begin(run, "RECONCILE", "/reconciliation", UUID.randomUUID().toString());
        try {
          processor.apply(
              uuid(p, "attempt_id"),
              s.psp.attempt(uuid(p, "attempt_id"), s.runs.policy(run), null),
              null);
          trace.finish(200);
        } catch (Exception ex) {
          trace.finish(503);
        }
      }
      var closing =
          db.sql.queryForList(
              "SELECT id,realm_id FROM orders WHERE state='CLOSING' AND next_close_check_at<=clock_timestamp() ORDER BY next_close_check_at LIMIT 4");
      for (var o : closing) {
        if (db.sql.update(
                "UPDATE orders SET next_close_check_at=clock_timestamp()+interval '3 seconds' WHERE id=? AND next_close_check_at<=clock_timestamp()",
                o.get("id"))
            == 0) continue;
        String run = o.get("realm_id").toString();
        if ("hold-apply".equals(s.faults.get(run))) continue;
        var a =
            db.one(
                "SELECT * FROM payment_attempts WHERE order_id=? ORDER BY seq DESC LIMIT 1",
                o.get("id"));
        if (a == null) {
          db.tx.executeWithoutResult(
              t -> {
                s.order(uuid(o, "id"), run, null, true);
                processor.finishClosed(uuid(o, "id"));
              });
          continue;
        }
        long active =
            number(
                db.one(
                    "SELECT count(*) AS n FROM payment_operations WHERE order_id=? AND state IN('PENDING','IN_FLIGHT','UNKNOWN','REVIEW')",
                    o.get("id")),
                "n");
        if (active > 0) continue;
        try {
          var response =
              s.psp.call(
                  "/v1/void",
                  map("attemptId", a.get("id").toString()),
                  s.runs.policy(run),
                  null,
                  null);
          processor.apply(
              uuid(a, "id"), (List<Map<String, Object>>) response.get("payments"), null);
          db.tx.executeWithoutResult(
              t -> {
                s.order(uuid(o, "id"), run, null, true);
                processor.finishClosed(uuid(o, "id"));
              });
        } catch (Exception ignored) {
        }
      }
    } catch (Exception ignored) {
    } finally {
      recovering = false;
    }
  }

  // flow:Workers.project
  @Scheduled(fixedDelay = 500, initialDelay = 2200)
  public void project() {
    try {
      var events =
          db.sql.queryForList(
              "SELECT * FROM payment_outbox WHERE state='PENDING' ORDER BY created_at LIMIT 8");
      for (var e : events) {
        if ("hold-projection".equals(s.faults.get(e.get("realm_id").toString()))) continue;
        db.tx.executeWithoutResult(
            t -> {
              var p = db.one("SELECT * FROM payments WHERE id=? FOR UPDATE", e.get("payment_id"));
              int inserted =
                  db.sql.update(
                      "INSERT INTO projection_inbox(event_id) VALUES(?) ON CONFLICT DO NOTHING",
                      e.get("id"));
              if (inserted > 0)
                db.sql.update(
                    "INSERT INTO payment_receipts(payment_id,realm_id,amount,canceled,version) VALUES(?,?,?,?,?) ON CONFLICT(payment_id) DO UPDATE SET amount=EXCLUDED.amount,canceled=EXCLUDED.canceled,version=EXCLUDED.version WHERE payment_receipts.version<EXCLUDED.version",
                    p.get("id"),
                    p.get("realm_id"),
                    p.get("approved_amount"),
                    p.get("canceled_amount"),
                    p.get("version"));
              db.sql.update("UPDATE payment_outbox SET state='APPLIED' WHERE id=?", e.get("id"));
            });
      }
    } catch (Exception ignored) {
    }
  }
}
