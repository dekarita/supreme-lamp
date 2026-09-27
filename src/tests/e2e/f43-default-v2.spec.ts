// [F43] Playwright: DEFAULT route is v2; ?ui=v1 is classic; missing file is
// fail-VISIBLE (red banner). Uses the shared F42 fixture (now default-on).
import { expect, test } from "@playwright/test";
import { copyFileSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { F42_BANNER_TEXT, startFixture } from "./f42-fixture";

async function expectV2Shell(page: import("@playwright/test").Page) {
  await page.waitForSelector('[data-testid="sidebar"]', { state: "attached", timeout: 30000 });
  await expect(page.locator('[data-testid="sidebar"]')).toBeVisible();
  await expect(page.locator('[data-testid="bb-elapsed"]')).toBeVisible();
  await expect(page.locator('[data-testid="classic-ui-link"]')).toBeVisible();
  await expect(page.locator("#uiV2MissingBanner")).toHaveCount(0);
}

async function expectV1Shell(page: import("@playwright/test").Page) {
  await expect(page.locator("#topbar")).toBeVisible({ timeout: 30000 });
  await expect(page.locator('[data-testid="sidebar"]')).toHaveCount(0);
}

test.use({ viewport: { width: 1440, height: 900 } });

test.describe("F43 default-v2 cutover", () => {
  let url = "";
  let close: () => Promise<void> = async () => {};
  let dirV1: string;

  test.beforeAll(async () => {
    const dist = join(process.cwd(), "ui", "dist", "index.html");
    expect(existsSync(dist), "ui/dist/index.html is missing - build the bundle first").toBe(true);
    const dir = mkdtempSync(join(tmpdir(), "f43-with-v2-"));
    copyFileSync(join(process.cwd(), "payloads", "ui.html"), join(dir, "ui.html"));
    copyFileSync(dist, join(dir, "ui-v2.html"));
    ({ url, close } = await startFixture(dir));
    dirV1 = mkdtempSync(join(tmpdir(), "f43-no-v2-"));
    copyFileSync(join(process.cwd(), "payloads", "ui.html"), join(dirV1, "ui.html"));
  });

  test.afterAll(async () => {
    await close();
  });

  test("(a) load '/' with stub backend -> v2 shell (sidebar+topbar+bottombar)", async ({ page }) => {
    await page.goto(url + "/");
    await expectV2Shell(page);
  });

  test("(b) load '/?ui=v1' -> v1 marker (classic escape)", async ({ page }) => {
    await page.goto(url + "/?ui=v1");
    await expectV1Shell(page);
  });

  test("(c) Classic UI link href contains ui=v1", async ({ page }) => {
    await page.goto(url + "/");
    await expectV2Shell(page);
    const href = await page.locator('[data-testid="classic-ui-link"]').getAttribute("href");
    expect(href || "").toMatch(/(?:\?|&)ui=v1(?:&|$)/);
  });

  test("(d) missing-file fixture -> banner text visible on default route", async ({ page }) => {
    const { url: urlV1, close: closeV1 } = await startFixture(dirV1);
    try {
      await page.goto(urlV1 + "/");
      const banner = page.locator("#uiV2MissingBanner");
      await expect(banner).toBeVisible();
      await expect(banner).toContainText(F42_BANNER_TEXT);
      await expect(page.locator('[data-testid="sidebar"]')).toHaveCount(0);
      await expect(page.locator("#topbar")).toBeVisible();
    } finally {
      await closeV1();
    }
  });
});
