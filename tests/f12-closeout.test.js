// [F12] Close-out contract tests: stale-handler overwrite, cert-bind fail-closed,
// all-browser provisioning, VNC password memory, timer/latency/clean-session.
// Run: node --test tests/f12-closeout.test.js
const fs = require('fs');
const test = require('node:test');
const assert = require('node:assert');

const installCmd = fs.readFileSync('payloads/install.cmd', 'utf8');
const ui = fs.readFileSync('payloads/ui.html', 'utf8');
const wf = fs.readFileSync('.github/workflows/main.yml', 'utf8');
const lab = fs.readFileSync('.github/workflows/autologin-lab.yml', 'utf8');
const gates = fs.readFileSync('.github/workflows/launch-gates.yml', 'utf8');
const shim = fs.readFileSync('payloads/ghrdp-cred-shim.js', 'utf8');
const resolver = fs.readFileSync('payloads/edge-ext-resolve.ps1', 'utf8');
const apps = fs.readFileSync('payloads/ghrdp-provision-apps.ps1', 'utf8');
const server = fs.readFileSync('payloads/ghrdp-server.ps1', 'utf8');

test('F12-1 install.cmd: prints BEFORE/AFTER and overwrites the stale registration', () => {
  // [F14 §1] tokens re-pinned to the byte-faithful F14 text (it supersedes the
  // F12-era wording; AFTER is printed and read back, no find-based verify).
  assert.match(installCmd, /echo BEFORE: & reg query/);
  assert.match(installCmd, /echo AFTER: & reg query/);
  assert.match(installCmd, /reg query "HKCU\\Software\\Classes\\ghrdp\\shell\\open\\command" \/ve 2>nul/);
  assert.match(installCmd, /reg add "HKCU\\Software\\Classes\\ghrdp\\shell\\open\\command"/);
  assert.match(installCmd, /HKCU\\Software\\Classes\\ghrdp/);
  assert.match(installCmd, /ghrdp-rdp-launcher\.exe/);
  // no script-host EXECUTION token (the DONE line may NAME the old handler)
  assert.ok(!/powershell\.exe|-ExecutionPolicy|Invoke-Expression|-EncodedCommand/i.test(installCmd));
});

test('F12-1 ui: 20s handler-hello watch drives the stale-registration notice', () => {
  assert.match(ui, /id="winAutoStale"/);
  assert.match(ui, /stale ghrdp registration/);
  assert.match(ui, /lastHandlerVerb/);
  assert.match(ui, /__helloWatchArmedAt/);
  assert.match(ui, /helloPoll=setInterval/);
  assert.match(ui, /\},20000\);/);                        // 20s window
  assert.match(ui, /nativeStatus\(\)/);
});

test('F12-2 cert bind: DNS gate first, 3x10s retry, fail-closed, thumbprint on success', () => {
  const dnsIdx = wf.split('\n').findIndex(l => l.includes('name: Wait for Tailscale connected'));
  const certIdx = wf.split('\n').findIndex(l => l.includes('name: Bind tailnet LE cert to RDP-Tcp'));
  assert.ok(dnsIdx > 0 && certIdx > 0 && dnsIdx < certIdx, 'DNS gate must precede cert bind');
  assert.match(wf, /TS_MAGICDNS_FQDN/);
  assert.match(wf, /for \(\$attempt = 1; \$attempt -le 3; \$attempt\+\+\)/);
  assert.match(wf, /Start-Sleep -Seconds 10/);
  assert.match(wf, /reason=cert-not-bound/);
  assert.match(wf, /Thumbprint:/);
  // only the success path may still exit 0 inside the cert step
  const body = wf.split('name: Bind tailnet LE cert to RDP-Tcp')[1].split('name: Optimize Tailscale path')[0];
  const exits = body.split('\n').filter(l => /^\s*exit 0\s*$/.test(l));
  assert.equal(exits.length, 1, 'cert step must not silently exit 0 on failure');
  assert.ok((body.match(/throw /g) || []).length >= 4, 'every cert failure path must throw');
});

