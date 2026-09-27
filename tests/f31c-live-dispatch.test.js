// [F31c] TOKEN-AWARE PUSH + SELF-REPORTING DIAGNOSTIC MATRIX.
// Run: node --test tests/f31c-live-dispatch.test.js
//
// The LIVE DISPATCH STATUS card is EXECUTED here (the real liveDispatchStatus /
// paintLiveDispatch out of payloads/ui.html). The Windows lab cell Y drives the
// extracted token-diagnostic block with a failing git shim and asserts exit 1.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const main = fs.readFileSync('.github/workflows/main.yml', 'utf8');
const ui = fs.readFileSync('payloads/ui.html', 'utf8');
const srv = fs.readFileSync('payloads/ghrdp-server.ps1', 'utf8');
const gates = fs.readFileSync('.github/workflows/launch-gates.yml', 'utf8');
const lab = fs.readFileSync('.github/workflows/autologin-lab.yml', 'utf8');

function between(src, begin, end) {
  const a = src.indexOf(begin);
  const b = src.indexOf(end);
  assert.ok(a >= 0 && b > a, 'markers missing: ' + begin);
  return src.slice(a, b);
}

function loadDispatch() {
  const fn = between(ui, '// [F31c §2 live-dispatch-begin]', '// [F31c §2 live-dispatch-end]');
  const ctx = {
    document: { getElementById: id => (ctx.els[id] || (ctx.els[id] = { id, style: {}, textContent: '' })) },
    els: {},
    String, Number, RegExp, Date, Object, Math,
  };
  vm.createContext(ctx);
  vm.runInContext(fn, ctx);
  return ctx;
}

const NOW = Date.parse('2026-09-27T12:00:00.000Z');
const RECENT = '2026-09-27T11:58:00.000Z';
const OLD = '2026-09-27T11:00:00.000Z';

function greenStatus() {
  return {
    runnerResolvedIP: '100.118.42.7',
    pingMs: 42,
    fqdn: 'lab-runner.dekarita.ts.net',
    launcher: { beacons: [
      { details: 'invoked', ts: RECENT },
      { details: 'ticket-redeemed', ts: RECENT },
      { details: 'credwrite-ok', ts: RECENT },
      { details: 'mstsc-started pid=4', ts: RECENT },
    ] },
    rdpListener: {
      listenerHandshakeOk: true,
      connLog: {
        items: [{ id: '100', timeUtc: RECENT, reason: 'listener-lifecycle', desc: 'Listener started' }],
        schannelProbeError: '',
      },
      authEvents: {
        count4624: 1,
        last4624At: RECENT,
        events: [{ id: '4624', logonType: '10', timeUtc: RECENT }],
      },
    },
  };
}

test('F31c-1 token diagnostic is the first step and fails loud with the reconnect message', () => {
  const diag = main.indexOf('name: GitHub Token Diagnostic');
  const checkout = main.indexOf('name: Checkout repo (payloads)');
  const tailscale = main.indexOf('name: Download Tailscale installer');
  assert.ok(diag > 0 && checkout > diag, 'GitHub Token Diagnostic must be the first step, before checkout');
  assert.ok(tailscale > checkout, 'Tailscale setup must stay after checkout');
  const block = between(main, '# [F31c §1 token-diag-begin]', '# [F31c §1 token-diag-end]');
  assert.match(block, /Write-Host "Testing git push access\.\.\."/);
  assert.match(block, /git push --dry-run origin \$\{?\{ github\.ref \}\}?/);
  assert.match(block, /::error::git push failed/);
  assert.match(block, /Arena Settings -> GitHub Integration -> Reconnect/);
  assert.match(block, /Windows Credential Manager -> git:github.com -> Remove/);
  assert.ok(block.includes('exit 1'), 'a failed dry-run must exit 1 (no token bypass)');
  assert.ok(block.indexOf('exit 1') < block.indexOf('git push access confirmed'), 'success text must not precede the fail-loud exit');
  assert.match(block, /github_pat_\|tskey-/);
  assert.ok(!/Write-Host[^\\n]*\$env:GITHUB_TOKEN/.test(between(main, 'name: GitHub Token Diagnostic', 'name: Checkout repo (payloads)')),
    'the diagnostic must not print the token');
  assert.match(main, /name: GitHub Token Diagnostic[\s\S]{0,200}shell: pwsh/);
});

