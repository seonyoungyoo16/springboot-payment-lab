package dev.portfolio.paymentlab;

import static dev.portfolio.paymentlab.Db.*;
import static dev.portfolio.paymentlab.PspClient.n;

import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.servlet.http.*;
import java.time.*;
import java.util.*;
import org.springframework.stereotype.Service;

@Service
public class PaymentService {
  public record Outcome(int status, Map<String, Object> body) {}

  final Db db;
  final Crypto crypto;
  final Contexts contexts;
  final Limiter limiter;
  final Runs runs;
  final TraceLog trace;
  final Faults faults;
  final PspClient psp;
  final ObjectMapper json;

  public PaymentService(
      Db db,
      Crypto crypto,
      Contexts contexts,
      Limiter limiter,
      Runs runs,
      TraceLog trace,
      Faults faults,
      PspClient psp,
      ObjectMapper json) {
    this.db = db;
    this.crypto = crypto;
    this.contexts = contexts;
    this.limiter = limiter;
    this.runs = runs;
    this.trace = trace;
    this.faults = faults;
    this.psp = psp;
    this.json = json;
  }

  public String stringify(Object v) {
    try {
      return json.writeValueAsString(v);
    } catch (Exception e) {
      throw new IllegalStateException(e);
    }
  }

  public Map<String, Object> parse(String v) {
    try {
      return json.readValue(v, Map.class);
    } catch (Exception e) {
      throw Failure.unavailable();
    }
  }

  public static String text(Map<String, ?> b, String key) {
    Object v = b.get(key);
    return v == null ? null : v.toString();
  }

  public static String key(Map<String, ?> b) {
    String k = text(b, "idempotencyKey");
    if (k == null || !k.matches("[A-Za-z0-9_-]{8,80}"))
      throw new Failure(400, "KEY_REQUIRED", "고정 요청 키가 필요합니다.");
    return k;
  }

  Map<String, Object> principal(HttpServletRequest r, String run) {
    runs.row(run);
    return contexts.principal(r, run);
  }

  Map<String, Object> order(UUID id, String run, UUID account, boolean lock) {
    var o =
        db.one(
            "SELECT * FROM orders WHERE id=? AND realm_id=?" + (lock ? " FOR UPDATE" : ""),
            id,
            run);
    if (o == null || account != null && !account.equals(o.get("account_id")))
      throw new Failure(403, "ORDER_OWNER_MISMATCH", "본인 주문을 확인하세요.");
    return o;
  }

  void limit(HttpServletRequest r, String run, UUID account) {
    Policy p = runs.policy(run);
    limiter.limit(run, "user", account.toString(), p.userLimit(), 60);
    limiter.limit(
        run, "ip", Optional.ofNullable(r.getHeader("X-Lab-Client-IP")).orElse("loopback"), 60, 60);
  }

  String fp(String scope, Map<String, Object> b) {
    var input = new TreeMap<>(b);
    input.remove("idempotencyKey");
    return crypto.hmac("request", scope + "\0" + stringify(input));
  }

  UUID replay(String run, UUID account, String scope, String key, String fp) {
    var old =
        db.one(
            "SELECT * FROM idempotency_requests WHERE realm_id=? AND account_id=? AND scope=? AND client_key=?",
            run,
            account,
            scope,
            key);
    if (old == null) return null;
    if (!Crypto.equal(fp, old.get("request_hmac").toString()))
      throw new Failure(409, "IDEMPOTENCY_KEY_REUSED", "같은 키에 다른 입력을 사용할 수 없습니다.");
    return uuid(old, "resource_id");
  }

  void bind(String run, UUID account, String scope, String key, String fp, UUID resource) {
    db.sql.update(
        "INSERT INTO idempotency_requests VALUES(?,?,?,?,?,?,clock_timestamp())",
        run,
        account,
        scope,
        key,
        fp,
        resource);
  }

