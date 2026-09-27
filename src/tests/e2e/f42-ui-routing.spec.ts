// [F42 §5] Playwright: BOTH url forms must reach v2 in a real browser, and a
// missing ui-v2.html must be fail-VISIBLE (red banner), never a silent v1.
// The fixture serves the REAL built v2 bundle (ui/dist/index.html) as
// ui-v2.html next to the REAL v1 payload (payloads/ui.html).
import { expect, test } from "@playwright/test";
import { copyFileSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { F42_BANNER_TEXT, startFixture } from "./f42-fixture";

// v2 shell markers (v1 payload carries NO data-testid at all): the sidebar and
// the bottom bar. Present => the v2 bundle rendered.
async function expectV2Shell(page: import("@playwright/test").Page) {
  await page.waitForSelector('[data-testid="sidebar"]', { state: "attached", timeout: 30000 });
  await expect(page.locator('[data-testid="sidebar"]')).toBeVisible();
  await expect(page.locator('[data-testid="bb-elapsed"]')).toBeVisible();
  await expect(page.locator("#uiV2MissingBanner")).toHaveCount(0);
}

test.use({ viewport: { width: 1440, height: 900 } });

test.describe("F42 ui routing", () => {
  let url = "";
  let close: () => Promise<void> = async () => {};
  let dirV1: string;

  test.beforeAll(async () => {
    const dist = join(process.cwd(), "ui", "dist", "index.html");
    expect(existsSync(dist), "ui/dist/index.html is missing - build the bundle first").toBe(true);
    const dir = mkdtempSync(join(tmpdir(), "f42-with-v2-"));
    copyFileSync(join(process.cwd(), "payloads", "ui.html"), join(dir, "ui.html"));
    copyFileSync(dist, join(dir, "ui-v2.html"));
    ({ url, close } = await startFixture(dir));
    // v1-only dir: the v2 artifact is absent (the "renamed" fixture)
    dirV1 = mkdtempSync(join(tmpdir(), "f42-no-v2-"));
    copyFileSync(join(process.cwd(), "payloads", "ui.html"), join(dirV1, "ui.html"));
  });

  test.afterAll(async () => {
    await close();
  });

  test("(a) /?key=k&ui=v2 renders the v2 shell (sidebar + bottom bar)", async ({ page }) => {
    await page.goto(url + "/?key=k&ui=v2");
    await expectV2Shell(page);
  });

  test("(b) /?key=k?ui=v2 also renders v2 (post query normalisation)", async ({ page }) => {
    await page.goto(url + "/?key=k?ui=v2");
    await expectV2Shell(page);
  });

  test("(c) ui-v2.html missing => v1 PLUS the red banner text (fail-visible)", async ({ page }) => {
    const { url: urlV1, close: closeV1 } = await startFixture(dirV1);
    try {
      await page.goto(urlV1 + "/?key=k&ui=v2");
      const banner = page.locator("#uiV2MissingBanner");
      await expect(banner).toBeVisible();
      await expect(banner).toContainText(F42_BANNER_TEXT);
      // v1 really was served: no v2 shell, the v1 top bar is present instead
      await expect(page.locator('[data-testid="sidebar"]')).toHaveCount(0);
      await expect(page.locator("#topbar")).toBeVisible();
    } finally {
      await closeV1();
    }
  });
});