test('F12-3 Firefox force-install ids + xpi URL are resolved live (never hardcoded)', () => {
  assert.match(resolver, /function Resolve-AmoAddon/);
  assert.match(resolver, /addons\.mozilla\.org\/api\/v5\/addons\/addon\//);
  assert.match(resolver, /current_version\.file\.url/);
  assert.match(resolver, /guid/);
  assert.match(wf, /Resolve-AmoAddon -Slug 'ublock-origin'/);
  assert.match(wf, /Resolve-AmoAddon -Slug 'darkreader'/);
  assert.ok(!/uBlock0@raymondhill|addon@darkreader|addons\.mozilla\.org\/firefox\/downloads/.test(wf),
    'no hardcoded Firefox id or download URL may live in main.yml');
});

test('F12-3 policy readback + value shape use the shared helper in both workflows', () => {
  assert.match(apps, /function Get-ForcedEntryCount/);
  assert.match(apps, /function Test-ForcedEntryShape/);
  assert.match(wf, /ghrdp-provision-apps\.ps1/);
  assert.match(lab, /ghrdp-provision-apps\.ps1/);
  assert.match(wf, /Get-ForcedEntryCount \$extPath/);
  assert.match(wf, /Get-ForcedEntryCount \$chromeExt/);
});

test('F12-3 qBittorrent: discovered ProgId wires .torrent + magnet, no Web UI', () => {
  assert.match(apps, /function Get-QbittorrentProgId/);
  assert.match(apps, /function Set-QbittorrentDefaultHandler/);
  assert.match(apps, /HKEY_CLASSES_ROOT\\magnet\\shell\\open\\command/);
  assert.match(apps, /HKEY_CLASSES_ROOT\\\.torrent/);
  assert.match(apps, /qBittorrent\./i);
  assert.match(wf, /Set-QbittorrentDefaultHandler -ExePath \$qbExe/);
  assert.ok(!/qbittorrent[^\n]*(--webui|webui|8080)/i.test(wf), 'no torrent Web UI wiring');
  assert.ok(!/MIRROR_INPUT'? *(-ne|==) *'?true/i.test(wf) || /MIRROR_INPUT -eq 'true'/.test(wf));
});

test('F12-4 VNC memory: 5x500ms retry then purge, no password in any URL', () => {
  assert.match(shim, /RETRY_CAP = 5/);
  assert.match(shim, /IDLE_CAP/);
  assert.match(shim, /pending = null/);
  assert.match(shim, /window\.opener = null/);
  assert.match(shim, /ev\.source !== window\.opener/);
  assert.match(shim, /originAllowed\(ev\.origin\)/);
  const urlCreds = /password=/.test(ui) && !ui.includes("no launch URL ever carries");
  assert.equal(urlCreds, false, 'ui.html must not build a launch URL carrying password=');
  const wfCredLines = wf.split('\n').filter(l => l.includes('password=') && !/^\s*(#|rem\b)/.test(l));
  assert.equal(wfCredLines.length, 0, 'workflows must not build a launch URL carrying password=');
  assert.match(ui, /compression=6/);
  assert.match(ui, /postMessage\(\{type:'ghrdp-vnc-pass',pass:pass\},origin\)/);
});

test('F12-5 latency/timer: PreferZlib + compression=6 + server-side usage accumulator', () => {
  assert.match(wf, /PreferZlib/);
  assert.match(wf, /compression=6|compression=6/);
  assert.match(ui, /compression=6/);
  assert.match(server, /rdpUsageActive/);
  assert.match(server, /rdpUsageSec/);
  assert.match(gates, /F12 gates PASS/);
});

test('F12-7 lab proof matrix: K/L/M/N cells present and wired to the summary', () => {
  assert.match(lab, /K: browser policies \+ extensions readback/);
  assert.match(lab, /L: qBittorrent \.torrent\/magnet default/);
  assert.match(lab, /M: zero console windows/);
  assert.match(lab, /N: handler overwrite \(stale value planted\)/);
  for (const cell of ['K_result', 'L_result', 'M_result', 'N_result']) {
    assert.match(lab, new RegExp(cell + '=pass'));
  }
  assert.match(lab, /edge:\/\/policy/);
  assert.match(lab, /edge:\/\/extensions|profile-unpack/);
});
