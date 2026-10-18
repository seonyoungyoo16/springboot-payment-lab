package dev.portfolio.paymentlab;

import static dev.portfolio.paymentlab.Db.*;

import jakarta.servlet.http.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

@RestController
public class ApiController {
  private final PaymentService s;
  private final String webhook;

  public ApiController(PaymentService s, @Value("${lab.webhook}") String webhook) {
    this.s = s;
    this.webhook = webhook;
  }

  private Object response(PaymentService.Outcome o) {
    return ResponseEntity.status(o.status()).body(o.body());
  }

  @GetMapping("/api/bootstrap")
  public Object bootstrap(HttpServletRequest r) {
    return s.bootstrap(r, RequestFilter.run(r));
  }

  @PostMapping("/api/checkout-intents")
  public Object intent(HttpServletRequest r) {
    return s.newIntent(r, RequestFilter.run(r));
  }

  @PostMapping("/api/orders")
  public Object create(HttpServletRequest r, @RequestBody Map<String, Object> b) {
    return response(s.createOrder(r, RequestFilter.run(r), b));
  }

  @PostMapping("/api/orders/{id}/attempts")
  public Object start(
      HttpServletRequest r, @PathVariable String id, @RequestBody Map<String, Object> b) {
    return s.start(r, RequestFilter.run(r), id(id), b);
  }

  @GetMapping("/payment/return")
  public void returned(
      HttpServletRequest r, HttpServletResponse out, @RequestParam(required = false) String state)
      throws IOException {
    try {
      out.setStatus(303);
      out.setHeader("Location", s.callback(r, state));
    } catch (Failure f) {
      var a =
          state == null
              ? null
              : s.db.one(
                  "SELECT realm_id,order_id FROM payment_attempts WHERE state_hash=?",
                  Crypto.hash(state));
      out.setStatus(303);
      out.setHeader(
          "Location",
          "https://localhost:8480/?run="
              + (a == null ? "invalid-return" : a.get("realm_id"))
              + "&order="
              + (a == null ? "" : a.get("order_id"))
              + "&pgError="
              + f.code);
    }
  }

  @PostMapping("/api/attempts/{id}/confirm")
  public Object confirm(
      HttpServletRequest r, @PathVariable String id, @RequestBody Map<String, Object> b) {
    String run = RequestFilter.run(r);
    var outcome = s.confirm(r, run, id(id), b);
    s.faults.check(run, "after-confirm-commit");
    return response(outcome);
  }

  @PostMapping("/api/payments/{id}/cancel")
  public Object cancel(
      HttpServletRequest r, @PathVariable String id, @RequestBody Map<String, Object> b) {
    String run = RequestFilter.run(r);
    var outcome = s.cancel(r, run, id(id), b);
    s.faults.check(run, "after-cancel-commit");
    return response(outcome);
  }

  @PostMapping("/api/orders/{id}/close")
  public Object close(
      HttpServletRequest r, @PathVariable String id, @RequestBody Map<String, Object> b) {
    return response(s.close(r, RequestFilter.run(r), id(id), b));
  }

  @GetMapping("/api/orders/{id}")
  public Object order(HttpServletRequest r, @PathVariable String id) {
    String run = RequestFilter.run(r);
    var p = s.principal(r, run);
    return s.orderView(id(id), run, uuid(p, "account_id"));
  }

  @GetMapping("/api/operations/{id}")
  public Object operation(HttpServletRequest r, @PathVariable String id) {
    String run = RequestFilter.run(r);
    var p = s.principal(r, run);
    return s.opView(id(id), run, uuid(p, "account_id"));
  }

