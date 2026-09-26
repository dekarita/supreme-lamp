// [F28] CLOSE THE LOGON-RESULT LOOP + ONE-CLICK RECOVERY + FALLBACK GAP.
// Run: node --test tests/f28-logon-recovery.test.js
//
// §1/§2/§4 are proven by EXECUTING the shipped renderer (the real nativeStatus()
// out of payloads/ui.html under a DOM stub) and the real recovery click handler
// (its URL builder + the POST /api/rdp-token -> ghrdp://recred handoff). §3 is
// proven against the shipped launcher source (the decision function the launcher
// itself runs in --fallback-selftest on the Windows lane). §5/§6 pin the gates
// and the lab cell.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const html = fs.readFileSync('payloads/ui.html', 'utf8');
const server = fs.readFileSync('payloads/ghrdp-server.ps1', 'utf8');
const launcher = fs.readFileSync('payloads/ghrdp-rdp-launcher.cs', 'utf8');
const main = fs.readFileSync('.github/workflows/main.yml', 'utf8');
const gates = fs.readFileSync('.github/workflows/launch-gates.yml', 'utf8');
const lab = fs.readFileSync('.github/workflows/autologin-lab.yml', 'utf8');
const windows = fs.readFileSync('tests/f27-windows.ps1', 'utf8');

const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].map(m => m[1]);
const native = scripts.find(s => s.includes('async function nativeStatus()'));
const fqdn = 'vps.example.ts.net';
const iso = ms => new Date(ms).toISOString();

// ---------------------------------------------------------------------------
// The shipped page, executed (same harness shape as the F24/F27 tests).
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
        attrs: {}, className: '', value: '',
        setAttribute(k, v) { this.attrs[k] = v; },
        removeAttribute(k) { delete this.attrs[k]; },
        appendChild(v) { this.children.push(v); }
      });
    }
    return items.get(id);
  };
  const status = {
    hostKind: 'vps', fqdn, certBound: true, nlaOn: true, runnerResolvedIP: '100.118.42.7',
    reasonsDisabled: [], advisory: [], probeReasons: {}, ticketAudit: {}, handlerChain: [],
    rdpListener: {
      listening: true, termService: true, fwRule: true, certOk: true, nla: true,
      credsspStatus: 'ok', credsspLive: 'ok',
      authLast: null, logonCollector: { alive: true, uptimeSec: 120, intervalSec: 30, scans: 4 }
    },
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
    if (url.includes('/api/config')) return { ok: true, json: async () => ({ creds: { fqdn, user: 'rdpuser', ip: '100.118.42.7' } }) };
    if (url.includes('/api/native-status')) return { ok: true, json: async () => status };
    if (url.includes('/api/rdp-token')) return { ok: true, json: async () => ({ rid: 'a'.repeat(32), ttl: 60 }) };
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
  }, { filename: 'ui-f28.js' });
  // the page's own DOM carries the live FQDN/user by the time a poll paints
  // (bootstrapConfig re-seeds them from /api/config after the __IP__ seed).
  node('rdpFqdn').textContent = fqdn;
  node('credUser').textContent = 'rdpuser';
  return { node, status, intervals };
}

async function refresh(view) {
  // named functions, so the harness never depends on registration order
  await view.intervals.find(f => f.name === 'bootstrapConfig')(); // /api/config
  await view.intervals.find(f => f.name === 'nativeStatus')();    // /api/native-status
}