  public void audit(String run, UUID actor, String event, String outcome) {
    db.sql.update(
        "INSERT INTO audit_events(id,realm_id,actor_id,event,outcome) VALUES(?,?,?,?,?)",
        UUID.randomUUID(),
        run,
        actor,
        event,
        outcome);
  }

  // flow:PaymentService.createOrder
  public Outcome createOrder(HttpServletRequest r, String run, Map<String, Object> b) {
    var p = principal(r, run);
    UUID account = uuid(p, "account_id"), checkout = id(text(b, "checkoutIntent"));
    String k = key(b), fingerprint = fp("ORDER", b);
    UUID old = replay(run, account, "ORDER", k, fingerprint);
    if (old != null) return new Outcome(200, orderView(old, run, account));
    limit(r, run, account);
    return db.tx.execute(
        t -> {
          var intent =
              db.one(
                  "SELECT * FROM checkout_intents WHERE id=? AND realm_id=? AND account_id=? FOR UPDATE",
                  checkout,
                  run,
                  account);
          if (intent == null) throw new Failure(403, "CHECKOUT_OWNER_MISMATCH", "본인 구매 의도가 필요합니다.");
          UUID again = replay(run, account, "ORDER", k, fingerprint);
          if (again != null) return new Outcome(200, orderView(again, run, account));
          long quantity = n(b, "quantity");
          if (quantity < 1
              || quantity > 10
              || !"LAB_PRODUCT".equals(text(b, "product"))
              || !"KRW".equals(text(b, "currency")))
            throw new Failure(400, "INVALID_ORDER_INPUT", "상품·수량·통화를 확인하세요.");
          long price = number(runs.row(run), "price"), amount = Math.multiplyExact(price, quantity);
          if (amount < 1 || amount > 1000000)
            throw new Failure(400, "AMOUNT_LIMIT", "주문 금액 상한을 확인하세요.");
          var existing = db.one("SELECT * FROM orders WHERE checkout_id=?", checkout);
          UUID oid = existing == null ? UUID.randomUUID() : uuid(existing, "id");
          if (existing != null
              && (number(existing, "quantity") != quantity
                  || !existing.get("product").equals(text(b, "product"))))
            throw new Failure(409, "CHECKOUT_ALREADY_USED", "같은 구매 의도의 주문 입력이 다릅니다.");
          if (existing == null)
            db.sql.update(
                "INSERT INTO orders(id,realm_id,account_id,checkout_id,product,unit_price,quantity,amount,currency,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
                oid,
                run,
                account,
                checkout,
                "LAB_PRODUCT",
                price,
                quantity,
                amount,
                "KRW",
                stamp(db.now().plusSeconds(runs.policy(run).order())));
          bind(run, account, "ORDER", k, fingerprint, oid);
          db.committed(
              () ->
                  trace.step(
                      "DB",
                      "order_committed",
                      "서버 가격 스냅샷과 구매 의도 유일성 확정",
                      "PaymentService.createOrder",
                      map(
                          "amount",
                          existing == null ? amount : number(existing, "amount"),
                          "currency",
                          "KRW",
                          "state",
                          existing == null ? "OPEN" : existing.get("state"))));
          return new Outcome(existing == null ? 201 : 200, orderView(oid, run, account));
        });
  }

  public Object bootstrap(HttpServletRequest r, String run) {
    var p = principal(r, run);
    return map(
        "user",
        p.get("login_id"),
        "role",
        p.get("role"),
        "price",
        runs.row(run).get("price"),
        "checkoutIntent",
        db.one(
                "SELECT id FROM checkout_intents WHERE realm_id=? AND account_id=? AND is_default",
                run,
                p.get("account_id"))
            .get("id"),
        "orders",
        db.sql.queryForList(
            "SELECT id,amount,state,close_intent,version,created_at,expires_at FROM orders WHERE realm_id=? AND account_id=? ORDER BY created_at DESC",
            run,
            p.get("account_id")),
        "policy",
        runs.policy(run));
  }

