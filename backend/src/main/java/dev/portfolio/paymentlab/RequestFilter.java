package dev.portfolio.paymentlab;

import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.servlet.*;
import jakarta.servlet.http.*;
import java.io.*;
import java.util.*;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

@Component
@Order(-200)
public class RequestFilter extends OncePerRequestFilter {
  private final TraceLog trace;
  private final ObjectMapper json;
  private final String key, instance;

  public RequestFilter(
      TraceLog trace,
      ObjectMapper json,
      @Value("${lab.key}") String key,
      @Value("${lab.instance}") String instance) {
    this.trace = trace;
    this.json = json;
    this.key = key;
    this.instance = instance;
  }

  public static String run(HttpServletRequest req) {
    return Runs.valid(req.getHeader("X-Lab-Run"));
  }

  // flow:RequestFilter.request
  protected void doFilterInternal(
      HttpServletRequest req, HttpServletResponse res, FilterChain chain)
      throws ServletException, IOException {
    String path = req.getRequestURI();
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-App-Instance", instance);
    if (path.startsWith("/internal/") && !Crypto.equal(key, req.getHeader("X-Lab-Key"))) {
      res.setStatus(403);
      return;
    }
    boolean tracked =
        path.startsWith("/api/") || path.equals("/payment/return") || path.startsWith("/webhooks/");
    if (tracked) {
      String requestId = req.getHeader("X-Request-Id");
      if (requestId == null || !requestId.matches("[A-Za-z0-9-]{1,80}"))
        requestId = UUID.randomUUID().toString();
      res.setHeader("X-Request-Id", requestId);
      String run = req.getHeader("X-Lab-Run");
      trace.begin(run == null ? "unknown" : run, req.getMethod(), path, requestId);
      trace.step("Server", "request", "실제 서버 요청·문맥 검사", "RequestFilter.request");
    }
    try {
      chain.doFilter(req, res);
    } catch (Exception error) {
      Throwable e = error;
      while (e.getCause() != null && !(e instanceof Failure)) e = e.getCause();
      Failure f = e instanceof Failure a ? a : Failure.unavailable();
      if (!res.isCommitted()) write(res, f);
      trace.step("Server", "rejected", f.code, "RequestFilter.response");
    } finally {
      if (tracked) trace.finish(res.getStatus());
    }
  }

  // flow:RequestFilter.response
  public static void write(HttpServletResponse res, Failure f) throws IOException {
    res.setStatus(f.status);
    res.setContentType("application/json;charset=UTF-8");
    if (f.status == 429) res.setHeader("Retry-After", Integer.toString(f.retryAfter));
    new ObjectMapper()
        .writeValue(res.getOutputStream(), Map.of("code", f.code, "message", f.getMessage()));
  }
}
