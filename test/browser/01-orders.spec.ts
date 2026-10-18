import { test, expect } from "@playwright/test";
import {
  setup,
  lab,
  api,
  createOrder,
  authenticate,
  confirmUi,
  getOrder,
  waitOrder,
  prepared,
  paid,
  confirmBody,
  snapshot,
} from "./helpers";
test("P01 서버 가격으로 주문을 만들고 PG 승인 없이 저장 @orders", async ({
  page,
  request,
}) => {
  const run = await setup(page, request, "normal");
  await page.getByLabel("주문 수량").fill("2");
  const o = await createOrder(page);
  expect(o.amount).toBe(20000);
  expect(o.unit_price).toBe(10000);
  const s = await snapshot(request, run);
  expect(s.merchant.counts.orders).toBe(1);
  expect(s.pg.transactions).toHaveLength(0);
});
test("P02 실제 PG 인증과 return GET은 승인과 분리 @orders", async ({
  page,
  request,
}) => {
  const { run, order } = await prepared(page, request);
  expect(order.attempts[0].state).toBe("AUTHORIZED");
  expect(order.payments).toHaveLength(0);
  expect((await snapshot(request, run)).pg.transactions).toHaveLength(0);
  expect(page.url()).not.toContain("state=");
});
test("P03 실제 승인 202 접수와 PG·상점 원자 반영 @orders", async ({
  page,
  request,
}) => {
  const { run, order } = await paid(page, request);
  expect(order.movements).toHaveLength(1);
  expect(order.payments[0].approved_amount).toBe(10000);
  const s = await snapshot(request, run);
  expect(s.pg.transactions).toHaveLength(1);
  expect(s.merchant.counts.payment_movements).toBe(1);
  await expect(page.getByTestId("order-state")).toContainText("ACCEPTED");
});
test("P04 실제 PG 인증 거절과 사용자 취소는 금전 효과 없음 @orders", async ({
  page,
  request,
}) => {
  for (const cancel of [false, true]) {
    const run = await setup(page, request);
    await createOrder(page);
    await authenticate(page, "AUTH_DENY", cancel);
    await expect(page.getByRole("status")).toContainText(
      cancel ? "AUTH_CANCELED" : "AUTH_DECLINED",
    );
    const s = await snapshot(request, run);
    expect(s.pg.transactions).toHaveLength(0);
    expect(s.merchant.counts.payment_operations).toBe(0);
  }
});
test("P05 PG 종결 승인 거절은 FAILED_FINAL·원장 0 @orders", async ({
  page,
  request,
}) => {
  const { run, order } = await prepared(page, request, "short", "DECLINE");
  expect((await confirmUi(page)).status()).toBe(202);
  const o = await waitOrder(
    page,
    run,
    order.id,
    (o) => o.operations[0]?.state === "FAILED_FINAL",
  );
  expect(o.payments).toHaveLength(0);
  expect(o.attempts[0].state).toBe("TERMINAL_NO_CHARGE");
  expect((await snapshot(request, run)).pg.transactions).toHaveLength(0);
});
test("P06 종결 비승인 뒤 새 시도는 새 PG 주문번호로 승인 @orders", async ({
  page,
  request,
}) => {
  const { run, order } = await prepared(page, request, "short", "DECLINE");
  await confirmUi(page);
  await waitOrder(
    page,
    run,
    order.id,
    (o) => o.operations[0]?.state === "FAILED_FINAL",
  );
  await page
    .getByRole("button", { name: "주문·결과 확인", exact: true })
    .click();
  await authenticate(page);
  await confirmUi(page);
  const o = await waitOrder(page, run, order.id, (o) => o.state === "ACCEPTED");
  expect(o.attempts).toHaveLength(2);
  expect(o.attempts[0].provider_order_id).not.toBe(
    o.attempts[1].provider_order_id,
  );
  expect((await snapshot(request, run)).pg.transactions).toHaveLength(1);
});
test("P07 실제 기한 경과 뒤 승인 POST는 새 금융 요청 없음 @orders", async ({
  page,
  request,
}) => {
  const { run, order } = await prepared(page, request, "expiry");
  await page.waitForTimeout(15200);
  const r = await api(
    page,
    run,
    "attempts/" + order.attempts[0].id + "/confirm",
    "POST",
    confirmBody(order),
  );
  expect([409, 410]).toContain(r.status);
  expect((await snapshot(request, run)).pg.transactions).toHaveLength(0);
});
test("P08 새로고침과 A→B 조회는 기존 작업·주문 복구 @orders", async ({
  page,
  request,
}) => {
  const { run, order } = await paid(page, request);
  await page.reload();
  await expect(page.getByTestId("order-state")).toContainText("ACCEPTED");
  const r = await api(page, run, "orders/" + order.id, "GET", undefined, "B");
  expect(r.status).toBe(200);
  expect(r.instance).toBe("B");
  expect(r.data.operations[0].id).toBe(order.operations[0].id);
  expect((await snapshot(request, run)).pg.transactions).toHaveLength(1);
});
