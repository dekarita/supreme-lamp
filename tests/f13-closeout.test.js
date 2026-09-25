// [F13] Close-out contract tests: byte-faithful user-held install.cmd, PS-free
// client payloads, no-password .rdp writer, VNC auto-submit deploy, telemetry
// anchors, provisioning shape, lab proof-matrix rows.
// Run: node --test tests/f13-closeout.test.js
const fs = require('fs');
const test = require('node:test');
const assert = require('node:assert');

const installCmd = fs.readFileSync('payloads/install.cmd', 'utf8');
const launcher = fs.readFileSync('payloads/ghrdp-rdp-launcher.cs', 'utf8');
const shim = fs.readFileSync('payloads/ghrdp-cred-shim.js', 'utf8');
const server = fs.readFileSync('payloads/ghrdp-server.ps1', 'utf8');
const ui = fs.readFileSync('payloads/ui.html', 'utf8');
const wf = fs.readFileSync('.github/workflows/main.yml', 'utf8');
const lab = fs.readFileSync('.github/workflows/autologin-lab.yml', 'utf8');
const gates = fs.readFileSync('.github/workflows/launch-gates.yml', 'utf8');

// EXECUTION tokens only: install.cmd legitimately NAMES the old handler in a
// rem/echo ("NOT powershell"); invoking a script host stays banned.
const EXEC_TOKEN = /powershell\.exe|-ExecutionPolicy|Invoke-Expression|-EncodedCommand|\bmshta\b|\bwscript\b|\bcscript\b/i;

