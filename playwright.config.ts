import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/browser",
  testMatch: "**/*.e2e.ts",
  fullyParallel: true,
  use: {
    baseURL: "http://127.0.0.1:1430",
    viewport: { width: 1366, height: 900 },
    launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROME },
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "bun run dev --host 127.0.0.1",
    url: "http://127.0.0.1:1430",
    reuseExistingServer: true,
  },
});
