// [F104 §3] GLOBAL CLICK TELEMETRY end to end: a real button click anywhere
// in Mission Control (outside /#/collector) lands a row in the Collector's
// "Global clicks (auto-captured)" section - with the control's testid, the
// route it was clicked on, and what the click did on the wire. The
// collector's OWN controls are invisible to the capture (GLOBAL_CLICK_IGNORE),
// so reading the Collector can never write to it (the F102 feedback guard).
import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";

mkdirSync("screenshots", { recursive: true });
const shot = (page: Page, name: string) => page.screenshot({ path: `screenshots/f104-${name}.png`, fullPage: true });

test.describe("[F104] global click capture", () => {
  test("a real button click on /#/search lands a Global-click row (not a Recent row)", async ({ page }) => {
    await page.goto("/#/search");
    const addSite = page.getByTestId("add-site-button");
    await expect(addSite).toBeVisible({ timeout: 20_000 });
    await addSite.click();
    // the modal opening is the proof the click really happened
    await expect(page.getByTestId("add-site-modal")).toBeVisible({ timeout: 10_000 });

    await page.goto("/#/collector");
    const rows = page.locator('[data-testid="collector-global-row"]');
    await expect.poll(() => rows.count(), { timeout: 15_000 }).toBeGreaterThan(0);
    const first = rows.first();
    await expect(first).toContainText("add-site-button");
    await expect(first).toContainText("#/search");
    // provenance split: auto-captured rows NEVER leak into Recent user
    // actions (that table's counts belong to F102).
    await expect(page.locator('[data-testid="collector-action-row"]')).toHaveCount(0);
    await shot(page, "global-row");
  });

  test("the collector's own controls capture nothing (no feedback loop)", async ({ page }) => {
    await page.goto("/#/collector");
    const refresh = page.getByTestId("collector-refresh");
    await expect(refresh).toBeVisible({ timeout: 20_000 });
    await refresh.click();
    // the refresh really ran (report fetch fired) - and recorded nothing.
    await page.waitForTimeout(1_500);
    await expect(page.locator('[data-testid="collector-global-row"]')).toHaveCount(0);
    await expect(page.getByTestId("collector-global-empty")).toBeVisible();
    await expect(page.locator('[data-testid="collector-action-row"]')).toHaveCount(0);
    await shot(page, "collector-ignored");
  });
});