test('F31c-2 the card names all 5 checks and the page polls every 10s', () => {
  const fn = between(ui, '// [F31c §2 live-dispatch-begin]', '// [F31c §2 live-dispatch-end]');
  for (const name of ['Runner reachable', 'F31 bound', '36870 absent', 'Credential stored', 'Logon success']) {
    assert.ok(fn.includes(name), 'check missing: ' + name);
  }
  assert.ok(fn.includes('listenerHandshakeOk'));
  assert.ok(fn.includes('runnerResolvedIP'));
  assert.ok(fn.includes('pingMs'));
  assert.ok(fn.includes('launcher.beacons') || fn.includes('s.launcher'));
  assert.ok(fn.includes('authEvents'));
  assert.ok(fn.includes('36870'));
  assert.ok(ui.includes('id="liveDispatchRow"'));
  assert.ok(ui.includes('LIVE DISPATCH STATUS'));
  assert.ok(ui.includes('setInterval(function(){ try{ nativeStatus(); }catch(_){} }, 10000);'));
  assert.ok(ui.includes('paintLiveDispatch(s);'));
});

test('F31c-b 36870 present => key ACL dump needed copy-line to session', () => {
  const ctx = loadDispatch();
  const s = greenStatus();
  s.rdpListener.connLog.items.push({
    id: '36870', provider: 'Schannel', timeUtc: RECENT, reason: 'schannel-36870',
    desc: 'A fatal error occurred when attempting to access the TLS server credential private key',
  });
  const d = ctx.liveDispatchStatus(s, NOW);
  assert.equal(d.ok, false);
  const sch = d.checks.find(c => c.id === 'schannel');
  assert.equal(sch.ok, false);
  assert.equal(sch.detail, '36870 present');
  assert.equal(sch.fix, '36870 present => key ACL dump needed => copy-line to session');
  ctx.paintLiveDispatch(s, NOW);
  assert.match(ctx.els.liveDispatchChecks.textContent, /36870 present/);
  assert.match(ctx.els.liveDispatchChecks.textContent, /key ACL dump needed/);
  assert.match(ctx.els.liveDispatchFix.textContent, /36870 present => key ACL dump needed => copy-line to session/);
  assert.equal(ctx.els.liveDispatchAcl.style.display, 'flex');
  console.log(ctx.els.liveDispatchChecks.textContent);
  console.log(ctx.els.liveDispatchFix.textContent);
});

test('F31c-c ALL GREEN when all 5 checks pass', () => {
  const ctx = loadDispatch();
  const s = greenStatus();
  const d = ctx.liveDispatchStatus(s, NOW);
  assert.equal(d.ok, true);
  assert.equal(d.failed.length, 0);
  assert.equal(d.checks.map(c => c.name).join('|'), 'Runner reachable|F31 bound|36870 absent|Credential stored|Logon success');
  for (const c of d.checks) assert.equal(c.ok, true, c.name);
  ctx.paintLiveDispatch(s, NOW);
  assert.match(ctx.els.liveDispatchSummary.textContent, /ALL GREEN - runner reachable, F31 bound, 36870 absent, credential stored, logon success/);
  assert.doesNotMatch(ctx.els.liveDispatchChecks.textContent, /❌/);
  for (const name of ['Runner reachable', 'F31 bound', '36870 absent', 'Credential stored', 'Logon success']) {
    assert.match(ctx.els.liveDispatchChecks.textContent, new RegExp('✅ ' + name));
  }
  assert.equal(ctx.els.liveDispatchFix.textContent, '');
  assert.equal(ctx.els.liveDispatchAcl.style.display, 'none');
  assert.equal(ctx.els.manualVerifyCmdkey.textContent, 'cmdkey /delete:TERMSRV/lab-runner.dekarita.ts.net');
  console.log(ctx.els.liveDispatchSummary.textContent);
});

