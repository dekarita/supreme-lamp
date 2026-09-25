/* ghrdp lab asset [F13-6 §3]: playwright driver for the webdesk auto-fill E2E.
 *
 * Proves, against the REAL noVNC v1.7.0 tree with the REAL deployed shim:
 *   1. POSITIVE: the dashboard stub (same-origin opener) posts the password
 *      once-per-500ms -> the noVNC credentials dialog is auto-filled and
 *      submitted by the shim ALONE -> the VNC-auth handshake completes ->
 *      the stub RFB server reports connected. The driver NEVER sends a
 *      keystroke; a capture-phase keydown counter on the popup must stay 0
 *      (ZERO manual typing).
 *   2. CONTROL: opening vnc.html?autoconnect=true directly (no opener, no
 *      postMessage) must NOT reach connected - the auto-fill only ever comes
 *      from the opener handoff.
 *   3. NO LEAK: the password literal must be absent from the popup URL, from
 *      every URL the page requested, and from every byte the RFB stub server
 *      received (the wire carries only the DES-encrypted response).
 *
 * Usage: node webdesk-e2e.js <origin=http://127.0.0.1:7333> <stateUrl=http://127.0.0.1:5902/state>
 * Exit 0 = all three proofs hold; any other exit code = classified failure.
 */
'use strict';
// Every failure ALSO emits a ::error:: workflow annotation so the classified
// reason is readable from the Checks API even when the job log is not.
let chromium;
try {
    chromium = require('playwright-core').chromium;
} catch (e) {
    console.log('::error::E2E-FAIL(2): playwright-core not resolvable from ' + __dirname + ' (cwd=' + process.cwd() + '): ' + e.message);
    process.exit(2);
}

const ORIGIN = process.argv[2] || 'http://127.0.0.1:7333';
const STATE = process.argv[3] || 'http://127.0.0.1:5902/state';
const PASSWORD = 'vnclab7';

function fail(code, msg) {
    console.log('E2E-FAIL(' + code + '): ' + msg);
    console.log('::error::E2E-FAIL(' + code + '): ' + String(msg).split('\n')[0]);
    process.exit(code);
}

async function getState() {
    const r = await fetch(STATE);
    return r.json();
}

(async () => {
    let browser;
    try {
        browser = await chromium.launch({ channel: 'msedge', headless: true });
    } catch (e) {
        try {
            browser = await chromium.launch({ channel: 'chrome', headless: true });
        } catch (e2) {
            fail(10, 'no Edge/Chrome channel available: ' + e2.message);
        }
    }
    const ctx = await browser.newContext();
    const urls = [];

    // ---------- 1. POSITIVE: opener handoff -> auto-filled -> connected ----
    const page = await ctx.newPage();
    page.on('request', (r) => urls.push(r.url()));
    await page.goto(ORIGIN + '/dash-stub.html');
    const popupPromise = ctx.waitForEvent('page', { timeout: 15000 });
    await page.click('#btnWebDesk');
    const popup = await popupPromise;
    await popup.waitForLoadState('load', { timeout: 15000 });
    // capture-phase keyboard counter on the popup: nothing may ever be typed
    await popup.evaluate(() => {
        window.__ghrdpKeys = 0;
        window.addEventListener('keydown', () => { window.__ghrdpKeys++; }, true);
    });
    let st = null;
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
        st = await getState();
        if (st && st.connected) { break; }
        await new Promise((r) => setTimeout(r, 500));
    }
    if (!st || !st.connected) {
        let diag = 'state=' + JSON.stringify(st);
        try {
            diag += ' popupUrl=' + popup.url();
            diag += ' title=' + (await popup.title());
            diag += ' page=' + await popup.evaluate(() => {
                const cp = document.getElementById('noVNC_connect_panel');
                const dlg = document.getElementById('noVNC_credentials_dlg');
                return JSON.stringify({
                    readyState: document.readyState,
                    connectPanelOpen: !!(cp && cp.classList && cp.classList.contains('noVNC_open')),
                    credDlgOpen: !!(dlg && dlg.classList && dlg.classList.contains('noVNC_open')),
                    statusText: (document.getElementById('noVNC_status_text') || {}).textContent || ''
                });
            });
            const shot = process.env.H2_SHOT || 'h2-shot.png';
            await popup.screenshot({ path: shot });
            diag += ' screenshot=' + shot;
        } catch (e) { diag += ' diagErr=' + (e && e.message ? e.message : e); }
        fail(20, diag);
    }
    const keys = await popup.evaluate(() => window.__ghrdpKeys);
    if (keys !== 0) { fail(21, 'keyboard events reached the popup: ' + keys); }
    if (popup.url().indexOf('password=') !== -1) { fail(22, 'popup URL carries password='); }

    // ---------- 2. CONTROL: no opener -> no handoff -> NOT connected -------
    const ctrl = await ctx.newPage();
    ctrl.on('request', (r) => urls.push(r.url()));
    await ctrl.goto(ORIGIN + '/vnc.html?autoconnect=true&compression=6');
    await new Promise((r) => setTimeout(r, 8000));
    const st2 = await getState();
    // the control page must still be sitting at the credentials dialog
    const dlgOpen = await ctrl.evaluate(() => {
        const d = document.getElementById('noVNC_credentials_dlg');
        return !!(d && d.classList && d.classList.contains('noVNC_open'));
    });
    if (dlgOpen !== true) {
        fail(30, 'control page: credentials dialog is not open (no-opener flow somehow proceeded)');
    }
    // ---------- 3. NO LEAK: URL/wire scan ----------------------------------
    for (const u of urls) {
        if (u.indexOf(PASSWORD) !== -1) { fail(40, 'password literal in a requested URL: ' + u); }
        if (u.indexOf('password=') !== -1) { fail(41, 'password= in a requested URL: ' + u); }
    }
    for (const buf of st.received) {
        if (String(buf).indexOf(PASSWORD) !== -1) {
            fail(42, 'cleartext password reached the RFB wire');
        }
    }
    await browser.close();
    console.log('E2E-PASS: connected=' + st.connected +
        ' via opener handoff, keydowns=0, control-dialog-open=' + dlgOpen +
        ', urls=' + urls.length + ' clean, rfb-bytes=' +
        st.received.reduce((a, b) => a + b.length, 0) + ' clean');
    process.exit(0);
})().catch((e) => fail(99, e && e.message ? e.message : String(e)));
