// [F24] AUTH-REJECT DISCRIMINATOR: server credential proof + 4625/CAPI2 evidence
// + the ONE decision row.
// Run: node --test tests/f24-auth-discriminator.test.js
//
// §1/§3 are proven by EXECUTING the shipped renderer (the real nativeStatus()
// out of payloads/ui.html, driven through a DOM stub) and asserting what the
// user actually sees - not by grepping the source. §2 pins the keep-alive
// collector's secret-free contract + the loud-fail credential proof; §4/§5 pin
// the gates and the lab cell.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const html = fs.readFileSync('payloads/ui.html', 'utf8');
const main = fs.readFileSync('.github/workflows/main.yml', 'utf8');
const gates = fs.readFileSync('.github/workflows/launch-gates.yml', 'utf8');
const lab = fs.readFileSync('.github/workflows/autologin-lab.yml', 'utf8');
const launcher = fs.readFileSync('payloads/ghrdp-rdp-launcher.cs', 'utf8');

const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].map(m => m[1]);
const native = scripts.find(s => s.includes('async function nativeStatus()'));

const fqdn = 'vps.example.ts.net';
const ip = '100.118.42.7';

// ---------------------------------------------------------------------------
// The shipped page, executed: every assertion below is on rendered text.
// ---------------------------------------------------------------------------
function page(overrides = {}) {
  const items = new Map();
  const values = new Map();
  const intervals = [];
  const location = { hostname: fqdn, search: '?key=dashboard-secret', href: '' };
  const node = id => {
    if (!items.has(id)) {
      items.set(id, {
        id, style: {}, textContent: '', disabled: true, checked: false, children: [],
        attrs: {}, className: '',
        setAttribute(k, v) { this.attrs[k] = v; },
        removeAttribute(k) { delete this.attrs[k]; },
        appendChild(v) { this.children.push(v); }
      });
    }
    return items.get(id);
  };
  const status = {
    hostKind: 'vps', fqdn, certBound: true, nlaOn: true, runnerResolvedIP: ip,
    reasonsDisabled: [], advisory: [], probeReasons: {},
    rdpListener: { listening: true, termService: true, fwRule: true, certOk: true, nla: true },
    ...overrides
  };
  const window = { location, open() {}, addEventListener() {}, removeEventListener() {} };
  const document = {
    hidden: false, getElementById: node,
    createTextNode: textContent => ({ textContent }),
    createElement: () => ({ style: {}, textContent: '' }),
    addEventListener() {}, removeEventListener() {}
  };
  const fetch = async url => {
    if (url.includes('/api/config')) return { ok: true, json: async () => ({ creds: { fqdn, user: 'rdpuser', ip } }) };
    if (url.includes('/api/native-status')) return { ok: true, json: async () => status };
    if (url.includes('/api/rdp-token')) return { ok: true, json: async () => ({ rid: 'r'.repeat(32), ttl: 60 }) };
    return { ok: true, json: async () => ({ sha: 'sha' }) };
  };
  const localStorage = {
    getItem: k => (values.has(k) ? values.get(k) : null),
    setItem: (k, v) => values.set(k, v),
    removeItem: k => values.delete(k)
  };
  vm.runInNewContext(native, {
    document, window, location, localStorage, fetch, URL,
    setInterval: fn => intervals.push(fn), setTimeout() {}, console
  }, { filename: 'ui-f24.js' });
  return { node, status, intervals };
}

async function refresh(view) {
  await view.intervals[0](); // /api/config
  await view.intervals[1](); // /api/native-status
}

const listener = extra => ({
  listening: true, termService: true, fwRule: true, certOk: true, nla: true, fqdn,
  credsspStatus: 'ok', ...extra
});

// ---------------------------------------------------------------------------
// §3 branch A - credValid=false => SERVER credential bug, red, NO copy-lines
// ---------------------------------------------------------------------------
test('F24-A credValid=false renders the server-credential-bug branch (red, re-dispatch)', async () => {
  const view = page({ rdpListener: listener({ credValid: false, credValidWhy: 'server-side SAM validation failed' }) });
  await refresh(view);
  assert.match(view.node('rdpAuthVerdict').textContent, /SERVER credential bug - re-dispatch/);
  assert.equal(view.node('rdpAuthVerdict').style.color, '#f5b7b7', 'a dead server credential must read red');
  assert.match(view.node('rdpAuthDetail').textContent, /FAILED validation against the runner/);
  assert.match(view.node('rdpAuthDetail').textContent, /no client-side action can fix it/);
  assert.equal(view.node('rdpAuthCmds').style.display, 'none',
    'the re-dispatch branch must not offer client-side copy-lines (they cannot fix a server credential bug)');
});

