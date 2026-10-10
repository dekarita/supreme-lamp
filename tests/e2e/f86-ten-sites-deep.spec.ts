// [F86 §D] TEN-SITE DEEP E2E. Runs against the REAL built bundle + the mock
// backend (playwright.e2e-ui.config.ts, `pnpm run e2e`), so every F86 claim is
// exercised through the buttons an operator presses.
//
// Why the F85 suite was not enough: it asserted the Lab LISTS (6 mock links) and
// the delete/download flows. It never asserted the F86 bar - "the Lab finds >= 50
// URLs on this site" - and it never clicked a Lab row and proved that the RDP
// side was REALLY asked to open the row. That is what this file does, per site:
//   1. bare domain -> auto-https -> saves (POST body carries https://<site>)
//   2. open Lab (f86 deep lane) -> >= 50 URLs found
//   3. click a row -> the F91 MIRROR contract: a navigate job is POSTed to
//      /api/launcher/queue with the row's own https URL, the launcher ACCEPTS
//      it (200 + jobId), and the mock's independent job record (/__f91/jobs,
//      its stand-in for the .job file in C:\ProgramData\ghrdp\launcher-queue)
//      carries the row URL - the readback proof that the RDP side was asked.
//   4. the file-ish lane still renders "Download to RDP" for the same site
//   5. one screenshot per site: screenshots/f86-<site>-deep.png
//
// [WP-09 / #203] WHY STEP 3 NO LONGER WAITS FOR /api/launch-url.
// The original step 3 waited for POST /api/launch-url and read a tier from its
// response. F91 (commit 1827d3f0) replaced the single-attempt ladder click with
// MIRROR MODE (local tab + launcher queue) in LabInspector/ResultsGrid but left
// this spec asserting the retired transport, so every site test burned its full
// 60s budget waiting for a request that can never come - 11 sites x (attempt +
// retry) is the ~18m that killed the lane before f88/f91/f10x ever ran (see
// the F79-E2E-TALLY / F79-E2E-LAST annotations on runs 38027291171 and
// 38036173948). The USER REQUIREMENT kept here is unchanged: "clicking a Lab
// row really reaches the RDP session, with server-side proof". Only the
// transport moved: queue acceptance + /__f91/jobs readback replace the tier
// body. A mirror click that never queues (a silent local-only fallback) FAILS
// this step, exactly as a dead ladder failed the old one.
//
// Lab isolation (#203 acceptance): the mirror click opens a popup at the row's
// own REAL third-party URL. That popup is fulfilled with a local stub BEFORE
// the click (isolateExternalNetwork) and closed in a finally (closeExtraPages),
// so no test ever waits on a public host and no context teardown can wedge on
// it - the two properties tests/f203-e2e-lane.test.js pins for the whole lane.
//
// The deep lane's corpus is tests/e2e/fixtures/f86-sitemaps/<host-with-dashes>.xml
// (F87 §B.4: 60 URLs per site in the site's REAL path grammar - archive.org/
// details/..., gutenberg.org/ebooks/..., pluto.tv/us/on-demand/... - plus a few
// same-host .pdf/.mp3/.mp4 rows), served by the mock for `q=f86...` and for
// body.sourceUrl requests - the same two shapes the shipped server answers.
//
// [F87 §B.2] Step 2 asserts UI STATE (the rendered list), not a captured
// response: `page.waitForResponse` raced the hash navigation and the F85 spec's
// deletes (see mock-backend.mjs POST /api/f58/sources), and a race is not a
// proof. The list the operator sees IS the proof.
import { expect, test, type Page } from "@playwright/test";
import { mkdirSync, readFileSync, readdirSync } from "node:fs";

mkdirSync("screenshots", { recursive: true });

const OPERATOR_FIXTURE = [
  "openculture.com",
  "archive.org",
  "openverse.org",
  "awesome.re",
  "gutenberg.org",
  "standardebooks.org",
  "librivox.org",
  "openlibrary.org",
  "tubitv.com",
  "pluto.tv",
  "freemusicarchive.org",
];

const SITES = OPERATOR_FIXTURE;
const idOf = (site: string) => site.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
/** [F87 §B.3] hostname -> fixture file, the SAME rule the mock applies. */
const fixtureOf = (site: string) => site.replace(/\./g, "-") + ".xml";
const sitemapOf = (site: string) => readFileSync(`tests/e2e/fixtures/f86-sitemaps/${fixtureOf(site)}`, "utf8");
/** [F87 §B.4] A query term that really occurs in the site's own URL grammar,
 *  so the "matches first" list is non-empty and the screenshot is believable. */
