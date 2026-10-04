// [F85 §4] TEN-SITE (11-domain) OPERATOR FIXTURE E2E. Runs against the REAL
// built bundle + the mock backend (playwright.e2e-ui.config.ts, `pnpm run e2e`),
// so every behaviour F84 claims is exercised through the buttons an operator
// presses - not by calling the endpoints directly.
//
// WHY THIS FILE EXISTS: the F84 spec's launch/download assertions degrade to a
// direct fetch() when the seeded rows are not file-ish, so no F84 test ever
// CLICKED the "Download to RDP" button on a real row. These specs seed a
// file-ish row for each story (the mock's `f85 <site>` lane) and assert the
// button, the request and the success toast.
//
// Five assertions per domain:
//   1. bare domain -> auto-https + save (POST body carries https://<site>)
//   2. the site is a card on the Your-sites row (seeded by f85-sites.json)
//   3. Lab inspect answers from www.<site> -> no "different hostname" error
//   4. a file-ish result on the site -> "Download to RDP" is present + writes
//   5. delete -> confirm modal -> the card is gone
// (4 and 5 run before the delete on purpose: a deleted site cannot be inspected.)
//
// One screenshot per domain: screenshots/f85-<domain>-flow.png
import { expect, test, type Page } from "@playwright/test";
import { mkdirSync, readFileSync } from "node:fs";

mkdirSync("screenshots", { recursive: true });

// The operator brief's list, verbatim (playwright runs with the repo as cwd).
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

const FIXTURE = JSON.parse(readFileSync("tests/e2e/fixtures/f85-sites.json", "utf8")) as {
  sites: string[];
  sources: Array<{ id: string; hostname: string }>;
};

/** The seeded list MUST be the operator fixture, or the suite tests nothing. */
const SITES = FIXTURE.sites;
const idOf = (site: string) => site.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

async function shot(page: Page, site: string) {
  await page.screenshot({ path: `screenshots/f85-${site}-flow.png`, fullPage: true });
}

/** Submit a query and wait for the results surface (the F78 helper pattern). */
async function runQuery(page: Page, query: string) {
  await page.goto("/#/search");
  await page.fill('[id="f56.search.query"]', query);
  await page.press('[id="f56.search.query"]', "Enter");
  await expect(page.locator('[id="f78.search.yourSitesRow"]')).toBeVisible();
}

test.describe("F85 operator fixture: every domain, end to end", () => {
  // The fixture list is the source of truth for how many stories run: if the
  // operator edits f85-sites.json, the suite follows without a code change.
  test("0 the operator fixture names every domain exactly once", () => {
    expect(SITES).toEqual(OPERATOR_FIXTURE);
    expect(SITES.length).toBeGreaterThanOrEqual(10);
    expect(new Set(SITES).size).toBe(SITES.length);
    for (const s of SITES) expect(s).toMatch(/^[a-z0-9.-]+$/);
  });

  for (const site of SITES) {
    test(`${site}: add -> card -> lab(www) -> download -> delete`, async ({ page }) => {
      const id = idOf(site);
      const bare = site; // exactly what the operator types: NO scheme

      // 1. ADD: the bare domain must be normalised to https:// and saved.
      await page.goto("/#/search");
      await page.click('[id="f78.search.addSite"]');
      const posted = page.waitForRequest(
        (r) => r.url().includes("/api/f58/sources") && r.method() === "POST",
      );
      await page.getByTestId("add-site-name").fill(site);
      await page.getByTestId("add-site-url").fill(bare);
      await page.getByTestId("add-site-url").blur();
      await expect(page.getByTestId("add-site-auto-https")).toBeVisible();
      await expect(page.getByTestId("add-site-url")).toHaveValue("https://" + site);
      await page.getByTestId("add-site-save").click();
      const req = await posted;
      expect(JSON.parse(req.postData() || "{}").baseUrl).toBe("https://" + site);
      await expect(page.locator('[id="f78.addSite.modal"]')).toHaveCount(0);

      // 2. CARD: the stored site is on the Your-sites row (seeded by the mock).
      await page.goto("/#/search");
      await expect(page.getByTestId("your-site-card-" + id)).toBeVisible();
      await expect(page.getByTestId("your-site-card-" + id)).toContainText(site);

      // 3. LAB: the mock answers from www.<site> - the F84 www-tolerant fence
      //    must keep the Lab working and show NO hostname error. The query is
      //    "tls", which the fixture's own link text carries, so the matching
      //    list is non-empty; the hostname assertion is the www proof itself.
      await page.goto("/#/search/lab/" + id + "?q=tls");
      await expect(page.getByTestId("lab-hostname")).toHaveText("www." + site);
      await expect(page.getByTestId("lab-link-list")).toBeVisible();
      await expect(page.getByText("different hostname")).toHaveCount(0);

      // 4. DOWNLOAD: a file-ish row on this site renders the F84 button, and
      //    clicking it posts download=true and toasts the RDP path.
      await runQuery(page, "f85 " + site);
      const dl = page.getByTestId("card-download-rdp").first();
      await expect(dl).toBeVisible();
      const fetchReq = page.waitForRequest(
        (r) => r.url().includes("/api/fetch") && r.url().includes("download=true"),
      );
      await dl.click();
      expect((await fetchReq).method()).toBe("POST");
      await expect(page.locator("#toasts")).toContainText("RDP-Downloads");

      // 5. DELETE: trash -> confirm modal -> the card is gone.
      await page.goto("/#/search");
      await page.getByTestId("your-site-delete-" + id).click();
      await expect(page.getByTestId("delete-site-modal")).toBeVisible();
      const del = page.waitForRequest(
        (r) => r.url().includes("/api/f58/sources/" + id) && r.method() === "DELETE",
      );
      await page.getByTestId("delete-site-confirm").click();
      expect((await del).method()).toBe("DELETE");
      await expect(page.getByTestId("your-site-card-" + id)).toHaveCount(0);

      await shot(page, site);
    });
  }

  test("banner: /#/search?diag=1 shows a verified mark per F84 feature", async ({ page }) => {
    await page.goto("/#/search?diag=1");
    const banner = page.getByTestId("f85-diag-banner");
    await expect(banner).toBeVisible();
    // Every mark comes from a real probe (server features + the running bundle).
    await expect(page.getByTestId("f85-diag-autoHttps")).toHaveAttribute("data-ok", "1");
    await expect(page.getByTestId("f85-diag-wwwTolerance")).toHaveAttribute("data-ok", "1");
    await expect(page.getByTestId("f85-diag-noFallback")).toHaveAttribute("data-ok", "1");
    await expect(page.getByTestId("f85-diag-downloadToRdp")).toHaveAttribute("data-ok", "1");
    await expect(page.getByTestId("f85-diag-sha")).toContainText("ui: ");
    await shot(page, "diagnostic-banner");

    // And it must NOT leak into the operator's normal surface.
    await page.goto("/#/search");
    await expect(page.getByTestId("f85-diag-banner")).toHaveCount(0);
  });
});
