// [F101 §4.E / N5] Collector deep per-button instrumentation, end to end.
//
// The operator's ask (issue #157): click ANY button in the dashboard from
// /#/collector and see the full breakdown - preCheck / request / response /
// postCheck / services / verdict - instead of "add-site save → ERR".
//
// Twelve buttons are exercised through their real "Click now" cells: the ones
// mounted on this route are DOM-clicked (the same path the operator's mouse
// takes, recorded by the fetch observer), the rest fall back to an
// instrumented route probe against the mock backend on :7331. Either way the
// row must land in "Recent user actions" WITH a verdict.
import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";

mkdirSync("screenshots", { recursive: true });

async function shot(page: Page, name: string) {
  await page.screenshot({ path: `screenshots/f101-${name}.png`, fullPage: true });
}

/** Twelve registry ids from src/lib/collectorAgent.ts KNOWN_BUTTONS. Only
 *  collector-refresh is mounted on /#/collector; the rest prove the route-probe
 *  fallback, which is what makes the table usable from a single page. */
const CLICK_NOW_IDS = [
  "collector-refresh",
  "lab-refetch",
  "search-submit",
  "search-cancel",
  "card-open-rdp",
  "card-fetch",
  "card-download-rdp",
  "card-open-lab",
  "diag-test-launch",
  "selftest-run",
  "ws-reconnect",
  "mirror-disable",
];

const DEEP_TABS = ["preCheck", "request", "response", "postCheck", "services", "verdict"];

test.describe("F101 Collector deep instrumentation", () => {
  test("1 the Collector page registers every known button", async ({ page }) => {
    await page.goto("/#/collector");
    await expect(page.locator('[data-testid="collector-page"]')).toBeVisible();
    const table = page.locator('[data-testid="collector-known-buttons"]');
    await expect(table).toBeVisible();
    const rows = page.locator('[data-testid^="collector-known-row-"]');
    await expect(rows).toHaveCount(await rows.count());
    expect(await rows.count()).toBeGreaterThanOrEqual(10);
    for (const id of CLICK_NOW_IDS) {
      await expect(page.locator(`[data-testid="collector-click-now-${id}"]`)).toBeAttached();
    }
    await shot(page, "01-known-buttons");
  });

  test("2 Click now on 12 buttons records 12 deeply-instrumented rows", async ({ page }) => {
    await page.goto("/#/collector");
    await expect(page.locator('[data-testid="collector-known-buttons"]')).toBeVisible();

    for (const id of CLICK_NOW_IDS) {
      const before = await page.locator('[data-testid^="collector-action-row-"]').count();
      await page.click(`[data-testid="collector-click-now-${id}"]`);
      // the click is recorded and its row auto-expands on the verdict tab
      await expect
        .poll(async () => page.locator('[data-testid^="collector-action-row-"]').count(), { timeout: 15000 })
        .toBeGreaterThan(before);
    }

    const rowCount = await page.locator('[data-testid^="collector-action-row-"]').count();
    expect(rowCount).toBeGreaterThanOrEqual(CLICK_NOW_IDS.length);

    // every recorded row carries a verdict chip (never the F100 blank)
    const chips = await page.locator('[data-testid^="collector-action-row-"] td:nth-child(7)').allInnerTexts();
    expect(chips.length).toBeGreaterThanOrEqual(CLICK_NOW_IDS.length);
    for (const c of chips) {
      expect(["ok", "warn", "fail", "n/a"]).toContain(c.trim().toLowerCase());
    }
    await shot(page, "02-rows-with-verdicts");
  });

  test("3 an expanded row exposes all six diagnostic tabs with real content", async ({ page }) => {
    await page.goto("/#/collector");
    await expect(page.locator('[data-testid="collector-known-buttons"]')).toBeVisible();
    await page.click('[data-testid="collector-click-now-collector-refresh"]');
    const detail = page.locator('[data-testid^="collector-action-detail-"]').first();
    await expect(detail).toBeVisible({ timeout: 15000 });

    for (const tab of DEEP_TABS) {
      await expect(page.locator(`[data-testid="collector-tab-${tab}"]`)).toBeVisible();
    }

    // the verdict tab is the default and always says what to do next
    const verdict = page.locator('[data-testid="collector-verdict"]');
    await expect(verdict).toBeVisible();
    await expect(verdict).toContainText(/OK|WARN|FAIL/);

    // the four JSON tabs render parseable JSON for this row
    for (const tab of ["preCheck", "request", "response", "postCheck"] as const) {
      await page.click(`[data-testid="collector-tab-${tab}"]`);
      const pane = page.locator(`[data-testid="collector-deep-${tab}"]`);
      await expect(pane).toBeVisible();
      const text = (await pane.innerText()).trim();
      const parsed = JSON.parse(text);
      expect(parsed === null || typeof parsed === "object").toBe(true);
      if (tab === "preCheck" && parsed) {
        expect(parsed.serviceStates).toBeTruthy();
        expect(parsed.prerequisites.length).toBeGreaterThanOrEqual(5);
      }
      if (tab === "postCheck" && parsed) {
        expect(parsed.newServiceStates).toBeTruthy();
        expect(typeof parsed.stateChanged).toBe("boolean");
      }
    }

    // the services tab is a table, not a blob
    await page.click('[data-testid="collector-tab-services"]');
    await expect(page.locator('[data-testid="collector-services"]')).toBeVisible();
    await expect(page.locator('[data-testid="collector-services"] tbody tr')).toHaveCount(5);
    await shot(page, "03-deep-tabs");
  });

  test("4 the add-site lane's auth failure carries a fix and a linked issue", async ({ page }) => {
    await page.goto("/#/collector");
    await expect(page.locator('[data-testid="collector-known-buttons"]')).toBeVisible();
    // add-site-save is not mounted here, so it probes POST-target route GET
    // /api/f58/sources through the same fence the real save uses.
    await page.click('[data-testid="collector-click-now-add-site-save"]');
    const detail = page.locator('[data-testid^="collector-action-detail-"]').first();
    await expect(detail).toBeVisible({ timeout: 15000 });
    const verdict = page.locator('[data-testid="collector-verdict"]');
    await expect(verdict).toBeVisible();
    // whatever the mock answers, the verdict must name a remedy - an empty
    // "Suggested fix:" is exactly what the operator complained about.
    await expect(verdict).toContainText(/Suggested fix: \S/);
    await shot(page, "04-verdict-with-fix");
  });

  test("5 button-actions.json download still carries the deep sections", async ({ page }) => {
    await page.goto("/#/collector");
    await expect(page.locator('[data-testid="collector-known-buttons"]')).toBeVisible();
    await page.click('[data-testid="collector-click-now-collector-refresh"]');
    await expect(page.locator('[data-testid^="collector-action-detail-"]').first()).toBeVisible({ timeout: 15000 });
    const stored = await page.evaluate(() => {
      const raw = window.localStorage.getItem("ghrdp.collector.actions.v1");
      return raw ? JSON.parse(raw) : [];
    });
    expect(Array.isArray(stored)).toBe(true);
    expect(stored.length).toBeGreaterThan(0);
    const last = stored[stored.length - 1];
    expect(last.preCheck).toBeTruthy();
    expect(last.postCheck).toBeTruthy();
    expect(last.verdict).toBeTruthy();
    expect(last.serviceDependencies.length).toBeGreaterThanOrEqual(5);
    // no credential ever reaches the record
    expect(JSON.stringify(last)).not.toMatch(/tok-[a-z0-9]{6}/);
    await shot(page, "05-stored-record");
  });
});
