// [F78 §E.3] Twenty E2E assertions for the stored-website Lab Mode lane, run by
// `pnpm run e2e` (playwright.e2e-ui.config.ts) against the built UI plus
// the mock backend on :7331 (tests/e2e/fixtures/mock-backend.mjs).
// [F79] Use the shipped HashRouter URLs, not unimplemented pathname routes.
//
// One screenshot per test is written to screenshots/f78-<test>.png; e2e-ui.yml
// uploads that directory as the "screenshots-<sha>" artifact (14 days), which is the
// operator's visual confirmation path when a run goes red.
import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";

mkdirSync("screenshots", { recursive: true });

async function shot(page: Page, name: string) {
  await page.screenshot({ path: `screenshots/f78-${name}.png`, fullPage: true });
}

// [#223] ELEVEN entries, not nine. "Health" (F92 self-test dashboard, /#/health)
// and "Collector" (F99 live feature probes, /#/collector) were added to NAV after
// this pin was written, so it drifted and test 1 failed a deep-equality compare on
// every run — `f78-add-sites.spec.ts ✘=4` in runs 38027291171 → 38057454362, and
// finally NAMED at f78-add-sites.spec.ts:78 by the F79-E2E-FAIL annotation added
// on 5146952. This is a stale expectation, not a UI regression: AppShell's own
// comment already calls it "the locked 11-entry list", and both entries are real
// features with real routes.
//
// Source of truth (read, not guessed):
//   order  -> src/components/layout/AppShell.tsx  `const NAV: NavItem[]`
//   labels -> src/i18n/en.json  nav.* with sidebar.* winning where labelKey is set
//             (sidebar.search/health/collector = "Search"/"Health"/"Collector")
//   count  -> one <span> per anchor: prefsStore defaults `collapsed: false`, so
//             the collapsed-mode second sr-only span is not rendered.
const SIDEBAR_ORDER = ["Overview", "Search", "Sessions", "Connections", "Keys & Secrets", "File Explorer", "Mirror", "Telemetry", "Health", "Collector", "Settings"];

async function seedTheme(page: Page, theme: "dark" | "light") {
  await page.addInitScript((t) => {
    window.localStorage.setItem("ghrdp:theme", JSON.stringify({ state: { theme: t }, version: 0 }));
  }, theme);
}

/** Type a query and submit it, then wait for the results surface + Your sites. */
async function runQuery(page: Page, query: string) {
  await page.goto("/#/search");
  await page.fill('[id="f56.search.query"]', query);
  await page.press('[id="f56.search.query"]', "Enter");
  await expect(page.locator('[id="f78.search.yourSitesRow"]')).toBeVisible();
}

// [WP-09 / #203] Popup isolation for the mirror click (test 17): the row's
// REAL third-party URL is fulfilled with a stub before the click, and every
// page the test opens besides the fixture page is closed in a finally - no
// public-host wait, no wedged teardown. Same helpers as f86/f91.
async function isolateExternalNetwork(page: Page): Promise<void> {
  await page.context().route("**/*", async (route) => {
    const url = route.request().url();
    let host = "";
    try {
      host = new URL(url).hostname;
    } catch {
      host = "";
    }
    const isLocal = host === "127.0.0.1" || host === "localhost" || host === "[::1]" || host === "";
    try {
      if (isLocal) return void (await route.continue());
      return void (await route.fulfill({
        status: 200,
        contentType: "text/html",
        body: "<!doctype html><meta charset=utf-8><title>ghrdp e2e stub</title><p>stub",
      }));
    } catch {
      try {
        await route.continue();
      } catch {
        /* a route that raced a page close cannot fail the lane */
      }
    }
  });
}

/** Close every page in the context except the fixture page (F203-c). */
async function closeExtraPages(page: Page): Promise<void> {
  for (const other of page.context().pages()) {
    if (other === page) continue;
    try {
      await other.close({ runBeforeUnload: false });
    } catch {
      /* a page that is already gone is the goal, not a failure */
    }
  }
}