  public Object newIntent(HttpServletRequest r, String run) {
    var p = principal(r, run);
    UUID id = UUID.randomUUID();
    db.sql.update(
        "INSERT INTO checkout_intents(id,realm_id,account_id) VALUES(?,?,?)",
        id,
        run,
        p.get("account_id"));
    return map("checkoutIntent", id);
  }

  // flow:PaymentService.startAttempt
  public Object start(HttpServletRequest r, String run, UUID oid, Map<String, Object> b) {
    var p = principal(r, run);
    UUID account = uuid(p, "account_id");
    if (b.containsKey("provider") && !"local".equals(text(b, "provider"))
        || b.containsKey("returnUrl")
            && !"https://localhost:8480/payment/return".equals(text(b, "returnUrl")))
      throw new Failure(400, "PROVIDER_NOT_ALLOWED", "고정 PG 출처만 사용할 수 있습니다.");
    limit(r, run, account);
    var a =
        db.tx.execute(
            t -> {
              var o = order(oid, run, account, true);
              if (o.get("accepted_payment_id") != null
                  || !"OPEN".equals(o.get("state"))
                  || o.get("close_intent") != null)
                throw new Failure(409, "ORDER_NOT_PAYABLE", "새 결제를 만들 수 없는 주문입니다.");
              if (!time(o, "expires_at").isAfter(db.now()))
                throw new Failure(410, "ORDER_EXPIRED", "주문 기한이 지났습니다.");
              var current =
                  db.one(
                      "SELECT * FROM payment_attempts WHERE order_id=? ORDER BY seq DESC LIMIT 1",
                      oid);
              if (current != null && !"TERMINAL_NO_CHARGE".equals(current.get("state"))) {
                if (!Set.of("AUTH_PENDING", "AUTHORIZED").contains(current.get("state")))
                  throw new Failure(409, "PAYMENT_UNRESOLVED", "기존 결제 결과를 먼저 확인하세요.");
                return current;
              }
              UUID aid = UUID.randomUUID();
              String ticket = crypto.random(), state = crypto.random();
              var c = contexts.load(r);
              Instant until =
                  Collections.min(
                      List.of(
                          time(o, "expires_at"), db.now().plusSeconds(runs.policy(run).auth())));
              db.sql.update(
                  "INSERT INTO payment_attempts(id,realm_id,order_id,seq,provider_order_id,state_hash,context_hash,ticket_ciphertext,auth_until) VALUES(?,?,?,?,?,?,?,?,?)",
                  aid,
                  run,
                  oid,
                  current == null ? 1 : number(current, "seq") + 1,
                  "pay_" + aid.toString().replace("-", ""),
                  Crypto.hash(state),
                  Crypto.hash(c.id()),
                  crypto.encrypt(
                      "ticket", aid.toString(), stringify(map("ticket", ticket, "state", state))),
                  stamp(until));
              return db.one("SELECT * FROM payment_attempts WHERE id=?", aid);
            });
    var o = order(oid, run, account, false);
    var ticket =
        parse(
            crypto.decrypt(
                "ticket", a.get("id").toString(), a.get("ticket_ciphertext").toString()));
    var remote =
        psp.call(
            "/v1/intents",
            map(
                "run",
                run,
                "attemptId",
                a.get("id").toString(),
                "providerOrderId",
                a.get("provider_order_id"),
                "amount",
                number(o, "amount"),
                "currency",
                o.get("currency"),
                "ticket",
                ticket.get("ticket"),
                "state",
                ticket.get("state"),
                "authUntil",
                time(a, "auth_until").toString(),
                "returnUrl",
                "https://localhost:8480/payment/return"),
            runs.policy(run),
            null,
            null);
    if (!("https://localhost:18480/checkout?ticket=" + ticket.get("ticket"))
        .equals(remote.get("url")))
      throw new Failure(422, "PG_RESPONSE_INVALID", "PG 이동 경로를 검증할 수 없습니다.");
    trace.step(
        "Server",
        "authentication_redirect",
        "별도 PG 인증 화면으로 이동 · 승인 전",
        "PaymentService.startAttempt");
    return map("attemptId", a.get("id"), "url", remote.get("url"));
  }

