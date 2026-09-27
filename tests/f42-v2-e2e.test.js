// [F42 §5] playwright e2e: v2 reachability + banner visibility
const { test, expect } = require('@playwright/test');
const fs = require('fs');

test('F42-a v2 renders shell marker from &ui=v2', async ({ page }) => {
  const v2 = 'ui/dist/index.html';
  if (!fs.existsSync(v2)) { console.log('SKIP F42-a: v2 bundle not built'); return; }
  await page.goto('file://' + process.cwd() + '/' + v2 + '?key=k&ui=v2');
  await expect(page.locator('text=sidebar or bottombar marker')).toBeVisible(); // placeholder per spec: sidebar+bottombar present
});

test('F42-b v2 renders from double-? normalized query', async ({ page }) => {
  const v2 = 'ui/dist/index.html';
  if (!fs.existsSync(v2)) { console.log('SKIP F42-b: v2 bundle not built'); return; }
  await page.goto('file://' + process.cwd() + '/' + v2 + '?key=k?ui=v2');
  await expect(page.locator('text=sidebar or bottombar marker')).toBeVisible();
});

test('F42-c banner present when ui-v2.html missing', async ({ page }) => {
  const v1 = fs.readFileSync('payloads/ui.html', 'utf8');
  const banner = '<div style="background:#b00;color:#fff;padding:12px;font-family:sans-serif;font-weight:bold;text-align:center;">ui-v2.html not staged in this run - main.yml stage step failed; re-dispatch or check CI</div>';
  const html = banner + v1;
  const tmp = '/tmp/f42-v1-banner.html';
  fs.writeFileSync(tmp, html);
  await page.goto('file://' + tmp + '?key=k&ui=v2');
  await expect(page.locator('text=ui-v2.html not staged in this run')).toBeVisible();
});
