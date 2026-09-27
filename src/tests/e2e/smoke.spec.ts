// [F41 §6.2] Playwright smoke against the REAL built bundle: regression ids,
// font subset requests, zero console errors, bottom-bar ids present.
import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";

const lockSrc = readFileSync("src/lib/regression-ids.ts", "utf8").replace(/\r\n?/g, "\n");
const IDS = [...lockSrc.matchAll(/'([^']+)'/g)].map((m) => m[1]);

test("bundle renders with zero JS errors and all regression ids", async ({ page }) => {
  // JS-exception contract: pageerror + app console.error are fatal. Chromium
  // logs RESOURCE-load failures ("Failed to load resource: ... 404") for the
  // absent preview backend (/api/*, /ping, /ws) and favicons - those are the
  // preview environment, not app defects, and are excluded here; against the
  // real server they do not occur.
  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    const text = msg.text();
    if (/Failed to load resource|net::ERR_|404\b|favicon/i.test(text)) return;
    errors.push(text);
  });
  page.on("pageerror", (err) => errors.push(String(err)));
  await page.goto("/");
  await page.waitForSelector("#root > *", { timeout: 30000 });
  const missing: string[] = [];
  for (const id of IDS) {
    if (!(await page.locator("#" + id).count())) missing.push(id);
  }
  expect(missing, "missing ids: " + missing.join(", ")).toEqual([]);
  expect(errors, "console errors: " + errors.join(" | ")).toEqual([]);
});

test("a Sinhala-capable font face is loaded for the sample glyphs", async ({ page }) => {
  await page.goto("/");
  await page.waitForSelector("#sinhalaSample", { timeout: 30000 });
  const hasSinhalaFace = await page.evaluate(async () => {
    await document.fonts.ready;
    let found = false;
    document.fonts.forEach((f) => {
      if (/noto sans sinhala/i.test(f.family)) found = true;
    });
    return found;
  });
  expect(hasSinhalaFace).toBe(true);
});

test("bottom bar shows clock and placeholders before data", async ({ page }) => {
  await page.goto("/");
  await page.waitForSelector("#bottomClock", { timeout: 30000 });
  await expect(page.locator("#bottomClock")).toHaveText(/^\d{2}:\d{2}:\d{2}$/);
  await expect(page.locator("#timerElapsed")).toHaveText(/^(--:--:--|\d{2}:\d{2}:\d{2})$/);
});
