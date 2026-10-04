// [F79 D1-D8] Real Chromium, real production bundle, backend request-log proof.
import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";

mkdirSync("screenshots", { recursive: true });
const FIVE = ["github-releases", "internet-archive", "arxiv-public", "wikipedia-public", "google-books-public"];
const backend = process.env.F78_MOCK_URL || "http://127.0.0.1:7331";
const id = (value: string) => `[id="${value}"]`;
async function query(page: Page, text: string) {
  await page.goto("/#/search");
  await page.getByTestId("search-query").fill(text);
  await page.getByTestId("search-query").press("Enter");
  await expect(page.getByTestId("search-page")).toHaveAttribute("data-view", "results");
  await expect(page.locator(id("f56.search.v2.landing"))).toBeHidden();
}
async function shot(page: Page, name: string) {
  await page.screenshot({ path: `screenshots/f79-${name}.png`, fullPage: true });
}
async function noDiagnostics(page: Page) {
  for (const name of ["progressive-lab", "lab-adapter-rail", "adapter-status-list", "lab-stage-classifier", "lab-stage-probes", "lab-stage-consolidation", "status-live"]) {
    await expect(page.getByTestId(name)).toHaveCount(0);
  }
  await expect(page.locator(id("f56.search.progressRail"))).toHaveCount(0);
}

