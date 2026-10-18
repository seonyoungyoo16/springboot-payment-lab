package dev.portfolio.paymentlab;

import java.time.*;
import java.util.*;
import java.util.concurrent.*;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

@Component
public class TraceLog {
  public record Step(
      String node,
      String action,
      String message,
      String source,
      String at,
      Map<String, Object> snapshot) {}

  public static class Entry {
    public String id, run, instance, path, method, startedAt, finishedAt, operationId;
    public int status;
    public List<Step> steps = new ArrayList<>();
  }

  private final ThreadLocal<Entry> current = new ThreadLocal<>();
  private final ConcurrentLinkedDeque<Entry> history = new ConcurrentLinkedDeque<>();
  private final String instance;

  public TraceLog(@Value("${lab.instance}") String instance) {
    this.instance = instance;
  }

  public void begin(String run, String method, String path, String id) {
    Entry e = new Entry();
    e.id = id;
    e.run = run;
    e.method = method;
    e.path = path;
    e.instance = instance;
    e.startedAt = Instant.now().toString();
    current.set(e);
  }

  public void step(String node, String action, String message, String source) {
    step(node, action, message, source, Map.of());
  }

  public void step(
      String node, String action, String message, String source, Map<String, Object> snapshot) {
    var e = current.get();
    if (e != null)
      e.steps.add(
          new Step(
              node,
              action,
              message,
              source,
              Instant.now().toString(),
              new LinkedHashMap<>(snapshot)));
  }

  public void operation(UUID id) {
    if (current.get() != null) current.get().operationId = id.toString();
  }

  public String id() {
    return current.get() == null ? "background" : current.get().id;
  }

  public void run(String run) {
    if (current.get() != null) current.get().run = run;
  }

  // flow:TraceLog.finish
  public void finish(int status) {
    var e = current.get();
    if (e == null) return;
    boolean http = Set.of("GET", "POST", "PUT", "PATCH", "DELETE", "HEAD").contains(e.method);
    step(
        "Server",
        http ? "response_generated" : "work_finished",
        http ? "실제 HTTP " + status + " 응답 생성" : "백그라운드 처리 종료 · 브라우저 수신과 구분",
        "TraceLog.finish");
    e.status = status;
    e.finishedAt = Instant.now().toString();
    history.addFirst(e);
    while (history.size() > 2500) history.pollLast();
    current.remove();
  }

  public List<Entry> list(String run) {
    return history.stream().filter(e -> e.run.equals(run)).limit(200).toList();
  }
}