  // flow:ApiController.webhook
  @PostMapping("/webhooks/local")
  public Object webhook(HttpServletRequest r) throws Exception {
    byte[] raw = r.getInputStream().readNBytes(32769);
    if (raw.length > 32768) throw new Failure(413, "BODY_TOO_LARGE", "본문이 너무 큽니다.");
    String ts = r.getHeader("X-Psp-Timestamp"), sig = r.getHeader("X-Psp-Signature");
    long timestamp;
    try {
      timestamp = Long.parseLong(ts);
    } catch (Exception e) {
      throw new Failure(403, "WEBHOOK_INVALID", "웹훅 검증 실패");
    }
    if (Math.abs(System.currentTimeMillis() - timestamp) > 300000)
      throw new Failure(403, "WEBHOOK_EXPIRED", "웹훅 전달 시각이 지났습니다.");
    Mac mac = Mac.getInstance("HmacSHA256");
    mac.init(new SecretKeySpec(webhook.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
    String expected =
        HexFormat.of()
            .formatHex(
                mac.doFinal(
                    (ts + "." + new String(raw, StandardCharsets.UTF_8))
                        .getBytes(StandardCharsets.UTF_8)));
    if (!Crypto.equal(expected, sig))
      throw new Failure(403, "WEBHOOK_SIGNATURE_INVALID", "웹훅 서명을 확인하세요.");
    var b = s.parse(new String(raw, StandardCharsets.UTF_8));
    String run = Runs.valid(PaymentService.text(b, "run"));
    UUID event = id(PaymentService.text(b, "eventId")),
        attempt = id(PaymentService.text(b, "attemptId"));
    s.trace.run(run);
    if (s.db.one("SELECT id FROM payment_attempts WHERE id=? AND realm_id=?", attempt, run) == null)
      throw new Failure(403, "WEBHOOK_TARGET_INVALID", "등록한 결제 시도만 받을 수 있습니다.");
    String hash = Crypto.hash(new String(raw, StandardCharsets.UTF_8));
    s.db.tx.executeWithoutResult(
        t -> {
          s.db.sql.update(
              "INSERT INTO webhook_inbox(id,realm_id,event_id,body_hash,attempt_id,payload) VALUES(?,?,?,?,?,?::jsonb) ON CONFLICT(event_id) DO NOTHING",
              UUID.randomUUID(),
              run,
              event,
              hash,
              attempt,
              s.stringify(b));
          var saved = s.db.one("SELECT body_hash FROM webhook_inbox WHERE event_id=?", event);
          if (!Crypto.equal(saved.get("body_hash").toString(), hash))
            throw new Failure(409, "WEBHOOK_ID_REUSED", "같은 이벤트 ID의 본문이 다릅니다.");
          s.db.committed(
              () ->
                  s.trace.step(
                      "DB",
                      "inbox_committed",
                      "서명 검증 후 inbox 커밋 · 결제 적용은 비동기 조회",
                      "ApiController.webhook",
                      map("state", "PENDING")));
        });
    return map("status", "accepted");
  }

  // flow:ApiController.resume
  @PostMapping("/api/reconciliation/{id}/resume")
  public Object resume(
      HttpServletRequest r, @PathVariable String id, @RequestBody Map<String, String> b) {
    String run = RequestFilter.run(r);
    var p = s.principal(r, run);
    if (!"OPERATOR".equals(p.get("role")))
      throw new Failure(403, "OPERATOR_REQUIRED", "운영 권한이 필요합니다.");
    s.contexts.recent(p, s.runs.policy(run));
    if (b.get("reason") == null || b.get("reason").isBlank() || b.get("reason").length() > 200)
      throw new Failure(400, "REASON_REQUIRED", "재개 사유가 필요합니다.");
    var c = s.db.one("SELECT * FROM reconciliation_cases WHERE id=? AND realm_id=?", id(id), run);
    if (c == null) throw new Failure(404, "CASE_NOT_FOUND", "확인 건이 없습니다.");
    s.db.tx.executeWithoutResult(
        t -> {
          s.order(uuid(c, "order_id"), run, null, true);
          if (c.get("operation_id") != null) {
            s.db.sql.update(
                "UPDATE payment_operations SET state='UNKNOWN',queries=0 WHERE id=? AND state='REVIEW'",
                c.get("operation_id"));
            s.db.sql.update(
                "UPDATE operation_jobs SET lease_until=NULL,next_at=clock_timestamp() WHERE operation_id=?",
                c.get("operation_id"));
          }
          s.db.sql.update(
              "UPDATE payments SET next_audit_at=clock_timestamp() WHERE order_id=?",
              c.get("order_id"));
          s.audit(run, uuid(p, "account_id"), "RECONCILIATION_RESUME", "REQUESTED");
          s.db.sql.update(
              "UPDATE reconciliation_cases SET state='RESUMED' WHERE id=?", c.get("id"));
        });
    return ResponseEntity.status(202).body(map("status", "queued"));
  }
}
