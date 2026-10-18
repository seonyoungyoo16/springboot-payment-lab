import { test, expect } from "@playwright/test";
import fs from "node:fs";
import {
  setup,
  lab,
  api,
  createOrder,
  authenticate,
  login,
  waitOrder,
  prepared,
  paid,
  confirmBody,
  cancelBody,
  snapshot,
  BASE,
} from "./helpers";
test("S01 승인·취소·종료·복구 POST의 CSRF·Origin 거부 @security", async ({
  page,
  request,
}) => {
  const { run, order } = await paid(page, request);
  for (const [path, b] of [
    ["attempts/" + order.attempts[0].id + "/confirm", confirmBody(order)],
    ["payments/" + order.payments[0].id + "/cancel", cancelBody(order)],
    ["orders/" + order.id + "/close", { idempotencyKey: crypto.randomUUID() }],
    ["reconciliation/" + crypto.randomUUID() + "/resume", { reason: "확인" }],
  ] as any[])
    expect((await api(page, run, path, "POST", b, "A", false)).status).toBe(
      403,
    );
  const r = await request.post("/api/orders/" + order.id + "/close", {
    headers: { Origin: "https://evil.invalid", "X-Lab-Run": run },
    data: { idempotencyKey: crypto.randomUUID() },
  });
  expect(r.status()).toBe(403);
  expect((await snapshot(request, run)).merchant.reservations).toHaveLength(0);
});
test("S02 타인·다른 실행의 주문·작업·결제 소유권 거부 @security", async ({
  page,
  request,
}) => {
  const { run, order } = await paid(page, request);
  await login(page, "B");
  for (const [path, method, b] of [
    ["orders/" + order.id, "GET"],
    ["operations/" + order.operations[0].id, "GET"],
    [
      "attempts/" + order.attempts[0].id + "/confirm",
      "POST",
      confirmBody(order),
    ],
    ["payments/" + order.payments[0].id + "/cancel", "POST", cancelBody(order)],
  ] as any[])
    expect((await api(page, run, path, method, b)).status).toBe(403);
  const other = await setup(page, request);
  expect((await api(page, other, "orders/" + order.id)).status).toBe(403);
  expect((await snapshot(request, run)).pg.transactions).toHaveLength(1);
});
test("S03 ticket·state 재사용·주문 키 대입·임의 PG URL 거부 @security", async ({
  page,
  request,
  browser,
}) => {
  const run = await setup(page, request),
    order = await createOrder(page);
  for (const b of [
    { provider: "http://127.0.0.1:1" },
    { returnUrl: "https://evil.invalid" },
  ])
    expect(
      (await api(page, run, "orders/" + order.id + "/attempts", "POST", b))
        .status,
    ).toBe(400);
  await page
    .getByRole("button", { name: "PG 인증 화면 열기", exact: true })
    .click();
  await page.waitForURL(/:18480\/checkout/);
  const ticketURL = page.url();
  let returnURL = "";
  page.on("request", (r) => {
    if (new URL(r.url()).pathname === "/payment/return") returnURL = r.url();
  });
  await page
    .getByRole("button", { name: "인증하고 상점으로 돌아가기", exact: true })
    .click();
  await page.waitForURL((u) => u.origin === BASE && u.pathname === "/");
  await expect(page.getByRole("status")).toContainText("PG 인증");
  const again = await page.request.get(ticketURL);
  expect(again.status()).toBe(409);
  const ret = await page.request.get(returnURL, { maxRedirects: 0 });
  expect(ret.headers().location).toContain("RETURN_ALREADY_USED");
  const o = (await api(page, run, "orders/" + order.id)).data;
  expect(
    (
      await api(
        page,
        run,
        "attempts/" + o.attempts[0].id + "/confirm",
        "POST",
        confirmBody(o, { paymentKey: crypto.randomUUID() }),
      )
    ).status,
  ).toBe(400);
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  try {
    const r = await ctx.request.get(returnURL, { maxRedirects: 0 });
    expect(r.headers().location).toContain("pgError=");
  } finally {
    await ctx.close();
  }
  expect((await snapshot(request, run)).pg.transactions).toHaveLength(0);
});
test("S04 정수 범위·소수·통화·긴 사유·HTML 데이터 처리 @security", async ({
  page,
  request,
}) => {
  const { run, order } = await paid(page, request);
  for (const b of [
    { amount: 9007199254740992 },
    { amount: 1.25 },
    { amount: 9223372036854776000 },
    { currency: "USD" },
    { reason: "x".repeat(201) },
  ])
    expect([400, 409]).toContain(
      (
        await api(
          page,
          run,
          "payments/" + order.payments[0].id + "/cancel",
          "POST",
          cancelBody(order, 3000, b),
        )
      ).status,
    );
  const malicious = "<img src=x onerror=window.paymentXss=1>";
  await api(
    page,
    run,
    "payments/" + order.payments[0].id + "/cancel",
    "POST",
    cancelBody(order, 3000, { reason: malicious }),
  );
  await waitOrder(
    page,
    run,
    order.id,
    (o) => o.payments[0].canceled_amount === 3000,
  );
  expect(await page.evaluate(() => (window as any).paymentXss)).toBeUndefined();
  expect((await snapshot(request, run)).pg.transactions).toHaveLength(2);
});
test("S05 A/B 공유 제한·위조 IP 무효·작은 대기열 상한 @security", async ({
  page,
  request,
  browser,
}) => {
  const { run, order } = await prepared(page, request, "capacity");
  await lab(request, "fault", { run, point: "hold-jobs" });
  expect(
    (
      await api(
        page,
        run,
        "attempts/" + order.attempts[0].id + "/confirm",
        "POST",
        confirmBody(order),
      )
    ).status,
  ).toBe(202);
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  try {
    const p2 = await ctx.newPage();
    await setup(p2, request, "capacity", run, "B");
    const o2 = await createOrder(p2);
    await authenticate(p2);
    const ready = (await api(p2, run, "orders/" + o2.id)).data;
    const denied = await api(
      p2,
      run,
      "attempts/" + ready.attempts[0].id + "/confirm",
      "POST",
      confirmBody(ready),
      "B",
    );
    expect(denied.status).toBe(429);
    expect(denied.data.code).toBe("QUEUE_CAPACITY");
    expect(Number(denied.retryAfter)).toBeGreaterThan(0);
  } finally {
    await ctx.close();
  }
  const responses = await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      api(
        page,
        run,
        "attempts/" + order.attempts[0].id + "/confirm",
        "POST",
        confirmBody(order),
        i % 2 ? "B" : "A",
        true,
        { "X-Lab-Client-IP": "spoof-" + i, "X-Forwarded-For": "10.1.1." + i },
      ),
    ),
  );
  expect(
    responses.some((r) => r.status === 429 && Number(r.retryAfter) > 0),
  ).toBe(true);
  expect((await snapshot(request, run)).pg.calls).toHaveLength(0);
  await lab(request, "fault", { run, point: "none" });
  await waitOrder(page, run, order.id, (o) => o.state === "ACCEPTED");
  expect((await snapshot(request, run)).pg.transactions).toHaveLength(1);
});
test("S06 정리된 URL·소스·관찰·브라우저 저장소에 비밀 원문 없음 @security", async ({
  page,
  request,
}) => {
  const { run } = await paid(page, request);
  const storage = await page.evaluate(() => ({
    session: { ...sessionStorage },
    local: { ...localStorage },
    cookie: document.cookie,
    url: location.href,
  }));
  const source = await (await request.get("/flow-source.json")).text();
  const material = JSON.stringify({
    storage,
    snapshot: await snapshot(request, run),
    traces: await lab(request, "traces?run=" + run),
    source,
  });
  const secrets = JSON.parse(fs.readFileSync(".runtime/secrets.json", "utf8"));
  for (const secret of Object.values(secrets) as string[])
    expect(material.includes(secret)).toBe(false);
  expect(storage.cookie).not.toContain("__Host-");
  expect(storage.url).not.toMatch(/ticket=|state=|paymentKey=/);
  expect(JSON.stringify(storage)).not.toMatch(
    /paymentKey|csrf|psp_context|payment_context/,
  );
  expect(material).not.toMatch(
    /"provider_ciphertext"|"provider_key_ciphertext"|"encoded_hash"/,
  );
});
