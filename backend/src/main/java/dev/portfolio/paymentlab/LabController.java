package dev.portfolio.paymentlab;

import static dev.portfolio.paymentlab.Db.*;

import java.util.*;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/internal/lab")
public class LabController {
  private final PaymentService s;
  private final StringRedisTemplate redis;

  public LabController(PaymentService s, StringRedisTemplate redis) {
    this.s = s;
    this.redis = redis;
  }

  @PostMapping("/runs")
  public Object create(@RequestBody Map<String, String> b) {
    if (!b.containsKey("policy")
        && s.db.one("SELECT id FROM lab_runs WHERE id=?", Runs.valid(b.get("run"))) != null)
      return map("status", "ready");
    s.runs.create(b.get("run"), b.getOrDefault("policy", "normal"));
    return map("status", "ready");
  }

  @GetMapping("/traces")
  public Object traces(@RequestParam String run) {
    return s.trace.list(Runs.valid(run));
  }

  @PostMapping("/fault")
  public Object fault(@RequestBody Map<String, String> b) {
    String run = Runs.valid(b.get("run"));
    s.faults.set(run, b.getOrDefault("point", "none"));
    return map("point", s.faults.get(run));
  }

  @PostMapping("/price")
  public Object price(@RequestBody Map<String, Object> b) {
    String run = Runs.valid(b.get("run").toString());
    long price = PspClient.n(b, "price");
    if (price < 1 || price > 100000) throw new Failure(400, "INVALID_PRICE", "실습 가격 범위를 확인하세요.");
    s.db.sql.update("UPDATE lab_runs SET price=? WHERE id=?", price, run);
    return map("status", "updated");
  }

  @PostMapping("/replay-outbox")
  public Object replay(@RequestBody Map<String, String> b) {
    String run = Runs.valid(b.get("run"));
    s.db.sql.update("UPDATE payment_outbox SET state='PENDING' WHERE realm_id=?", run);
    return map("status", "queued");
  }

  // flow:LabController.snapshot
  @GetMapping("/snapshot")
  public Object snapshot(@RequestParam String run) {
    Runs.valid(run);
    var db = s.db;
    Map<String, Object> counts = new LinkedHashMap<>();
    for (String table :
        List.of(
            "orders",
            "payment_attempts",
            "payments",
            "payment_operations",
            "payment_movements",
            "webhook_inbox",
            "payment_outbox",
            "payment_receipts",
            "reconciliation_cases"))
      counts.put(
          table, db.one("SELECT count(*) AS n FROM " + table + " WHERE realm_id=?", run).get("n"));
    Object limits;
    try {
      var keys = redis.keys("payment:limit:" + run + ":*");
      limits =
          keys == null
              ? List.of()
              : keys.stream()
                  .map(k -> map("kind", k.split(":")[3], "ttl", redis.getExpire(k)))
                  .toList();
    } catch (Exception e) {
      limits = map("status", "unavailable");
    }
    return map(
        "observedAt",
        db.now().toString(),
        "counts",
        counts,
        "orders",
        db.sql.queryForList(
            "SELECT id,amount,unit_price,quantity,currency,state,close_intent,accepted_payment_id,version,created_at,expires_at FROM orders WHERE realm_id=? ORDER BY created_at",
            run),
        "attempts",
        db.sql.queryForList(
            "SELECT id,order_id,seq,state,auth_until FROM payment_attempts WHERE realm_id=? ORDER BY created_at",
            run),
        "payments",
        db.sql.queryForList(
            "SELECT id,order_id,attempt_id,approved_amount,canceled_amount,reserved_amount,money_state,sync_state,version,observed_at FROM payments WHERE realm_id=? ORDER BY approved_at,id",
            run),
        "operations",
        db.sql.queryForList(
            "SELECT o.id,o.order_id,o.attempt_id,o.payment_id,o.kind,o.amount,o.state,o.failure_code,o.attempts,o.queries,o.safe_until,j.worker_id,j.lease_until FROM payment_operations o LEFT JOIN operation_jobs j ON j.operation_id=o.id WHERE o.realm_id=? ORDER BY o.created_at",
            run),
        "reservations",
        db.sql.queryForList(
            "SELECT r.operation_id,r.amount,r.state FROM cancel_reservations r JOIN payments p ON p.id=r.payment_id WHERE p.realm_id=?",
            run),
        "movements",
        db.sql.queryForList(
            "SELECT kind,amount,created_at FROM payment_movements WHERE realm_id=? ORDER BY created_at",
            run),
        "inbox",
        db.sql.queryForList(
            "SELECT id,event_id,state,received_at FROM webhook_inbox WHERE realm_id=? ORDER BY received_at",
            run),
        "outbox",
        db.sql.queryForList(
            "SELECT id,payment_id,aggregate_version,event_type,state FROM payment_outbox WHERE realm_id=? ORDER BY created_at",
            run),
        "receipts",
        db.sql.queryForList("SELECT * FROM payment_receipts WHERE realm_id=?", run),
        "cases",
        db.sql.queryForList(
            "SELECT id,order_id,operation_id,reason,state FROM reconciliation_cases WHERE realm_id=? ORDER BY created_at",
            run),
        "limits",
        limits);
  }
}
