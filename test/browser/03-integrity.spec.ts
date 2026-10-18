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
  cancelBody,
  snapshot,
} from "./helpers";
test("T01 브라우저 금액·통화·PG 주문번호 변조 거부 @integrity", async ({
  page,
  request,
}) => {
  const { run, order } = await prepared(page, request);
  for (const b of [
    { amount: 1 },
    { currency: "USD" },
    { providerOrderId: "foreign" },
  ])
    expect(
      (
        await api(
          page,
          run,
          "attempts/" + order.attempts[0].id + "/confirm",
          "POST",
          confirmBody(order, b),
        )
      ).status,
    ).toBe(400);
  expect((await snapshot(request, run)).pg.transactions).toHaveLength(0);
});
test("T02 마스터 가격 변경 뒤에도 기존 주문은 가격 스냅샷 유지 @integrity", async ({
  page,
  request,
}) => {
  const { run, order } = await prepared(page, request);
  await lab(request, "price", { run, price: 15000 });
  await confirmUi(page);
  const o = await waitOrder(page, run, order.id, (o) => o.state === "ACCEPTED");
  expect(o.amount).toBe(10000);
  const intent = await api(page, run, "checkout-intents", "POST", {});
  const next = await api(page, run, "orders", "POST", {
    checkoutIntent: intent.data.checkoutIntent,
    quantity: 1,
    product: "LAB_PRODUCT",
    currency: "KRW",
    idempotencyKey: crypto.randomUUID(),
  });
  expect(next.data.amount).toBe(15000);
  expect((await snapshot(request, run)).pg.transactions[0].amount).toBe(10000);
});
test("T03 PG 금액·통화·상점·환경 불일치 응답은 수락 없이 REVIEW @integrity", async ({
  page,
  request,
}) => {
  for (const tamper of ["amount", "currency", "merchant", "environment"]) {
    const { run, order } = await prepared(page, request);
    await lab(request, "psp-control", {
      run,
      controls: { tamper, "hold-webhooks": true },
    });
    await confirmUi(page);
    const o = await waitOrder(
      page,
      run,
      order.id,
      (o) => o.operations[0]?.state === "REVIEW",
    );
    expect(o.accepted_payment_id).toBeNull();
    expect(o.movements).toHaveLength(0);
    expect(
      (await snapshot(request, run)).merchant.cases.length,
    ).toBeGreaterThan(0);
  }
});
test("T04 PG 승인 후 상점 커밋 실패는 부분 반영 없이 재조회 복구 @integrity", async ({
  page,
  request,
}) => {
  const { run, order } = await prepared(page, request);
  await lab(request, "fault", { run, point: "hold-apply-commit" });
  await lab(request, "psp-control", {
    run,
    controls: { "hold-webhooks": true },
  });
  await confirmUi(page);
  await expect
    .poll(async () => (await snapshot(request, run)).pg.transactions.length)
    .toBe(1);
  const before = await snapshot(request, run);
  expect(before.merchant.counts.payments).toBe(0);
  expect(before.merchant.counts.payment_movements).toBe(0);
  expect(before.merchant.counts.payment_outbox).toBe(0);
  await lab(request, "fault", { run, point: "none" });
  const o = await waitOrder(page, run, order.id, (o) => o.state === "ACCEPTED");
  expect(o.movements).toHaveLength(1);
  expect((await snapshot(request, run)).pg.transactions).toHaveLength(1);
});
test("T05 동기 응답·웹훅·대사 경쟁도 원장·outbox 한 번 @integrity", async ({
  page,
  request,
}) => {
  const { run, order } = await paid(page, request);
  const s = await snapshot(request, run);
  await Promise.all(
    Array.from({ length: 5 }, () =>
      lab(request, "deliver", { run, id: s.pg.webhooks[0].id }),
    ),
  );
  await page.waitForTimeout(3500);
  const after = await snapshot(request, run);
  expect(after.merchant.counts.payment_movements).toBe(1);
  expect(after.merchant.counts.payment_outbox).toBe(1);
  expect((await getOrder(page, run, order.id)).operations[0].state).toBe(
    "SUCCEEDED",
  );
});
test("T06 10000 승인 뒤 3000·2000 부분 취소의 양쪽 합계 일치 @integrity", async ({
  page,
  request,
}) => {
  let { run, order } = await paid(page, request);
  for (const amount of [3000, 2000]) {
    expect(
      (
        await api(
          page,
          run,
          "payments/" + order.payments[0].id + "/cancel",
          "POST",
          cancelBody(order, amount),
        )
      ).status,
    ).toBe(202);
    order = await waitOrder(
      page,
      run,
      order.id,
      (o) =>
        o.payments[0].reserved_amount === 0 &&
        o.payments[0].canceled_amount === (amount === 3000 ? 3000 : 5000),
    );
  }
  expect(
    order.payments[0].approved_amount - order.payments[0].canceled_amount,
  ).toBe(5000);
  const s = await snapshot(request, run);
  expect(
    s.pg.transactions
      .filter((x: any) => x.kind === "CANCEL")
      .reduce((n: number, x: any) => n + x.amount, 0),
  ).toBe(5000);
  expect(order.movements).toHaveLength(3);
});
test("T07 영수증 소비 중단·중복 outbox 재생도 최신 취소 버전 유지 @integrity", async ({
  page,
  request,
}) => {
  const { run, order } = await paid(page, request);
  await lab(request, "fault", { run, point: "hold-projection" });
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
  await lab(request, "replay-outbox", { run });
  await lab(request, "fault", { run, point: "none" });
  await expect
    .poll(
      async () => (await snapshot(request, run)).merchant.receipts[0]?.canceled,
    )
    .toBe(3000);
  await lab(request, "replay-outbox", { run });
  await page.waitForTimeout(1200);
  expect((await snapshot(request, run)).merchant.receipts[0].canceled).toBe(
    3000,
  );
});
test("T08 예상 밖 추가 PG 승인도 사실 기록 후 별도 보상 @integrity", async ({
  page,
  request,
}) => {
  const { run, order } = await paid(page, request);
  await lab(request, "duplicate", { run, attemptId: order.attempts[0].id });
  const o = await waitOrder(
    page,
    run,
    order.id,
    (o) =>
      o.payments.length === 2 &&
      o.operations.some(
        (x: any) => x.kind === "COMPENSATE" && x.state === "SUCCEEDED",
      ),
  );
  expect(o.accepted_payment_id).toBe(order.accepted_payment_id);
  expect(
    o.payments.reduce(
      (n: number, p: any) => n + p.approved_amount - p.canceled_amount,
      0,
    ),
  ).toBe(10000);
  expect(o.movements.filter((m: any) => m.kind === "CAPTURE")).toHaveLength(2);
  expect((await snapshot(request, run)).pg.transactions).toHaveLength(3);
});