test('F31c-3 each check fails alone with exactly one fix', () => {
  const ctx = loadDispatch();
  const cases = [
    ['runner ip', s => { s.runnerResolvedIP = ''; }, 'runner', 'runnerResolvedIP absent => re-dispatch main.yml (F18 runner FQDN self-test)'],
    ['ping', s => { s.pingMs = 500; }, 'runner', 'ping=500ms (>= 500ms) => check Tailscale direct path (UDP 41641)'],
    ['f31', s => { s.rdpListener.listenerHandshakeOk = false; }, 'f31', 'F31 not bound => re-dispatch main.yml'],
    ['connlog missing', s => { s.rdpListener.connLog = null; }, 'schannel', 'connLog not reported => 36870 absence not proven => re-dispatch main.yml'],
    ['cred', s => { s.launcher.beacons = [{ details: 'invoked' }, { details: 'credwrite-ok' }, { details: 'invoked' }, { details: 'credwrite-failed' }]; }, 'cred', 'credwrite-ok absent from last attempt => click WINDOWS AUTO-LOGIN (ticket -> CredWrite); read the launcher beacon row if the chain stops earlier'],
    ['logon', s => { s.rdpListener.authEvents = { count4624: 1, last4624At: OLD, events: [{ id: '4624', logonType: '10', timeUtc: OLD }] }; }, 'logon', 'no 4624 type10 in last 10 minutes => click WINDOWS AUTO-LOGIN; if the session never reaches LSA, read SERVER CONN LOG (a pre-logon drop never writes 4624)'],
  ];
  for (const [label, mutate, id, fix] of cases) {
    const s = greenStatus();
    mutate(s);
    const d = ctx.liveDispatchStatus(s, NOW);
    const hit = d.checks.find(c => c.id === id);
    assert.equal(hit.ok, false, label);
    assert.equal(hit.fix, fix, label);
    assert.equal(d.fix, d.failed[0].fix, label + ' single fix is the first failure');
  }
});

test('F31c-4 a stale 36870 is not "present", an undated one is, type-3 4624 is not a logon', () => {
  const ctx = loadDispatch();
  const stale = greenStatus();
  stale.rdpListener.connLog.items.push({ id: '36870', timeUtc: OLD, reason: 'schannel-36870', desc: 'old' });
  assert.equal(ctx.liveDispatchStatus(stale, NOW).checks.find(c => c.id === 'schannel').ok, true);
  const undated = greenStatus();
  undated.rdpListener.connLog.items.push({ id: 36870, reason: 'schannel-36870', desc: 'no time' });
  assert.equal(ctx.liveDispatchStatus(undated, NOW).checks.find(c => c.id === 'schannel').detail, '36870 present');
  const type3 = greenStatus();
  type3.rdpListener.authEvents = { count4624: 0, events: [{ id: '4624', logonType: '3', timeUtc: RECENT }] };
  assert.equal(ctx.liveDispatchStatus(type3, NOW).checks.find(c => c.id === 'logon').ok, false);
  const unreadable = greenStatus();
  unreadable.rdpListener.connLog.schannelProbeError = 'schannel-log-unreadable';
  const u = ctx.liveDispatchStatus(unreadable, NOW).checks.find(c => c.id === 'schannel');
  assert.equal(u.ok, false);
  assert.match(u.fix, /copy-line to session/);
  const pingOk = greenStatus();
  pingOk.pingMs = 499;
  assert.equal(ctx.liveDispatchStatus(pingOk, NOW).checks.find(c => c.id === 'runner').ok, true);
});

