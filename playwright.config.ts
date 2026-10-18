import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "test/browser",
  timeout: 45000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"], ["./test/reporter.cjs"]],
  use: {
    baseURL: "https://localhost:8480",
    ignoreHTTPSErrors: true,
    trace: "off",
    screenshot: "off",
    video: "off",
    viewport: { width: 1440, height: 1100 },
  },
});
