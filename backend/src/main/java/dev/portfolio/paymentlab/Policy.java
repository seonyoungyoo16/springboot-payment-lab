package dev.portfolio.paymentlab;

public record Policy(
    long order,
    long auth,
    long recent,
    long lease,
    long timeout,
    long keyTtl,
    long safeMargin,
    long retryDelay,
    long audit,
    long maxQueries,
    int userLimit,
    int queueLimit) {
  public static Policy of(String name) {
    return switch (name) {
      case "short" -> new Policy(60, 20, 10, 4, 1, 1296000, 60, 1, 3, 60, 60, 1000);
      case "expiry" -> new Policy(15, 10, 3, 4, 1, 10, 1, 1, 2, 2, 60, 1000);
      case "capacity" -> new Policy(120, 90, 90, 4, 1, 1296000, 60, 1, 3, 60, 6, 1);
      default -> new Policy(600, 300, 300, 20, 5, 1296000, 60, 5, 30, 288, 10, 1000);
    };
  }
}