  // flow:PaymentService.callback
  public String callback(HttpServletRequest r, String state) {
    if (state == null || !state.matches("[A-Za-z0-9_-]{43}"))
      throw new Failure(403, "RETURN_STATE_INVALID", "결제 인증 문맥을 확인하세요.");
    var a = db.one("SELECT * FROM payment_attempts WHERE state_hash=?", Crypto.hash(state));
    if (a == null) throw new Failure(403, "RETURN_STATE_INVALID", "결제 인증 문맥을 확인하세요.");
    String run = a.get("realm_id").toString();
    trace.run(run);
    var p = principal(r, run);
    var c = contexts.load(r);
    var o = order(uuid(a, "order_id"), run, uuid(p, "account_id"), false);
    if (!Crypto.equal(Crypto.hash(c.id()), a.get("context_hash").toString()))
      throw new Failure(403, "RETURN_OWNER_CHANGED", "인증을 시작한 브라우저에서 진행하세요.");
    List<Map<String, Object>> remote = psp.attempt(uuid(a, "id"), runs.policy(run), null);
    if (remote.isEmpty()) throw Failure.unavailable();
    var s = remote.getFirst();
    psp.validate(s, a, o);
    String auth = s.get("authState").toString();
    if (!"AUTHORIZED".equals(auth)) throw new Failure(409, "AUTH_" + auth, "PG 인증이 완료되지 않았습니다.");
    if (!time(a, "auth_until").isAfter(db.now()) || !time(o, "expires_at").isAfter(db.now()))
      throw new Failure(410, "AUTH_EXPIRED", "결제 인증 기한이 지났습니다.");
    db.tx.executeWithoutResult(
        t -> {
          order(uuid(o, "id"), run, uuid(p, "account_id"), true);
          int consumed =
              db.sql.update(
                  "UPDATE payment_attempts SET provider_ciphertext=?,provider_hash=?,instrument=?,state=CASE WHEN state='AUTH_PENDING' THEN 'AUTHORIZED' ELSE state END,return_consumed_at=clock_timestamp() WHERE id=? AND return_consumed_at IS NULL AND state='AUTH_PENDING'",
                  crypto.encrypt(
                      "provider", a.get("id").toString(), s.get("paymentKey").toString()),
                  crypto.hmac("provider", s.get("paymentKey").toString()),
                  Boolean.TRUE.equals(s.get("partialCancelable")) ? "PARTIAL" : "FULL_ONLY",
                  a.get("id"));
          if (consumed != 1)
            throw new Failure(409, "RETURN_ALREADY_USED", "이미 처리한 인증 복귀입니다. 기존 주문 결과를 확인하세요.");
        });
    trace.step(
        "DB", "authenticated_only", "소유·주문·금액 대조 후 인증 증명 저장 · 금전 효과 없음", "PaymentService.callback");
    return "https://localhost:8480/?run=" + run + "&order=" + o.get("id") + "&returned=1";
  }

  Map<String, Object> attemptOwned(UUID aid, String run, UUID account) {
    var a = db.one("SELECT * FROM payment_attempts WHERE id=? AND realm_id=?", aid, run);
    if (a == null) throw new Failure(403, "ATTEMPT_OWNER_MISMATCH", "본인 결제 시도를 확인하세요.");
    order(uuid(a, "order_id"), run, account, false);
    return a;
  }

  void capacity(String run) {
    db.one("SELECT id FROM lab_runs WHERE id=? FOR UPDATE", run);
    if (number(
            db.one(
                "SELECT count(*) AS n FROM payment_operations WHERE realm_id=? AND state IN('PENDING','IN_FLIGHT','UNKNOWN')",
                run),
            "n")
        >= runs.policy(run).queueLimit())
      throw new Failure(429, "QUEUE_CAPACITY", "접수 대기 상한에 도달했습니다.");
  }

