// [F24] AUTH-REJECT DISCRIMINATOR: server cred proof + 4625/CAPI2 evidence +
// lab matrix. Run: node --test tests/f24-auth-reject.test.js
//
// §1 pins the main.yml ValidateCredentials probe (call shape, credValid-only
// config write, loud fail, no password anywhere in its non-comment lines).
// §2 pins the keep-alive 4624/4625 collector (secret-free by construction).
// §3 EXECUTES the shipped pure core (authDecision, extracted verbatim from
// payloads/ui.html between the [F24 §3 matrix-begin/end] markers) against the
// full branch matrix - the same source autologin-lab cell U runs on Windows,
// so dashboard and proof cannot drift. The pwsh collector itself is executed
// for real (synthetic events + secret fish) by cell U; here the contract is
// pinned at source level.
const fs = require('fs');
const test = require('node:test');
const assert = require('node:assert');

const ui = fs.readFileSync('payloads/ui.html', 'utf8');
const wf = fs.readFileSync('.github/workflows/main.yml', 'utf8');
const launcher = fs.readFileSync('payloads/ghrdp-rdp-launcher.cs', 'utf8');
const gates = fs.readFileSync('.github/workflows/launch-gates.yml', 'utf8');
const lab = fs.readFileSync('.github/workflows/autologin-lab.yml', 'utf8');

function between(src, begin, end, what) {
  const a = src.indexOf(begin);
  assert.ok(a >= 0, `F24: ${what} missing (begin marker ${begin})`);
  const b = src.indexOf(end, a);
  assert.ok(b > a, `F24: ${what} not closed (end marker ${end})`);
  return src.slice(a, b);
}
const codeLines = (s) => s.split('\n').filter((l) => !/^\s*#/.test(l) && !/^\s*\/\//.test(l)).join('\n');

function proofStep() {
  const lines = wf.split('\n');
  const start = lines.findIndex((l) => /name: Server-side credential proof/.test(l));
  assert.ok(start > 0, 'F24 §1: main.yml lacks the server-side credential proof step');
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) if (/^      - name: /.test(lines[i])) { end = i; break; }
  return lines.slice(start, end).join('\n');
}

// ---------------------------------------------------------------------------
// §1 server-side credential proof
// ---------------------------------------------------------------------------
test('F24 §1: ValidateCredentials probe, credValid-only write, loud fail', () => {
  const step = proofStep();
  for (const tok of [
    'Add-Type -AssemblyName System.DirectoryServices.AccountManagement',
    'PrincipalContext([System.DirectoryServices.AccountManagement.ContextType]::Machine)',
    '$pcF24.ValidateCredentials([string]$env:RDP_USER, [string]$env:RDP_PASS)',
    "Add-Member -NotePropertyName credValid -NotePropertyValue $credValid -Force",
    'server-side credential invalid - user creation bug',
    "throw 'F24 server-side credential invalid - user creation bug'",
  ]) assert.ok(step.includes(tok), `F24 §1: proof step missing ${tok}`);
  // credValid is stamped into config BEFORE any throw (dashboard honesty).
  assert.ok(step.indexOf('NotePropertyName credValid') < step.indexOf("throw 'F24"), 'F24 §1: config write must precede the loud fail');
  // secret-free: RDP_PASS may appear ONLY in the ValidateCredentials call line
  const passLines = codeLines(step).split('\n').filter((l) => l.includes('RDP_PASS') && !l.includes('ValidateCredentials(') && !l.includes('-not $env:RDP_PASS'));
  assert.equal(passLines.length, 0, `F24 §1: password handled outside the probe: ${passLines.join(' | ')}`);
  assert.ok(!codeLines(step).match(/\$pass\b/), 'F24 §1: a $pass variable must not circulate in the step');
});

