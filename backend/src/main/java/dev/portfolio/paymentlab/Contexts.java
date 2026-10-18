package dev.portfolio.paymentlab;

import static dev.portfolio.paymentlab.Db.*;

import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.servlet.http.*;
import java.time.*;
import java.util.*;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.stereotype.Service;

@Service
public class Contexts {
  public static final String COOKIE = "__Host-payment_context", FLOW = "__Host-payment_flow";

  public record Context(String id, Map<String, Object> data) {}

  private final StringRedisTemplate redis;
  private final Crypto crypto;
  private final ObjectMapper json;
  private final Db db;

  public Contexts(StringRedisTemplate redis, Crypto crypto, ObjectMapper json, Db db) {
    this.redis = redis;
    this.crypto = crypto;
    this.json = json;
    this.db = db;
  }

  public static String cookie(HttpServletRequest r, String name) {
    if (r.getCookies() != null)
      for (var c : r.getCookies()) if (c.getName().equals(name)) return c.getValue();
    return null;
  }

  public static void cookie(HttpServletResponse r, String name, String value, Long seconds) {
    var b =
        org.springframework.http.ResponseCookie.from(name, value)
            .secure(true)
            .httpOnly(true)
            .sameSite("Lax")
            .path("/");
    if (seconds != null) b.maxAge(seconds);
    r.addHeader("Set-Cookie", b.build().toString());
  }

  public Context load(HttpServletRequest req) {
    Object cached = req.getAttribute("payment.context");
    if (cached instanceof Context c) return c;
    String id = cookie(req, COOKIE);
    if (id == null || !id.matches("[A-Za-z0-9_-]{43}")) return null;
    String value = redis.opsForValue().get("payment:context:" + Crypto.hash(id));
    if (value == null) return null;
    try {
      Context c = new Context(id, json.readValue(value, Map.class));
      req.setAttribute("payment.context", c);
      return c;
    } catch (Exception e) {
      throw new Failure(401, "CONTEXT_INVALID", "브라우저 문맥을 다시 준비해 주세요.");
    }
  }

  public Context prepare(HttpServletRequest req, HttpServletResponse res) {
    Context old = load(req);
    if (old != null) return old;
    Context c = new Context(crypto.random(), map("csrf", crypto.random()));
    save(c);
    cookie(res, COOKIE, c.id(), null);
    req.setAttribute("payment.context", c);
    return c;
  }

  public void save(Context c) {
    try {
      redis
          .opsForValue()
          .set(
              "payment:context:" + Crypto.hash(c.id()),
              json.writeValueAsString(c.data()),
              Duration.ofMinutes(30));
    } catch (org.springframework.dao.DataAccessException e) {
      throw e;
    } catch (Exception e) {
      throw new IllegalStateException(e);
    }
  }

  public Map<String, Object> principal(HttpServletRequest req, String run) {
    Context c = load(req);
    if (c == null || !c.data().containsKey("record"))
      throw new Failure(401, "LOGIN_REQUIRED", "기존 계정으로 로그인해 주세요.");
    var p =
        db.one(
            "SELECT c.*,a.status,a.role,a.login_id,a.auth_version AS current_version FROM auth_contexts c JOIN accounts a ON a.id=c.account_id WHERE c.id=? AND c.realm_id=?",
            id(c.data().get("record").toString()),
            run);
    if (p == null
        || Boolean.TRUE.equals(p.get("revoked"))
        || !"ACTIVE".equals(p.get("status"))
        || number(p, "auth_version") != number(p, "current_version")
        || !Crypto.equal(Crypto.hash(c.id()), p.get("sid_hash").toString())
        || !time(p, "expires_at").isAfter(db.now()))
      throw new Failure(401, "AUTH_REVOKED", "인증 상태가 변경되었습니다. 다시 로그인해 주세요.");
    return p;
  }

  // flow:Contexts.authenticate
  public void authenticate(
      HttpServletRequest req,
      HttpServletResponse res,
      String run,
      UUID account,
      String method,
      Instant at) {
    authenticate(req, res, run, account, method, at, null);
  }

  public void authenticate(
      HttpServletRequest req,
      HttpServletResponse res,
      String run,
      UUID account,
      String method,
      Instant at,
      Instant previousAbsolute) {
    Context previous = load(req);
    Context c =
        new Context(
            crypto.random(), map("csrf", crypto.random(), "record", UUID.randomUUID().toString()));
    save(c);
    db.tx.executeWithoutResult(
        t -> {
          var user =
              db.one("SELECT * FROM accounts WHERE id=? AND realm_id=? FOR UPDATE", account, run);
          if (user == null || !"ACTIVE".equals(user.get("status")))
            throw new Failure(401, "AUTH_REVOKED", "계정에 로그인할 수 없습니다.");
          db.sql.update(
              "INSERT INTO auth_contexts(id,realm_id,account_id,sid_hash,auth_version,authenticated_at,method,expires_at) VALUES(?,?,?,?,?,?,?,?)",
              id(c.data().get("record").toString()),
              run,
              account,
              Crypto.hash(c.id()),
              number(user, "auth_version"),
              stamp(at),
              method,
              stamp(previousAbsolute == null ? db.now().plusSeconds(28800) : previousAbsolute));
          if (previous != null) {
            if (previous.data().containsKey("record"))
              db.sql.update(
                  "UPDATE auth_contexts SET revoked=true WHERE id=?",
                  id(previous.data().get("record").toString()));
          }
        });
    if (previous != null) redis.delete("payment:context:" + Crypto.hash(previous.id()));
    cookie(res, COOKIE, c.id(), null);
    req.setAttribute("payment.context", c);
  }

  public void logout(HttpServletRequest req, HttpServletResponse res, String run) {
    var p = principal(req, run);
    db.sql.update("UPDATE auth_contexts SET revoked=true WHERE id=?", uuid(p, "id"));
    Context c = load(req);
    redis.delete("payment:context:" + Crypto.hash(c.id()));
    req.removeAttribute("payment.context");
    cookie(res, COOKIE, "", 0L);
  }

  public void recent(Map<String, Object> p, Policy policy) {
    if (!time(p, "authenticated_at").plusSeconds(policy.recent()).isAfter(db.now()))
      throw new Failure(403, "REAUTH_REQUIRED", "기존 로그인 수단으로 다시 확인해 주세요.");
  }
}
