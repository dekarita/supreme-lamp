// [F10] PS-free auto-login redirect + telemetry + gated creds + provisioning
// contract tests. Run: node tests/f10-autologin.test.js
const fs = require('fs');
const test = require('node:test');
const assert = require('node:assert');

const server = fs.readFileSync('payloads/ghrdp-server.ps1', 'utf8');
const ui = fs.readFileSync('payloads/ui.html', 'utf8');
const wf = fs.readFileSync('.github/workflows/main.yml', 'utf8');
const launcher = fs.readFileSync('payloads/ghrdp-rdp-launcher.cs', 'utf8');
const installer = fs.readFileSync('payloads/install.cmd', 'utf8');

test('F10-1 launcher: required .rdp directives, no password/resolution lines', () => {
  for (const d of [
    'screen mode id:i:2', 'redirectclipboard:i:1', 'redirectprinters:i:1',
    'redirectdrives:i:1', 'drivestoredirect:s:*', 'devicestoredirect:s:*',
    'redirectcomports:i:1', 'redirectsmartcards:i:1', 'redirectposdevices:i:1',
    'audiocapturemode:i:1', 'bandwidthautodetect:i:1', 'compression:i:1',
  ]) assert.ok(launcher.includes('"' + d + '"'), 'missing directive ' + d);
  const code = launcher.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  for (const bad of ['password 51', 'desktopwidth', 'desktopheight', 'prompt for credentials', 'enablecredsspsupport'])
    assert.ok(!code.toLowerCase().includes(bad), 'forbidden rdp line ' + bad);
  // FQDN discipline: only *.ts.net servers are accepted.
  assert.match(launcher, /\\\.ts\\\.net\$/);
  // interactive cmdkey, never scripted: /pass with NO value.
  assert.match(launcher, /cmdkey\.exe/);
  assert.match(launcher, /\/pass"\)/);
  assert.ok(!launcher.includes('/pass:'), 'never embeds a password');
  // telemetry beacon, no creds.
  assert.match(launcher, /\/api\/handler-hello/);
});

test('F10-1 install.cmd: in-box csc + HKCU registration, script-host free', () => {
  assert.match(installer, /Framework64\\v4\.0\.30319\\csc\.exe/);
  assert.match(installer, /HKCU\\Software\\Classes\\ghrdp/);
  assert.match(installer, /URL:ghrdp Protocol/);
  assert.match(installer, /ghrdp-launcher\.exe/);
  assert.ok(!/powershell|-ExecutionPolicy/i.test(installer), 'install.cmd must stay script-host free');
});

test('F10-2 server: rdpLogonAgeSec + ping fields + rdp-ping loop + client capture', () => {
  assert.match(server, /LogonType=10/);
  assert.match(server, /rdpLogonAgeSec = \$rdpLogonAgeSec/);
  assert.match(server, /pingMs = \$rdpPingMs/);
  assert.match(server, /pingPath = \$rdpPingPath/);
  assert.match(server, /rdp-ping\.json/);
  assert.match(server, /dash-client-ip\.txt/);
  assert.match(server, /tailscale\.exe/i);
  assert.match(server, /-c 1 -timeout 3s/);
  assert.match(server, /Start-Sleep -Seconds 15/);
});

test('F10-2/§3 creds block: single gated write site, strict transport gate', () => {
  assert.match(server, /function Test-CredsAllowed/);
  // gating: token OR tailnet source; bare loopback excluded from creds.
  assert.ok(/Test-CredsAllowed[\s\S]*?oct\[0\] -eq 100/.test(server) ||
            /oct\[0\] -eq 100[\s\S]*?Test-CredsAllowed/.test(server));
  assert.match(server, /\$credsAllowed = Test-CredsAllowed/);
  assert.match(server, /if \(\$cfgOut -and \$credsAllowed\)/);
  assert.match(server, /windowsPassMask/);
  assert.match(server, /vncPassMask/);
  // vncPass must be in the Remove-CredKeys strip list (non-gated responses).
  assert.match(server, /'rdpPass','vncPass'/);
  // creds fields must NOT appear in any other route block: exactly one
  // Add-Member write site for the raw values.
  assert.strictEqual((server.match(/Add-Member -MemberType NoteProperty -Name 'windowsPass'/g) || []).length, 1);
  assert.strictEqual((server.match(/Add-Member -MemberType NoteProperty -Name 'vncPass'/g) || []).length, 1);
});

test('F10-3 ui: WINDOWS AUTO-LOGIN + gated KEYS + logon age + ping row', () => {
  assert.match(ui, /id="btnWinAuto"/);
  assert.match(ui, /ghrdp:\/\/rdp\?server=/);
  assert.match(ui, /id="winAutoInstall"/);
  assert.match(ui, /install\.cmd \+ payloads\\ghrdp-rdp-launcher\.cs/);
  assert.match(ui, /id="credWinPass"/);
  assert.match(ui, /id="credVncPass"/);
  assert.match(ui, /windowsPassMask/);
  assert.match(ui, /\/api\/config'\+\(key\?\('/);
  assert.match(ui, /rdpLogonAgeSec/);
  assert.match(ui, /window\.__rdpLogon/);
  assert.match(ui, /id="connUdpAdv"/);
  assert.match(ui, /UDP 41641/);
  assert.match(ui, /srv '\+s\.pingMs/);
  assert.ok(!/powershell|-ExecutionPolicy/i.test(ui), 'ui must stay script-host free');
});

test('F10-4 workflow: gated vncPass stamp, latency keys, live ext resolution, clean bookmarks', () => {
  assert.match(wf, /Name 'vncPass' -Value \(\[string\]\$vp\)/);
  assert.ok(!/Write-Host[^\n]*\$vp[^a-zA-Z]/.test(wf), 'vncPass never printed');
  assert.match(wf, /PollUnderCursor/);
  assert.match(wf, /CompareFB/);
  assert.match(wf, /Resolve-EdgeExtId/);
  assert.match(wf, /ExtensionInstallForcelist/);
  assert.match(wf, /docs\/AUTOLOGIN\.md/);
  assert.match(wf, /login\.tailscale\.com\/admin\/dns/);
  assert.match(wf, /actions\/cache@v4/);
  assert.ok(!/fmhy|megathread|torrent/i.test(wf), 'no piracy-index strings');
});

test('F10-5 launch-gates carry the F10 block', () => {
  const gates = fs.readFileSync('.github/workflows/launch-gates.yml', 'utf8');
  assert.match(gates, /F10 PS-free launch \/ gated creds \/ bookmark gates/);
  assert.match(gates, /ghrdp-rdp-launcher\.cs/);
  assert.match(gates, /fmhy\|megathread\|torrent/);
  assert.match(gates, /Test-CredsAllowed/);
});
