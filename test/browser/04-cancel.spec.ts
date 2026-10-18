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
  PASSWORD,
} from "./helpers";
test("C01 실제 화면 전액 취소는 원승인 보존·취소 하나·CLOSED @cancel", async ({
  page,
  request,
}) => {
  const { run, order } = await paid(page, request);
  const r = page.waitForResponse((r) =>
    /\/api\/payments\/[^/]+\/cancel$/.test(new URL(r.url()).pathname),
  );
  await page
    .getByRole("button", { name: "남은 금액 전액 취소", exact: true })
    .click();
  expect((await r).status()).toBe(202);
  const o = await waitOrder(page, run, order.id, (o) => o.state === "CLOSED");
  expect(o.payments[0]).toMatchObject({
    approved_amount: 10000,
    canceled_amount: 10000,
    reserved_amount: 0,
    money_state: "CANCELED",
  });
  expect((await snapshot(request, run)).pg.transactions).toHaveLength(2);
});
test("C02 부분 취소 화면에서 예약과 확정 금액을 구분 @cancel", async ({
  page,
  request,
}) => {
  const { run, order } = await paid(page, request);
  await lab(request, "fault", { run, point: "hold-jobs" });
  await page.getByLabel("부분 취소 금액", { exact: true }).fill("3000");
  await page
    .getByRole("button", { name: "부분 취소 요청", exact: true })
    .click();
  await expect(page.getByTestId("payment-summary")).toContainText(
    "미해결 예약 3,000",
  );
  expect((await snapshot(request, run)).merchant.reservations[0].state).toBe(
    "ACTIVE",
  );
  await lab(request, "fault", { run, point: "none" });
  const o = await waitOrder(
    page,
    run,
    order.id,
    (o) =>
      o.payments[0].canceled_amount === 3000 &&
      o.payments[0].reserved_amount === 0,
  );
  expect(o.state).toBe("ACCEPTED");
  expect(o.movements).toHaveLength(2);
});
test("C03 잘못된 취소 금액과 전액 전용 수단은 예약 전에 거부 @cancel", async ({
  page,
  request,
}) => {
  const { run, order } = await paid(page, request, "short", "FULL_ONLY");
  for (const amount of [0, -1, 1.5, 10001, 3000])
    expect([400, 409]).toContain(
      (
        await api(
          page,
          run,
          "payments/" + order.payments[0].id + "/cancel",
          "POST",
          cancelBody(order, amount),
        )
      ).status,
    );
  const s = await snapshot(request, run);
  expect(s.merchant.reservations).toHaveLength(0);
  expect(s.pg.transactions).toHaveLength(1);
});
test("C04 같은 취소 키의 A/B 경쟁은 작업·예약·취소 하나 @cancel", async ({
  page,
  request,
}) => {
  const { run, order } = await paid(page, request);
  const b = cancelBody(order);
  const rs = await Promise.all(
    ["A", "B", "A", "B"].map((n) =>
      api(
        page,
        run,
        "payments/" + order.payments[0].id + "/cancel",
        "POST",
        b,
        n,
      ),
    ),
  );
  expect(rs.every((r) => [200, 202].includes(r.status))).toBe(true);
  expect(new Set(rs.map((r) => r.data.id)).size).toBe(1);
  await waitOrder(
    page,
    run,
    order.id,
    (o) => o.payments[0].canceled_amount === 3000,
  );
  const s = await snapshot(request, run);
  expect(s.merchant.reservations).toHaveLength(1);
  expect(s.pg.transactions).toHaveLength(2);
});
test("C05 다른 키의 동시 7000원 취소 두 개는 하나만 선점 @cancel", async ({
  page,
  request,
}) => {
  const { run, order } = await paid(page, request);
  await lab(request, "fault", { run, point: "hold-jobs" });
  const rs = await Promise.all(
    ["A", "B"].map((n) =>
      api(
        page,
        run,
        "payments/" + order.payments[0].id + "/cancel",
        "POST",
        cancelBody(order, 7000),
        n,
      ),
    ),
  );
  expect(rs.map((r) => r.status).sort()).toEqual([202, 409]);
  expect((await snapshot(request, run)).merchant.reservations).toHaveLength(1);
  await lab(request, "fault", { run, point: "none" });
  await waitOrder(
    page,
    run,
    order.id,
    (o) => o.payments[0].canceled_amount === 7000,
  );
  expect((await snapshot(request, run)).pg.transactions).toHaveLength(2);
});
test("C06 완료 뒤 낡은 버전의 새 키는 409·명시한 새 버전만 추가 취소 @cancel", async ({
  page,
  request,
}) => {
  const { run, order } = await paid(page, request);
  await api(
    page,
    run,
    "payments/" + order.payments[0].id + "/cancel",
    "POST",
    cancelBody(order),
  );
  const current = await waitOrder(
    page,
    run,
    order.id,
    (o) => o.payments[0].canceled_amount === 3000,
  );
  expect(
    (
      await api(
        page,
        run,
        "payments/" + order.payments[0].id + "/cancel",
        "POST",
        cancelBody(order),
      )
    ).status,
  ).toBe(409);
  expect(
    (
      await api(
        page,
        run,
        "payments/" + order.payments[0].id + "/cancel",
        "POST",
        cancelBody(current, 2000),
      )
    ).status,
  ).toBe(202);
  await waitOrder(
    page,
    run,
    order.id,
    (o) => o.payments[0].canceled_amount === 5000,
  );
});
test("C07 PG 취소 후 HTTP 응답 제거는 예약을 유지한 채 조회 정산 @cancel", async ({
  page,
  request,
}) => {
  const { run, order } = await paid(page, request);
  await lab(request, "psp-control", {
    run,
    controls: {
      "drop-CANCEL": true,
      "hold-webhooks": true,
      "hide-operation-results": true,
    },
  });
  await api(
    page,
    run,
    "payments/" + order.payments[0].id + "/cancel",
    "POST",
    cancelBody(order),
  );
  await waitOrder(page, run, order.id, (o) =>
    o.operations.some((x: any) => x.kind === "CANCEL" && x.state === "UNKNOWN"),
  );
  const held = await snapshot(request, run);
  expect(held.merchant.reservations[0].state).toBe("ACTIVE");
  expect(held.pg.transactions).toHaveLength(2);
  await lab(request, "psp-control", {
    run,
    controls: { "hold-webhooks": true },
  });
  const o = await waitOrder(
    page,
    run,
    order.id,
    (o) =>
      o.payments[0].canceled_amount === 3000 &&
      o.payments[0].reserved_amount === 0,
  );
  expect(o.operations.find((x: any) => x.kind === "CANCEL").state).toBe(
    "SUCCEEDED",
  );
  expect((await snapshot(request, run)).pg.transactions).toHaveLength(2);
});
test("C08 자신의 취소 종결 거절은 예약 해제·승인 잔액 보존 @cancel", async ({
  page,
  request,
}) => {
  const { run, order } = await paid(page, request, "short", "CANCEL_DECLINE");
  await api(
    page,
    run,
    "payments/" + order.payments[0].id + "/cancel",
    "POST",
    cancelBody(order),
  );
  const o = await waitOrder(page, run, order.id, (o) =>
    o.operations.some(
      (x: any) => x.kind === "CANCEL" && x.state === "FAILED_FINAL",
    ),
  );
  expect(o.payments[0]).toMatchObject({
    approved_amount: 10000,
    canceled_amount: 0,
    reserved_amount: 0,
  });
  expect((await snapshot(request, run)).merchant.reservations[0].state).toBe(
    "RELEASED",
  );
  expect((await snapshot(request, run)).pg.transactions).toHaveLength(1);
});
test("C09 전송 중 종료 요청은 늦은 승인 기록·보상 뒤 CLOSED @cancel", async ({
  page,
  request,
}) => {
  const { run, order } = await prepared(page, request);
  await lab(request, "psp-control", {
    run,
    controls: { "delay-CONFIRM": 1600, "hold-webhooks": true },
  });
  await confirmUi(page);
  await waitOrder(page, run, order.id, (o) => o.operations[0]?.attempts === 1);
  expect(
    (
      await api(page, run, "orders/" + order.id + "/close", "POST", {
        idempotencyKey: crypto.randomUUID(),
      })
    ).data.state,
  ).toBe("CLOSING");
  const o = await waitOrder(
    page,
    run,
    order.id,
    (o) => o.state === "CLOSED",
    20000,
  );
  expect(o.accepted_payment_id).toBeNull();
  expect(o.payments[0].canceled_amount).toBe(10000);
  expect(o.operations.filter((x: any) => x.kind === "COMPENSATE")).toHaveLength(
    1,
  );
  expect((await snapshot(request, run)).pg.transactions).toHaveLength(2);
});
test("C10 승인·종료 경쟁과 보상 응답 유실·작업자 재시작 @cancel", async ({
  page,
  request,
}) => {
  const { run, order } = await prepared(page, request);
  await lab(request, "psp-control", {
    run,
    controls: {
      "delay-CONFIRM": 1600,
      "drop-CANCEL": true,
      "hold-webhooks": true,
    },
  });
  await confirmUi(page);
  await waitOrder(page, run, order.id, (o) => o.operations[0]?.attempts === 1);
  await api(page, run, "orders/" + order.id + "/close", "POST", {
    idempotencyKey: crypto.randomUUID(),
  });
  await expect
    .poll(async () => (await snapshot(request, run)).pg.transactions.length, {
      timeout: 20000,
    })
    .toBe(2);
  await lab(request, "app", { node: "A", action: "stop" });
  try {
    const o = await waitOrder(
      page,
      run,
      order.id,
      (o) => o.state === "CLOSED",
      20000,
    );
    expect(
      o.operations.filter((x: any) => x.kind === "COMPENSATE"),
    ).toHaveLength(1);
    expect(o.payments[0].reserved_amount).toBe(0);
    expect((await snapshot(request, run)).pg.transactions).toHaveLength(2);
  } finally {
    await lab(request, "app", { node: "A", action: "start" });
  }
});
