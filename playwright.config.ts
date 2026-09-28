// [F41 plan §6.2] Playwright: serves ui/dist over a static server and runs the
// smoke specs against the REAL bundle (browser console assertions included).
// Kept out of the default vitest run; launched by lab job "F41 e2e (playwright)".
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "src/tests/e2e",
  timeout: 60000,
  retries: 0,
  use: {
    baseURL: process.env.F41_BASE_URL || "http://127.0.0.1:4173",
    // [F45-S2-RESUME §1.1] Bound navigation explicitly. Without it a stuck
    // page.goto inherits the whole 60s test timeout and the failure reads as an
    // opaque "Test timeout of 60000ms exceeded" with no pending-call detail.
    // 30s is far beyond a local fixture serving the 557 kB single-file bundle,
    // and it leaves the rest of the budget for the assertions.
    navigationTimeout: 30000,
    trace: "retain-on-failure",
  },
  webServer: process.env.F41_BASE_URL
    ? undefined
    : {
        command: "node scripts/serve-dist.mjs ui/dist",
        port: 4173,
        reuseExistingServer: true,
        timeout: 60000,
      },
});
