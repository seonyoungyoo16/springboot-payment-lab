package dev.portfolio.paymentlab;

public class Failure extends RuntimeException {
  public final int status;
  public final String code;
  public final int retryAfter;

  public Failure(int status, String code, String message) {
    this(status, code, message, 5);
  }

  public Failure(int status, String code, String message, long retryAfter) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryAfter = (int) Math.min(Integer.MAX_VALUE, Math.max(1, retryAfter));
  }

  public static Failure unavailable() {
    return new Failure(503, "DEPENDENCY_UNAVAILABLE", "현재 처리 결과를 확인할 수 없습니다. 같은 요청의 상태를 확인해 주세요.");
  }
}