test.describe("F78 stored-website Lab Mode", () => {
  test("1 sidebar order is the locked nine entries", async ({ page }) => {
    await page.goto("/");
    const labels = await page.locator('[data-testid="sidebar"] nav a span').allInnerTexts();
    expect(labels.map((l) => l.trim())).toEqual(SIDEBAR_ORDER);
    await shot(page, "01-sidebar-order");
  });

  test("2 clicking Search routes to /search", async ({ page }) => {
    await page.goto("/");
    await page.click('[id="f56.search.nav"]');
    await expect(page).toHaveURL(/\/search$/);
    await shot(page, "02-search-route");
  });

  test("3 the command bar renders", async ({ page }) => {
    await page.goto("/#/search");
    await expect(page.locator('[id="f56.search.commandBar"]')).toBeVisible();
    await expect(page.locator('[id="f56.search.query"]')).toBeVisible();
    await shot(page, "03-command-bar");
  });

  test("4 typing a query and pressing Enter submits to /api/search", async ({ page }) => {
    await page.goto("/#/search");
    const request = page.waitForRequest((r) => r.url().includes("/api/search") && r.method() === "POST");
    await page.fill('[id="f56.search.query"]', "tls");
    await page.press('[id="f56.search.query"]', "Enter");
    expect((await request).method()).toBe("POST");
    await shot(page, "04-submit");
  });

  test("5 the + Add site button is visible next to the search bar", async ({ page }) => {
    await page.goto("/#/search");
    await expect(page.locator('[id="f78.search.addSite"]')).toBeVisible();
    await shot(page, "05-add-site-button");
  });

  test("6 clicking + Add site opens the modal", async ({ page }) => {
    await page.goto("/#/search");
    await page.click('[id="f78.search.addSite"]');
    await expect(page.locator('[id="f78.addSite.modal"]')).toBeVisible();
    await shot(page, "06-modal-open");
  });

  test("7 the modal has Name, Base URL and Save", async ({ page }) => {
    await page.goto("/#/search");
    await page.click('[id="f78.search.addSite"]');
    await expect(page.locator('[id="f78.addSite.name"]')).toBeVisible();
    await expect(page.locator('[id="f78.addSite.url"]')).toBeVisible();
    await expect(page.locator('[id="f78.addSite.save"]')).toBeVisible();
    await shot(page, "07-modal-fields");
  });

  test("8 an http:// URL produces an inline error and saves nothing", async ({ page }) => {
    await page.goto("/#/search");
    await page.click('[id="f78.search.addSite"]');
    await page.fill('[id="f78.addSite.name"]', "Python docs");
    await page.fill('[id="f78.addSite.url"]', "http://docs.python.org");
    await page.click('[id="f78.addSite.save"]');
    await expect(page.locator('[id="f78.addSite.error"]')).toContainText(/https/i);
    await expect(page.locator('[id="f78.addSite.modal"]')).toBeVisible();
    await shot(page, "08-http-refused");
  });

  test("9 a valid HTTPS URL closes the modal and toasts", async ({ page }) => {
    await page.goto("/#/search");
    await page.click('[id="f78.search.addSite"]');
    await page.fill('[id="f78.addSite.name"]', "Python docs");
    await page.fill('[id="f78.addSite.url"]', "https://docs.python.org/3");
    await page.click('[id="f78.addSite.save"]');
    await expect(page.locator('[id="f78.addSite.modal"]')).toHaveCount(0);
    await expect(page.locator('#toasts')).toContainText(/added to Your sites/i);
    await shot(page, "09-saved-toast");
  });

  test("10 Your sites row renders the two mock sources", async ({ page }) => {
    await runQuery(page, "tls");
    await expect(page.locator('[data-testid="your-site-card-docs-python-org"]')).toBeVisible();
    await expect(page.locator('[data-testid="your-site-card-si-wikipedia-org"]')).toBeVisible();
    await shot(page, "10-your-sites-row");
  });

  test("11 each card shows its hostname and a Deep-inspect CTA", async ({ page }) => {
    await runQuery(page, "tls");
    const card = page.locator('[id="f78.search.siteCard.docs-python-org"]');
    await expect(card).toContainText("docs.python.org");
    await expect(page.locator('[id="f78.search.siteDeepInspect.docs-python-org"]')).toContainText(/Deep-inspect/i);
    await shot(page, "11-card-cta");
  });

  test("12 clicking a card routes to /search/lab/<id>?q=<query>", async ({ page }) => {
    await runQuery(page, "tls");
    await page.click('[id="f78.search.siteDeepInspect.docs-python-org"]');
    await expect(page).toHaveURL(/\/search\/lab\/docs-python-org\?q=tls/);
    await shot(page, "12-card-navigates");
  });

  test("13 the Lab page title shows the site's title and hostname", async ({ page }) => {
    await page.goto("/#/search/lab/docs-python-org?q=tls");
    await expect(page.locator('[id="f78.lab.title"]')).toContainText("Python 3 documentation");
    await expect(page.locator('[id="f78.lab.hostname"]')).toContainText("docs.python.org");
    // never an auto fan-out query for a stored site
    expect(page.url()).toContain("q=tls");
    await shot(page, "13-lab-title");
  });

  test("14 matching links are listed and highlighted", async ({ page }) => {
    await page.goto("/#/search/lab/docs-python-org?q=tls");
    const matched = page.locator('[data-testid="lab-link-row"][data-matches="true"]');
    await expect(matched).toHaveCount(1);
    await expect(matched.first()).toContainText("TLS");
    await expect(page.locator('[id="f78.lab.matchCount"]')).toContainText("1 of 6 links match");
    await shot(page, "14-matched-links");
  });

  test("15 non-matching links live in the collapsed All links section", async ({ page }) => {
    await page.goto("/#/search/lab/docs-python-org?q=tls");
    await expect(page.locator('[id="f78.lab.allLinksList"]')).toHaveCount(0);
    await page.click('[id="f78.lab.allLinks"]');
    await expect(page.locator('[id="f78.lab.allLinksList"]')).toContainText("asyncio.html");
    await shot(page, "15-collapsed-section");
  });

  test("16 the Matches first toggle switches between the matching set and every link", async ({ page }) => {
    await page.goto("/#/search/lab/docs-python-org?q=tls");
    await expect(page.locator('[data-testid="lab-link-row"]')).toHaveCount(1);
    await page.click('[id="f78.lab.matchesFirst"]');
    await expect(page.locator('[data-testid="lab-link-row"]')).toHaveCount(6);
    await page.click('[id="f78.lab.matchesFirst"]');
    await expect(page.locator('[data-testid="lab-link-row"]')).toHaveCount(1);
    await shot(page, "16-matches-first-toggle");
  });

  // [F84 §2.3 -> F91 §B.2] The link is still no new-tab anchor: the element
  // contract stays a BUTTON without href/target. Since F91 the click itself is
  // MIRROR MODE - the local tab is the design and the RDP half rides
  // POST /api/launcher/queue - so the assertion follows the mirror contract:
  // the queue POST really fires (a silent local-only fallback fails here) and
  // no retired anchor behaviour returns. [WP-09 / #203] external navigation
  // is stubbed and the popup is closed, so the lane stays isolated.
  test("17 a link launches through the server route (no new-tab anchor)", async ({ page }) => {
    await isolateExternalNetwork(page);
    try {
      let queued: { url?: string; mode?: string } | null = null;
      await page.route("**/api/launcher/queue", async (route) => {
        queued = route.request().postDataJSON();
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, jobId: "j-f78-17" }) });
      });
      await page.goto("/#/search/lab/docs-python-org?q=tls");
      const link = page.locator('[data-testid="lab-link-open"]').first();
      await expect(link).toHaveJSProperty("tagName", "BUTTON");
      await expect(link).not.toHaveAttribute("target", "_blank");
      await expect(link).not.toHaveAttribute("href", /./);
      const popupPromise = page.context().waitForEvent("page", { timeout: 15_000 });
      await link.click();
      // RDP half: the navigate job reached the launcher queue with the row's
      // own https URL (never a local-only silent open).
      await expect.poll(() => queued !== null, { timeout: 10_000 }).toBe(true);
      expect(queued!.mode).toBe("navigate");
      expect(String(queued!.url || "")).toMatch(/^https:\/\/www\.docs\.python\.org\//);
      // Local half: the mirror design opens the tab (the popup fires).
      const popup = await popupPromise;
      await expect.poll(() => popup.url(), { timeout: 10_000 }).not.toBe("about:blank");
      await shot(page, "17-link-launch-url");
    } finally {
      await closeExtraPages(page);
    }
  });

  test("18 the footer badge carries the ui sha", async ({ page }) => {
    await page.goto("/#/search");
    await expect(page.locator('[id="uiShaBadge"]')).toContainText(/ui:\s*\S+/);
    await shot(page, "18-ui-sha-badge");
  });

  test("19 dark mode renders the row and the modal", async ({ page }) => {
    await seedTheme(page, "dark");
    await runQuery(page, "tls");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(page.locator('[id="f78.search.yourSitesRow"]')).toBeVisible();
    await page.click('[id="f78.search.addSite"]');
    await expect(page.locator('[id="f78.addSite.modal"]')).toBeVisible();
    await shot(page, "19-dark-mode");
  });

  test("20 light mode renders the row and the modal", async ({ page }) => {
    await seedTheme(page, "light");
    await runQuery(page, "tls");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await expect(page.locator('[id="f78.search.yourSitesRow"]')).toBeVisible();
    await page.click('[id="f78.search.addSite"]');
    await expect(page.locator('[id="f78.addSite.modal"]')).toBeVisible();
    await shot(page, "20-light-mode");
  });
});