// ---------------------------------------------------------------------------
// §1 LAST RDP LOGON: the server-side 30s scan, rendered verbatim
// ---------------------------------------------------------------------------
test('F28-1 LAST RDP LOGON renders authLast result+sub+eventTs+scanTs verbatim', async () => {
  const view = page({
    rdpListener: {
      listening: true, fwRule: true, certOk: true, nla: true, credsspLive: 'ok',
      authLast: {
        result: 'failed', sub: '0xC000006A', subMeaning: 'wrong-password',
        eventTs: '2026-09-26T16:20:00.0000000Z', scanTs: '2026-09-26T16:20:30.1234567Z',
        count4624: 0, count4625: 1, probeError: ''
      },
      logonCollector: { alive: true, uptimeSec: 300, intervalSec: 30, scans: 10 }
    }
  });
  await refresh(view);
  assert.equal(view.node('lastRdpLogon').textContent,
    'failed sub=0xC000006A (wrong-password) at 2026-09-26T16:20:00.0000000Z - scanned 2026-09-26T16:20:30.1234567Z');
  view.status.rdpListener.authLast = {
    result: 'success', sub: '', eventTs: '2026-09-26T16:25:00.0000000Z', scanTs: '2026-09-26T16:25:30.0000000Z', probeError: ''
  };
  await refresh(view);
  assert.equal(view.node('lastRdpLogon').textContent,
    'success at 2026-09-26T16:25:00.0000000Z - scanned 2026-09-26T16:25:30.0000000Z');
  view.status.rdpListener.authLast = {
    result: 'none', sub: '', eventTs: '', scanTs: '2026-09-26T16:30:30.0000000Z', windowStart: '2026-09-26T16:26:30.0000000Z', probeError: ''
  };
  await refresh(view);
  assert.match(view.node('lastRdpLogon').textContent, /^none yet - scanned 2026-09-26T16:30:30\.0000000Z/);
});

test('F28-1 collector-dead is RED and never a silent "not reported yet"', async () => {
  const view = page({
    rdpListener: {
      listening: true, fwRule: true, certOk: true, nla: true, credsspLive: 'ok',
      authLast: null, logonCollector: { alive: false, uptimeSec: 400, intervalSec: 30, scans: 0 }
    }
  });
  await refresh(view);
  assert.match(view.node('lastRdpLogon').textContent, /logon collector not running/);
  assert.equal(view.node('lastRdpLogon').style.color, '#f5b7b7');
  // a stamp that lost scanTs is the same verdict (scanTs is always written)
  view.status.rdpListener.authLast = { result: 'success', eventTs: '2026-09-26T16:00:00.0000000Z' };
  await refresh(view);
  assert.match(view.node('lastRdpLogon').textContent, /logon collector not running/);
});

test('F28-1 server-side tick is independent of the keep-alive step', () => {
  const block = server.slice(server.indexOf('# [F28 §1 scanner-begin]'), server.indexOf('# [F28 §1 scanner-end]'));
  assert.ok(block.length > 500, 'the scanner block is missing');
  for (const tok of [
    '$script:F28IntervalSec = 30', '$script:F28StaleSec = 90',
    "Id = @(4624, 4625)", "LogonType 10", "'security-log-unreadable'",
    'scanTs      = $scanTs', 'result      = $result', 'sub         = $sub', 'eventTs     = $eventTs',
    'function Get-RdpLogonAuthLast', 'function Update-RdpLogonAuthLast', 'function Get-RdpLogonCollectorState'
  ]) {
    assert.ok(block.includes(tok), 'scanner block lacks: ' + tok);
  }
  // scanTs is stamped BEFORE any branch: every result path carries it.
  const fn = block.slice(block.indexOf('function Get-RdpLogonAuthLast'));
  assert.ok(fn.indexOf('$scanTs = (Get-Date)') < fn.indexOf("$result = 'none'"),
    'scanTs must be stamped before the verdict branches');
  // the tick lives in the server process, from server start - and never in the
  // workflow's keep-alive loop (the F24 defect this closes).
  assert.ok(server.includes('try { Update-RdpLogonAuthLast -StatePath $script:LogonStatePath -ScanStartedUtc $script:ServerStartedUtc | Out-Null } catch { }'),
    'the startup scan is missing');
  assert.ok(server.includes('if (((Get-Date) - $lastLogonScan).TotalSeconds -ge $script:F28IntervalSec)'),
    'the 30s tick is missing from the accept loop');
  assert.ok(server.includes('$script:LogonStatePath = Join-Path $Root \'rdp-logon.json\''), 'state path missing');
  assert.ok(!main.includes('Update-RdpLogonAuthLast'), 'the logon scan leaked into the keep-alive workflow step');
  // served surface
  for (const tok of ['$logonState.authLast', '$logonState.logonCollector',
                     'rdpListener = $rlOut', '-NotePropertyName authLast', '-NotePropertyName logonCollector']) {
    assert.ok(server.includes(tok), 'native-status wiring lacks: ' + tok);
  }
  // the scanner never inventories credential material
  // FIELD-level scan: a reason SLUG ('wrong-password') is a status-code
  // description, not a credential - match field keys only (the F24 lab run
  // failed here once for exactly this reason).
  assert.doesNotMatch(block, /SubjectUserName|IpAddress|"Password"|ChangePassword|RDP_PASS/);
});

