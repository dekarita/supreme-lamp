// [F78 §E.1] E2E-UI lane config (the F41 smoke lane keeps its own
// playwright.config.ts untouched - launch-gates.yml runs `playwright test` with
// the DEFAULT config against the built bundle, and replacing it would break that
// gate). This config is what `pnpm run e2e` / .github/workflows/e2e-ui.yml use:
//   * chromium only, headless, ONE worker, retries 1 - the spec asserts UI state,
//     so serial execution keeps the screenshots deterministic;
//   * screenshots on failure + a trace on the first retry (the F78 spec also
//     writes one explicit screenshot per test, see tests/e2e/f78-add-sites.spec.ts);
//   * baseURL http://127.0.0.1:5173 - vite dev, NOT the built bundle, because the
//     spec drives interactive flows (modal typing, toggles, route changes);
//   * TWO web servers: the vite dev server and the mock backend on :7331. That
//     port is not arbitrary: src/lib/api.ts apiBase() resolves every request to
//     `<hostname>:7331` whenever the page is not on 7331/7332/https, which is
//     exactly how the real dashboard reaches payloads/ghrdp-server.ps1. The mock
//     therefore answers at the address the shipped client already uses.
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
      command: "npx vite --host 127.0.0.1 --port 5173 --strictPort",
      port: 5173,
      reuseExistingServer: !process.env.CI,
      timeout: 60000,
    },
  ],
});
