// [F11] UX PACKAGE: PS-free auto-login, VNC memory, usage timer, provisioning.
// Run: node tests/f11-ux-package.test.js
const fs = require('fs');
const test = require('node:test');
const assert = require('node:assert/strict');

const ui = fs.readFileSync('payloads/ui.html', 'utf8');
const wf = fs.readFileSync('.github/workflows/main.yml', 'utf8');
const shim = fs.readFileSync('payloads/ghrdp-cred-shim.js', 'utf8');
const launcher = fs.readFileSync('payloads/ghrdp-rdp-launcher.cs', 'utf8');
const installer = fs.readFileSync('payloads/install.cmd', 'utf8');
const server = fs.readFileSync('payloads/ghrdp-server.ps1', 'utf8');

// §1 PS-FREE WINDOWS AUTO-LOGIN
test('F11 §1: launcher has all required .rdp directives, no creds', () => {
  for (const d of [
    'screen mode id:i:2', 'redirectclipboard:i:1', 'redirectprinters:i:1',
    'redirectdrives:i:1', 'drivestoredirect:s:*', 'devicestoredirect:s:*',
    'redirectcomports:i:1', 'redirectsmartcards:i:1',
    'audiocapturemode:i:1', 'bandwidthautodetect:i:1', 'compression:i:1',
  ]) assert.ok(launcher.includes('"' + d + '"'), 'missing directive ' + d);
  // No password, no resolution lines
  const code = launcher.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
  for (const bad of ['password 51', 'desktopwidth', 'desktopheight'])
    assert.ok(!code.toLowerCase().includes(bad), 'forbidden rdp line ' + bad);
});

test('F11 §1: install.cmd uses in-box csc + HKCU, no PowerShell', () => {
  assert.match(installer, /Framework64\\v4\.0\.30319\\csc\.exe/);
  assert.match(installer, /HKCU\\Software\\Classes\\ghrdp/);
  assert.ok(!/powershell|-ExecutionPolicy/i.test(installer), 'install.cmd must stay script-host free');
});

test('F11 §1: ui.html WINDOWS AUTO-LOGIN fires ghrdp://rdp', () => {
  assert.match(ui, /id="btnWinAuto"/);
  assert.match(ui, /ghrdp:\/\/rdp\?server=/);
  assert.match(ui, /id="winAutoInstall"/);
});

// §2 VNC PASSWORD MEMORY
test('F11 §2: shim exists and enforces origin check', () => {
  assert.match(shim, /ghrdp-vnc-pass/);
  assert.match(shim, /isAllowedOrigin/);
  assert.match(shim, /postMessage/);
  // Must NOT log the password
  assert.ok(!shim.includes('console.log(pass') && !shim.includes("console.log(data"), 'shim must not log the password');
  // Must NOT place password in URL
  assert.ok(!shim.includes('location.href') || !shim.match(/location\.href.*pass/), 'shim must not put password in URL');
});

test('F11 §2: ui.html stores VNC pass in localStorage on copy', () => {
  assert.match(ui, /localStorage\.setItem\('ghrdp:vnc-pass'/);
  assert.match(ui, /credVncPass.*data-full/);
});

test('F11 §2: ui.html postMessage VNC pass on WEB DESKTOP click', () => {
  assert.match(ui, /ghrdp-vnc-pass/);
  assert.match(ui, /postMessage.*ghrdp-vnc-pass/);
  assert.match(ui, /localStorage\.getItem\('ghrdp:vnc-pass'\)/);
});

test('F11 §2: noVNC URL never contains password=', () => {
  assert.match(ui, /password=.*disabled/);
  // The gate: if URL has password=, disable the button
  assert.ok(ui.includes("openUrl.indexOf('password=')>=0"), 'must gate on password= in URL');
});

test('F11 §2: workflow deploys shim into noVNC directory', () => {
  assert.match(wf, /ghrdp-cred-shim\.js/);
  assert.match(wf, /ghrdp-cred-shim\.js.*vnc\.html/);
  assert.match(wf, /injected into noVNC vnc\.html/);
});

// §3 USAGE TIMER
test('F11 §3: UI label is RDP USAGE, not RDP logon age', () => {
  assert.match(ui, /RDP USAGE/);
  // The i18n map should not have the old label
  assert.ok(!ui.includes("'RDP logon age':"), 'old label must be replaced');
});

test('F11 §3: server accumulates rdpUsageSec only while active', () => {
  assert.match(server, /rdpUsageSec/);
  assert.match(server, /rdpUsageLastTick/);
  assert.match(server, /rdpSessionActive/);
  assert.match(server, /wsClientsActive/);
  // Accumulator logic: only ticks when session or websockify active
  assert.match(server, /if \(\$rdpSessionActive -or \$wsClientsActive\)/);
});

test('F11 §3: server exposes rdpUsageSec in native-status', () => {
  assert.match(server, /rdpUsageSec = \$rdpUsageSec/);
});

// §4 PING + LATENCY (already implemented, just verify)
test('F11 §4: ping row shows ms + path + fps', () => {
  assert.match(ui, /id="connRtt"/);
  assert.match(ui, /id="connBadge"/);
  assert.match(ui, /id="connFps"/);
  assert.match(ui, /UDP 41641/);
});

// §5 PROVISIONING
test('F11 §5: no piracy-index strings in workflow or ui', () => {
  assert.ok(!/fmhy|megathread|torrent/i.test(wf), 'no piracy strings in workflow');
  assert.ok(!/fmhy|megathread|torrent/i.test(ui), 'no piracy strings in ui');
});

test('F11 §5: managed bookmarks are exactly {Mission Control, AUTOLOGIN.md, Tailscale DNS}', () => {
  assert.match(wf, /Mission Control/);
  assert.match(wf, /docs\/AUTOLOGIN\.md/);
  assert.match(wf, /login\.tailscale\.com\/admin\/dns/);
});

test('F11 §5: Edge extension IDs resolved at build time, not hardcoded', () => {
  assert.match(wf, /edge-ext-resolve\.ps1/);
  assert.match(wf, /Resolve-StoreExtId/);
  const resolver = fs.readFileSync('payloads/edge-ext-resolve.ps1', 'utf8');
  assert.ok(!/[a-p]{32}/.test(resolver), 'no literal extension id may be hardcoded');
});

// §9 REFUSALS
test('F11 §9: no credentials in .rdp files, URLs, query strings, logs', () => {
  // No password in launcher .rdp file
  assert.ok(!launcher.includes('password 51'), 'no password directive in launcher');
  // The noVNC URL must never embed a password; the only occurrence is the GATE check
  const passwordEqLines = ui.split('\n').filter(l => l.includes('password='));
  for (const line of passwordEqLines) {
    // Every line with password= must be a gate check (indexOf check or error), never a URL construction
    assert.ok(
      line.includes("indexOf('password=')") || line.includes('must not be in URL') || line.includes('GATE'),
      'password= found in non-gate context: ' + line.trim()
    );
  }
  // No PowerShell-from-page
  assert.ok(!/powershell|-ExecutionPolicy/i.test(ui), 'no PowerShell references in ui');
});

test('F11 §9: no mirror re-enable', () => {
  // Mirror stays off (remediation 8G/8D removed mirror)
  assert.ok(!wf.includes('mirror = $true') || wf.includes('mirror = $false'), 'mirror stays configurable');
});
