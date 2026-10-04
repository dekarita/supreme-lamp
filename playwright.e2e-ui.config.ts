// [F79 D8] Chromium E2E against the production single-file bundle + F78 mock.
// F41's default config stays untouched. CI selects cached prebuilt Chromium via
// executablePath, so neither CDN downloads nor fake browser-directory paths
// are necessary. Build first (`npm run build`), then `npm run e2e`.
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 60000,
  expect: { timeout: 10000 },
  retries: 1,
  workers: 1,
  fullyParallel: false,
  reporter: [["list"], ["html", { outputFolder: "playwright-report", open: "never" }]],
  use: {
    baseURL: process.env.F78_BASE_URL || "http://127.0.0.1:5173",
    headless: true,
    launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined },
    screenshot: "only-on-failure",
    trace: "on-first-retry",
    navigationTimeout: 30000,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      // The mock backend must be up BEFORE the page loads (CommandBar pulls the
      // source list on mount).
      command: "node tests/e2e/fixtures/mock-backend.mjs",
      port: 7331,
      reuseExistingServer: !process.env.CI,
      timeout: 30000,
    },
    {
      command: "npx vite preview --host 0.0.0.0 --port 5173 --strictPort",
      port: 5173,
      reuseExistingServer: !process.env.CI,
      timeout: 60000,
    },
  ],
});