  UUID operation(
      String run,
      UUID account,
      Map<String, Object> o,
      Map<String, Object> a,
      UUID payment,
      String kind,
      long amount,
      String reason,
      String fp) {
    UUID op = UUID.randomUUID();
    String pgkey = crypto.hmac("pg-operation", run + "\0local\0payment-lab\0" + kind + "\0" + op);
    db.sql.update(
        "INSERT INTO payment_operations(id,realm_id,account_id,order_id,attempt_id,payment_id,kind,amount,reason,request_hmac,provider_key_ciphertext) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
        op,
        run,
        account,
        o.get("id"),
        a.get("id"),
        payment,
        kind,
        amount,
        reason,
        fp,
        crypto.encrypt("pg-key", op.toString(), pgkey));
    db.sql.update("INSERT INTO operation_jobs(operation_id) VALUES(?)", op);
    return op;
  }

  // flow:PaymentService.confirm
  public Outcome confirm(HttpServletRequest r, String run, UUID aid, Map<String, Object> b) {
    if (b.containsKey("paymentKey"))
      throw new Failure(400, "CLIENT_PAYMENT_KEY_REJECTED", "PG 식별자는 서버에 저장한 인증 결과만 사용합니다.");
    var p = principal(r, run);
    UUID account = uuid(p, "account_id");
    var a = attemptOwned(aid, run, account);
    String k = key(b), fingerprint = fp("CONFIRM:" + aid, b);
    UUID old = replay(run, account, "CONFIRM", k, fingerprint);
    if (old != null) return opOutcome(old, run, account);
    limit(r, run, account);
    return db.tx.execute(
        t -> {
          var o = order(uuid(a, "order_id"), run, account, true);
          UUID again = replay(run, account, "CONFIRM", k, fingerprint);
          if (again != null) return opOutcome(again, run, account);
          var canonical =
              db.one("SELECT * FROM payment_operations WHERE attempt_id=? AND kind='CONFIRM'", aid);
          if (n(b, "amount") != number(o, "amount")
              || !o.get("currency").equals(text(b, "currency"))
              || !a.get("provider_order_id").equals(text(b, "providerOrderId")))
            throw new Failure(400, "ORDER_AMOUNT_MISMATCH", "저장된 주문 금액·통화·시도와 일치해야 합니다.");
          if (canonical != null) {
            if (!canonical
                .get("request_hmac")
                .equals(fp("CONFIRM:" + aid, new LinkedHashMap<>(b)))) {
              var originalAmount = number(canonical, "amount");
              if (originalAmount != n(b, "amount"))
                throw new Failure(409, "CONFIRM_INPUT_CHANGED", "승인 입력을 바꿀 수 없습니다.");
            }
            bind(run, account, "CONFIRM", k, fingerprint, uuid(canonical, "id"));
            trace.operation(uuid(canonical, "id"));
            return opOutcome(uuid(canonical, "id"), run, account);
          }
          if (o.get("accepted_payment_id") != null
              || o.get("close_intent") != null
              || !"OPEN".equals(o.get("state")))
            throw new Failure(409, "ORDER_NOT_PAYABLE", "이 주문에 새 승인을 만들 수 없습니다.");
          if (!time(o, "expires_at").isAfter(db.now()) || !time(a, "auth_until").isAfter(db.now()))
            throw new Failure(410, "ORDER_EXPIRED", "주문 또는 인증 기한이 지났습니다.");
          var current = db.one("SELECT * FROM payment_attempts WHERE id=? FOR UPDATE", aid);
          if (!"AUTHORIZED".equals(current.get("state"))
              || current.get("provider_ciphertext") == null)
            throw new Failure(403, "AUTH_REQUIRED", "PG 결제수단 인증이 필요합니다.");
          capacity(run);
          UUID op =
              operation(
                  run,
                  account,
                  o,
                  current,
                  null,
                  "CONFIRM",
                  number(o, "amount"),
                  null,
                  fingerprint);
          bind(run, account, "CONFIRM", k, fingerprint, op);
          db.sql.update("UPDATE payment_attempts SET state='CONFIRM_PENDING' WHERE id=?", aid);
          faults.check(run, "before-confirm-commit");
          trace.operation(op);
          db.committed(
              () ->
                  trace.step(
                      "DB",
                      "confirm_queued",
                      "승인 작업·PG 키·job 내구성 커밋",
                      "PaymentService.confirm",
                      map("state", "PENDING", "amount", number(o, "amount"))));
          return new Outcome(202, opView(op, run, account));
        });
  }