test('F13 §1 install.cmd is the user-held text (pinned anchors)', () => {
  assert.ok(installCmd.startsWith('@echo off\r\n') || installCmd.startsWith('@echo off\n'));
  assert.match(installCmd, /setlocal EnableExtensions/);
  assert.match(installCmd, /set "SRC=%~dp0ghrdp-rdp-launcher\.cs"/);
  assert.match(installCmd, /set "DIR=%LOCALAPPDATA%\\ghrdp"/);
  assert.match(installCmd, /set "EXE=%DIR%\\ghrdp-rdp-launcher\.exe"/);
  assert.match(installCmd, /%SystemRoot%\\Microsoft\.NET\\Framework64\\v4\.0\.30319\\csc\.exe/);
  assert.match(installCmd, /%SystemRoot%\\Microsoft\.NET\\Framework\\v4\.0\.30319\\csc\.exe/);
  assert.match(installCmd, /echo BEFORE: & reg query "HKCU\\Software\\Classes\\ghrdp\\shell\\open\\command" \/ve 2>nul/);
  assert.match(installCmd, /\/target:winexe \/out:"%EXE%" \/r:System\.dll \/r:System\.Windows\.Forms\.dll "%SRC%"/);
  assert.match(installCmd, /URL:ghrdp Protocol/);
  assert.match(installCmd, /"URL Protocol" \/d "" \/f/);
  assert.match(installCmd, /\\\"%%1\\\"/);                // "<exe>" "%1"
  assert.match(installCmd, /echo AFTER: & reg query "HKCU\\Software\\Classes\\ghrdp\\shell\\open\\command" \/ve/);
  assert.match(installCmd, /echo DONE - the AFTER line must show ghrdp-rdp-launcher\.exe, NOT powershell\./);
  assert.ok(!EXEC_TOKEN.test(installCmd), 'install.cmd must never invoke a script host');
});

test('F13 §1 gate: launcher stays PS-free and its .rdp writer can emit no password', () => {
  assert.ok(!EXEC_TOKEN.test(launcher), 'launcher must never invoke a script host');
  const code = launcher.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  for (const bad of ['password 51', 'password=', '"password']) {
    assert.ok(!code.toLowerCase().includes(bad.toLowerCase()), '.rdp writer could emit ' + bad);
  }
  assert.match(launcher, /HelloBounded/);                 // bounded beacon, no wedge
  assert.match(launcher, /\/api\/handler-hello/);
});

test('F13 §2 provisioning shape: bookmarks are ONLY the allowed three, mirror defaults OFF', () => {
  const names = [...wf.matchAll(/@{ name = '([^']*)'; url = /g)].map((m) => m[1])
    .filter((n) => !n.startsWith('ghrdp-'));              // firewall rules are not bookmarks
  assert.deepEqual(new Set(names), new Set([
    'Mission Control',
    'Auto-login guide (docs/AUTOLOGIN.md)',
    'Tailscale Admin - DNS',
  ]), 'managed bookmarks must stay exactly the allowed three');
  assert.match(wf, /ExtensionInstallForcelist/);
  assert.match(wf, /Resolve-StoreExtId/);                 // Edge+CWS ids resolved AT BUILD
  assert.match(wf, /Resolve-AmoAddon -Slug 'ublock-origin'/);
  assert.match(wf, /Resolve-AmoAddon -Slug 'darkreader'/);
  assert.match(wf, /policies\.json/);                     // Firefox policies when installed
  assert.match(wf, /Set-QbittorrentDefaultHandler/);
  assert.ok(!/\$env:MIRROR_INPUT -eq 'false'/.test(wf), 'mirror must not be forced on');
  assert.match(wf, /\$mirrorOn = \(\$env:MIRROR_INPUT -eq 'true'\)/); // off unless opted in
  assert.ok(!/fmhy|megathread|1337x|thepiratebay|rarbg|torrentz|kickass/i.test(wf), 'no piracy-index strings');
});

test('F13 §3 VNC auto-submit: shim deployed into vnc.html, exact-origin, no password= URLs', () => {
  assert.match(wf, /ghrdp-cred-shim\.js/);
  assert.match(wf, /ghrdp-cred-origin/);
  assert.match(shim, /ev\.source !== window\.opener/);
  assert.match(shim, /originAllowed\(ev\.origin\)/);
  assert.match(shim, /RETRY_CAP = 5/);                    // 5x500ms retry
  assert.match(shim, /setInterval\(function \(\) {[\s\S]*?}, 500\)/);
  assert.match(shim, /pending = null/);                   // purge
  assert.match(ui, /postMessage\(\{type:'ghrdp-vnc-pass',pass:pass\},origin\)/);
  const badUi = ui.split('\n').filter((l) => l.includes('password=') && !l.includes('no launch URL ever carries'));
  assert.equal(badUi.length, 0, 'ui.html must not build a launch URL carrying password=');
  const badWf = wf.split('\n').filter((l) => l.includes('password=') && !/^\s*(#|rem\b)/.test(l));
  assert.equal(badWf.length, 0, 'workflows must not build a launch URL carrying password=');
});

test('F13 §4 telemetry anchors: usage accumulator freezes/resumes, ping row, relay advisory', () => {
  assert.match(server, /rdpUsageActive/);
  assert.match(server, /rdpUsageSec/);
  assert.match(server, /It freezes/);                     // freeze contract in the loop doc
  assert.match(server, /pingMs = \$rdpPingMs/);
  assert.match(server, /pingPath = \$rdpPingPath/);
  assert.match(ui, /UDP 41641/);                          // relay advisory
});

test('F13 §5 workflow optimization anchors: caches, setup report, Pages skip', () => {
  assert.match(wf, /actions\/cache@v4/);
  assert.match(wf, /C:\\ghrdp\\novnc/);
  assert.match(wf, /ghrdp-rust\\target/);
  assert.match(wf, /tightvnc-2\.8\.85\.msi/);
  assert.match(wf, /Setup time report \(F11-6\)/);
  assert.match(wf, /byte-identical/);                     // Pages PUT skipped when docs unchanged
});

test('F13 §6 lab proof matrix rows exist (fallback lab; ghrdp-lab still 404)', () => {
  assert.match(lab, /A: install\.cmd compiles \+ registers handler \(zero-prompt path\)/);
  assert.match(lab, /ghrdp-rdp-launcher\.exe/);
  assert.match(lab, /prompts-after-first=0/);
  assert.match(lab, /AFTER readback equals ghrdp-rdp-launcher\.exe/);
  assert.match(lab, /K: browser policies \+ extensions readback/);
  assert.match(lab, /L: qBittorrent \.torrent\/magnet default/);
  assert.match(lab, /M: zero console windows/);
  assert.match(lab, /N: handler overwrite \(stale value planted\)/);
  assert.match(lab, /H_result|H: /);                      // shim auto-fill cell
  assert.match(lab, /I_usage/);                           // usage freeze/resume cell
  assert.match(gates, /F13 close-out gates/);
  assert.match(gates, /F13 gates PASS/);
});