test('F31c-5 MANUAL VERIFY STEPS are collapsed, copy-only, and carry the three lines', () => {
  const block = between(ui, '<!-- [F31c §3 manual-verify-begin]', '<!-- [F31c §3 manual-verify-end]');
  assert.match(block, /<details id="manualVerifySteps">/);
  assert.ok(!/details id="manualVerifySteps"[^>]*open/.test(block), 'the checklist must stay collapsed');
  assert.match(block, /If WINDOWS AUTO-LOGIN opens a browser prompt, click OPEN and tick always-allow/);
  assert.match(block, /If RDP window appears but shows 0x904\/0x7, run this in PowerShell on your PC:/);
  assert.match(block, /cmdkey \/delete:TERMSRV\//);
  assert.match(block, /Then click WINDOWS AUTO-LOGIN again/);
  assert.match(block, /If still failing, copy this and paste to the session:/);
  assert.match(block, /wevtutil qe System \/q:"\*\[System\[Provider\[@Name='Schannel'\]\]\]" \/c:10 \/f:text \| findstr "36870 36871"/);
  assert.match(ui, /cmdkey \/delete:TERMSRV\/'\+\(fqdn\|\|'<current-fqdn>'\)/);
  if (/powershell\.exe|-ExecutionPolicy|Invoke-Expression|-EncodedCommand|mshta|wscript|cscript/.test(block)) {
    assert.fail('the verify checklist contains a script-host launch token');
  }
  assert.ok(!/onclick="(?!copyById)/.test(block), 'every control in the checklist must be copyById');
});

test('F31c-6 server serves launcher.beacons and merges Schannel 36870 into connLog, without secrets', () => {
  const blk = between(srv, '# [F31c §2 schannel-begin]', '# [F31c §2 schannel-end]');
  assert.match(blk, /Get-F31cSchannelWindow/);
  assert.match(blk, /Merge-F31cConnLog/);
  assert.match(blk, /Id = @\(36870, 36871\)/);
  assert.match(blk, /schannel-log-unreadable/);
  assert.match(blk, /\[redacted\]/);
  assert.match(srv, /\$ns\.launcher = \[ordered\]@\{ beacons = @\(\$f31cBeacons\) \}/);
  assert.match(srv, /Merge-F31cConnLog -ConnLog \$connState\.connLog -Sch \(Get-F31cSchannelWindow\)/);
  assert.ok(!/RDP_PASS|windowsPass|\$Password/.test(blk), 'the schannel merge must not read a password (the redaction pattern may name the word)');
  const card = between(ui, '<!-- [F31c §2 live-dispatch-card-begin]', '<!-- [F31c §2 live-dispatch-card-end]');
  assert.ok(!/password=|\?key=/.test(card + blk), 'no credential in a URL');
});

test('F31c-7 gate + lab cell are pinned; new blocks do not weaken NLA', () => {
  assert.match(gates, /F31c token diagnostic \+ live dispatch gates/);
  assert.match(gates, /tests\/f31c-live-dispatch\.test\.js/);
  assert.match(lab, /Y: F31c token diagnostic fail-loud \+ live dispatch matrix/);
  assert.match(lab, /F31C_GIT_MODE/);
  assert.match(lab, /tests\/f31c-git-shim\.ps1/);
  const diag = between(main, 'name: GitHub Token Diagnostic', 'name: Checkout repo (payloads)');
  assert.ok(!/UserAuthentication.{0,12}0|AllowEncryptionOracle.{0,12}[12]|authentication level:i:0/.test(diag),
    'the token diagnostic must not weaken NLA');
});

test('F32 absent/nonboolean listenerHandshakeOk cannot render ALL GREEN', () => {
  for (const value of [undefined, null, false, 'true', 1]) {
    const ctx = loadDispatch(); const s = greenStatus();
    if (value === undefined) delete s.rdpListener.listenerHandshakeOk;
    else s.rdpListener.listenerHandshakeOk = value;
    assert.equal(ctx.liveDispatchStatus(s, NOW).ok, false);
    ctx.paintLiveDispatch(s, NOW);
    assert.doesNotMatch(ctx.els.liveDispatchSummary.textContent, /ALL GREEN/);
  }
});