const QUERY_OF: Record<string, string> = {
  "openculture.com": "free",
  "archive.org": "details",
  "openverse.org": "image",
  "awesome.re": "awesome",
  "gutenberg.org": "ebooks",
  "standardebooks.org": "ebooks",
  "librivox.org": "author",
  "openlibrary.org": "works",
  "tubitv.com": "movies",
  "pluto.tv": "on-demand",
  "freemusicarchive.org": "music",
};
const labUrlOf = (site: string) => "/#/search/lab/" + idOf(site) + "?q=f86+" + encodeURIComponent(QUERY_OF[site] || "free");
const locsOf = (site: string) => (sitemapOf(site).match(/<loc>[^<]+<\/loc>/g) || []).length;

async function shot(page: Page, site: string) {
  await page.screenshot({ path: `screenshots/f86-${site}-deep.png`, fullPage: true });
}

async function runQuery(page: Page, query: string) {
  await page.goto("/#/search");
  await page.fill('[id="f56.search.query"]', query);
  await page.press('[id="f56.search.query"]', "Enter");
  await expect(page.locator('[id="f78.search.yourSitesRow"]')).toBeVisible();
}

// [WP-09 / #203] The mock backend's own base. In-page fetches must use it (or
// a page.route stub): a RELATIVE fetch from the :5173 preview silently hits the
// vite SPA fallback (200 + index.html), which is how a dead contract can read
// as green. f79's `backend` constant is the same value.
const MOCK = process.env.F78_MOCK_URL || "http://127.0.0.1:7331";

// [WP-09 / #203] The mirror click opens a popup at the row's own REAL
// third-party URL. Fulfil every non-local request with a stub BEFORE any
// click so no test waits on a public host (F203-d intent, extended to
// popups), and the popup's URL - not its load - stays the assertion.
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