// ---------------------------------------------------------------------------
// §2 auth-failure evidence collector (contract; cell U executes it in pwsh)
// ---------------------------------------------------------------------------
test('F24 §2: collector queries Security 4624/4625 and is secret-free', () => {
  const fn = between(wf, '# [F24 §2 collector-fn-begin]', '# [F24 §2 collector-fn-end]', 'collector function');
  for (const tok of [
    "LogName = 'Security'", 'Id = 4624, 4625', "Name -eq 'Status'",
    "'0xc000006a' = 'wrong-password'", "'0xc000006d' = 'unknown-user-or-wrong-password'",
    "'0xc000015b' = 'logon-type-denied'", 'event-query-unavailable', 'bad4625', 'unknown-status',
  ]) assert.ok(fn.includes(tok), `F24 §2: collector missing ${tok}`);
  assert.ok(!/TargetUserName|TargetDomainName|SubjectUserName/i.test(codeLines(fn)), 'F24 §2: collector must read only Id + Status');
  const tick = between(wf, '# [F24 §2 tick-begin]', '# [F24 §2 tick-end]', 'keep-alive tick block');
  for (const tok of [
    'Get-F24AuthEvidence -WindowMinutes 10',
    'Add-Member -NotePropertyName authEvents -NotePropertyValue $f24ev -Force',
    'Add-Member -NotePropertyName rdpListener -NotePropertyValue $rdpLF24 -Force',
    'WriteAllText($cfgPath', 'bad4625',
  ]) assert.ok(tick.includes(tok), `F24 §2: tick missing ${tok}`);
  assert.ok(!/RDP_PASS|\$pass\b/.test(codeLines(tick)), 'F24 §2: tick must not touch passwords');
  // summary on demand only (change-gated), never every beat
  assert.ok(tick.includes('f24LastBad'), 'F24 §2: tick must only log when the failure count changes');
});

// ---------------------------------------------------------------------------
// §3 AUTH DECISION matrix - execute the SHIPPED pure core
// ---------------------------------------------------------------------------
const core = (() => {
  const blk = between(ui, '[F24 §3 matrix-begin]', '/* [F24 §3 matrix-end]', 'authDecision core');
  const close = blk.indexOf('*/');
  assert.ok(close > 0 && close < blk.indexOf('function authDecision'), 'F24 §3: core must open with its doc comment');
  return new Function(blk.slice(close + 2) + '\n; return authDecision;')();
})();

test('F24 §3: credValid=false => SERVER credential bug, red, no user action', () => {
  const d = core({ credValid: false, credValidWhy: 'ValidateCredentials returned false', credsspStatus: 'ok', authEvents: { bad4625: 3, statuses: ['0xc000006a'] } }, 'host.ts.net');
  assert.equal(d.state, 'err');
  assert.match(d.verdict, /^SERVER credential bug - re-dispatch$/);
  assert.match(d.why, /user-creation bug/);
  assert.match(d.why, /ValidateCredentials returned false/);
  assert.deepEqual(d.lines, []);
});

test('F24 §3: credValid=true + 4625 6A/6D => stale stored password, both copy-lines', () => {
  for (const code of ['0xC000006A', '0xc000006d']) {
    const d = core({ credValid: true, credsspStatus: 'ok', fqdn: 'fallback.ts.net', authEvents: { bad4625: 2, statuses: [code], reasons: ['wrong-password'] } }, 'runner.ts.net');
    assert.equal(d.state, 'warn');
    assert.match(d.verdict, /YOUR stored password is stale/);
    assert.equal(d.lines.length, 2, 'both copy-lines must be present');
    assert.equal(d.lines[0].copy, 'cmdkey /delete:TERMSRV:runner.ts.net');
    assert.equal(d.lines[1].copyFrom, 'credWinPass', 'password copy points at the KEYS row');
    assert.match(d.why, /CURRENT password from KEYS/);
    assert.match(d.why, /WINDOWS AUTO-LOGIN and paste the copied password exactly/);
  }
  // live FQDN absent => falls back to rdpListener.fqdn, never a dangling prefix
  const d2 = core({ credValid: true, authEvents: { bad4625: 1, statuses: ['0xc000006a'] }, fqdn: 'only.ts.net' }, '');
  assert.equal(d2.lines[0].copy, 'cmdkey /delete:TERMSRV:only.ts.net');
  // legacy single-string statuses (PS JSON quirk) still map
  const d3 = core({ credValid: true, authEvents: { bad4625: 2, statuses: '0xc000006a, 0xc000015b' } }, 'x.ts.net');
  assert.match(d3.verdict, /stale/);
});

