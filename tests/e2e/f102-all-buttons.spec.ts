// [F102 §3] Every Collector "Click now" is a REAL DOM click (issue #159).
//
// F101 answered 15 of 18 buttons with a route-probe / "not-mounted" row and
// the operator saw 32 identical "no replay handler" warn rows. Here each of the
// 18 known buttons is clicked from /#/collector and must come back with a
// recorded row whose verdict is a real ok|warn|fail, whose elapsed time is a
// measurement (> 0), and whose `data-via` says how the click went:
//   dom-click    - the runner navigated to the host page, ran the button's
//                  preconditions and clicked the element (the default)
//   not-rendered - a state-gated button that legitimately is not on screen
//                  (ws-reconnect needs a DISCONNECTED socket, mirror-disable an
//                  ENABLED mirror) - recorded as such, never as a success
//   disabled     - rendered but disabled (search-cancel once the search ended)
// Rows must also survive a page refresh (zustand persist, "Rehydrated from
// localStorage" chip), and "Click every button" must record 18 DIFFERENT rows.
import { test, expect, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";

const MOCK = "http://127.0.0.1:7331";

const BUTTONS = [
  "add-site-open",
  "add-site-save",
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
  "collector-run",
  "collector-refresh",
  "collector-download-json",
  "preview-open-source",
  "stream-watch-rdp",
] as const;

/** How each click may legitimately end against the mock backend. Everything
 *  the mock can render is clicked for real (dom-click). */
const ALLOWED_VIA: Record<(typeof BUTTONS)[number], string[]> = {
  "add-site-open": ["dom-click"],
  "add-site-save": ["dom-click"],
  "lab-refetch": ["dom-click"],
  "search-submit": ["dom-click"],
  // Cancel is enabled only while the probe search runs (the test slows the
  // status poll down to a real search's pace, see below).
  "search-cancel": ["dom-click"],
  "card-open-rdp": ["dom-click"],
  "card-fetch": ["dom-click"],
  "card-download-rdp": ["dom-click"],
  "card-open-lab": ["dom-click"],
  "diag-test-launch": ["dom-click"],
  "selftest-run": ["dom-click"],
  // state-gated: rendered only for a DISCONNECTED socket / an ENABLED mirror
  "ws-reconnect": ["dom-click", "not-rendered"],
  "mirror-disable": ["dom-click", "not-rendered"],
  "collector-run": ["dom-click"],
  "collector-refresh": ["dom-click"],
  "collector-download-json": ["dom-click"],
  "preview-open-source": ["dom-click"],
  "stream-watch-rdp": ["dom-click"],
};

async function shot(page: Page, name: string) {
  mkdirSync("screenshots", { recursive: true });
  await page.screenshot({ path: `screenshots/f102-${name}.png`, fullPage: true });
}

function rowFor(page: Page, id: string) {
  return page.locator(`[data-testid="collector-action-row"][data-button-id="${id}"]`).first();
}

test.describe("[F102] Collector buttons are real DOM clicks", () => {
  test.afterAll(async ({ request }) => {
    // add-site-save really saves "example.com" into the mock registry; remove
    // it so the alphabetically-later specs see the seeded site list unchanged.
    await request.delete(`${MOCK}/api/f58/sources/example-com`).catch(() => undefined);
  });

  for (const id of BUTTONS) {
    test(`Click now "${id}" records a real result (not a fake route-probe)`, async ({ page }) => {
      if (id === "search-cancel") {
        // The mock completes a search on its first status poll; a real
        // 11-adapter search runs for seconds. Hold the status answers so the
        // search is still running when the runner reaches Cancel.
        await page.route("**/api/search/status**", async (route) => {
          await new Promise((r) => setTimeout(r, 4_000));
          await route.continue().catch(() => undefined);
        });
      }
      await page.goto("/#/collector");
      await expect(page.getByTestId("collector-known-buttons")).toBeVisible();
      await page.click(`[data-testid="click-now-${id}"]`);

      const row = rowFor(page, id);
      await expect(row).toBeVisible({ timeout: 50_000 });
      // the runner comes back to the page the click started from
      await expect(page).toHaveURL(/#\/collector$/);

      const verdict = ((await row.getByTestId("verdict").textContent()) || "").trim();
      expect(verdict).toMatch(/^(ok|warn|fail)$/i);
      const text = (await row.textContent()) || "";
      expect(text).not.toContain("no replay handler");
      expect(text).not.toContain("route-probe");
      const elapsed = Number(((await row.getByTestId("elapsed-ms").textContent()) || "").trim());
      expect(elapsed).toBeGreaterThan(0);
      const via = await row.getAttribute("data-via");
      expect(ALLOWED_VIA[id]).toContain(via);
      if (via === "dom-click") {
        // a real click names what it did: a request it fired or a DOM effect
        await expect(row.locator("xpath=following-sibling::tr[1]")).toContainText("real click");
      }
      // the deep row is opened on return and names the real verdict reason
      await expect(page.getByTestId("collector-verdict")).toBeVisible();
      await shot(page, id);
    });
  }

  test("records survive page refresh (zustand persist + Rehydrated chip)", async ({ page }) => {
    await page.goto("/#/collector");
    const rows = page.locator('[data-testid="collector-action-row"]');
    // one click at a time: each recorded row re-lays-out the page above the
    // buttons table, so a second click must wait for the first row
    await page.click('[data-testid="click-now-collector-refresh"]');
    await expect.poll(() => rows.count(), { timeout: 30_000 }).toBe(1);
    await page.click('[data-testid="click-now-add-site-open"]');
    await expect.poll(() => rows.count(), { timeout: 30_000 }).toBe(2);
    await expect(page).toHaveURL(/#\/collector$/);
    const ids = await rows.evaluateAll((els) => els.map((e) => e.getAttribute("data-action-id")));

    await page.reload();
    await expect(page.getByTestId("collector-rehydrated")).toContainText("Rehydrated from localStorage · 2 actions");
    await expect(rows).toHaveCount(2);
    expect(await rows.evaluateAll((els) => els.map((e) => e.getAttribute("data-action-id")))).toEqual(ids);
    const persisted = await page.evaluate(() => {
      const raw = window.localStorage.getItem("f102-collector-actions-v1");
      return raw ? (JSON.parse(raw).state?.actions || []).length : -1;
    });
    expect(persisted).toBe(2);
    await shot(page, "refresh-survived");
  });

  test("Click every button records 18 DIFFERENT real rows", async ({ page }) => {
    test.setTimeout(300_000);
    await page.goto("/#/collector");
    await page.click('[data-testid="collector-click-all"]');
    const rows = page.locator('[data-testid="collector-action-row"]');
    await expect
      .poll(async () => new Set(await rows.evaluateAll((els) => els.map((e) => e.getAttribute("data-button-id")))).size, {
        timeout: 280_000,
        intervals: [1_000],
      })
      .toBe(BUTTONS.length);
    await expect(page).toHaveURL(/#\/collector$/);
    const summary = await rows.evaluateAll((els) =>
      els.map((e) => ({
        id: e.getAttribute("data-button-id"),
        via: e.getAttribute("data-via"),
        verdict: (e.querySelector('[data-testid="verdict"]')?.textContent || "").trim(),
        elapsed: Number((e.querySelector('[data-testid="elapsed-ms"]')?.textContent || "").trim()),
      }))
    );
    expect(summary).toHaveLength(BUTTONS.length);
    for (const r of summary) {
      expect(r.verdict).toMatch(/^(ok|warn|fail)$/);
      expect(r.elapsed).toBeGreaterThan(0);
    }
    expect(summary.filter((r) => r.via === "dom-click").length).toBeGreaterThanOrEqual(14);
    await expect(page.getByTestId("collector-notice")).toHaveCount(0);
    await shot(page, "click-every-button");
  });
});