// ---------------------------------------------------------------------------
// §2 ONE-CLICK RECOVERY
// ---------------------------------------------------------------------------
test('F28-2 recovery correlator: only host-refused 0xC000006A within 120s of the launch', async () => {
  const now = Date.now();
  const beacon = { ts: iso(now - 40000), details: 'mstsc-started pid=4242' };
  const view = page({ handlerChain: [beacon] });
  view.status.rdpListener.authLast = {
    result: 'failed', sub: '0xC000006A', subMeaning: 'wrong-password',
    eventTs: iso(now - 30000), scanTs: iso(now - 20000)
  };
  await refresh(view);
  assert.equal(view.node('recoveryRow').style.display, 'flex', 'the recovery card must appear');
  assert.match(view.node('recoveryText').textContent, /Password rejected by the host/);
  assert.match(view.node('recoveryText').textContent, /no typing, no clipboard/);
  assert.equal(view.node('rdpFqdn').textContent, fqdn, 'the harness must resolve the live FQDN first');
  assert.equal(view.node('recoveryCmdkey').textContent, 'cmdkey /generic:TERMSRV/' + fqdn + ' /user:rdpuser /pass');
  assert.equal(view.node('btnFixReconnect').disabled, false);

  // (a) a different sub-status is NOT a wrong-password recovery case
  view.status.rdpListener.authLast.sub = '0xC000006D';
  await refresh(view);
  assert.equal(view.node('recoveryRow').style.display, 'none', '0xC000006D must not offer the recovery card');
  // (b) a successful logon is never a recovery case
  view.status.rdpListener.authLast = { result: 'success', eventTs: iso(now - 30000), scanTs: iso(now - 20000) };
  await refresh(view);
  assert.equal(view.node('recoveryRow').style.display, 'none');
  // (c) a failure more than 120s after the launch is stale evidence
  view.status.rdpListener.authLast = { result: 'failed', sub: '0xC000006A', eventTs: iso(now - 40000 + 180000), scanTs: iso(now) };
  await refresh(view);
  assert.equal(view.node('recoveryRow').style.display, 'none', 'a 180s-late failure must not re-open recovery');
  // (d) no mstsc-started beacon => the host was never reached
  view.status.rdpListener.authLast = { result: 'failed', sub: '0xC000006A', eventTs: iso(now - 30000), scanTs: iso(now - 20000) };
  view.status.handlerChain = [{ ts: iso(now - 40000), details: 'credwrite-ok' }];
  await refresh(view);
  assert.equal(view.node('recoveryRow').style.display, 'none', 'without an mstsc-started beacon there is no launch to correlate');
  // (e) the beacon/event pair just inside the window still shows
  view.status.handlerChain = [{ ts: iso(now - 120000), details: 'mstsc-started pid=7' }];
  view.status.rdpListener.authLast = { result: 'failed', sub: '0xc000006a', eventTs: iso(now - 1000), scanTs: iso(now) };
  await refresh(view);
  assert.equal(view.node('recoveryRow').style.display, 'flex', 'a 119s-old beacon with a fresh failure is in-window');
});