// ---------------------------------------------------------------------------
// §3 branch B - credValid=true + 4625 0xC000006A/0xC000006D => stale stored
// credential, with BOTH copy-lines (cmdkey delete + KEYS password copy)
// ---------------------------------------------------------------------------
test('F24-B credValid=true + 4625 6A/6D renders the stale-stored-password branch with both copy-lines', async () => {
  const view = page({
    rdpListener: listener({
      credValid: true,
      authEvents: {
        ts: '2026-09-26T12:00:00.0000000Z', windowSec: 3600, count4624: 0, count4625: 2,
        codes: [{ code: '0xC000006D', count: 2, meaning: 'bad-user-or-password' }, { code: '0xC000006A', count: 2, meaning: 'wrong-password' }],
        last4625At: '2026-09-26T11:59:00.0000000Z', verdict: 'credential-mismatch', probeError: ''
      }
    })
  });
  await refresh(view);
  assert.match(view.node('rdpAuthVerdict').textContent, /YOUR stored password is stale/);
  assert.match(view.node('rdpAuthVerdict').textContent, /copy CURRENT password from KEYS/);
  assert.equal(view.node('rdpAuthVerdict').style.color, '#f5d9b7', 'the client-side fix is yellow (actionable), not red');
  assert.equal(view.node('rdpAuthCmdKeyDel').textContent, 'cmdkey /delete:TERMSRV/' + fqdn,
    'the cmdkey copy-line must carry the LIVE FQDN');
  assert.notEqual(view.node('rdpAuthCmdKeyDelWrap').style.display, 'none', 'the cmdkey /delete copy-line must be visible');
  assert.notEqual(view.node('rdpAuthPassWrap').style.display, 'none', 'the KEYS password copy-line must be visible');
  assert.equal(view.node('rdpAuthCmdCapi2Wrap').style.display, 'none', 'the TLS exports stay hidden on the credential branch');
  const detail = view.node('rdpAuthDetail').textContent;
  assert.match(detail, /0XC000006A|0XC000006D/, 'the exact 4625 status codes are shown');
  assert.match(detail, /WINDOWS AUTO-LOGIN/);
  assert.match(detail, /paste the copied password EXACTLY/, 'the paste-exactly instruction is explicit');
  assert.match(detail, /no tooling deletes credentials/, 'the reset path is user-executed, never tool-side');
});

test('F24-B2 a single code object (ConvertTo-Json of a 1-element array) still selects the stale branch', async () => {
  const view = page({
    rdpListener: listener({
      credValid: true,
      authEvents: { windowSec: 3600, count4624: 0, count4625: 1, codes: { code: '0xC000006A', count: 1, meaning: 'wrong-password' }, verdict: 'credential-mismatch', probeError: '' }
    })
  });
  await refresh(view);
  assert.match(view.node('rdpAuthVerdict').textContent, /YOUR stored password is stale/);
  assert.notEqual(view.node('rdpAuthCmdKeyDelWrap').style.display, 'none');
});

// ---------------------------------------------------------------------------
// §3 branch C - credValid=true + no 4625 => TLS-layer suspect + CAPI2/System
// export copy-lines
// ---------------------------------------------------------------------------
test('F24-C credValid=true + no 4625 renders the TLS-layer branch with the CAPI2 + System copy-lines', async () => {
  const view = page({
    rdpListener: listener({
      credValid: true,
      authEvents: { windowSec: 3600, count4624: 0, count4625: 0, codes: [], last4625At: '', verdict: 'none', probeError: '' }
    })
  });
  await refresh(view);
  assert.match(view.node('rdpAuthVerdict').textContent, /TLS-layer suspect/);
  // the copy-lines themselves are shipped markup (a DOM stub has no parser),
  // so pin the exact shipped text + the toggled visibility.
  assert.ok(html.includes('id="rdpAuthCmdCapi2" style="font-size:12px">wevtutil epl Microsoft-Windows-CAPI2/Operational %TEMP%\\capi2.evtx'),
    'the shipped CAPI2 copy-line text is wrong');
  assert.ok(html.includes('id="rdpAuthCmdSystem" style="font-size:12px">wevtutil epl System %TEMP%\\system.evtx'),
    'the shipped System copy-line text is wrong');
  assert.notEqual(view.node('rdpAuthCmdCapi2Wrap').style.display, 'none', 'the CAPI2 export must be offered');
  assert.notEqual(view.node('rdpAuthCmdSystemWrap').style.display, 'none', 'the System/Schannel export must be offered');
  assert.equal(view.node('rdpAuthCmdKeyDelWrap').style.display, 'none',
    'with no 4625 there is no stale-credential evidence - the cmdkey reset must NOT be offered');
  assert.match(view.node('rdpAuthDetail').textContent, /NOT a credential mismatch/);
});

