/* ghrdp lab asset [F13-6 §2/§6]: playwright policy-page readbacks.
 *
 * The lab writes the SAME policy keys main.yml writes (live-resolved
 * ExtensionInstallForcelist ids). This driver opens the REAL policy UI the
 * user would look at and proves the values render there:
 *   kind=policy     -> goto <page> (edge://policy or chrome://policy), click
 *                      "Reload policies", assert every <needle> appears.
 *   kind=extensions -> launchPersistentContext(<profileDir>) (the profile the
 *                      lab already unpacked the forced extensions into), goto
 *                      <page> (edge://extensions), assert every <needle>
 *                      (extension NAME) appears.
 *
 * Usage: node policy-readback.js <channel=msedge|chrome> <kind> <page> <arg4=profileDir|-> <needle> [needle...]
 * Exit 0 = all needles render on the page; other = classified failure.
 */
'use strict';
let chromium;
try {
    chromium = require('playwright-core').chromium;
} catch (e) {
    console.log('::error::POLICY-FAIL(2): playwright-core not resolvable from ' + __dirname + ' (cwd=' + process.cwd() + '): ' + e.message);
    process.exit(2);
}

const channel = process.argv[2];
const kind = process.argv[3];
const pageUrl = process.argv[4];
const profileDir = process.argv[5];
const needles = process.argv.slice(6);

function fail(code, msg) {
    console.log('POLICY-FAIL(' + code + '): ' + msg);
    console.log('::error::POLICY-FAIL(' + code + '): ' + String(msg).split('\n')[0]);
    process.exit(code);
}
if (!channel || !kind || !pageUrl || needles.length === 0) {
    fail(1, 'usage: node policy-readback.js <channel> <kind> <page> <profileDir|-> <needle>...');
}

(async () => {
    let browser, context;
    if (kind === 'extensions') {
        if (!profileDir || profileDir === '-') { fail(2, 'extensions kind needs a profileDir'); }
        context = await chromium.launchPersistentContext(profileDir, {
            channel, headless: true,
            args: ['--no-first-run', '--no-default-browser-check', '--disable-gpu'],
        });
        browser = context.browser();
    } else if (kind === 'policy') {
        browser = await chromium.launch({ channel, headless: true });
        context = await browser.newContext();
    } else {
        fail(3, 'unknown kind ' + kind);
    }
    const page = await context.newPage();
    try {
        await page.goto(pageUrl, { timeout: 30000 });
    } catch (e) {
        fail(10, 'goto ' + pageUrl + ' failed: ' + e.message);
    }
    if (kind === 'policy') {
        try {
            const btn = page.getByText('Reload policies', { exact: false }).first();
            await btn.click({ timeout: 15000 });
        } catch (e) {
            console.log('POLICY-NOTE: Reload policies button not clickable (' + e.message.split('\n')[0] + ') - reading current render');
        }
        await page.waitForTimeout(2500);
    } else {
        await page.waitForTimeout(3000);
    }
    const bodyText = await page.evaluate(() => document.body.innerText).catch(() => '');
    let ok = true;
    for (const n of needles) {
        const byText = await page.getByText(n, { exact: false }).count();
        const inBody = bodyText.indexOf(n) !== -1;
        console.log('POLICY-NEEDLE ' + n + ': locator=' + byText + ' body=' + inBody);
        if (byText === 0 && !inBody) { ok = false; }
    }
    await context.close();
    if (browser) { await browser.close(); }
    if (!ok) { fail(20, 'a needle did not render on ' + pageUrl); }
    console.log('POLICY-PASS: ' + needles.length + ' needle(s) render on ' + pageUrl + ' (channel ' + channel + ')');
    process.exit(0);
})().catch((e) => fail(99, e && e.message ? e.message : String(e)));