test('F28-2 FIX & RECONNECT mints a ticket then fires ghrdp://recred with ONLY t', async () => {
  const launch = [];
  const requests = [];
  const els = {
    rdpFqdn: { textContent: fqdn }, credUser: { textContent: 'rdpuser' }, recoveryNote: {},
    btnFixReconnect: { disabled: false, style: {} }
  };
  const ctx = {
    $: id => els[id], FQDN_RE: /\.ts\.net$/, getKey: () => 'fixture-bearer', apiBase: () => '',
    window: {}, encodeURIComponent, Date,
    fetch: async (url, opt) => { requests.push({ url, opt }); return { ok: true, status: 200, json: async () => ({ rid: 'b'.repeat(32), ttl: 60 }) }; },
    launchProto: u => launch.push(u)
  };
  vm.createContext(ctx);
  const src = a => html.slice(html.indexOf(a), html.indexOf(a.replace('begin', 'end')));
  vm.runInContext(src('// [F28 §2 recovery-url-begin]') + '\n' + src('// [F28 §2 recovery-click-begin]'), ctx);
  await ctx.frBtn.onclick();
  assert.equal(requests[0].url, '/api/rdp-token');
  assert.equal(requests[0].opt.method, 'POST');
  assert.equal(requests[0].opt.headers.Authorization, 'Bearer fixture-bearer');
  assert.equal(launch[0], 'ghrdp://recred?server=' + fqdn + '&user=rdpuser&t=' + 'b'.repeat(32));
  // the recovery URL may carry the ticket and identity ONLY - never a credential.
  const q = new URL(launch[0].replace('ghrdp://recred', 'https://x/y'));
  assert.deepEqual([...q.searchParams.keys()].sort(), ['server', 't', 'user']);
  assert.doesNotMatch(launch[0], /pass|password|pwd|secret|apikey/i);
  assert.match(els.recoveryNote.textContent, /recred-redeemed -> credwrite-ok -> mstsc-started/);
  // a ticket-issue failure launches nothing
  ctx.fetch = async () => ({ ok: false, status: 401 });
  await ctx.frBtn.onclick();
  assert.equal(launch.length, 1, 'a failed ticket issue must not launch anything');
  assert.match(els.recoveryNote.textContent, /ticket-issue failed/);
});

test('F28-2 launcher implements recred: redeem -> CredWrite overwrite -> mstsc, with beacons', () => {
  assert.ok(launcher.includes('if (verb == "recred") { return RecredStep('), 'the recred verb is not wired');
  const step = launcher.slice(launcher.indexOf('private static int RecredStep'), launcher.indexOf('private static int Main'));
  assert.ok(step.includes('"recred-redeemed"'), 'the recovery redemption beacon is missing');
  assert.ok(step.indexOf('RedeemAndStoreStep') < step.indexOf('MstscStep'), 'redeem must precede the launch');
  assert.ok(step.includes('CredentialFallbackDecision'), 'the recovery path must use the shared decision function');
  assert.ok(step.includes('MstscStep(server, user, host, port, true)'), 'the recovery fallback must be the native prompt');
  // the store path is the F27 one, normalised by F30: same-target purge of
  // BOTH entry variants, then the CRED_TYPE_DOMAIN_PASSWORD write.
  const handoff = launcher.slice(launcher.indexOf('// [F27 handoff-begin]'), launcher.indexOf('// [F27 handoff-end]'));
  assert.ok(handoff.includes('CredWriteW') && handoff.includes('c.Type = 2') && handoff.includes('c.Type = 1'));
  // [F30 §2.1] SUPERSEDED (was: no CredDelete token anywhere): the purge IS
  // the point now - CredEnumerate+CredDelete of the EXACT same target, both
  // type variants, immediately before the write. Still banned: a cmdkey
  // /delete invocation and any verb/request-driven deletion surface.
  assert.ok(handoff.includes('CredEnumerateW') && handoff.includes('CredDeleteW'),
    'F30: the purge must enumerate and delete same-target stale entries');
  const purgeAt = handoff.indexOf('int purged = PurgeStaleTargetCredentials(fqdn);');
  const writeAt = handoff.indexOf('if (!CredWrite(ref c, 0))');
  assert.ok(purgeAt > 0 && writeAt > purgeAt, 'F30: the purge must run before the write');
  assert.doesNotMatch(handoff, /cmdkey[^\n]*\/delete/i, 'a cmdkey /delete invocation stays banned');
  // server-side beacon allowlist accepts both new details verbatim
  assert.ok(server.includes('recred-redeemed'), 'the beacon allowlist lacks recred-redeemed');
  assert.ok(server.includes('fallback-mstsc-native-prompt'), 'the beacon allowlist lacks fallback-mstsc-native-prompt');
});

