// [F88 §E] THE FOUR OPERATOR CASES, end to end against the real bundle + the
// mock backend (playwright.e2e-ui.config.ts, `pnpm run e2e`). One test per
// spec case, one screenshot each (screenshots/f88-*.png), and the F88 UI
// claims asserted through the buttons an operator presses:
//   the visible "Source: ..." line (strategy + results + timing),
//   the source-switching tabs,
//   and (case 1) the per-row ⬇ Download button POSTing /api/fetch?download=true.
//
// The mock answers these four queries with the F88 search-endpoint payload
// (tests/e2e/fixtures/mock-backend.mjs f88InspectPayload), shaped after the
// cached real responses in tests/e2e/fixtures/f88-real-responses/.
import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";

mkdirSync("screenshots", { recursive: true });

async function shot(page: Page, name: string) {
  await page.screenshot({ path: `screenshots/f88-${name}.png`, fullPage: true });
}

/** Add the bare domain through the UI, exactly like the F86 spec does. */
async function addSite(page: Page, site: string) {
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
}

function labUrl(id: string, q: string) {
  return `/#/search/lab/${id}?q=${encodeURIComponent(q)}`;
}

test.describe("F88 concrete operator cases", () => {
  test("1. openculture.com + Free Online Philosophy Courses -> HTML search endpoint", async ({ page }) => {
    await addSite(page, "openculture.com");
    await page.goto(labUrl("openculture-com", "Free Online Philosophy Courses"));
    await expect(page.getByTestId("lab-link-list")).toBeVisible({ timeout: 20_000 });
    // The visible Source line names the strategy, count and timing.
    const line = page.getByTestId("lab-source-line");
    await expect(line).toBeVisible();
    await expect(line).toContainText("HTML search endpoint");
    await expect(line).toContainText("1.2");
    // The operator's expected URLs are on screen.
    await expect(page.getByTestId("lab-link-row").filter({ hasText: "https://www.openculture.com/freeonlinecourses" })).toHaveCount(1);
    await expect(page.getByTestId("lab-link-row").filter({ hasText: "walter_kaufmanns_lectures.html" })).toHaveCount(1);
    // Two sources were fetched -> two tabs, and switching moves the list.
    const tabs = page.getByTestId("lab-source-tab");
    await expect(tabs).toHaveCount(2);
    await expect(tabs.nth(0)).toContainText("HTML search endpoint (42)");
    await expect(tabs.nth(1)).toContainText("Sitemap XML (500)");
    await tabs.nth(1).click();
    await expect(tabs.nth(1)).toHaveAttribute("data-active", "true");
    await expect(page.getByTestId("lab-link-row").filter({ hasText: "https://openculture.com/about" })).toHaveCount(1);
    await tabs.nth(0).click();
    // The file-ish row carries the F88 Download button; posting it proves
    // /api/fetch?download=true and the success toast names the RDP folder.
    await page.getByTestId("lab-matches-first").uncheck();
    const dl = page.getByTestId("lab-link-download");
    await expect(dl).toHaveCount(1);
    const posted = page.waitForRequest((r) => r.url().includes("/api/fetch?download=true") && r.method() === "POST");
    await dl.click();
    const req = await posted;
    expect(JSON.parse(req.postData() || "{}").urlImport.url).toContain("platos-republic-lecture.mp3");
    await expect(page.locator("#toasts")).toContainText("RDP-Downloads");
    await shot(page, "openculture-philosophy");
  });

  test("2. archive.org + A Matter of Life and Death -> JSON search endpoint, top-10 identifiers", async ({ page }) => {
    await addSite(page, "archive.org");
    await page.goto(labUrl("archive-org", "A Matter of Life and Death"));
    await expect(page.getByTestId("lab-link-list")).toBeVisible({ timeout: 20_000 });
    const line = page.getByTestId("lab-source-line");
    await expect(line).toBeVisible();
    await expect(line).toContainText("JSON search endpoint");
    // All ten identifiers render as archive.org/details rows.
    const detailRows = page.getByTestId("lab-link-row").filter({ hasText: "archive.org/details/" });
    await expect(detailRows).toHaveCount(10);
    await expect(detailRows.first()).toContainText("matter-of-life-and-death-1946");
    await shot(page, "archive-matter");
  });

  test("3. openverse.org + Saturn's Rings in Ultraviolet Light -> >= 10 image results", async ({ page }) => {
    await addSite(page, "openverse.org");
    await page.goto(labUrl("openverse-org", "Saturn's Rings in Ultraviolet Light"));
    await expect(page.getByTestId("lab-link-list")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("lab-source-line")).toContainText("JSON search endpoint");
    const imgRows = page.getByTestId("lab-link-row").filter({ hasText: "PIA" });
    expect(await imgRows.count()).toBeGreaterThanOrEqual(10);
    // every row shows an https image URL (openverse results carry the
    // publisher's own landing/asset links - the F84 no-http fence holds).
    const texts = await page.getByTestId("lab-link-row").allTextContents();
    for (const row of texts) {
      expect(row).toContain("https://");
      expect(row).not.toContain("http://");
    }
    await shot(page, "openverse-saturn");
  });

  test("4. awesome.re + networking -> README Networking section with the five projects", async ({ page }) => {
    await addSite(page, "awesome.re");
    await page.goto(labUrl("awesome-re", "networking"));
    await expect(page.getByTestId("lab-link-list")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("lab-source-line")).toContainText("GitHub README section - Networking");
    const list = page.getByTestId("lab-link-row");
    for (const item of ["PCAPTools", "Real-Time Communications", "SNMP", "Scapy", "Cilium"]) {
      await expect(list.filter({ hasText: item })).toHaveCount(1);
    }
    // The section rows link at the spec's redirect target host.
    await expect(list.filter({ hasText: "PCAPTools" }).locator("a")).toHaveAttribute("href", "https://github.com/caesar0301/awesome-pcaptools");
    await shot(page, "awesome-networking");
  });
});
