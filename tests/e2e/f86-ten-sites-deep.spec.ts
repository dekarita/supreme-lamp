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
// The deep lane's corpus is tests/e2e/fixtures/f86-sitemaps/<site>.xml (52 URLs:
// pages + .mp3/.mp4/.pdf), served by the mock for `q=f86...` and for
// body.sourceUrl requests - the same two shapes the shipped server answers.
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
const sitemapOf = (site: string) => readFileSync(`tests/e2e/fixtures/f86-sitemaps/${site}.xml`, "utf8");
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

test.describe("F86 ten-site deep inspection", () => {
  test("0 the fixture set covers the operator list and every sitemap has >= 50 URLs", () => {
    expect(SITES.length).toBeGreaterThanOrEqual(10);
    const files = readdirSync("tests/e2e/fixtures/f86-sitemaps");
    for (const site of SITES) {
      expect(files).toContain(`${site}.xml`);
      expect(locsOf(site)).toBeGreaterThanOrEqual(50);
    }
  });

  for (const site of SITES) {
    test(`${site}: add -> Lab >= 50 URLs -> row opens in RDP (tier) -> download`, async ({ page }) => {
      const id = idOf(site);

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

      // 2. LAB DEEP: the f86 lane answers the site's own 52-URL corpus. The
      //    operator bar is >= 50 URLs, read off the match-count line the
      //    inspector renders from server data (never from a hard-coded number).
      const [inspectRes] = await Promise.all([
        page.waitForResponse((r) => r.url().includes("/api/lab/inspect") && r.request().method() === "POST"),
        page.goto("/#/search/lab/" + id + "?q=f86+sample"),
      ]);
      await expect(page.getByTestId("lab-link-list")).toBeVisible();
      // The operator bar: the inspect that fed this list returned >= 50 URLs.
      const inspected = (await inspectRes.json()) as { linkCount?: number; source?: string };
      expect(Number(inspected.linkCount || 0)).toBeGreaterThanOrEqual(50);
      expect(inspected.source || "").toContain("sitemap");
      expect(await page.getByTestId("lab-link-row").count()).toBeGreaterThan(0);
      // The deep crawl is visible as a real source, not as a homepage fallback.
      await expect(page.getByTestId("lab-source")).toContainText("sitemap");

      // 3. OPEN: the first matching row must POST /api/launch-url and the
      //    response must carry the F86 tier (1-3), which is the proof that the
      //    launch path ran a rung instead of silently failing.
      const launchReq = page.waitForRequest((r) => r.url().includes("/api/launch-url") && r.method() === "POST");
      const launchRes = page.waitForResponse((r) => r.url().includes("/api/launch-url") && r.request().method() === "POST");
      await page.getByTestId("lab-link-open").first().click();
      const post = await launchReq;
      expect(String(post.postData() || "")).toContain("https://" + site);
      const launchBody = (await (await launchRes).json()) as { ok?: boolean; tier?: number; tierDetail?: string };
      expect(launchBody.ok).toBe(true);
      expect([1, 2, 3]).toContain(launchBody.tier);
      expect(typeof launchBody.tierDetail).toBe("string");

      // 4. DOWNLOAD: a file-ish row on this site still renders the F84 button.
      await runQuery(page, "f86 " + site);
      await expect(page.getByTestId("card-download-rdp").first()).toBeVisible();

      // 5. SCREENSHOT of the inspector view (full page, per site).
      await page.goto("/#/search/lab/" + id + "?q=f86+sample");
      await expect(page.getByTestId("lab-link-list")).toBeVisible();
      await shot(page, site);
    });
  }
});