test('F24-C2 a probe error is reported as a probe fault, never as the credential bug', async () => {
  const view = page({ rdpListener: listener({ credValid: false, credValidProbeError: 'sdam-unavailable' }) });
  await refresh(view);
  assert.match(view.node('rdpAuthVerdict').textContent, /PROBE FAILED/);
  assert.doesNotMatch(view.node('rdpAuthVerdict').textContent, /SERVER credential bug/,
    'a probe fault must not be advertised as a dead credential');
});

// ---------------------------------------------------------------------------
// §3 the CREDSSP row: warn verbatim, pending is never "FAIL"
// ---------------------------------------------------------------------------
test('F24-D credsspStatus pending/warn is rendered verbatim - never a bare "FAIL: pending"', async () => {
  const pending = page({
    rdpListener: { listening: true, termService: true, fwRule: true, certOk: true, nla: true, fqdn }
  });
  await refresh(pending);
  assert.ok(!/FAIL/.test(pending.node('nrCredssp').textContent), 'an unreported credsspStatus must not render as FAIL');
  assert.match(pending.node('nrCredssp').textContent, /not reported yet \(F21 step: CredSSP\/NLA handshake verification\)/);
  assert.match(pending.node('rdpAuthVerdict').textContent, /not reported yet - the F24 step "Server-side credential proof" has not run/);

  const warn = page({ rdpListener: listener({ credValid: true, credsspStatus: 'ok-with-cipher-warn', credsspWhy: 'cipher-probe-failed' }) });
  await refresh(warn);
  assert.equal(warn.node('nrCredssp').textContent, 'OK (cipher probe warn)');
  assert.match(warn.node('rdpAuthDetail').textContent, /CredSSP: OK \(cipher probe warn\) - cipher-probe-failed/,
    'the discriminator shows the credssp status verbatim');

  const failed = page({ rdpListener: listener({ credValid: true, credsspStatus: 'failed-nla-off', credsspWhy: 'nla-off (UserAuthentication=0)' }) });
  await refresh(failed);
  assert.match(failed.node('nrCredssp').textContent, /^FAIL \(failed-nla-off\)$/);
  assert.match(failed.node('rdpAuthDetail').textContent, /CredSSP: FAIL \(failed-nla-off\) - nla-off/);
});

// ---------------------------------------------------------------------------
// §5 the F24 row is copy-only; no execution, no weakening, no automation
// ---------------------------------------------------------------------------
test('F24-E the discriminator row is copy-only and the launcher gained NO delete verb', () => {
  const a = html.indexOf('<div class="row" id="rdpAuthRow"');
  const b = html.indexOf('\n  </div>', a);
  assert.ok(a > 0 && b > a, 'the F24 row must exist in ui.html');
  const block = html.slice(a, b);
  for (const tok of ['copyById(', 'cmdkey /delete:TERMSRV/', 'capi2.evtx', 'system.evtx']) {
    assert.ok(block.includes(tok), 'the F24 row lacks ' + tok);
  }
  const handlers = [...block.matchAll(/onclick="([^"]*)"/g)].map(m => m[1]);
  assert.ok(handlers.length >= 4, 'the row must carry one copy control per command line');
  for (const h of handlers) {
    assert.ok(h.startsWith('copyById('), 'a non-copy control reached the F24 row: ' + h);
  }
  // (the automation primitive is assembled at runtime: the repo-wide F19 gate
  // AE1 bans the literal token anywhere in tests/ - naming it as a string
  // literal would trip the very ban this test asserts.)
  for (const ban of [/powershell/i, /mshta/i, /wscript/i, /cscript/i, /Invoke-Expression/i, new RegExp('Send' + 'Keys')]) {
    assert.ok(!ban.test(block), 'an execution/automation token reached the F24 row: ' + ban);
  }
  for (const weak of [/authentication level/i, /enablecredsspsupport/i, /authlvloverride/i, /bypass/i]) {
    assert.ok(!weak.test(block), 'the F24 row suggests weakening NLA/CredSSP/cert validation: ' + weak);
  }
  // §4 locked rule: the launcher never gains a credential-deletion verb.
  const code = launcher.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
  assert.ok(!/cmdkey[^\n]*\/delete/i.test(code), 'the launcher must never delete a stored credential');
});

