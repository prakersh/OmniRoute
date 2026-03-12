import { defineConfig, devices } from "@playwright/test";

const dashboardPort = process.env.DASHBOARD_PORT || process.env.PORT || "20128";
const dashboardBaseUrl = `http://localhost:${dashboardPort}`;
const webServerReadyUrl = `${dashboardBaseUrl}/api/monitoring/health`;

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: ["**/*.spec.ts"],
  fullyParallel: false,
  timeout: 120_000,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: process.env.CI ? "github" : "html",
  use: {
    baseURL: dashboardBaseUrl,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: process.env.CI
      ? "node scripts/run-next-playwright.mjs start"
      : "node scripts/run-next-playwright.mjs dev",
    url: webServerReadyUrl,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
