import { expect, type Page, type APIRequestContext } from "@playwright/test";
export const BASE = "https://localhost:8480",
  CONTROL = { "X-Lab-Control": "1" },
  PASSWORD = "Payment!2026LongPass";
export async function lab(
  request: APIRequestContext,
  path: string,
  body?: any,
) {
  const r = body
    ? await request.post("/lab/" + path, { headers: CONTROL, data: body })
    : await request.get("/lab/" + path, { headers: CONTROL });
  expect(r.status(), path).toBe(200);
  return r.json();
}
export async function login(page: Page, user = "A") {
  await page.getByLabel("실습 사용자", { exact: true }).selectOption(user);
  await page
    .getByRole("button", { name: "실습 계정 로그인", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText("로그인됨 · " + user);
  await expect(page.locator(".auth-state")).toContainText(user);
}
export async function setup(
  page: Page,
  request: APIRequestContext,
  policy = "short",
  run?: string,
  user = "A",
) {
  run = run || "t-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
  await expect
    .poll(
      async () => {
        try {
          return (await lab(request, "health")).apps;
        } catch {
          return {};
        }
      },
      { timeout: 20000 },
    )
    .toEqual({ A: 200, B: 200 });
  await lab(request, "runs", { run, policy });
  await page.goto("/?run=" + run);
  await expect
    .poll(
      async () => {
        if ((await page.getByRole("status").textContent())?.includes("503"))
          await page
            .getByRole("button", { name: "실험실 다시 연결", exact: true })
            .click();
        return page.getByRole("status").textContent();
      },
      { timeout: 15000 },
    )
    .toMatch(/로그인하세요|복구했습니다/);
  await login(page, user);
  return run;
}
export async function api(
  page: Page,
  run: string,
  path: string,
  method = "GET",
  body?: any,
  node = "A",
  withCsrf = true,
  extra: Record<string, string> = {},
) {
  return page.evaluate(
    async ({ run, path, method, body, node, withCsrf, extra }) => {
      let token = "";
      if (method !== "GET" && withCsrf) {
        const c = await fetch("/api/context", {
          headers: { "X-Lab-Run": run, "X-Lab-Node": node },
        });
        token = (await c.json()).csrf;
      }
      const r = await fetch("/api/" + path, {
        method,
        headers: {
          "Content-Type": "application/json",
          "X-Lab-Run": run,
          "X-Lab-Node": node,
          ...(token ? { "X-CSRF-TOKEN": token } : {}),
          ...extra,
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      return {
        status: r.status,
        data: await r.json(),
        instance: r.headers.get("x-app-instance"),
        retryAfter: r.headers.get("retry-after"),
      };
    },
    { run, path, method, body, node, withCsrf, extra },
  );
}
export async function createOrder(page: Page) {
  const response = page.waitForResponse(
    (r) => r.url().endsWith("/api/orders") && r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "주문 생성", exact: true }).click();
  const r = await response;
  expect([200, 201]).toContain(r.status());
  const order = await r.json();
  await expect(page.getByTestId("order-state")).toContainText("OPEN");
  return order;
}
export async function authenticate(
  page: Page,
  instrument = "APPROVE",
  cancel = false,
) {
  await page
    .getByRole("button", { name: "PG 인증 화면 열기", exact: true })
    .click();
  await page.waitForURL(/https:\/\/localhost:18480\/checkout/);
  await page
    .getByLabel("실습 결제수단", { exact: true })
    .selectOption(instrument);
  await page
    .getByRole("button", {
      name: cancel ? "인증 취소" : "인증하고 상점으로 돌아가기",
      exact: true,
    })
    .click();
  await page.waitForURL((u) => u.origin === BASE && u.pathname === "/");
  await expect(page.getByRole("status")).toContainText("PG 인증");
}
export async function confirmUi(page: Page) {
  const response = page.waitForResponse(
    (r) =>
      /\/api\/attempts\/[^/]+\/confirm$/.test(new URL(r.url()).pathname) &&
      r.request().method() === "POST",
  );
  await page
    .getByRole("button", { name: "결제 확정 요청", exact: true })
    .click();
  return response;
}
export function confirmBody(order: any, overrides: any = {}) {
  const a = order.attempts.at(-1);
  return {
    amount: order.amount,
    currency: order.currency,
    providerOrderId: a.provider_order_id,
    idempotencyKey: crypto.randomUUID(),
    ...overrides,
  };
}
export function cancelBody(order: any, amount = 3000, overrides: any = {}) {
  const p =
    order.payments.find((p: any) => p.id === order.accepted_payment_id) ||
    order.payments[0];
  return {
    amount,
    currency: order.currency,
    reason: "실제 브라우저 취소",
    expectedPaymentVersion: p.version,
    idempotencyKey: crypto.randomUUID(),
    ...overrides,
  };
}
export async function getOrder(page: Page, run: string, id: string) {
  const r = await api(page, run, "orders/" + id);
  expect(r.status).toBe(200);
  return r.data;
}
export async function waitOrder(
  page: Page,
  run: string,
  id: string,
  predicate: (o: any) => boolean,
  timeout = 15000,
) {
  let o: any;
  await expect
    .poll(
      async () => {
        const r = await api(page, run, "orders/" + id);
        if (r.status !== 200) return false;
        o = r.data;
        return predicate(o);
      },
      { timeout, intervals: [150, 250, 500] },
    )
    .toBe(true);
  return o;
}
export async function prepared(
  page: Page,
  request: APIRequestContext,
  policy = "short",
  instrument = "APPROVE",
) {
  const run = await setup(page, request, policy),
    order = await createOrder(page);
  await authenticate(page, instrument);
  return { run, order: await getOrder(page, run, order.id) };
}
export async function paid(
  page: Page,
  request: APIRequestContext,
  policy = "short",
  instrument = "APPROVE",
) {
  const { run, order } = await prepared(page, request, policy, instrument);
  expect((await confirmUi(page)).status()).toBe(202);
  const settled = await waitOrder(
    page,
    run,
    order.id,
    (o) =>
      o.state === "ACCEPTED" &&
      o.payments.length === 1 &&
      o.operations[0].state === "SUCCEEDED",
  );
  return { run, order: settled };
}
export async function snapshot(request: APIRequestContext, run: string) {
  return lab(request, "snapshot?run=" + run);
}
export async function healthy(request: APIRequestContext) {
  await expect
    .poll(async () => (await lab(request, "health")).apps, { timeout: 20000 })
    .toEqual({ A: 200, B: 200 });
}
