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
  confirmBody,
  snapshot,
  BASE,
  login,
} from "./helpers";
test("D01 같은 구매 의도는 다른 키에도 하나, 명시한 새 의도는 별도 @duplicates", async ({
  page,
  request,
}) => {
  const run = await setup(page, request);
  const boot = (await api(page, run, "bootstrap")).data;
  const b = {
    checkoutIntent: boot.checkoutIntent,
    quantity: 1,
    product: "LAB_PRODUCT",
    currency: "KRW",
    idempotencyKey: crypto.randomUUID(),
  };
  const rs = await Promise.all(
    Array.from({ length: 4 }, (_, i) =>
      api(
        page,
        run,
        "orders",
        "POST",
        { ...b, idempotencyKey: crypto.randomUUID() },
        i % 2 ? "B" : "A",
      ),
    ),
  );
  expect(rs.every((r) => [200, 201].includes(r.status))).toBe(true);
  expect(new Set(rs.map((r) => r.data.id)).size).toBe(1);
  const intent = await api(page, run, "checkout-intents", "POST", {});
  const next = await api(page, run, "orders", "POST", {
    ...b,
    checkoutIntent: intent.data.checkoutIntent,
    idempotencyKey: crypto.randomUUID(),
  });
  expect(next.data.id).not.toBe(rs[0].data.id);
  expect((await snapshot(request, run)).merchant.counts.orders).toBe(2);
});
test("D02 동일 승인 키를 A/B에 동시에 보내도 작업과 거래 하나 @duplicates", async ({
  page,
  request,
}) => {
  const { run, order } = await prepared(page, request);
  const b = confirmBody(order),
    path = "attempts/" + order.attempts[0].id + "/confirm";
  const rs = await Promise.all(
    ["A", "B", "A", "B"].map((n) => api(page, run, path, "POST", b, n)),
  );
  expect(rs.every((r) => [200, 202].includes(r.status))).toBe(true);
  expect(new Set(rs.map((r) => r.data.id)).size).toBe(1);
  const o = await waitOrder(page, run, order.id, (o) => o.state === "ACCEPTED");
  expect(o.operations).toHaveLength(1);
  expect((await snapshot(request, run)).pg.transactions).toHaveLength(1);
});
test("D03 같은 키의 금액·통화·대상 변경은 최초 매핑을 보존 @duplicates", async ({
  page,
  request,
}) => {
  const { run, order } = await prepared(page, request);
  const b = confirmBody(order),
    path = "attempts/" + order.attempts[0].id + "/confirm";
  const first = await api(page, run, path, "POST", b);
  for (const changed of [
    { amount: 9999 },
    { currency: "USD" },
    { providerOrderId: "foreign" },
  ])
    expect(
      (await api(page, run, path, "POST", { ...b, ...changed })).status,
    ).toBe(409);
  const o = await waitOrder(page, run, order.id, (o) => o.state === "ACCEPTED");
  expect(o.operations[0].id).toBe(first.data.id);
  expect((await snapshot(request, run)).pg.transactions).toHaveLength(1);
});
test("D04 같은 시도에 서로 다른 승인 키도 canonical 작업 하나 @duplicates", async ({
  page,
  request,
}) => {
  const { run, order } = await prepared(page, request);
  const rs = await Promise.all(
    Array.from({ length: 5 }, (_, i) =>
      api(
        page,
        run,
        "attempts/" + order.attempts[0].id + "/confirm",
        "POST",
        confirmBody(order),
        i % 2 ? "B" : "A",
      ),
    ),
  );
  expect(rs.every((r) => [200, 202].includes(r.status))).toBe(true);
  expect(new Set(rs.map((r) => r.data.id)).size).toBe(1);
  await waitOrder(page, run, order.id, (o) => o.state === "ACCEPTED");
  expect((await snapshot(request, run)).pg.transactions).toHaveLength(1);
});
test("D05 UNKNOWN에 새 키는 기존 작업으로, 새 시도는 차단 @duplicates", async ({
  page,
  request,
}) => {
  const { run, order } = await prepared(page, request);
  await lab(request, "network", { target: "pg", blocked: true });
  try {
    const r = await api(
      page,
      run,
      "attempts/" + order.attempts[0].id + "/confirm",
      "POST",
      confirmBody(order),
    );
    await waitOrder(
      page,
      run,
      order.id,
      (o) => o.operations[0]?.state === "UNKNOWN",
    );
    const again = await api(
      page,
      run,
      "attempts/" + order.attempts[0].id + "/confirm",
      "POST",
      confirmBody(order),
      "B",
    );
    expect(again.data.id).toBe(r.data.id);
    expect(
      (await api(page, run, "orders/" + order.id + "/attempts", "POST", {}))
        .status,
    ).toBe(409);
  } finally {
    await lab(request, "network", { target: "pg", blocked: false });
  }
  await waitOrder(page, run, order.id, (o) => o.state === "ACCEPTED");
  expect((await snapshot(request, run)).pg.transactions).toHaveLength(1);
});
test("D06 두 브라우저 문맥 A/B의 20개 병렬 제출도 금융 효과 하나 @duplicates", async ({
  page,
  request,
  browser,
}) => {
  const { run, order } = await prepared(page, request);
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  try {
    const p2 = await ctx.newPage();
    await p2.goto(BASE + "/?run=" + run);
    await expect(p2.getByRole("status")).toContainText("로그인하세요");
    await login(p2);
    const b = confirmBody(order),
      path = "attempts/" + order.attempts[0].id + "/confirm";
    const rs = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        api(i % 2 ? p2 : page, run, path, "POST", b, i % 2 ? "B" : "A"),
      ),
    );
    expect(rs.every((r) => [200, 202].includes(r.status))).toBe(true);
    expect(new Set(rs.map((r) => r.data.id)).size).toBe(1);
    await waitOrder(page, run, order.id, (o) => o.state === "ACCEPTED");
    const s = await snapshot(request, run);
    expect(s.pg.transactions).toHaveLength(1);
    expect(s.merchant.counts.payment_movements).toBe(1);
    expect(s.merchant.counts.payment_outbox).toBe(1);
  } finally {
    await ctx.close();
  }
});
test("D07 접수 커밋 뒤 실제 브라우저 응답 유실은 같은 키로 복구 @duplicates", async ({
  page,
  request,
}) => {
  const { run, order } = await prepared(page, request);
  const b = confirmBody(order),
    path = "attempts/" + order.attempts[0].id + "/confirm";
  await expect(
    api(page, run, path, "POST", b, "A", true, { "X-Lab-Drop-Response": "1" }),
  ).rejects.toThrow();
  const again = await api(page, run, path, "POST", b, "B");
  expect([200, 202]).toContain(again.status);
  await waitOrder(page, run, order.id, (o) => o.state === "ACCEPTED");
  expect((await snapshot(request, run)).pg.transactions).toHaveLength(1);
});
test("D08 실제 PG 키 안전 기한 뒤에는 변경 재전송 없이 REVIEW @duplicates", async ({
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
    20000,
  );
  await page.waitForTimeout(10500);
  const before = await snapshot(request, run);
  const again = await api(
    page,
    run,
    "attempts/" + order.attempts[0].id + "/confirm",
    "POST",
    confirmBody(order),
  );
  expect(again.data.state).toBe("REVIEW");
  await page.waitForTimeout(1500);
  const after = await snapshot(request, run);
  expect(after.pg.calls).toEqual(before.pg.calls);
  expect(after.pg.transactions).toHaveLength(1);
  expect(
    (await api(page, run, "orders/" + order.id + "/attempts", "POST", {}))
      .status,
  ).toBe(409);
});
