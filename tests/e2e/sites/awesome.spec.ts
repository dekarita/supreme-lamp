// [F92 §4.3] awesome - two lanes, one file:
//   1. the /#/health row for search:awesome (mock envelope, CI, no network);
//   2. the live probe recorded/replayed through tests/e2e/fixtures/awesome.har
//      (nightly e2e-real-sites.yml only - UPDATE_HAR=1 records, a committed
//      fixture replays).
import { test, expect, SITES, UPDATE_HAR, harRoute, liveProbeUrl } from "./_shared";

const site = SITES["awesome"];

test("awesome: /#/health row is awesome.status in CI (mock envelope)", async ({ page }) => {
  test.skip(UPDATE_HAR, "nightly HAR-record lane has no app server by design");
  await page.goto("/#/health");
  await expect(page.getByTestId("health-row-search:awesome")).toHaveAttribute("data-status", site.status, {
    timeout: 20_000,
  });
});

test("awesome: live probe matches the known-good pattern (HAR lane)", async ({ page }) => {
  test.skip(!UPDATE_HAR, "live probes run only in the nightly HAR lane (e2e-real-sites.yml)");
  await harRoute(page, site);
  const resp = await page.goto(liveProbeUrl(site), { waitUntil: "domcontentloaded" });
  expect(resp?.ok(), "HTTP " + (resp?.status() ?? "no-response")).toBeTruthy();
  expect(await page.content()).toMatch(site.expect);
});