// ---------------------------------------------------------------------------
// §3 FALLBACK GAP: no silent mstsc with a known-absent credential
// ---------------------------------------------------------------------------
test('F28-3 stored=false retries the ticket ONCE and then uses the native prompt', () => {
  const work = launcher.slice(launcher.indexOf('private static int DoWork'), launcher.indexOf('private static int Main'));
  assert.ok(work.includes('if (storeOutcome == "stored") { return MstscStep(server, user, host, port); }'),
    'a stored credential must still launch normally');
  assert.ok(work.includes('if (storeOutcome == "abort") { return 1; }'),
    'a timed-out/cancelled prompt must abort without launching');
  const missing = work.slice(work.indexOf('// [F28 §3] stored=false'));
  assert.ok(missing.includes('RedeemAndStore(uri, server, user, host, port)'), 'the single retry redemption is missing');
  assert.ok(missing.includes('CredentialFallbackDecision(true, ticketPresent, retryOk)'), 'the decision call is missing');
  const beaconAt = launcher.indexOf('HandoffStep(host, port, "fallback-mstsc-native-prompt", false);');
  const launchAt = launcher.indexOf('ProcessStartInfo msi = new ProcessStartInfo("mstsc.exe"');
  assert.ok(beaconAt > 0 && launchAt > beaconAt, 'the native-prompt beacon must precede the mstsc launch');
  assert.ok(launcher.includes('nativePrompt ? ("\\"" + rdp + "\\" /prompt")'), 'the native-prompt launch flag is missing');
  assert.ok(launcher.includes('// [F28 §3 fallback-gap-begin]') && launcher.includes('// [F28 §3 fallback-gap-end]'),
    'the decision function is not marked for the gate/lab');
  const decision = launcher.slice(launcher.indexOf('// [F28 §3 fallback-gap-begin]'), launcher.indexOf('// [F28 §3 fallback-gap-end]'));
  assert.ok(decision.includes('private static string CredentialFallbackDecision(bool storeMissing, bool ticketPresent, bool retryOk)'));
  assert.ok(decision.includes('if (!storeMissing) { return "mstsc"; }'));
  assert.ok(decision.includes('if (ticketPresent && retryOk) { return "mstsc"; }'));
  assert.ok(decision.includes('return "native-prompt";'));
  // both flows use it and the lab harness proves the table on Windows.
  // code occurrences: the definition + the rdp path + the recred path + the selftest
  const decisionUses = launcher.split('\n').filter(l => !/^\s*\/\//.test(l)).filter(l => l.includes('CredentialFallbackDecision(')).length;
  assert.equal(decisionUses, 4,
    'the decision function must be defined once and used by the rdp path, the recred path and the selftest');
  assert.ok(launcher.includes('private static int FallbackSelfTestMain()'));
  assert.ok(launcher.includes('" nativePrompt=" + (decision == "native-prompt" ? "true" : "false")'));
  assert.ok(launcher.includes('if (IsFallbackSelfTest(args)) { return FallbackSelfTestMain(); }'));
  // refusals hold: no typing automation, no value-bearing /pass, no delete verb.
  const code = launcher.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
  for (const banned of ['Send' + 'Keys', 'UI' + 'Automation', 'Clipboard.Get', '/pass:']) {
    assert.ok(!code.includes(banned), 'the launcher gained ' + banned);
  }
  assert.match(code, /" \/user:" \+ user \+ " \/pass"\)/);
  assert.doesNotMatch(code, /" \/pass"\s*\+/);
});