  // flow:PaymentService.reserveCancel
  public Outcome cancel(HttpServletRequest r, String run, UUID pid, Map<String, Object> b) {
    var auth = principal(r, run);
    UUID account = uuid(auth, "account_id");
    String k = key(b), fingerprint = fp("CANCEL:" + pid, b);
    var p0 = db.one("SELECT * FROM payments WHERE id=? AND realm_id=?", pid, run);
    if (p0 == null) throw new Failure(403, "PAYMENT_OWNER_MISMATCH", "본인 결제를 확인하세요.");
    order(uuid(p0, "order_id"), run, account, false);
    UUID old = replay(run, account, "CANCEL", k, fingerprint);
    if (old != null) return opOutcome(old, run, account);
    contexts.recent(auth, runs.policy(run));
    limit(r, run, account);
    String reason = text(b, "reason");
    if (reason == null || reason.isBlank() || reason.length() > 200)
      throw new Failure(400, "INVALID_CANCEL_REASON", "취소 사유는 1~200자입니다.");
    long amount = n(b, "amount");
    if (amount < 1 || amount > 1000000) throw new Failure(400, "INVALID_AMOUNT", "취소 금액을 확인하세요.");
    return db.tx.execute(
        t -> {
          var o = order(uuid(p0, "order_id"), run, account, true);
          var p = db.one("SELECT * FROM payments WHERE id=? FOR UPDATE", pid);
          UUID again = replay(run, account, "CANCEL", k, fingerprint);
          if (again != null) return opOutcome(again, run, account);
          if (n(b, "expectedPaymentVersion") != number(p, "version"))
            throw new Failure(409, "PAYMENT_VERSION_CHANGED", "새 결제 상태를 확인한 뒤 취소하세요.");
          if (!o.get("currency").equals(text(b, "currency")))
            throw new Failure(400, "CURRENCY_MISMATCH", "승인 통화와 같아야 합니다.");
          if (db.one(
                  "SELECT id FROM payment_operations WHERE payment_id=? AND kind IN('CANCEL','COMPENSATE') AND state IN('PENDING','IN_FLIGHT','UNKNOWN','REVIEW')",
                  pid)
              != null) throw new Failure(409, "CANCEL_IN_PROGRESS", "기존 취소 결과를 먼저 확인하세요.");
          long available =
              number(p, "approved_amount")
                  - number(p, "canceled_amount")
                  - number(p, "reserved_amount");
          if (!"CURRENT".equals(p.get("sync_state")) || amount > available)
            throw new Failure(409, "CANCEL_EXCEEDS_BALANCE", "취소 가능액 또는 동기화 상태를 확인하세요.");
          if (!Boolean.TRUE.equals(p.get("partial_cancelable")) && amount != available)
            throw new Failure(400, "PARTIAL_NOT_ALLOWED", "전액 취소만 가능합니다.");
          capacity(run);
          var a = db.one("SELECT * FROM payment_attempts WHERE id=?", p.get("attempt_id"));
          UUID op = operation(run, account, o, a, pid, "CANCEL", amount, reason, fingerprint);
          db.sql.update("INSERT INTO cancel_reservations VALUES(?,?,?,'ACTIVE')", op, pid, amount);
          db.sql.update(
              "UPDATE payments SET reserved_amount=reserved_amount+?,sync_state='PENDING',version=version+1 WHERE id=?",
              amount,
              pid);
          bind(run, account, "CANCEL", k, fingerprint, op);
          faults.check(run, "before-cancel-commit");
          trace.operation(op);
          db.committed(
              () ->
                  trace.step(
                      "DB",
                      "cancel_reserved",
                      "취소 작업·예약·job을 같은 트랜잭션으로 확정",
                      "PaymentService.reserveCancel",
                      map(
                          "approved",
                          number(p, "approved_amount"),
                          "canceled",
                          number(p, "canceled_amount"),
                          "reserved",
                          number(p, "reserved_amount") + amount)));
          return new Outcome(202, opView(op, run, account));
        });
  }

