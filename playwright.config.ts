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
