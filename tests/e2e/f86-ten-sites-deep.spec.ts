// [F86 §D] TEN-SITE DEEP E2E. Runs against the REAL built bundle + the mock
// backend (playwright.e2e-ui.config.ts, `pnpm run e2e`), so every F86 claim is
// exercised through the buttons an operator presses.
//
// Why the F85 suite was not enough: it asserted the Lab LISTS (6 mock links) and
// the delete/download flows. It never asserted the F86 bar - "the Lab finds >= 50
// URLs on this site" - and it never clicked a Lab row and proved that
// /api/launch-url was REALLY called and that a TIER came back. That is what this
// file does, per site:
//   1. bare domain -> auto-https -> saves (POST body carries https://<site>)
//   2. open Lab (f86 deep lane) -> >= 50 URLs found
//   3. click a row -> POST /api/launch-url with that href -> response tier 1-3
//   4. the file-ish lane still renders "Download to RDP" for the same site
//   5. one screenshot per site: screenshots/f86-<site>-deep.png
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

// [F103 §5.4] Ten sites x the old 60s-class waits is what pushed e2e-ui past
// the 25-minute job limit, where GitHub CANCELS the job (red, with no failing
// assertion to read). Each test gets a hard 15s budget and the in-test waits
// are trimmed to match: against the local mock backend every step here is
// sub-second, so a 15s ceiling only ever fires on a real hang.
test.setTimeout(15_000);

const LAUNCH_ROUTE = /\/api\/(launch-url|launcher\/queue)(\?|$)/;

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
    test(`${site}: add -> Lab >= 50 URLs -> row opens in RDP (tier) -> download`, async ({ page }) => {

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
      await expect(page.getByTestId("lab-link-list")).toBeVisible({ timeout: 8_000 });
      await expect(page.getByTestId("lab-match-count")).toBeVisible({ timeout: 8_000 });
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

      // 3. OPEN: the first matching row must POST /api/launch-url and the
      //    response must carry the F86 tier (1-3), which is the proof that the
      //    launch path ran a rung instead of silently failing.
      // [F103 §5.2] F91 replaced POST /api/launch-url with POST
      // /api/launcher/queue; the spec waited only for the old path and hung
      // until the job-level timeout. Accept EITHER (backward compatible).
      const launchReq = page.waitForRequest((r) => LAUNCH_ROUTE.test(r.url()) && r.method() === "POST");
      const launchRes = page.waitForResponse((r) => LAUNCH_ROUTE.test(r.url()) && r.request().method() === "POST");
      await page.getByTestId("lab-link-open").first().click();
      const post = await launchReq;
      // The row's href is on THIS site (www-tolerant, exactly like the F84
      // same-host fence: openculture.com and gutenberg.org canonicalise to www).
      const postedUrl = String((JSON.parse(post.postData() || "{}") as { url?: string }).url || "");
      expect(new URL(postedUrl).hostname.replace(/^www\./, "")).toBe(site);
      expect(postedUrl.startsWith("https://")).toBe(true);
      const launchBody = (await (await launchRes).json()) as { ok?: boolean; tier?: number; tierDetail?: string };
      expect(launchBody.ok).toBe(true);
      expect([1, 2, 3]).toContain(launchBody.tier);
      expect(typeof launchBody.tierDetail).toBe("string");

      // 4. DOWNLOAD: a file-ish row on this site still renders the F84 button.
      await runQuery(page, "f86 " + site);
      await expect(page.getByTestId("card-download-rdp").first()).toBeVisible();

      // 5. SCREENSHOT of the inspector view (full page, per site).
      await page.goto(labUrlOf(site));
      await expect(page.getByTestId("lab-link-list")).toBeVisible({ timeout: 8_000 });
      await expect(page.getByTestId("lab-link-row").first()).toBeVisible();
      await shot(page, site);
    });
  }
});
