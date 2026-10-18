package dev.portfolio.paymentlab;

import static dev.portfolio.paymentlab.Db.*;

import com.fasterxml.jackson.databind.ObjectMapper;
import java.net.*;
import java.net.http.*;
import java.time.*;
import java.util.*;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

@Component
public class PspClient {
  private final HttpClient client =
      HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(2)).build();
  private final ObjectMapper json;
  private final String secret;
  private final TraceLog trace;

  public PspClient(ObjectMapper json, @Value("${lab.psp}") String secret, TraceLog trace) {
    this.json = json;
    this.secret = secret;
    this.trace = trace;
  }

  // flow:PspClient.call
  public Map<String, Object> call(
      String path, Map<String, Object> body, Policy p, String key, UUID correlation) {
    try {
      var b =
          HttpRequest.newBuilder(URI.create("http://127.0.0.1:18482" + path))
              .timeout(Duration.ofSeconds(p.timeout()))
              .header("X-Psp-Secret", secret)
              .header("Content-Type", "application/json");
      if (key != null) b.header("Idempotency-Key", key);
      if (correlation != null) b.header("X-Correlation-Id", correlation.toString());
      if (body == null) b.GET();
      else b.POST(HttpRequest.BodyPublishers.ofString(json.writeValueAsString(body)));
      trace.step("Server", "pg_request", "고정 PG 경로 요청 시작 · 도달·커밋과 구분", "PspClient.call");
      var r = client.send(b.build(), HttpResponse.BodyHandlers.ofString());
      if (r.statusCode() != 200) throw Failure.unavailable();
      return json.readValue(r.body(), Map.class);
    } catch (Failure f) {
      throw f;
    } catch (Exception e) {
      throw Failure.unavailable();
    }
  }

  public List<Map<String, Object>> attempt(UUID id, Policy p, UUID op) {
    var r = call("/v1/attempts/" + id, null, p, null, op);
    if (!(r.get("payments") instanceof List<?>))
      throw new Failure(422, "PG_RESPONSE_INVALID", "PG 응답을 검증할 수 없습니다.");
    return (List<Map<String, Object>>) r.get("payments");
  }

  public Map<String, Object> operation(UUID id, Policy p) {
    return call("/v1/operations/" + id, null, p, null, id);
  }

  // flow:PspClient.validate
  public void validate(Map<String, Object> s, Map<String, Object> a, Map<String, Object> o) {
    try {
      if (!o.get("realm_id").equals(s.get("realm"))
          || !"payment-lab".equals(s.get("merchant"))
          || !"local".equals(s.get("environment"))
          || !a.get("id").toString().equals(s.get("attemptId"))
          || !a.get("provider_order_id").equals(s.get("providerOrderId"))
          || !o.get("currency").equals(s.get("currency"))
          || number(o, "amount") != n(s, "amount")) throw new IllegalArgumentException();
      UUID.fromString(s.get("paymentKey").toString());
      long cap = n(s, "captured"), cancel = n(s, "canceled");
      if ((cap != 0 && cap != number(o, "amount")) || cancel < 0 || cancel > cap)
        throw new IllegalArgumentException();
      long sc = 0, sr = 0;
      Set<String> ids = new HashSet<>();
      for (var t : (List<Map<String, Object>>) s.get("transactions")) {
        if (!ids.add(t.get("id").toString()) || n(t, "amount") <= 0)
          throw new IllegalArgumentException();
        if ("CAPTURE".equals(t.get("kind"))) sc = Math.addExact(sc, n(t, "amount"));
        else if ("CANCEL".equals(t.get("kind"))) sr = Math.addExact(sr, n(t, "amount"));
        else throw new IllegalArgumentException();
        Instant.parse(t.get("occurredAt").toString());
      }
      if (sc != cap || sr != cancel) throw new IllegalArgumentException();
    } catch (Exception e) {
      throw new Failure(422, "PG_RESPONSE_INVALID", "주문·금액·통화·상점·거래 응답이 일치하지 않습니다.");
    }
  }

  public static long n(Map<String, Object> m, String key) {
    Object v = m.get(key);
    if (!(v instanceof Integer || v instanceof Long))
      throw new Failure(400, "INVALID_AMOUNT", "정수 금액이 필요합니다.");
    return ((Number) v).longValue();
  }
}