test.describe("F79 Google-simple Search", () => {
  test("probe rail is hidden by default", async ({ page }) => {
    await query(page, "xyz");
    await expect(page.getByTestId("results-empty")).toBeVisible();
    await noDiagnostics(page);
    await shot(page, "default-hidden");
  });
  test("Advanced opt-in reveals only the five real adapter rows and can hide them again", async ({ page }) => {
    await query(page, "f79-loading");
    await expect(page.getByTestId("results-loading")).toBeVisible();
    await page.getByTestId("bar-icon-drawer").click();
    const toggle = page.locator(id("f79.search.showProgressToggle"));
    await expect(toggle).not.toBeChecked();
    await toggle.check();
    await expect(page.getByTestId("lab-adapter-rail")).toBeVisible();
    await expect(page.getByTestId("lab-adapter-row")).toHaveCount(5);
    const adapters = await page.getByTestId("lab-adapter-row").evaluateAll((rows) => rows.map((row) => row.getAttribute("data-adapter-id")));
    expect(adapters.sort()).toEqual([...FIVE].sort());
    await shot(page, "debug-progress");
    await toggle.uncheck();
    await noDiagnostics(page);
  });
  test("zero results names xyz and its custom-site button opens F78 quick-add", async ({ page }) => {
    await query(page, "xyz");
    await expect(page.getByTestId("results-empty")).toContainText("No results for 'xyz'. Try broader terms or");
    await expect(page.getByRole("button", { name: "+ Add a custom site" })).toBeVisible();
    await noDiagnostics(page);
    await shot(page, "01-empty-state");
    await page.getByTestId("add-custom-site-button").click();
    await expect(page.locator(id("f78.addSite.modal"))).toBeVisible();
    await expect(page.locator(id("f78.addSite.name"))).toBeVisible();
    await expect(page.locator(id("f78.addSite.url"))).toBeVisible();
  });
  test("loading is a single spinner and Searching...", async ({ page }) => {
    await query(page, "f79-loading");
    await expect(page.getByTestId("results-loading")).toContainText("Searching...");
    await expect(page.getByTestId("search-spinner")).toHaveCount(1);
    await expect(page.getByTestId("results-empty")).toHaveCount(0);
    await noDiagnostics(page);
    await shot(page, "02-loading-state");
  });
  test("default request delegates to the backend and queries exactly five adapters", async ({ page, request }) => {
    const posted = page.waitForRequest((req) => req.url().includes("/api/search") && req.method() === "POST");
    await query(page, "f79-default-five");
    const postedBody = (await posted).postDataJSON();
    expect(postedBody.adapterIds).toEqual([]);
    await expect(page.getByTestId("result-card").first()).toBeVisible();
    const log = await request.get(backend + "/__f79/search-requests");
    expect(log.ok()).toBeTruthy();
    const data = await log.json();
    const entries = data.requests.filter((entry: { requestId: string }) => entry.requestId === postedBody.requestId);
    expect(entries).toHaveLength(1);
    expect(entries[0].requestedAdapterIds).toEqual([]);
    expect(entries[0].adapterIds).toEqual(FIVE);
    await shot(page, "five-adapter-request");
  });
  test("Google navigation is smaller, secondary and below the search form", async ({ page }) => {
    await page.goto("/#/search");
    await page.getByTestId("search-query").fill("TLS & security");
    const google = page.getByTestId("google-nav-button");
    await expect(page.getByTestId("search-external-row").getByTestId("google-nav-button")).toBeVisible();
    await expect(google).toHaveCSS("font-size", "12px");
    const form = await page.locator(id("f56.search.commandBar") + " form").boundingBox();
    const link = await google.boundingBox();
    expect(link!.y).toBeGreaterThanOrEqual(form!.y + form!.height);
    // Verify external navigation without requiring Google egress in CI.
    await page.context().route("https://www.google.com/**", (route) => route.fulfill({ status: 200, contentType: "text/html", body: "Google navigation target" }));
    const popup = await Promise.all([page.waitForEvent("popup"), google.click()]);
    await popup[0].waitForURL("https://www.google.com/search?q=TLS%20%26%20security");
    expect(popup[0].url()).toContain("https://www.google.com/search?q=TLS%20%26%20security");
    await popup[0].close();
    await shot(page, "secondary-google");
  });
  test("Classifier, Federated probes and Consolidation never leak into the primary flow", async ({ page }) => {
    await query(page, "tls");
    await expect(page.getByTestId("result-card")).toHaveCount(2);
    await noDiagnostics(page);
    await expect(page.locator(id("f56.search.resultsHeader"))).toHaveCount(0);
    await shot(page, "phase-chips-hidden");
  });
  for (const theme of ["dark", "light"] as const) {
    test(`result typography, padding, 24px gaps and Your-sites ordering in ${theme} mode`, async ({ page }) => {
      await page.addInitScript((t) => localStorage.setItem("ghrdp:theme", JSON.stringify({ state: { theme: t }, version: 0 })), theme);
      await query(page, "tls");
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      const cards = page.getByTestId("result-card");
      await expect(cards).toHaveCount(2);
      await expect(cards.first()).toHaveCSS("padding", "16px");
      await expect(page.locator('[id^="f56.search.resultTitle."]').first()).toHaveCSS("font-size", "18px");
      await expect(page.getByTestId("card-snippet").first()).toHaveCSS("font-size", "14px");
      await expect(page.getByTestId("card-direct-url").first()).toHaveCSS("font-size", "12px");
      const first = (await cards.nth(0).boundingBox())!;
      const second = (await cards.nth(1).boundingBox())!;
      expect(second.y - first.y - first.height).toBeCloseTo(24, 0);
      const sites = (await page.getByTestId("your-sites-row").boundingBox())!;
      expect(sites.y + sites.height).toBeLessThanOrEqual(first.y);
      await noDiagnostics(page);
      await shot(page, `03-results-${theme}`);
    });
  }
  test("F78 quick-add stores a site whose row stays above the results", async ({ page }) => {
    await page.goto("/#/search");
    await page.locator(id("f78.search.addSite")).click();
    await page.locator(id("f78.addSite.name")).fill("Example docs");
    await page.locator(id("f78.addSite.url")).fill("https://docs.example.org");
    await page.locator(id("f78.addSite.save")).click();
    await expect(page.locator(id("f78.addSite.modal"))).toHaveCount(0);
    await page.getByTestId("search-query").fill("tls");
    await page.getByTestId("search-query").press("Enter");
    await expect(page.getByTestId("your-site-card-docs-example-org")).toBeVisible();
    await expect(page.getByTestId("result-card")).toHaveCount(2);
    await shot(page, "04-your-sites-row");
  });
});
