import { test, expect } from "@playwright/test";
import {
  lab,
  api,
  waitOrder,
  paid,
  prepared,
  confirmUi,
  confirmBody,
  cancelBody,
  snapshot,
  healthy,
} from "./helpers";
test("F01 승인 접수 커밋 전 실패는 작업·매핑·job 롤백 @failures", async ({
  page,
  request,
}) => {
  const { run, order } = await prepared(page, request);
  await lab(request, "fault", { run, point: "before-confirm-commit" });
  const r = await api(
    page,
    run,
    "attempts/" + order.attempts[0].id + "/confirm",
    "POST",
    confirmBody(order),
  );
  expect(r.status).toBe(503);
  const s = await snapshot(request, run);
  expect(s.merchant.counts.payment_operations).toBe(0);
  expect(s.pg.calls).toHaveLength(0);
  await lab(request, "fault", { run, point: "none" });
  await confirmUi(page);
  await waitOrder(page, run, order.id, (o) => o.state === "ACCEPTED");
});
test("F02 접수 커밋 후 앱 실제 종료는 B가 영속 작업 처리 @failures", async ({
  page,
  request,
}) => {
  const { run, order } = await prepared(page, request);
  await lab(request, "fault", { run, point: "hold-jobs" });
  await confirmUi(page);
  await lab(request, "app", { node: "A", action: "stop" });
  try {
    await lab(request, "fault", { run, point: "none" });
    await waitOrder(page, run, order.id, (o) => o.state === "ACCEPTED");
    expect((await snapshot(request, run)).pg.transactions).toHaveLength(1);
  } finally {
    await lab(request, "app", { node: "A", action: "start" });
    await healthy(request);
  }
});
test("F03 PG 도착 전 실제 TCP 차단 뒤 같은 작업 복구 @failures", async ({
  page,
  request,
}) => {
  const { run, order } = await prepared(page, request);
  await lab(request, "network", { target: "pg", blocked: true });
  try {
    await confirmUi(page);
    await waitOrder(
      page,
      run,
      order.id,
      (o) => o.operations[0]?.state === "UNKNOWN",
    );
    expect((await snapshot(request, run)).pg.calls).toHaveLength(0);
  } finally {
    await lab(request, "network", { target: "pg", blocked: false });
  }
  await waitOrder(page, run, order.id, (o) => o.state === "ACCEPTED");
  expect((await snapshot(request, run)).pg.transactions).toHaveLength(1);
});
test("F04 실제 PG 승인 HTTP 응답 제거 뒤 조회로 한 번 복구 @failures", async ({
  page,
  request,
}) => {
  const { run, order } = await prepared(page, request);
  await lab(request, "psp-control", {
    run,
    controls: { "drop-CONFIRM": true, "hold-webhooks": true },
  });
  await confirmUi(page);
  await waitOrder(page, run, order.id, (o) => o.state === "ACCEPTED");
  const traces = await lab(request, "traces?run=" + run);
  expect(
    traces.some((t: any) =>
      t.steps.some((s: any) => s.action === "response_lost"),
    ),
  ).toBe(true);
  expect((await snapshot(request, run)).pg.transactions).toHaveLength(1);
});
test("F05 PG 요청 중 lease 소유 앱 실제 종료 후 회수 @failures", async ({
  page,
  request,
}) => {
  const { run, order } = await prepared(page, request);
  await lab(request, "psp-control", {
    run,
    controls: { "delay-CONFIRM": 1800, "hold-webhooks": true },
  });
  await confirmUi(page);
  await waitOrder(page, run, order.id, (o) => o.operations[0]?.attempts === 1);
  const worker = (await snapshot(request, run)).merchant.operations[0]
    .worker_id;
  expect(["A", "B"]).toContain(worker);
  await lab(request, "app", { node: worker, action: "stop" });
  try {
    const o = await waitOrder(
      page,
      run,
      order.id,
      (o) => o.state === "ACCEPTED" && o.operations[0].state === "SUCCEEDED",
      20000,
    );
    expect(o.movements).toHaveLength(1);
    expect((await snapshot(request, run)).pg.transactions).toHaveLength(1);
  } finally {
    await lab(request, "app", { node: worker, action: "start" });
    await healthy(request);
  }
});
test("F06 PG 성공 뒤 실제 상점 DB TCP 차단·복구 @failures", async ({
  page,
  request,
}) => {
  const { run, order } = await prepared(page, request, "normal");
  await lab(request, "psp-control", {
    run,
    controls: { "hold-response-CONFIRM": 2500, "hold-webhooks": true },
  });
  await confirmUi(page);
  await expect
    .poll(async () => (await snapshot(request, run)).pg.transactions.length)
    .toBe(1);
  await lab(request, "network", { target: "db", blocked: true });
  try {
    const s = await snapshot(request, run);
    expect(s.pg.transactions).toHaveLength(1);
    expect(s.merchant.status).toBe("unavailable");
    await page.waitForTimeout(2800);
  } finally {
    await lab(request, "network", { target: "db", blocked: false });
  }
  const o = await waitOrder(
    page,
    run,
    order.id,
    (o) => o.state === "ACCEPTED",
    25000,
  );
  expect(o.movements).toHaveLength(1);
  expect((await snapshot(request, run)).pg.transactions).toHaveLength(1);
});
test("F07 신규 접수 중 Redis 실제 TCP 차단은 신규 작업 없는 503 @failures", async ({
  page,
  request,
}) => {
  const { run, order } = await prepared(page, request);
  await lab(request, "network", { target: "redis", blocked: true });
  try {
    const r = await api(
      page,
      run,
      "attempts/" + order.attempts[0].id + "/confirm",
      "POST",
      confirmBody(order),
      "A",
      false,
    );
    expect(r.status).toBe(503);
    const s = await snapshot(request, run);
    expect(s.merchant.counts.payment_operations).toBe(0);
    expect(s.pg.transactions).toHaveLength(0);
  } finally {
    await lab(request, "network", { target: "redis", blocked: false });
  }
});
test("F08 Redis 프로세스 실제 중단 중 기존 DB 작업자는 승인 처리 @failures", async ({
  page,
  request,
}) => {
  const { run, order } = await prepared(page, request);
  await lab(request, "fault", { run, point: "hold-jobs" });
  await confirmUi(page);
  await lab(request, "redis-stop", {});
  try {
    await lab(request, "fault", { run, point: "none" });
    await expect
      .poll(
        async () => (await snapshot(request, run)).merchant.operations[0].state,
        { timeout: 15000 },
      )
      .toBe("SUCCEEDED");
    expect((await snapshot(request, run)).merchant.limits.status).toBe(
      "unavailable",
    );
  } finally {
    await lab(request, "redis-restart", {});
  }
  const replay = confirmBody(order);
  await expect
    .poll(
      async () =>
        (
          await api(
            page,
            run,
            "attempts/" + order.attempts[0].id + "/confirm",
            "POST",
            replay,
          )
        ).status,
      { timeout: 15000 },
    )
    .toBe(200);
  expect((await snapshot(request, run)).pg.transactions).toHaveLength(1);
});
test("F09 취소 예약 커밋 전 롤백과 커밋 후 실제 앱 종료 비교 @failures", async ({
  page,
  request,
}) => {
  const { run, order } = await paid(page, request);
  const b = cancelBody(order),
    path = "payments/" + order.payments[0].id + "/cancel";
  await lab(request, "fault", { run, point: "before-cancel-commit" });
  expect((await api(page, run, path, "POST", b)).status).toBe(503);
  expect((await snapshot(request, run)).merchant.reservations).toHaveLength(0);
  await lab(request, "fault", { run, point: "hold-jobs" });
  expect((await api(page, run, path, "POST", b)).status).toBe(202);
  expect((await snapshot(request, run)).merchant.reservations[0].state).toBe(
    "ACTIVE",
  );
  await lab(request, "app", { node: "A", action: "stop" });
  try {
    await lab(request, "fault", { run, point: "none" });
    await waitOrder(
      page,
      run,
      order.id,
      (o) => o.payments[0].canceled_amount === 3000,
    );
    expect((await snapshot(request, run)).pg.transactions).toHaveLength(2);
  } finally {
    await lab(request, "app", { node: "A", action: "start" });
    await healthy(request);
  }
});
test("F10 PG 취소 후 실제 DB 장애에도 예약을 잃지 않고 정산 @failures", async ({
  page,
  request,
}) => {
  const { run, order } = await paid(page, request, "normal");
  await lab(request, "psp-control", {
    run,
    controls: { "hold-response-CANCEL": 2500, "hold-webhooks": true },
  });
  await api(
    page,
    run,
    "payments/" + order.payments[0].id + "/cancel",
    "POST",
    cancelBody(order),
  );
  await expect
    .poll(async () => (await snapshot(request, run)).pg.transactions.length)
    .toBe(2);
  await lab(request, "network", { target: "db", blocked: true });
  try {
    expect((await snapshot(request, run)).merchant.status).toBe("unavailable");
    await page.waitForTimeout(2800);
  } finally {
    await lab(request, "network", { target: "db", blocked: false });
  }
  const o = await waitOrder(
    page,
    run,
    order.id,
    (o) =>
      o.payments[0].canceled_amount === 3000 &&
      o.payments[0].reserved_amount === 0,
    25000,
  );
  expect(o.movements).toHaveLength(2);
  expect((await snapshot(request, run)).pg.transactions).toHaveLength(2);
});
test("F11 웹훅 수신 DB 장애는 성공 ACK 없음·복구 후 ACK 유실 재전송 @failures", async ({
  page,
  request,
}) => {
  const { run, order } = await prepared(page, request);
  await lab(request, "psp-control", {
    run,
    controls: { "hold-webhooks": true },
  });
  await confirmUi(page);
  await waitOrder(page, run, order.id, (o) => o.state === "ACCEPTED");
  const id = (await snapshot(request, run)).pg.webhooks[0].id;
  await lab(request, "network", { target: "db", blocked: true });
  try {
    expect((await lab(request, "deliver", { id })).status).toBe(503);
  } finally {
    await lab(request, "network", { target: "db", blocked: false });
  }
  await expect
    .poll(
      async () => (await snapshot(request, run)).merchant.counts?.webhook_inbox,
      { timeout: 10000 },
    )
    .toBe(0);
  expect((await lab(request, "deliver", { id, mode: "drop-ack" })).status).toBe(
    0,
  );
  expect((await lab(request, "deliver", { id })).status).toBe(200);
  expect((await snapshot(request, run)).merchant.counts.webhook_inbox).toBe(1);
});
test("F12 A 종료 뒤 B 처리와 양쪽 실제 재시작은 DB 결과 복원 @failures", async ({
  page,
  request,
}) => {
  const { run, order } = await paid(page, request);
  await lab(request, "app", { node: "A", action: "stop" });
  try {
    const r = await api(page, run, "orders/" + order.id, "GET", undefined, "B");
    expect(r.instance).toBe("B");
    expect(r.data.state).toBe("ACCEPTED");
    await lab(request, "app", { node: "B", action: "stop" });
  } finally {
    await lab(request, "app", { node: "A", action: "start" });
    await lab(request, "app", { node: "B", action: "start" });
    await healthy(request);
  }
  const restored = await waitOrder(
    page,
    run,
    order.id,
    (o) => o.state === "ACCEPTED",
  );
  expect(restored.operations[0].id).toBe(order.operations[0].id);
  expect((await snapshot(request, run)).pg.transactions).toHaveLength(1);
});