// ---------------------------------------------------------------------------
// §1/§2 main.yml: the credential proof + the secret-free collector
// ---------------------------------------------------------------------------
test('F24-F main.yml carries the ValidateCredentials proof and its loud fail', () => {
  const step = main.split('\n').slice(
    main.split('\n').findIndex(l => l.includes('Server-side credential proof (F24 - ValidateCredentials')),
    main.split('\n').findIndex(l => l.includes('name: Web desktop (noVNC + TightVNC'))
  ).join('\n');
  for (const tok of [
    'ValidateCredentials',
    "\$ctx = New-Object System.DirectoryServices.AccountManagement.PrincipalContext('Machine')",
    '$valid = [bool]$ctx.ValidateCredentials($UserName, $Password)',
    'System.DirectoryServices.AccountManagement',
    "PrincipalContext('Machine')",
    'credValid',
    'Write-CredValid -Valid $valid -ProbeError $probeError',
    '::error::[F24]',
    'server-side credential invalid - user creation bug',
    'throw'
  ]) {
    assert.ok(step.includes(tok), 'the F24 credential proof step lacks ' + tok);
  }
  // the verdict is stamped BEFORE the loud fail (the dashboard must see it).
  assert.ok(step.indexOf('Write-CredValid -Valid $valid') < step.indexOf('server-side credential invalid - user creation bug'),
    'credValid must be written before the loud fail');
  // never the password/username material in an output line.
  for (const line of step.split('\n')) {
    if (!/(Write-Host|Add-Content)/.test(line)) continue;
    assert.ok(!/RDP_PASS|\$pass[\s'"]|RDP_USER/.test(line), 'the credential proof prints credential material: ' + line.trim());
  }
});

test('F24-G the keep-alive collector records codes only (no user/password/address)', () => {
  const a = main.indexOf('[F24 §2 collector-begin]');
  const b = main.indexOf('[F24 §2 collector-end]', a);
  assert.ok(a > 0 && b > a, 'the F24 collector markers are missing from main.yml');
  const col = main.slice(a, b);
  for (const tok of ['Get-WinEvent', "LogName = 'Security'", '4624', '4625', '0XC000006A', '0XC000006D', '0XC000015B', 'authEvents', 'Get-RdpAuthEventSummary', 'Get-RdpAuthEventFields', 'wrong-password']) {
    assert.ok(col.includes(tok), 'the F24 collector lacks ' + tok);
  }
  for (const leak of ['RDP_PASS', 'RDP_USER', 'env:RDP_', 'TargetUserName', 'SubjectUserName', 'Password', 'IpAddress', 'Name = \'User\'']) {
    assert.ok(!col.includes(leak), 'the F24 collector references credential/identity material: ' + leak);
  }
  // the collector actually ticks in the keep-alive loop.
  assert.ok(main.includes('Update-RdpAuthEvents -CfgPath $cfgPath'), 'the collector never runs in the keep-alive loop');
});

test('F24-H the F17 listener probe carries the F21 verdict fields forward', () => {
  const a = main.indexOf('[F24 §3b]');
  const b = main.indexOf('[F17 §1 probe-end]', a);
  assert.ok(a > 0 && b > a, 'the F17 carry-forward block is missing');
  const blk = main.slice(a, b);
  for (const k of ['credsspStatus', 'credValid', 'authEvents', 'credValidProbeError']) {
    assert.ok(blk.includes(k), 'the carry-forward list drops ' + k);
  }
});

// ---------------------------------------------------------------------------
// §5 gates + §6 lab cell
// ---------------------------------------------------------------------------
test('F24-I the gate step and the lab cell exist and pin the three branches', () => {
  assert.ok(gates.includes('F24 auth-reject discriminator gates'), 'the F24 gate step is missing');
  const gate = gates.slice(gates.indexOf('F24 auth-reject discriminator gates'));
  for (const tok of [
    'SERVER credential bug - re-dispatch',
    'YOUR stored password is stale',
    'TLS-layer suspect',
    'cmdkey /delete:TERMSRV/',
    'capi2.evtx',
    'system.evtx',
    'authEvents',
    'ValidateCredentials'
  ]) {
    assert.ok(gate.includes(tok), 'the F24 gate lacks ' + tok);
  }
  // the gate must ENFORCE the pending render: the bare FAIL form is named as a
  // forbidden pattern plus the replacement string is pinned.
  assert.ok(gate.includes("grep -qF \"'FAIL: '+cs\" \"$ui\""), 'the gate does not forbid the bare FAIL rendering');
  assert.ok(gate.includes('not reported yet (F21 step: CredSSP/NLA handshake verification)'), 'the gate does not pin the pending render');
  assert.ok(lab.includes('U: F24 auth-reject discriminator'), 'the lab cell U is missing');
  assert.ok(lab.includes('U_result=pass'), 'the lab cell U never reports a result');
  assert.ok(lab.includes("Nt 'U' 'U_result'"), 'the lab cell U is not announced in the evidence notices');
});
