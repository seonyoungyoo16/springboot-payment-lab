import fs from "node:fs";
import assert from "node:assert/strict";
import { chromium, request, expect } from "@playwright/test";
const browser = await chromium.launch(),
  ctx = await browser.newContext({
    ignoreHTTPSErrors: true,
    baseURL: "https://localhost:8480",
    viewport: { width: 1440, height: 1100 },
  }),
  page = await ctx.newPage(),
  r = await request.newContext({
    baseURL: "https://localhost:8480",
    ignoreHTTPSErrors: true,
  }),
  headers = { "X-Lab-Control": "1" };
try {
  await page.goto("/?run=runner-" + Date.now());
  if (!process.argv.includes("--read")) {
    await page
      .getByRole("button", { name: "브라우저 전체 검증 실행", exact: true })
      .click();
    await page
      .getByTestId("runner-state")
      .filter({ hasText: "실행 중" })
      .waitFor();
    assert.equal(
      (await r.post("/lab/test", { headers, data: {} })).status(),
      409,
    );
  }
  const deadline = Date.now() + 600000;
  let last = 0,
    result;
  while (Date.now() < deadline) {
    const s = await (await r.get("/lab/test-result", { headers })).json();
    const n = s.result?.tests?.length || 0;
    if (n !== last) {
      console.log("Actual browser suite " + n + "/64");
      last = n;
    }
    if (!s.running) {
      result = s.result;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  assert.equal(result?.status, "passed");
  assert.equal(result.tests.length, 64);
  assert(result.tests.every((t) => t.status === "passed"));
  fs.mkdirSync("docs/verification", { recursive: true });
  fs.writeFileSync(
    "docs/verification/browser.json",
    JSON.stringify(result, null, 2) + "\n",
  );
  await page
    .getByRole("button", { name: "검증 결과 새로고침", exact: true })
    .click();
  await expect(page.getByTestId("runner-state")).toContainText("통과");
  console.log(
    "Browser UI initiated full real suite: 64 passed; duplicate launch rejected",
  );
} finally {
  await r.dispose();
  await browser.close();
}