test.describe("F86 ten-site deep inspection", () => {
  test("0 the fixture set covers the operator list and every sitemap has >= 60 real-shaped URLs", () => {
    expect(SITES.length).toBeGreaterThanOrEqual(10);
    const files = readdirSync("tests/e2e/fixtures/f86-sitemaps");
    for (const site of SITES) {
      expect(files).toContain(fixtureOf(site));
      expect(locsOf(site)).toBeGreaterThanOrEqual(60);
      // [F87 §B.4] real sitemap snippets: every row is an https URL on the
      // site's own host (www-tolerant), none is the old synthetic /item/NNN.
      const xml = sitemapOf(site);
      const locs = xml.match(/<loc>[^<]+<\/loc>/g) || [];
      for (const loc of locs) {
        const href = loc.replace(/<\/?loc>/g, "");
        expect(href.startsWith("https://")).toBe(true);
        expect(new URL(href).hostname.replace(/^www\./, "")).toBe(site);
        expect(href).not.toMatch(/\/item\/\d{3}$/);
      }
      expect(locs.filter((l) => l.toLowerCase().includes(QUERY_OF[site])).length).toBeGreaterThan(0);
    }
  });

  for (const site of SITES) {
    test(`${site}: add -> Lab >= 50 URLs -> row mirrors into RDP (queue) -> download`, async ({ page }) => {
      // [WP-09 / #203] every popup this test opens is closed in the finally,
      // and every external navigation is stubbed, so the lane never waits on
      // a public host and no teardown can wedge (see the file header).
      await isolateExternalNetwork(page);
      try {
        // 1. ADD: the bare domain (exactly what the operator types) normalises to
        //    https:// and is saved on the server.
        await page.goto("/#/search");
        await page.click('[id="f78.search.addSite"]');
        const posted = page.waitForRequest((r) => r.url().includes("/api/f58/sources") && r.method() === "POST");
        await page.getByTestId("add-site-name").fill(site);
        await page.getByTestId("add-site-url").fill(site);
        await page.getByTestId("add-site-url").blur();
        await expect(page.getByTestId("add-site-auto-https")).toBeVisible();
        await page.getByTestId("add-site-save").click();
        const req = await posted;
        expect(JSON.parse(req.postData() || "{}").baseUrl).toBe("https://" + site);
        await expect(page.locator('[id="f78.addSite.modal"]')).toHaveCount(0);

        // 2. LAB DEEP: the f86 lane answers the site's own 60-URL corpus. The
        //    operator bar is >= 50 URLs, read off the RENDERED list and the
        //    match-count line (both come from server data, never from a
        //    hard-coded number). No waitForResponse: UI state is the assertion.
        await page.goto(labUrlOf(site));
        await expect(page.getByTestId("lab-link-list")).toBeVisible({ timeout: 20_000 });
        await expect(page.getByTestId("lab-match-count")).toBeVisible({ timeout: 20_000 });
        // "{matches} of {total} links match" - the total is the inspect's linkCount.
        const countLine = (await page.getByTestId("lab-match-count").textContent()) || "";
        const total = Number((/of\s+(\d+)/.exec(countLine) || [])[1] || 0);
        expect(total).toBeGreaterThanOrEqual(50);
        // The deep crawl is visible as a real source, not as a homepage fallback.
        await expect(page.getByTestId("lab-source")).toContainText("sitemap");
        // The matching rows (the per-site query term) are on screen...
        expect(await page.getByTestId("lab-link-row").count()).toBeGreaterThan(0);
        // ...and with "matches first" off the WHOLE corpus is: >= 50 <li> rows.
        await page.getByTestId("lab-matches-first").uncheck();
        const linkCount = await page.getByTestId("lab-link-list").locator("li").count();
        expect(linkCount).toBeGreaterThanOrEqual(50);
        await page.getByTestId("lab-matches-first").check();

        // 3. OPEN (F91 MIRROR CONTRACT): the first matching row opens LOCALLY
        //    (a popup fires) AND queues a navigate job for the RDP launcher.
        //    The proof the RDP side was really asked is threefold:
        //      a. POST /api/launcher/queue carried the row's own https URL
        //         (same-host fence, www-tolerant) with mode=navigate;
        //      b. the launcher ACCEPTED it (200 + a jobId, never a faked ok);
        //      c. the mock's independent job record (/__f91/jobs) carries the
        //         URL afterwards - a readback, not the request we sent.
        //    A click that opens locally but never queues (silent local-only
        //    fallback) FAILS (b)/(c), exactly as a dead ladder failed the old
        //    tier assertion. This is the same contract f91-mirror-mode.spec.ts
        //    proves; F86 keeps it inside the ten-site deep journey.
        const queueRes = page.waitForResponse(
          (r) => r.url().includes("/api/launcher/queue") && r.request().method() === "POST",
          { timeout: 20_000 },
        );
        const popupPromise = page.context().waitForEvent("page", { timeout: 15_000 });
        await page.getByTestId("lab-link-open").first().click();
        const post = await (await queueRes).request();
        const body = post.postDataJSON() as { url?: string; mode?: string };
        // The row's href is on THIS site (www-tolerant, exactly like the F84
        // same-host fence: openculture.com and gutenberg.org canonicalise to www).
        const postedUrl = String(body.url || "");
        expect(body.mode).toBe("navigate");
        expect(new URL(postedUrl).hostname.replace(/^www\./, "")).toBe(site);
        expect(postedUrl.startsWith("https://")).toBe(true);
        const accepted = await (await queueRes).json() as { ok?: boolean; jobId?: string };
        expect(accepted.ok).toBe(true);
        expect(typeof accepted.jobId).toBe("string");
        expect(accepted.jobId!.length).toBeGreaterThan(0);
        // Readback from the mock's own job record (the .job-file stand-in):
        // the RDP side holds this URL, independently of the request we made.
        const jobs = await (await page.request.get(MOCK + "/__f91/jobs")).json() as { jobs?: { url?: string; mode?: string }[] };
        expect(
          (jobs.jobs || []).some((j) => j.mode === "navigate" && j.url === postedUrl),
        ).toBe(true);
        // Local half: a popup really opened at the row's own site. Its LOAD is
        // stubbed (isolateExternalNetwork); creation + correct target is proof.
        const popup = await popupPromise;
        await expect.poll(() => popup.url(), { timeout: 10_000 }).not.toBe("about:blank");
        expect(popup.url()).toContain(site);

        // 4. DOWNLOAD: a file-ish row on this site still renders the F84 button.
        await runQuery(page, "f86 " + site);
        await expect(page.getByTestId("card-download-rdp").first()).toBeVisible();

        // 5. SCREENSHOT of the inspector view (full page, per site).
        await page.goto(labUrlOf(site));
        await expect(page.getByTestId("lab-link-list")).toBeVisible({ timeout: 20_000 });
        await expect(page.getByTestId("lab-link-row").first()).toBeVisible();
        await shot(page, site);
      } finally {
        await closeExtraPages(page);
      }
    });
  }
});