test('F24 §3: credValid=true + NO 4625 => TLS-layer suspect with CAPI2/System copy-lines', () => {
  const d = core({ credValid: true, credsspStatus: 'ok', authEvents: { bad4625: 0, ok4624: 1, statuses: [] } }, 'h.ts.net');
  assert.equal(d.state, 'warn');
  assert.match(d.verdict, /TLS-layer suspect \(CAPI2\/Schannel\)/);
  assert.equal(d.lines.length, 2);
  assert.match(d.lines[0].copy, /^wevtutil epl Microsoft-Windows-CAPI2\/Operational %TEMP%\\capi2\.evtx$/);
  assert.match(d.lines[1].copy, /^wevtutil epl System %TEMP%\\system\.evtx$/);
  assert.ok(!d.lines[0].copy.includes('TERMSRV'), 'no credential mutation may ride the TLS branch');
});

test('F24 §3: 4625 with other codes => verbatim status + static label (6A/6D guidance NOT claimed)', () => {
  const d = core({ credValid: true, authEvents: { bad4625: 1, statuses: ['0xc000015b'] } }, 'h.ts.net');
  assert.equal(d.state, 'warn');
  assert.match(d.verdict, /logon-type-denied/);
  assert.ok(!/stale/i.test(d.verdict), 'must not blame the user for a policy refusal');
  assert.match(d.why, /0xc000015b/);
});

test('F24 §3: pending/warn credsspStatus renders verbatim + F21 pointer, never bare FAIL: pending', () => {
  const seen = [
    core(null, ''),
    core({ credValid: true, authEvents: { bad4625: 0, statuses: [] } }, 'h.ts.net'),
    core({ credsspStatus: 'pending', authEvents: { bad4625: 0, statuses: [] } }, 'h.ts.net'),
    core({ credsspStatus: 'ok-with-cipher-warn', authEvents: { bad4625: 0, statuses: [] } }, 'h.ts.net'),
  ];
  for (const d of seen) assert.ok(!/FAIL: pending/.test(d.verdict + ' ' + d.why), `F24 §3: bare FAIL: pending leaked: ${d.verdict}`);
  assert.match(seen[3].why, /ok-with-cipher-warn/);
  // the row renderer guards pending BEFORE the FAIL render
  const pg = ui.indexOf("if(cs==='pending')");
  const fl = ui.indexOf("('FAIL: '+cs)");
  assert.ok(pg > 0 && fl > pg, 'F24 §3: credssp row must route pending away from the FAIL render');
  assert.ok(ui.includes('PENDING - F21 not stamped yet'), 'F24 §3: pending needs the explicit verbatim render');
});

test('F24 §3: matrix is copy-only and wired into nativeStatus', () => {
  assert.ok(ui.includes('paintAuthDecision(rl,diagF)'), 'AUTH DECISION row must be driven by the live status refresh');
  assert.ok(ui.includes('id="nrAuthRow"') && ui.includes('id="nrAuthLines"'), 'row + lines containers missing');
  const renderer = ui.slice(ui.indexOf('function paintAuthDecision'), ui.indexOf('function paintBeacon'));
  for (const tok of ['code.id=ln.id', 'copyById(\'"+ln.id+"\',this)', 'copyById(\'"+ln.copyFrom+"\',this)'])
    assert.ok(renderer.includes(tok), `renderer missing ${tok}`);
  assert.ok(!/fetch\(|powershell|cmdkey \/generic:add|innerHTML\s*=\s*'cmdkey/i.test(renderer), 'renderer must stay copy-only');
});

// ---------------------------------------------------------------------------
// §4 + gates + lab wiring
// ---------------------------------------------------------------------------
test('F24 §4/§5/§6: no launcher delete verb, gates present, lab cell wired', () => {
  const csCode = launcher.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  assert.ok(!/\/delete/.test(csCode), 'F24 §4: the launcher must NOT gain a credential-delete verb');
  assert.ok(!/cmdkey \/add|cmdkey.exe \/add/i.test(csCode), 'F24 §4: launcher must not write credentials either');
  assert.ok(gates.includes('F24 auth-reject discriminator gates'), 'launch-gates lacks the F24 gate step');
  assert.ok(lab.includes('"U: F24 cred proof + 4625 collector parse + matrix render"'), 'autologin-lab lacks cell U');
  assert.ok(lab.includes('$env:U_result') && /u=' \+ \$\(if \(\$env:U_result/.test(lab), 'lab matrix summary must publish the u= flag');
  assert.ok(ui.includes("id=\"connDiagEvtSec\""), 'F20 evidence block must remain (matrix complements, never replaces it)');
});
