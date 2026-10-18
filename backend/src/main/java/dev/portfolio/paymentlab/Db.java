package dev.portfolio.paymentlab;

import java.sql.Timestamp;
import java.time.*;
import java.util.*;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

@Component
public class Db {
  public final JdbcTemplate sql;
  public final TransactionTemplate tx;

  public Db(JdbcTemplate sql, PlatformTransactionManager tm) {
    this.sql = sql;
    this.tx = new TransactionTemplate(tm);
    sql.setQueryTimeout(3);
  }

  public Map<String, Object> one(String query, Object... args) {
    var list = sql.queryForList(query, args);
    return list.isEmpty() ? null : list.getFirst();
  }

  public static UUID uuid(Map<String, Object> row, String key) {
    return UUID.fromString(row.get(key).toString());
  }

  public static long number(Map<String, Object> row, String key) {
    return ((Number) row.get(key)).longValue();
  }

  public static Instant time(Map<String, Object> row, String key) {
    Object v = row.get(key);
    return v == null
        ? null
        : v instanceof Timestamp t ? t.toInstant() : ((java.time.OffsetDateTime) v).toInstant();
  }

  public static Timestamp stamp(Instant at) {
    return Timestamp.from(at);
  }

  public Instant now() {
    return time(one("SELECT clock_timestamp() AS at"), "at");
  }

  public void committed(Runnable work) {
    if (org.springframework.transaction.support.TransactionSynchronizationManager
        .isSynchronizationActive())
      org.springframework.transaction.support.TransactionSynchronizationManager
          .registerSynchronization(
              new org.springframework.transaction.support.TransactionSynchronization() {
                public void afterCommit() {
                  work.run();
                }
              });
    else work.run();
  }

  public static Map<String, Object> map(Object... pairs) {
    Map<String, Object> m = new LinkedHashMap<>();
    for (int i = 0; i < pairs.length; i += 2) m.put(pairs[i].toString(), pairs[i + 1]);
    return m;
  }

  public static UUID id(String value) {
    try {
      return UUID.fromString(value);
    } catch (Exception e) {
      throw new Failure(400, "INVALID_ID", "요청 식별자가 올바르지 않습니다.");
    }
  }
}
