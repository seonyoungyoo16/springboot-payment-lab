package dev.portfolio.paymentlab;

import static dev.portfolio.paymentlab.Db.*;

import jakarta.servlet.http.*;
import java.util.*;
import java.util.concurrent.Semaphore;
import org.springframework.web.bind.annotation.*;

@RestController
public class AuthController {
  private final Db db;
  private final Crypto crypto;
  private final Contexts contexts;
  private final Limiter limiter;
  private final TraceLog trace;
  private final Runs runs;
  private final Semaphore checks = new Semaphore(4);
  private final String dummy;

  public AuthController(
      Db db, Crypto crypto, Contexts contexts, Limiter limiter, TraceLog trace, Runs runs) {
    this.db = db;
    this.crypto = crypto;
    this.contexts = contexts;
    this.limiter = limiter;
    this.trace = trace;
    this.runs = runs;
    dummy = crypto.encode("Unused!PaymentDummy2026");
  }

  @GetMapping("/health")
  public Object health() {
    return map("status", "up");
  }

  @GetMapping("/api/context")
  public Object context(HttpServletRequest r, HttpServletResponse s) {
    var c = contexts.prepare(r, s);
    return map("csrf", c.data().get("csrf"));
  }

  private boolean matches(String raw, String encoded) {
    if (raw == null || raw.length() > 512)
      throw new Failure(400, "INVALID_PASSWORD", "비밀번호 입력을 확인하세요.");
    if (!checks.tryAcquire()) throw new Failure(429, "HASH_CAPACITY", "인증 확인이 사용 중입니다.");
    try {
      return crypto.matches(raw, encoded == null ? dummy : encoded);
    } finally {
      checks.release();
    }
  }

  // flow:AuthController.login
  @PostMapping("/api/auth/login")
  public Object login(
      HttpServletRequest r, HttpServletResponse s, @RequestBody Map<String, String> b) {
    String run = RequestFilter.run(r), name = b.getOrDefault("user", "");
    runs.row(run);
    limiter.limit(run, "login", name, 10, 60);
    var a =
        db.one(
            "SELECT a.*,p.encoded_hash FROM accounts a JOIN password_credentials p ON p.account_id=a.id WHERE a.realm_id=? AND a.login_id=?",
            run,
            name);
    boolean ok = matches(b.get("password"), a == null ? null : a.get("encoded_hash").toString());
    if (a == null || !ok || !"ACTIVE".equals(a.get("status")))
      throw new Failure(401, "AUTHENTICATION_FAILED", "사용자와 비밀번호를 확인하세요.");
    contexts.authenticate(r, s, run, uuid(a, "id"), "PASSWORD", db.now());
    trace.step("DB", "authenticated", "실제 Argon2id 자격정보 확인과 인증 문맥 교체", "AuthController.login");
    return me(r);
  }

  @GetMapping("/api/auth/me")
  public Object me(HttpServletRequest r) {
    String run = RequestFilter.run(r);
    var p = contexts.principal(r, run);
    return map(
        "user",
        p.get("login_id"),
        "role",
        p.get("role"),
        "recentUntil",
        time(p, "authenticated_at").plusSeconds(runs.policy(run).recent()).toString());
  }

  @PostMapping("/api/auth/reauth")
  public Object reauth(
      HttpServletRequest r, HttpServletResponse s, @RequestBody Map<String, String> b) {
    String run = RequestFilter.run(r);
    var p = contexts.principal(r, run);
    limiter.limit(run, "reauth", p.get("account_id").toString(), 10, 60);
    var a =
        db.one(
            "SELECT encoded_hash FROM password_credentials WHERE account_id=?",
            p.get("account_id"));
    if (!matches(b.get("password"), a.get("encoded_hash").toString()))
      throw new Failure(401, "REAUTH_FAILED", "기존 수단을 다시 확인하세요.");
    contexts.authenticate(
        r, s, run, uuid(p, "account_id"), "PASSWORD", db.now(), time(p, "expires_at"));
    return map("code", "REAUTHENTICATED");
  }

  @PostMapping("/api/auth/logout")
  public Object logout(HttpServletRequest r, HttpServletResponse s) {
    contexts.logout(r, s, RequestFilter.run(r));
    return map("code", "LOGGED_OUT");
  }
}