  // flow:PaymentService.closeOrder
  public Outcome close(HttpServletRequest r, String run, UUID oid, Map<String, Object> b) {
    var p = principal(r, run);
    UUID account = uuid(p, "account_id");
    String k = key(b), fingerprint = fp("CLOSE:" + oid, b);
    UUID old = replay(run, account, "CLOSE", k, fingerprint);
    if (old != null) return new Outcome(200, orderView(oid, run, account));
    limit(r, run, account);
    return db.tx.execute(
        t -> {
          var o = order(oid, run, account, true);
          UUID again = replay(run, account, "CLOSE", k, fingerprint);
          if (again != null) return new Outcome(200, orderView(oid, run, account));
          db.sql.update(
              "UPDATE orders SET close_intent=COALESCE(close_intent,'USER_CANCEL'),state=CASE WHEN state='CLOSED' THEN state ELSE 'CLOSING' END,version=version+1 WHERE id=?",
              oid);
          bind(run, account, "CLOSE", k, fingerprint, oid);
          audit(run, account, "ORDER_CLOSE", "REQUESTED");
          db.committed(
              () ->
                  trace.step(
                      "DB",
                      "close_requested",
                      "주문 종료 의사 저장 · 불명 금전 상태를 완료로 바꾸지 않음",
                      "PaymentService.closeOrder"));
          return new Outcome(202, orderView(oid, run, account));
        });
  }

  public Outcome opOutcome(UUID op, String run, UUID account) {
    var v = opView(op, run, account);
    boolean terminal = Set.of("SUCCEEDED", "FAILED_FINAL", "REVIEW").contains(v.get("state"));
    return new Outcome(terminal ? 200 : 202, v);
  }

  public Map<String, Object> opView(UUID id, String run, UUID account) {
    var op =
        db.one(
            "SELECT id,realm_id,account_id,order_id,attempt_id,payment_id,kind,amount,state,failure_code,attempts,queries,created_at,updated_at,safe_until FROM payment_operations WHERE id=? AND realm_id=?",
            id,
            run);
    if (op == null || !account.equals(op.get("account_id")))
      throw new Failure(403, "OPERATION_OWNER_MISMATCH", "본인 작업을 확인하세요.");
    op.remove("account_id");
    op.remove("realm_id");
    return op;
  }

  public Map<String, Object> orderView(UUID id, String run, UUID account) {
    var o = order(id, run, account, false);
    o.remove("account_id");
    o.remove("realm_id");
    o.put(
        "attempts",
        db.sql.queryForList(
            "SELECT id,seq,provider_order_id,state,auth_until FROM payment_attempts WHERE order_id=? ORDER BY seq",
            id));
    o.put(
        "payments",
        db.sql.queryForList(
            "SELECT id,approved_amount,canceled_amount,reserved_amount,currency,money_state,sync_state,partial_cancelable,version,approved_at,observed_at FROM payments WHERE order_id=? ORDER BY approved_at,id",
            id));
    o.put(
        "operations",
        db.sql.queryForList(
            "SELECT id,attempt_id,payment_id,kind,amount,state,failure_code,attempts,queries,created_at,updated_at,safe_until FROM payment_operations WHERE order_id=? ORDER BY created_at",
            id));
    o.put(
        "movements",
        db.sql.queryForList(
            "SELECT m.kind,m.amount,m.occurred_at FROM payment_movements m JOIN payments p ON p.id=m.payment_id WHERE p.order_id=? ORDER BY m.created_at",
            id));
    o.put("observedAt", db.now().toString());
    return o;
  }
}
