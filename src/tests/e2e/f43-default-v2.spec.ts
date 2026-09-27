// [F43 §3] Default route is the v2 shell. ?ui=v1 is the classic escape.
// A missing ui-v2.html is fail-visible (red banner), never a silent v1.
// The fixture is the stub backend: it mirrors ghrdp-server.ps1 routing and
// does not call the real tailnet APIs.
import { expect, test } from "@playwright/test";
import { copyFileSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { F42_BANNER_TEXT, startFixture } from "./f42-fixture";

test.use({ viewport: { width: 1440, height: 900 } });

test.describe("F43 default v2", () => {
  let url = "";
  let close: () => Promise<void> = async () => {};
  let dirMissing: string;

  test.beforeAll(async () => {
    const dist = join(process.cwd(), "ui", "dist", "index.html");
    expect(existsSync(dist), "ui/dist/index.html is missing - build the bundle first").toBe(true);
    const dir = mkdtempSync(join(tmpdir(), "f43-with-v2-"));
    copyFileSync(join(process.cwd(), "payloads", "ui.html"), join(dir, "ui.html"));
    copyFileSync(dist, join(dir, "ui-v2.html"));
    ({ url, close } = await startFixture(dir));
    dirMissing = mkdtempSync(join(tmpdir(), "f43-no-v2-"));
    copyFileSync(join(process.cwd(), "payloads", "ui.html"), join(dirMissing, "ui.html"));
  });

  test.afterAll(async () => {
    await close();
  });

  test("(/) stub backend renders the v2 shell (sidebar + topbar + bottombar)", async ({ page }) => {
    await page.goto(url + "/");
    await expect(page.locator('[data-testid="sidebar"]')).toBeVisible();
    await expect(page.locator('[data-testid="topbar"]')).toBeVisible();
    await expect(page.locator('[data-testid="bottombar"]')).toBeVisible();
    await expect(page.locator("#classicUiLink")).toHaveAttribute("href", "?ui=v1");
    await expect(page.locator("#classicUiLink")).toHaveText("Classic UI");
    await expect(page.locator("#uiV2MissingBanner")).toHaveCount(0);
  });

  test("(/?ui=v1) renders the classic v1 marker", async ({ page }) => {
    await page.goto(url + "/?ui=v1");
    await expect(page.locator("#topbar")).toBeVisible();
    await expect(page.locator('[data-testid="sidebar"]')).toHaveCount(0);
    await expect(page.locator("#uiV2MissingBanner")).toHaveCount(0);
  });

  test("missing ui-v2.html on the default route shows the fail-visible banner", async ({ page }) => {
    const { url: missingUrl, close: closeMissing } = await startFixture(dirMissing);
    try {
      await page.goto(missingUrl + "/");
      const banner = page.locator("#uiV2MissingBanner");
      await expect(banner).toBeVisible();
      await expect(banner).toContainText(F42_BANNER_TEXT);
      await expect(page.locator('[data-testid="sidebar"]')).toHaveCount(0);
      await expect(page.locator("#topbar")).toBeVisible();
    } finally {
      await closeMissing();
    }
  });
});
