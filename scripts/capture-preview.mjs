import fs from "node:fs";
import { chromium, request } from "@playwright/test";
import { paid, api, cancelBody, waitOrder } from "../test/browser/helpers.ts";
const browser = await chromium.launch(),
  ctx = await browser.newContext({
    ignoreHTTPSErrors: true,
    baseURL: "https://localhost:8480",
    viewport: { width: 1800, height: 1100 },
  }),
  page = await ctx.newPage(),
  r = await request.newContext({
    baseURL: "https://localhost:8480",
    ignoreHTTPSErrors: true,
    baseURL: "https://localhost:8480",
  });
try {
  const { run, order } = await paid(page, r, "normal");
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
  await page.waitForTimeout(2200);
  fs.mkdirSync("docs/screenshots", { recursive: true });
  for (const width of [1800, 1440, 768, 390]) {
    await page.setViewportSize({ width, height: 1100 });
    await page.screenshot({
      path: "docs/screenshots/backend-" + width + ".png",
      fullPage: true,
    });
    const over = await page.evaluate(() =>
      [...document.querySelectorAll("*")]
        .filter((e) => {
          const b = e.getBoundingClientRect();
          return b.width > 0 && (b.right > innerWidth + 1 || b.left < -1);
        })
        .slice(0, 10)
        .map((e) => ({
          tag: e.tagName,
          class: e.className,
          width: e.getBoundingClientRect().width,
        })),
    );
    console.log(JSON.stringify({ width, overflow: over }));
  }
  await page.setViewportSize({ width: 390, height: 1100 });
  await page.getByRole("tab", { name: "흐름·소스", exact: true }).click();
  await page.screenshot({
    path: "docs/screenshots/backend-mobile-flow.png",
    fullPage: true,
  });
} finally {
  await r.dispose();
  await browser.close();
}
