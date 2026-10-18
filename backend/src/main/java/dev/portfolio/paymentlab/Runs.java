package dev.portfolio.paymentlab;

import static dev.portfolio.paymentlab.Db.*;

import java.util.*;
import org.springframework.stereotype.Component;

@Component
public class Runs {
  private final Db db;
  private final String fixture;

  public Runs(Db db, Crypto crypto) {
    this.db = db;
    fixture = crypto.encode("Payment!2026LongPass");
  }

  public static String valid(String run) {
    if (run == null || !run.matches("[A-Za-z0-9_-]{1,80}"))
      throw new Failure(400, "INVALID_RUN", "실행 식별자가 필요합니다.");
    return run;
  }

  public Map<String, Object> row(String run) {
    var r = db.one("SELECT * FROM lab_runs WHERE id=?", valid(run));
    if (r == null) throw new Failure(404, "RUN_REQUIRED", "실험 실행을 준비하세요.");
    return r;
  }

  public Policy policy(String run) {
    return Policy.of(row(run).get("policy").toString());
  }

  public void create(String run, String policy) {
    valid(run);
    if (!Set.of("normal", "short", "expiry", "capacity").contains(policy))
      throw new Failure(400, "INVALID_POLICY", "정책을 확인하세요.");
    db.tx.executeWithoutResult(
        t -> {
          int n =
              db.sql.update(
                  "INSERT INTO lab_runs(id,policy) VALUES(?,?) ON CONFLICT DO NOTHING",
                  run,
                  policy);
          if (n == 0) {
            if (!row(run).get("policy").equals(policy))
              throw new Failure(409, "POLICY_FIXED", "실행 정책은 변경할 수 없습니다.");
            return;
          }
          for (String name : List.of("A", "B", "OPERATOR")) {
            UUID account = UUID.randomUUID();
            db.sql.update(
                "INSERT INTO accounts(id,realm_id,login_id,role) VALUES(?,?,?,?)",
                account,
                run,
                name,
                name.equals("OPERATOR") ? "OPERATOR" : "CUSTOMER");
            db.sql.update("INSERT INTO password_credentials VALUES(?,?)", account, fixture);
            db.sql.update(
                "INSERT INTO checkout_intents(id,realm_id,account_id,is_default) VALUES(?,?,?,true)",
                UUID.randomUUID(),
                run,
                account);
          }
        });
  }
}
