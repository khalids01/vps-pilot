import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/screenshots",
  testMatch: "**/*.shot.ts",
  fullyParallel: false,
  workers: 1,
  reporter: "line",
  outputDir: "test-results/screenshots",
  use: {
    baseURL: "http://127.0.0.1:1430",
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    locale: "en-US",
    timezoneId: "UTC",
    screenshot: "off",
    trace: "off",
    video: "off",
    launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROME },
  },
  webServer: {
    command: "bun run dev --host 127.0.0.1",
    url: "http://127.0.0.1:1430",
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
