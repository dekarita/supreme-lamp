// [F103 §3/§6] Reachability banner + persistence BEFORE paint.
//
// Operator: "refresh still looks fake". F102 did persist the rows, but the
// table was painted from a subscription, so the first frame after a reload
// could be empty and the operator read that flash as "the page lost my data".
// Test 1 reloads and counts the rows in the FIRST frame, with no waiting.
// Tests 2-3 cover the banner: hidden while /api/health answers, shown (with
// both origins and the troubleshoot link) when it does not.
import { test, expect } from "@playwright/test";

test.setTimeout(15_000);

test.describe("F103 reachability + no-flash persistence", () => {
  test("1 rows are on screen in the FIRST frame after a reload (no empty flash)", async ({ page }) => {
    await page.goto("/#/collector");
    // the per-button "Click now" (data-testid="collector-click-now-<id>")
    await page.getByTestId("collector-click-now-add-site-open").click();
    await page.waitForTimeout(2000);
    const beforeReload = await page.getByTestId("collector-action-row").count();
    expect(beforeReload).toBeGreaterThan(0);

    await page.reload({ waitUntil: "commit" });
    // No waits, no polling: whatever the FIRST render painted is what the
    // operator sees. A subscription-only read would report 0 here.
    const afterReloadInitial = await page.getByTestId("collector-action-row").count();
    expect(afterReloadInitial).toBe(beforeReload);
    await expect(page.getByTestId("collector-rehydrated")).toBeVisible();
  });

  test("2 the banner stays hidden while /api/health answers", async ({ page }) => {
    await page.goto("/");
    await page.waitForTimeout(1500);
    await expect(page.getByTestId("reachability-banner")).toHaveCount(0);
  });

  test("3 the banner appears on every page when /api/health is blocked, and links to the troubleshooter", async ({ page }) => {
    // Simulate exactly the operator's failure: the request never produces an
    // HTTP response (what a CORS preflight denial looks like to JS).
    await page.route("**/api/health", (route) => route.abort("failed"));
    await page.goto("/#/sessions");
    const banner = page.getByTestId("reachability-banner");
    await expect(banner).toBeVisible({ timeout: 8_000 });
    await expect(banner).toContainText("Backend unreachable from this origin");
    await expect(banner).toContainText("status=0");
    await expect(page.getByTestId("reachability-troubleshoot")).toHaveAttribute("href", "#/collector?troubleshoot=reachability");
  });

  test("4 the troubleshooter panel names the origin pair, the probes and the allowlist", async ({ page }) => {
    await page.goto("/#/collector?troubleshoot=reachability");
    const panel = page.getByTestId("reachability-troubleshoot-panel");
    await expect(panel).toBeVisible({ timeout: 8_000 });
    await expect(panel).toContainText("Current origin");
    await expect(panel).toContainText("Backend URL");
    await expect(panel).toContainText("WebSocket");
    await expect(page.getByTestId("reach-health")).toContainText("status=200");
    await expect(panel).toContainText("X-Dash-Token");
  });
});
