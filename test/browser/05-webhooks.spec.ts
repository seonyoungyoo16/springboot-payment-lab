import { test, expect } from "@playwright/test";
import {
  lab,
  api,
  waitOrder,
  paid,
  prepared,
  confirmUi,
  cancelBody,
  snapshot,
  login,
} from "./helpers";
test("W01 서명 웹훅은 inbox 접수 뒤 PG 조회로 반영 @webhooks", async ({
  page,
  request,
}) => {
  const { run, order } = await paid(page, request);
  await expect
    .poll(async () => (await snapshot(request, run)).merchant.inbox[0]?.state)
    .toBe("APPLIED");
  expect((await snapshot(request, run)).merchant.counts.payment_movements).toBe(
    1,
  );
  const traces = await lab(request, "traces?run=" + run);
  expect(
    traces.some((t: any) =>
      t.steps.some((s: any) => s.action === "inbox_committed"),
    ),
  ).toBe(true);
});
test("W02 eventId 10회와 실제 ACK 유실에도 inbox·원장 하나 @webhooks", async ({
  page,
  request,
}) => {
  const { run } = await paid(page, request);
  const s = await snapshot(request, run),
    id = s.pg.webhooks[0].id;
  const dropped = await lab(request, "deliver", { id, mode: "drop-ack" });
  expect(dropped.status).toBe(0);
  await Promise.all(
    Array.from({ length: 10 }, () => lab(request, "deliver", { id })),
  );
  await expect
    .poll(async () => (await snapshot(request, run)).merchant.inbox[0]?.state)
    .toBe("APPLIED");
  const after = await snapshot(request, run);
  expect(after.merchant.counts.webhook_inbox).toBe(1);
  expect(after.merchant.counts.payment_movements).toBe(1);
});
test("W03 취소 이벤트부터 전달해도 현재 PG 사실로 수렴·역행 없음 @webhooks", async ({
  page,
  request,
}) => {
  const { run, order } = await prepared(page, request);
  await lab(request, "psp-control", {
    run,
    controls: { "hold-webhooks": true },
  });
  await confirmUi(page);
  let o = await waitOrder(page, run, order.id, (o) => o.state === "ACCEPTED");
  await api(
    page,
    run,
    "payments/" + o.payments[0].id + "/cancel",
    "POST",
    cancelBody(o),
  );
  await waitOrder(
    page,
    run,
    order.id,
    (o) => o.payments[0].canceled_amount === 3000,
  );
  const s = await snapshot(request, run);
  await lab(request, "deliver", { id: s.pg.webhooks[1].id });
  await lab(request, "deliver", { id: s.pg.webhooks[0].id });
  await expect
    .poll(
      async () =>
        (await snapshot(request, run)).merchant.inbox.filter(
          (x: any) => x.state === "APPLIED",
        ).length,
    )
    .toBe(2);
  o = await waitOrder(
    page,
    run,
    order.id,
    (o) => o.payments[0].canceled_amount === 3000,
  );
  expect(o.movements).toHaveLength(2);
});
test("W04 잘못된 서명·변경 본문·만료·같은 ID 다른 본문 거부 @webhooks", async ({
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
  for (const mode of ["bad-signature", "changed-body", "expired"])
    expect((await lab(request, "deliver", { id, mode })).status).toBe(403);
  expect((await snapshot(request, run)).merchant.counts.webhook_inbox).toBe(0);
  expect((await lab(request, "deliver", { id })).status).toBe(200);
  expect(
    (await lab(request, "deliver", { id, mode: "same-id-different-body" }))
      .status,
  ).toBe(409);
  expect((await snapshot(request, run)).merchant.counts.webhook_inbox).toBe(1);
});
test("W05 웹훅 누락과 승인 응답 유실은 DB 작업자 대사로 복구 @webhooks", async ({
  page,
  request,
}) => {
  const { run, order } = await prepared(page, request);
  await lab(request, "psp-control", {
    run,
    controls: { "hold-webhooks": true, "drop-CONFIRM": true },
  });
  await confirmUi(page);
  const o = await waitOrder(page, run, order.id, (o) => o.state === "ACCEPTED");
  expect(o.movements).toHaveLength(1);
  const s = await snapshot(request, run);
  expect(s.merchant.counts.webhook_inbox).toBe(0);
  expect(s.pg.transactions).toHaveLength(1);
});
test("W06 취소 전 PG 조회가 늦게 돌아와도 이미 기록한 취소 보존 @webhooks", async ({
  page,
  request,
}) => {
  const { run, order } = await paid(page, request, "normal");
  await lab(request, "psp-control", {
    run,
    controls: { "delay-query": 2500, "hold-webhooks": true },
  });
  const event = (await snapshot(request, run)).pg.webhooks[0].id;
  await lab(request, "deliver", { id: event });
  await expect
    .poll(async () => (await snapshot(request, run)).pg.pendingQueries.length)
    .toBeGreaterThan(0);
  await lab(request, "psp-control", {
    run,
    controls: { "hold-webhooks": true },
  });
  await api(
    page,
    run,
    "payments/" + order.payments[0].id + "/cancel",
    "POST",
    cancelBody(order),
  );
  await waitOrder(
    page,
    run,
    order.id,
    (o) => o.payments[0].canceled_amount === 3000,
  );
  const cancelObservedAt = new Date().toISOString();
  await page.waitForTimeout(2700);
  const traces = await lab(request, "traces?run=" + run);
  expect(
    traces.some(
      (t: any) =>
        t.instance === "PG" &&
        t.finishedAt > cancelObservedAt &&
        t.steps.some(
          (s: any) => s.action === "snapshot_read" && s.snapshot.canceled === 0,
        ),
    ),
  ).toBe(true);
  expect(
    (await snapshot(request, run)).merchant.payments[0].canceled_amount,
  ).toBe(3000);
});
test("W07 외부 취소와 자기 취소 불명 혼합은 금액으로 성공 추정 금지 @webhooks", async ({
  page,
  request,
}) => {
  const { run, order } = await paid(page, request);
  await lab(request, "network", { target: "pg", blocked: true });
  try {
    await api(
      page,
      run,
      "payments/" + order.payments[0].id + "/cancel",
      "POST",
      cancelBody(order, 7000),
    );
    await waitOrder(page, run, order.id, (o) =>
      o.operations.some(
        (x: any) => x.kind === "CANCEL" && x.state === "UNKNOWN",
      ),
    );
    await lab(request, "external-cancel", {
      run,
      attemptId: order.attempts[0].id,
      amount: 5000,
    });
  } finally {
    await lab(request, "network", { target: "pg", blocked: false });
  }
  const o = await waitOrder(
    page,
    run,
    order.id,
    (o) => o.payments[0].sync_state === "REVIEW",
  );
  expect(o.payments[0]).toMatchObject({
    canceled_amount: 5000,
    reserved_amount: 7000,
  });
  expect(o.operations.find((x: any) => x.kind === "CANCEL").state).toBe(
    "REVIEW",
  );
  expect((await snapshot(request, run)).merchant.reservations[0].state).toBe(
    "REVIEW_HELD",
  );
});
test("W08 대사 소진 후 운영자 권한·사유·감사와 조회 재개 @webhooks", async ({
  page,
  request,
}) => {
  const { run, order } = await prepared(page, request, "expiry");
  await lab(request, "psp-control", {
    run,
    controls: {
      "hide-operation-results": true,
      "hold-webhooks": true,
      "drop-CONFIRM": true,
    },
  });
  await confirmUi(page);
  await waitOrder(
    page,
    run,
    order.id,
    (o) => o.operations[0]?.state === "REVIEW",
  );
  const c = (await snapshot(request, run)).merchant.cases[0];
  expect(
    (
      await api(page, run, "reconciliation/" + c.id + "/resume", "POST", {
        reason: "확인",
      })
    ).status,
  ).toBe(403);
  await login(page, "OPERATOR");
  expect(
    (
      await api(page, run, "reconciliation/" + c.id + "/resume", "POST", {
        reason: "",
      })
    ).status,
  ).toBe(400);
  await lab(request, "psp-control", {
    run,
    controls: { "hold-webhooks": true },
  });
  expect(
    (
      await api(page, run, "reconciliation/" + c.id + "/resume", "POST", {
        reason: "PG 작업 식별자 조회 복구 후 재확인",
      })
    ).status,
  ).toBe(202);
  await expect
    .poll(
      async () => (await snapshot(request, run)).merchant.operations[0].state,
    )
    .toBe("SUCCEEDED");
  expect((await snapshot(request, run)).merchant.cases[0].state).toBe(
    "RESUMED",
  );
});
