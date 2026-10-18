package dev.portfolio.paymentlab;

import java.util.*;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.data.redis.core.script.DefaultRedisScript;
import org.springframework.stereotype.Service;

@Service
public class Limiter {
  private final StringRedisTemplate redis;
  private final Crypto crypto;
  private final TraceLog trace;

  public Limiter(StringRedisTemplate redis, Crypto crypto, TraceLog trace) {
    this.redis = redis;
    this.crypto = crypto;
    this.trace = trace;
  }

  private final DefaultRedisScript<Long> script =
      new DefaultRedisScript<>(
          "local n=tonumber(redis.call('GET',KEYS[1]) or '0');if n>=tonumber(ARGV[1]) then return -redis.call('TTL',KEYS[1]) end;n=redis.call('INCR',KEYS[1]);if n==1 then redis.call('EXPIRE',KEYS[1],ARGV[2]) end;return 1",
          Long.class);

  // flow:Limiter.reserve
  public void limit(String run, String kind, String subject, int max, long seconds) {
    String key = "payment:limit:" + run + ":" + kind + ":" + crypto.hmac("limit", subject);
    Long result =
        redis.execute(script, List.of(key), Integer.toString(max), Long.toString(seconds));
    if (result == null || result <= 0)
      throw new Failure(
          429,
          "RATE_LIMITED",
          "요청 제한 시간 뒤에 다시 시도해 주세요.",
          result == null ? 1 : (int) Math.abs(result));
    trace.step("Redis", "rate_limit", "공유 Redis에서 " + kind + " 제한 원자 검사", "Limiter.reserve");
  }

  public void ping() {
    redis.execute((org.springframework.data.redis.core.RedisCallback<String>) c -> c.ping());
  }
}
