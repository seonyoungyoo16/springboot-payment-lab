import { test, expect } from "@playwright/test";
import fs from "node:fs";
import crypto from "node:crypto";
import pg from "pg";
import {
  setup,
  lab,
  api,
  createOrder,
  waitOrder,
  prepared,
  paid,
  confirmUi,
  cancelBody,
  snapshot,
  BASE,
} from "./helpers";
test("U01 자동 관찰은 주문·인증·재인증 기한을 갱신하지 않고 장애는 확인 불가 @observer", async ({
  page,
  request,
}) => {
  const { run, order } = await prepared(page, request, "expiry");
  const db = new pg.Client({
    host: "127.0.0.1",
    port: 55452,
    user: "paylab",
    database: "merchant",
  });
  await db.connect();
  try {
    const before = (
      await db.query(
        "SELECT authenticated_at,expires_at FROM auth_contexts WHERE realm_id=$1 AND NOT revoked",
        [run],
      )
    ).rows[0];
    await page.waitForTimeout(7000);
    const after = (
      await db.query(
        "SELECT authenticated_at,expires_at FROM auth_contexts WHERE realm_id=$1 AND NOT revoked",
        [run],
      )
    ).rows[0];
    expect(after).toEqual(before);
    expect((await api(page, run, "orders/" + order.id)).data.expires_at).toBe(
      order.expires_at,
    );
    expect((await snapshot(request, run)).pg.calls).toHaveLength(0);
    await lab(request, "network", { target: "db", blocked: true });
    try {
      await expect(page.locator(".observation-error")).toContainText(
        "확인 불가",
        { timeout: 12000 },
      );
    } finally {
      await lab(request, "network", { target: "db", blocked: false });
    }
    await waitOrder(page, run, order.id, (o) => o.state === "CLOSED", 20000);
    expect((await snapshot(request, run)).pg.transactions).toHaveLength(0);
  } finally {
    await db.end();
  }
});
test("U02 390·768·1440·1800 화면 패널·입력·포커스 사용 @observer", async ({
  page,
  request,
}) => {
  await setup(page, request);
  for (const width of [390, 768, 1440, 1800]) {
    await page.setViewportSize({ width, height: 1050 });
    for (const tab of ["서비스", "PG", "흐름·소스", "데이터", "검증"]) {
      if (width === 390)
        await page.getByRole("tab", { name: tab, exact: true }).click();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth + 1,
        ),
      ).toBe(true);
      if (width === 390)
        expect(await page.locator(".pane:visible").count()).toBe(1);
    }
    if (width === 390)
      await page.getByRole("tab", { name: "서비스", exact: true }).click();
    await page.getByLabel("부분 취소 금액", { exact: true }).fill("2000");
    await page.getByLabel("취소 사유", { exact: true }).focus();
    await expect(page.getByLabel("취소 사유", { exact: true })).toBeFocused();
  }
});
test("U03 승인·취소 실제 단계·시각·스냅샷과 37개 소스 행·해시 일치 @observer", async ({
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
  await waitOrder(
    page,
    run,
    order.id,
    (o) => o.payments[0].canceled_amount === 3000,
  );
  await expect
    .poll(
      async () =>
        (await lab(request, "traces?run=" + run)).filter(
          (t: any) => t.operationId,
        ).length,
    )
    .toBeGreaterThan(1);
  const traces = await lab(request, "traces?run=" + run);
  expect(
    traces.some((t: any) =>
      t.steps.some(
        (s: any) => s.node === "PG DB" && s.snapshot.state === "SUCCEEDED",
      ),
    ),
  ).toBe(true);
  expect(
    traces.some((t: any) =>
      t.steps.some(
        (s: any) => s.node === "DB" && Object.keys(s.snapshot).length > 0,
      ),
    ),
  ).toBe(true);
  const source = await (await request.get("/flow-source.json")).json();
  expect(Object.keys(source)).toHaveLength(37);
  for (const s of Object.values(source) as any[]) {
    const text = fs.readFileSync(s.file, "utf8");
    expect(crypto.createHash("sha256").update(text).digest("hex")).toBe(
      s.sha256,
    );
    expect(
      text
        .split(/\r?\n/)
        .slice(s.line - 1, s.line - 1 + s.snippet.split("\n").length)
        .join("\n"),
    ).toBe(s.snippet);
  }
  await expect(page.getByLabel("실행 기록 선택")).toContainText("작업");
  await page
    .getByLabel("실행 기록 선택")
    .selectOption("op:" + order.operations[0].id);
  if (
    await page
      .getByRole("button", { name: "흐름 일시 정지", exact: true })
      .isVisible()
  )
    await page
      .getByRole("button", { name: "흐름 일시 정지", exact: true })
      .click();
  if (
    await page
      .getByRole("button", { name: "현재 단계 실제 소스 열기", exact: true })
      .isVisible()
  )
    await page
      .getByRole("button", { name: "현재 단계 실제 소스 열기", exact: true })
      .click();
  await expect(page.locator(".source")).toContainText("SHA-256");
  const s = await snapshot(request, run);
  expect(s.merchant.observedAt).toBeTruthy();
  expect(s.pg.observedAt).toBeTruthy();
});
test("U04 실행 중·중복 실행 거부·의도적 실패 진단과 금융 보고서 분리 @observer", async ({
  page,
  request,
}) => {
  await setup(page, request);
  await page
    .getByRole("button", { name: "의도적 실패 진단 실행", exact: true })
    .click();
  await expect(page.getByTestId("probe-state")).toContainText("실행 중");
  const duplicate = await request.post("/lab/probe", {
    headers: { "X-Lab-Control": "1" },
    data: {},
  });
  expect(duplicate.status()).toBe(409);
  await expect
    .poll(async () => (await lab(request, "test-result")).probe.running)
    .toBe(false);
  await page
    .getByRole("button", { name: "검증 결과 새로고침", exact: true })
    .click();
  await expect(page.getByTestId("probe-state")).toContainText("예상된 실패");
  const result = await lab(request, "test-result");
  expect(result.probe.result.expectedFailure).toBe(true);
  expect(result.result.tests.some((t: any) => t.id === "PROBE")).toBe(false);
});
