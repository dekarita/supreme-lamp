// [F17] RDP 0x904/0x7 diagnosis contracts: runner-side rdpListener probe,
// UTC-safe beacon-age parse, client-DNS guard, lab-switch hygiene.
// Run: node --test tests/f17-listener.test.js
const fs = require('fs');
const test = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('child_process');

const mainYml = fs.readFileSync('.github/workflows/main.yml', 'utf8');
const ui = fs.readFileSync('payloads/ui.html', 'utf8');
const server = fs.readFileSync('payloads/ghrdp-server.ps1', 'utf8');
const launcher = fs.readFileSync('payloads/ghrdp-rdp-launcher.cs', 'utf8');
const gates = fs.readFileSync('.github/workflows/launch-gates.yml', 'utf8');
const lab = fs.readFileSync('.github/workflows/autologin-lab.yml', 'utf8');

function probeStep(src) {
  const lines = src.split('\n');
  let start = -1, end = -1;
  for (let i = 0; i < lines.length; i++) {
    if (start < 0 && /name: RDP listener self-probe \(F17/.test(lines[i])) { start = i; continue; }
    if (start >= 0 && /^      - name: /.test(lines[i])) { end = i; break; }
  }
  assert.ok(start > 0, 'probe step not found');
  if (end < 0) end = lines.length;
  return lines.slice(start, end).join('\n');
}

test('F17-1 main.yml: the §1 self-probe exists, writes rdpListener, fails LOUD with the exact field', () => {
  const p = probeStep(mainYml);
  for (const tok of [
    'Test-NetConnection 127.0.0.1 -Port 3389',
    'Get-Service TermService',
    "Get-NetFirewallRule -DisplayName 'ghrdp-rdp-3389'",
    "RemoteAddress '100.64.0.0/10'",
    'SSLCertificateSHA1Hash',
    'X509Chain',
    'certChainOk',
    'UserAuthentication',
    '[F17 §1 probe-begin]',
    '[F17 §1 probe-end]',
    'Add-Member -NotePropertyName rdpListener',
    '::error::[F17]',
    'throw',
  ]) assert.ok(p.includes(tok), 'probe step missing: ' + tok);
  // config write happens BEFORE the loud fail: a red run still publishes the
  // exact ❌ field to /api/native-status.
  const w = p.indexOf('Add-Member -NotePropertyName rdpListener');
  const f = p.indexOf('::error::[F17]');
  assert.ok(w > 0 && f > w, 'rdpListener must be written before the loud fail');
  // the probe runs AFTER the firewall + cert steps (ordering sanity).
  const fwStep = mainYml.indexOf('name: Enable RDP + harden + firewall');
  const certStep = mainYml.indexOf('name: Bind tailnet LE cert to RDP-Tcp');
  const probeAt = mainYml.indexOf('name: RDP listener self-probe (F17');
  assert.ok(fwStep > 0 && certStep > 0 && probeAt > fwStep && probeAt > certStep,
    'probe must run after firewall + cert steps');
});

test('F17-2 fwRule scope: 100.64.0.0/10 EXACTLY everywhere; 0.0.0.0/0 only in # comments', () => {
  const scoped = [...mainYml.matchAll(/RemoteAddress '([^']+)'/g)].map((m) => m[1]);
  for (const s of scoped) assert.strictEqual(s, '100.64.0.0/10', 'bad scope literal: ' + s);
  const rip = [...mainYml.matchAll(/remoteip=([0-9A-Za-z./]+)/g)].map((m) => m[1]);
  for (const s of rip) assert.strictEqual(s, '100.64.0.0/10', 'bad netsh scope: ' + s);
  const vps = fs.readFileSync('payloads/Provision-GhrdpVps.ps1', 'utf8');
  for (const m of vps.matchAll(/RemoteAddress '([^']+)'/g)) {
    assert.strictEqual(m[1], '100.64.0.0/10', 'bad VPS scope literal');
  }
  for (const line of mainYml.split('\n')) {
    if (line.includes('0.0.0.0/0')) {
      assert.match(line, /^\s*#/, '0.0.0.0/0 on an executable line: ' + line.trim().slice(0, 80));
    }
  }
});

test('F17-3 server: RoundtripKind UTC ts parse + per-run beacon store reset + rdpListener served', () => {
  assert.ok(server.includes('RoundtripKind'), 'server must parse ts with RoundtripKind');
  assert.ok(server.includes('function Get-RawJsonTs'), 'raw-ts extractor missing');
  assert.ok(server.includes('[F17 §2] per-run beacon store'), 'beacon store reset marker missing');
  assert.ok(server.includes("'handler-hello-last.json'"), 'beacon store file not reset');
  assert.ok(server.includes('rdpListener = $(if ($cfgN'), 'native-status must serve rdpListener');
  assert.ok(server.includes('rdpListenerAgeSec'), 'rdpListenerAgeSec missing');
  // the old local-shifted computations are gone.
  assert.ok(!server.includes('[datetime]::UtcNow - [datetime]$hh.ts'), 'beacon age still parsed via ConvertFrom-Json datetime');
  assert.ok(!server.includes('ts = [string]$lv.ts'), 'beacon echo still re-serializes a local datetime');
});

test('F17-4 ui: parseTsUtc treats bare ts as UTC in ANY machine timezone (+05:30 regression)', () => {
  const line = ui.split('\n').find((l) => l.startsWith('function parseTsUtc'));
  assert.ok(line, 'parseTsUtc missing');
  // TZ-sensitive proof in a child process: under TZ=Asia/Kolkata the OLD
  // Date.parse(bare-ts) shifted the age by exactly 19800s.
  const child = [
    "const line = process.argv[1];",
    "const f = eval('(' + line + ')');",
    "const assert = require('node:assert');",
    "assert.strictEqual(f('2026-01-01T00:00:00Z'), Date.parse('2026-01-01T00:00:00Z'));",
    "assert.strictEqual(f('2026-01-01T00:00:00+05:30'), Date.parse('2026-01-01T00:00:00+05:30'));",
    "assert.strictEqual(f('2026-01-01T00:00:00'), Date.parse('2026-01-01T00:00:00Z'), 'bare ts must read as UTC, not local');",
    "assert.ok(isNaN(f('')), 'empty -> NaN');",
    "console.log('ok');",
  ].join('\n');
  const r = spawnSync(process.execPath, ['-e', child, line], {
    env: { ...process.env, TZ: 'Asia/Kolkata' },
    encoding: 'utf8',
  });
  assert.strictEqual(r.status, 0, 'parseTsUtc is timezone-dependent (the +05:30 beacon-age bug): ' + r.stderr);
  assert.ok(ui.includes('parseTsUtc(b.ts)'), 'paintBeacon must use the UTC parse');
  assert.ok(ui.includes('parseTsUtc(hv)'), 'hello-watch must use the UTC parse');
  assert.ok(ui.includes('parseTsUtc(b.ts)') && ui.includes('[F17 §2] UTC/RoundtripKind parse'),
    'beacon age parse lacks the UTC/RoundtripKind handling');
});

test('F17-5 ui: RDP LISTENER row renders ✅/❌ + fix text and gates WINDOWS AUTO-LOGIN', () => {
  assert.ok(ui.includes('id="rdpListenerRow"'), 'RDP LISTENER row missing');
  assert.ok(ui.includes('RDP LISTENER'), 'RDP LISTENER label missing');
  assert.ok(ui.includes('function paintRdpListener'), 'renderer missing');
  for (const fix of [
    'fix: Start-Service TermService',
    'RemoteAddress 100.64.0.0/10',
    'fix: re-run "Bind tailnet LE cert"',
    'fix: set UserAuthentication=1 on RDP-Tcp (NLA on)',
  ]) assert.ok(ui.includes(fix), 'exact fix text missing: ' + fix);
  assert.ok(ui.includes('window.__listenerOk=!!(rl&&rl.listening===true&&rl.fwRule===true&&rl.certOk===true&&rl.nla===true)'),
    'AUTO-LOGIN gate must require listening+fw+cert+nla all ✅');
  assert.ok(ui.includes("var all=ok&&lOK&&dOK;"), 'syncWinAuto must AND the listener + runner DNS gates');
  assert.ok(ui.includes('RDP LISTENER probe not all ✅'), 'disabled-state note missing');
});

test('F17-6 ui: CONNECTION diagnostics are copy-only lines with the exact commands', () => {
  assert.ok(ui.includes('id="connDiagRow"'), 'CONNECTION diagnostics row missing');
  assert.ok(ui.includes("dp.textContent='ping '+diagF"), 'ping line missing');
  assert.ok(ui.includes("dt.textContent='Test-NetConnection '+diagF+' -Port 3389'"), 'TNC line missing');
  // copy-only: no button/script may execute the diagnostics.
  const row = ui.slice(ui.indexOf('id="connDiagRow"'), ui.indexOf('id="connDiagRow"') + 1600);
  assert.ok(!/onclick="(?!copyById)/.test(row), 'diagnostics row must be copy-only (no exec buttons)');
});

test('F17-7 launcher: DNS guard runs BEFORE any cmdkey/mstsc work and blocks dead names', () => {
  const code = launcher.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  assert.ok(code.includes('Dns.GetHostAddresses'), 'guard must resolve the fqdn');
  assert.ok(code.includes('IsTailnetAddress'), 'tailnet address check missing');
  assert.ok(code.includes('if (allTailnet) { return null; }'), 'mixed/non-tailnet DNS answers must be rejected');
  assert.ok(code.includes('every answer must be in 100.64.0.0/10'), 'DNS guard scope must be exact IPv4 tailnet range');
  assert.ok(code.includes('b[0] == 100 && b[1] >= 64 && b[1] <= 127'), '100.64.0.0/10 check missing');
  assert.ok(code.includes('dns-guard'), 'beacon reason missing');
  assert.ok(code.includes('DNS stale/blocked - flushdns or check Tailscale'), 'MessageBox text missing');
  assert.ok(code.includes('mstsc was NOT started'), 'the not-started verdict missing');
  // guard call precedes CmdkeyStep/MstscStep in DoWork.
  const gw = launcher.indexOf('string dnsProblem = DnsGuardReason(server);');
  const ck = launcher.indexOf('private static int CmdkeyStep');
  assert.ok(gw > 0 && ck > 0 && gw > ck, 'guard must be defined before use');
  const callAt = launcher.slice(gw).indexOf('int rc = CmdkeyStep(server, user, host, port);');
  assert.ok(callAt > 0, 'cmdkey must come after the guard in the rdp path');
  // rc 5 exit path + beacon ok:false.
  assert.ok(code.includes('return 5;'), 'dns-guard exit code missing');
  assert.match(code, /HelloBounded\(host, port, verb, false, "dns-guard: " \+ dnsProblem\)/);
  // the F15 fail-visible contract still holds.
  assert.strictEqual((launcher.match(/MessageBox\.Show/g) || []).length, 1, 'MessageBox.Show must stay single');
  assert.ok(!/CreateNoWindow|WindowStyle\.Hidden/.test(code), 'hidden-window flag survived');
});

test('F17-8 lab switches stay lab-only (relaxation in the lab, never in production)', () => {
  assert.ok(lab.includes('GHRDP_LAB_DNS_ALLOW_LOOPBACK'), 'lab must set the loopback relaxation');
  assert.ok(!mainYml.includes('GHRDP_LAB_'), 'a GHRDP_LAB_ switch leaked into production main.yml');
  // the .cs must document it as lab-only, and production default stays strict.
  assert.match(launcher, /LAB-ONLY relaxation/i);
});

test('F17-9 gates: the launch-gates F17 step exists and pins the contracts', () => {
  assert.match(gates, /name: F17 RDP listener probe \+ client-DNS guard gates/, 'gate step missing');
  for (const tok of ['0.0.0.0/0', 'RoundtripKind', 'parseTsUtc', 'rdpListenerRow', 'Dns.GetHostAddresses', 'GHRDP_LAB_DNS_ALLOW_LOOPBACK', 'X509Chain', 'every answer must be in 100.64.0.0/10']) {
    assert.ok(gates.includes(tok), 'gate does not pin: ' + tok);
  }
});
