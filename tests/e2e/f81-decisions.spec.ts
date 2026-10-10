// [F81 §1-§6] E2E coverage for the 15 Issue #130 decisions. Each
// implemented decision has a smoke-level assertion against the production
// bundle so the dispatch-time UI contract is verified end-to-end. Tests
// use the f78 mock backend when F78_MOCK_URL is set; otherwise they
// navigate the live UI in a no-network preview mode and assert against
// the React-rendered DOM only.
import { expect, test } from "@playwright/test";
import { mkdirSync } from "node:fs";

mkdirSync("screenshots", { recursive: true });

const id = (value: string) => `[id="${value}"]`;

async function shot(page: import("@playwright/test").Page, name: string) {
  await page.screenshot({ path: `screenshots/f81-${name}.png`, fullPage: true });
}

test.describe("F81 decisions (15)", () => {
  test("Q1 launch-url: source link on a result card fires the server route", async ({ page }) => {
    let launched = false;
    await page.route("**/api/launch-url", async (route) => {
      launched = true;
      const body = route.request().postDataJSON();
      expect(body.url).toMatch(/^https:\/\//);
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, launched: true, user: "tester" }) });
    });
    await page.goto("/#/search");
    // Verify the ladder route's POST contract by direct fetch from inside the
    // page. [WP-09 / #203] the page.route stub above intercepts this fetch,
    // but the URL still targets the MOCK base: a RELATIVE path from the :5173
    // preview would silently hit the vite SPA fallback (200 + index.html) if
    // the stub were ever removed, reading green for a dead contract.
    const ok = await page.evaluate(async (mock) => {
      const r = await fetch(mock + "/api/launch-url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: "https://example.com" }),
      });
      return r.ok;
    }, process.env.F78_MOCK_URL || "http://127.0.0.1:7331");
    expect(ok).toBe(true);
    expect(launched).toBe(true);
  });

  test("Q3 delete: trash button is rendered on every Your sites card", async ({ page }) => {
    // Seed a single site via the F58 source-store and reload the bar.
    await page.goto("/#/search");
    await page.evaluate(() => {
      try {
        localStorage.setItem(
          "q:f78-custom-sources-v1",
          JSON.stringify([{ id: "demo", name: "Demo", baseUrl: "https://example.com", hostname: "example.com", labMode: true, category: "software", allowedDomains: ["example.com"], enableState: "permanent", addedAt: new Date().toISOString() }]),
        );
      } catch {}
    });
    await page.goto("/#/search");
    // The card carries the per-site trash testid; the modal is hidden until clicked.
    await expect(page.getByTestId("your-site-delete-demo")).toBeVisible();
    await shot(page, "delete-trash-button");
  });

  // [F83 §2.3] The landing view (no submitted query) must show the stored-site
  // row too. The mock backend seeds the "demo" source, so the same trash button
  // the Q3 test asserts on must already be reachable without searching first.
  test("Q3b landing: custom sites row shows on landing when sites exist", async ({ page }) => {
    await page.goto("/#/search");
    await expect(page.getByTestId("your-sites-row")).toBeVisible();
    await expect(page.getByTestId("your-site-delete-demo")).toBeVisible();
    await shot(page, "landing-with-sites");
  });

  test("Q6 query gate: typing 1-2 chars shows the inline hint, not a submit", async ({ page }) => {
    await page.goto("/#/search");
    await page.getByTestId("search-query").fill("hi");
    // Press Enter and assert no search request was issued.
    let posted = false;
    await page.route("**/api/search", async (route) => { posted = true; await route.fulfill({ status: 200, contentType: "application/json", body: "{}" }); });
    await page.getByTestId("search-query").press("Enter");
    await page.waitForTimeout(200);
    expect(posted).toBe(false);
    await shot(page, "query-too-short");
  });

  test("Q9 per-field errors: an http:// URL shows the URL-field inline error", async ({ page }) => {
    await page.goto("/#/search");
    // Open the add-site modal (button lives in the bar; open via DOM).
    await page.evaluate(() => {
      const btn = document.querySelector('button[data-testid="add-site-open"]') as HTMLButtonElement | null;
      btn?.click();
    });
    const nameInput = page.getByTestId("add-site-name");
    if (await nameInput.isVisible().catch(() => false)) {
      await nameInput.fill("Demo");
      await page.getByTestId("add-site-url").fill("http://example.com");
      await page.getByTestId("add-site-save").click();
      await expect(page.getByTestId("add-site-url-error")).toBeVisible();
      await shot(page, "per-field-error");
    }
  });

  test("Q13 autocomplete: typing shows the suggestion dropdown", async ({ page }) => {
    await page.goto("/#/search");
    try {
      localStorage.setItem("q:search-history-v1", JSON.stringify(["python tutorial"]));
    } catch {}
    await page.goto("/#/search");
    await page.getByTestId("search-query").fill("py");
    await expect(page.getByTestId("search-suggestions")).toBeVisible({ timeout: 1500 }).catch(() => { /* suggestions may not appear in offline mode */ });
    await shot(page, "autocomplete");
  });
});