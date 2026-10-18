package dev.portfolio.paymentlab;

import java.util.*;
import org.springframework.dao.*;
import org.springframework.http.*;
import org.springframework.web.bind.annotation.*;

@RestControllerAdvice
public class ApiAdvice {
  private final TraceLog trace;

  public ApiAdvice(TraceLog trace) {
    this.trace = trace;
  }

  @ExceptionHandler(Failure.class)
  public ResponseEntity<?> failure(Failure f) {
    trace.step("Server", "rejected", f.code, "RequestFilter.response");
    var b = ResponseEntity.status(f.status);
    if (f.status == 429) b.header("Retry-After", Integer.toString(f.retryAfter));
    return b.body(Map.of("code", f.code, "message", f.getMessage()));
  }

  @ExceptionHandler(Exception.class)
  public ResponseEntity<?> other(Exception e) {
    if (e instanceof org.springframework.http.converter.HttpMessageNotReadableException
        || e instanceof IllegalArgumentException
        || e instanceof ArithmeticException)
      return ResponseEntity.badRequest()
          .body(Map.of("code", "INVALID_INPUT", "message", "입력 형식과 범위를 확인하세요."));
    trace.step("Server", "unavailable", "실제 의존 서비스의 처리 결과를 확인할 수 없음", "RequestFilter.response");
    return ResponseEntity.status(503)
        .body(Map.of("code", "DEPENDENCY_UNAVAILABLE", "message", "저장소·외부 서비스의 결과를 확인할 수 없습니다."));
  }
}
