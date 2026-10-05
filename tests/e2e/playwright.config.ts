// [F92 §4.1] HAR-replay E2E config for the eleven search sites.
// Two modes, one config:
//   CI (default, F92_MODE=mock): the row assertions run against the built
//     bundle + tests/e2e/fixtures/mock-backend.mjs - no network, deterministic.
//   UPDATE_HAR=1 (nightly e2e-real-sites.yml): the live-probe test of each
//     spec navigates the REAL site through page.routeFromHAR({update:true}),
//     recording fixtures/<site>.har; a later replay run reads the committed
//     fixture instead of the network. The row tests are skipped in this mode
//     (the nightly lane has no app server by design).
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./sites",
  timeout: 30_000,
  retries: process.env.CI ? 1 : 0,
  reporter: [["html", { outputFolder: "playwright-report" }], ["list"]],
  use: {
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    baseURL: process.env.BASE_URL || "http://127.0.0.1:5173",
  },
  workers: process.env.UPDATE_HAR ? 1 : undefined,
  webServer: process.env.UPDATE_HAR
    ? undefined
    : {
        command: "node tests/e2e/fixtures/mock-backend.mjs",
        port: 7331,
        reuseExistingServer: !process.env.CI,
        timeout: 30_000,
      },
});