// ---------------------------------------------------------------------------
// §4 CREDSSP row: live probe primary, config stamp secondary
// ---------------------------------------------------------------------------
test('F28-4 CREDSSP row renders the live probe and never a bare pending beside it', async () => {
  const view = page({ rdpListener: { listening: true, fwRule: true, certOk: true, nla: true, credsspLive: 'ok' } });
  await refresh(view);
  assert.equal(view.node('nrCredssp').textContent, 'OK (live probe) (stamp: none)');
  assert.ok(!/not reported yet/.test(view.node('nrCredssp').textContent), 'a live probe must never render as pending');
  // live probe warn wins over a stale 'ok' stamp, and the stamp stays visible
  view.status.rdpListener.credsspLive = 'warn';
  view.status.rdpListener.credsspLiveWhy = 'rdp-min-encryption-level=2';
  view.status.rdpListener.credsspStatus = 'ok';
  await refresh(view);
  assert.equal(view.node('nrCredssp').textContent, 'WARN (live probe: rdp-min-encryption-level=2) (stamp: ok)');
  // the listener checkbox and the row share the one verdict function
  assert.ok(html.includes('var credsspOk=credsspVerdict(rl).ok;'), 'the listener gate must use the shared verdict');
  assert.ok(html.includes('window.__listenerOk=!!(rl&&rl.listening===true&&rl.fwRule===true&&rl.certOk===true&&rl.nla===true&&credsspOk)'),
    'the listener gate line is pinned and must stay');
  assert.ok(html.includes("function credsspVerdict(rl)"), 'the shared verdict function is missing');
  assert.ok(html.includes("rl.credsspStatus==='ok-with-cipher-warn'"), 'the F23 stamp back-compat literal was dropped');
  // legacy config (no live probe at all): the historic renders stay exact
  const legacy = page({ rdpListener: { listening: true, fwRule: true, certOk: true, nla: true, credsspStatus: 'ok-with-cipher-warn' } });
  await refresh(legacy);
  assert.equal(legacy.node('nrCredssp').textContent, 'OK (cipher probe warn)');
  // server side: the live probe is computed at request time
  for (const tok of ['$csLive = \'unknown\'; $csLiveWhy = \'\'', "AllowEncryptionOracle", "rdp-security-layer=", "rdp-min-encryption-level=",
                     '-NotePropertyName credsspLive']) {
    assert.ok(server.includes(tok), 'the live CredSSP probe lacks: ' + tok);
  }
});

// ---------------------------------------------------------------------------
// §5 gates + §6 lab cell
// ---------------------------------------------------------------------------
test('F28-5 the gate step pins the loop, the recovery URL and the fallback gap', () => {
  assert.ok(gates.includes('F28 logon-result loop + one-click recovery + fallback-gap gates'), 'the F28 gate step is missing');
  const gate = gates.slice(gates.indexOf('F28 logon-result loop + one-click recovery + fallback-gap gates'));
  for (const tok of [
    'authLast', 'logonCollector', 'scanTs', 'logon collector not running', '0xC000006A',
    'ghrdp://recred', 'fallback-mstsc-native-prompt', 'CredentialFallbackDecision', 'stored=false'
  ]) {
    assert.ok(gate.includes(tok), 'the F28 gate lacks ' + tok);
  }
  // the recovery URL may not carry a credential-ish parameter
  assert.ok(/pass|password|pwd/.test(gate), 'the gate must name the forbidden URL parameters');
  assert.ok(gates.includes('F28 launcher fallback-gap decision matrix'), 'the Windows decision-matrix gate step is missing');
  assert.ok(gates.includes('--fallback-selftest'), 'the gate does not run the shipped decision harness');
  assert.ok(gates.includes('F28 server-side logon scanner'), 'the Windows scanner gate step is missing');
  assert.ok(gates.includes('# [F28 §1 scanner-begin]'), 'the gate does not extract the scanner block');
});

test('F28-6 the lab cell proves the scanner with synthetic events and the fallback gap on Windows', () => {
  assert.ok(lab.includes('V: F28 logon-result loop + one-click recovery + fallback gap'), 'the lab cell V is missing');
  assert.ok(lab.includes('V_result=pass'), 'the lab cell V never reports a result');
  assert.ok(lab.includes("Nt 'V' 'V_result'"), 'the lab cell V is not announced in the evidence notices');
  assert.ok(lab.includes('Get-RdpLogonAuthLast'), 'the lab cell does not drive the shipped scanner');
  assert.ok(lab.includes('fallback-selftest'), 'the lab cell does not run the shipped fallback matrix');
  // the Windows lane proves the scanner + the decision table without a live NLA
  // session (synthetic 4625 0x6A => failed/sub, 4624 type10 => success).
  assert.ok(windows.includes('Get-RdpLogonAuthLast'), 'the Windows proof does not exercise the shipped scanner');
  assert.ok(windows.includes('CredentialFallbackDecision'), 'the Windows proof does not exercise the decision function');
  assert.ok(windows.includes('scanTs'), 'the Windows proof does not assert the scanTs stamp');
  // and nothing in the F28 surfaces may invent a password sink. The server file
  // historically NAMES the removed /connect-now.bat violation in a comment, so
  // this ban is asserted on the launcher + the page (the executable surfaces).
  for (const f of [html, launcher]) {
    assert.doesNotMatch(f, /\/pass:\s*[^"'\s]/, 'a value-bearing /pass: switch appeared');
  }
});
