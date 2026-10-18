package dev.portfolio.paymentlab;

import java.util.*;
import java.util.concurrent.*;
import org.springframework.stereotype.Component;

@Component
public class Faults {
  private final ConcurrentHashMap<String, String> faults = new ConcurrentHashMap<>();
  public final Set<String> heldMail = ConcurrentHashMap.newKeySet();

  public void set(String run, String point) {
    if (point.equals("none")) {
      faults.remove(run);
      heldMail.remove(run);
    } else if (point.equals("hold-mail")) heldMail.add(run);
    else faults.put(run, point);
  }

  public String get(String run) {
    return faults.getOrDefault(run, "none");
  }

  public boolean take(String run, String point) {
    return faults.remove(run, point);
  }

  // flow:Faults.check
  public void check(String run, String point) {
    if (take(run, point))
      throw new Failure(503, "CHECKPOINT_INTERRUPTED", "지정한 처리 경계에서 실험용 중단이 발생했습니다.");
  }
}
