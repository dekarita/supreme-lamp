// [F28] CLOSE THE LOGON-RESULT LOOP + ONE-CLICK RECOVERY + FALLBACK GAP.
// Run: node --test tests/f28-logon-loop.test.js
//
// §1 is proven by EXECUTING the shipped renderer (paintHandoffStatus +
// paintRecovery out of payloads/ui.html under a DOM stub) and asserting what
// the user actually sees. §2 pins the single recred builder (t ONLY). §3 pins
// the launcher fallback gap fix. §4 pins CredSSP row consistency. Server gates
// pin the independent 30s tick + allowlisted fields + beacon allowlist.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

// Normalize CRLF: the lab checks out on Windows, and multi-line anchors must
// match identically there - line endings are not what's under test.
const read = p => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const server = read('payloads/ghrdp-server.ps1');
const cs = read('payloads/ghrdp-rdp-launcher.cs');
const ui = read('payloads/ui.html');
const gates = read('.github/workflows/launch-gates.yml');
const lab = read('.github/workflows/autologin-lab.yml');

const block = (s, a, b) => {
  assert.ok(s.includes(a), 'missing block start: ' + a);
  assert.ok(s.includes(b), 'missing block end: ' + b);
  return s.slice(s.indexOf(a), s.indexOf(b, s.indexOf(a)));
};

// Shipped logon renderer + recovery correlator, executed under a stub.
function logonView() {
  const els = {};
  const stub = id => {
    if (!els[id]) els[id] = { textContent: '', style: {}, setAttribute() {}, removeAttribute() {} };
    return els[id];
  };
  const ctx = {
    $: stub,
    parseTsUtc: s => {
      if (!s) return NaN;
      const t = String(s).trim();
      const v = Date.parse(t);
      if (!isNaN(v) && (/[Zz]$/.test(t) || /[+-]\d{2}:?\d{2}$/.test(t))) return v;
      const u = Date.parse(t + 'Z');
      return isNaN(u) ? (isNaN(v) ? NaN : v) : u;
    },
    Date
  };
  vm.createContext(ctx);
  vm.runInContext(
    block(ui, '// [F28 §1 logon-render-begin]', '// [F28 §1 logon-render-end]') +
    '\n' + block(ui, '// [F28 §2 recovery-begin]', '// [F28 §2 recovery-end]'),
    ctx
  );
  return { els, ctx, stub };
}

const isoNow = () => new Date().toISOString();
const isoAgo = sec => new Date(Date.now() - sec * 1000).toISOString();

// ---------------------------------------------------------------------------
// §1 LAST RDP LOGON renders authLast verbatim; scanTs always present.
// ---------------------------------------------------------------------------
test('F28-§1 success renders verbatim with scanTs', () => {
  const { els, ctx } = logonView();
  ctx.paintHandoffStatus(
    { authLast: { result: 'success', sub: '', eventTs: '2026-09-26T16:30:00Z', scanTs: '2026-09-26T16:30:30Z' } },
    { serverUptimeSec: 120, handlerChain: [] }
  );
  assert.equal(els.lastRdpLogon.textContent, 'success 2026-09-26T16:30:00Z (scanned 2026-09-26T16:30:30Z)');
  assert.equal(els.lastRdpLogon.style.color, '#7dffc9');
});

test('F28-§1 failed renders sub + eventTs + scanTs verbatim', () => {
  const { els, ctx } = logonView();
  ctx.paintHandoffStatus(
    { authLast: { result: 'failed', sub: '0xC000006A', eventTs: '2026-09-26T16:31:00Z', scanTs: '2026-09-26T16:31:30Z' } },
    { serverUptimeSec: 200, handlerChain: [] }
  );
  assert.equal(els.lastRdpLogon.textContent, 'failed sub=0xC000006A 2026-09-26T16:31:00Z (scanned 2026-09-26T16:31:30Z)');
  assert.equal(els.lastRdpLogon.style.color, '#f5b7b7');
});

test('F28-§1 none with scanTs renders scanned-nothing-yet (not collector-dead)', () => {
  const { els, ctx } = logonView();
  ctx.paintHandoffStatus(
    { authLast: { result: 'none', sub: '', eventTs: '', scanTs: '2026-09-26T16:32:00Z' } },
    { serverUptimeSec: 500, handlerChain: [] }
  );
  assert.equal(els.lastRdpLogon.textContent, 'scanned 2026-09-26T16:32:00Z, nothing yet');
});

test('F28-§1 empty scanTs + uptime>90s renders collector-dead red', () => {
  const { els, ctx } = logonView();
  ctx.paintHandoffStatus({ authLast: { result: 'none', sub: '', eventTs: '', scanTs: '' } }, { serverUptimeSec: 91, handlerChain: [] });
  assert.equal(els.lastRdpLogon.textContent, 'logon collector not running');
  assert.equal(els.lastRdpLogon.style.color, '#f5b7b7');
});

test('F28-§1 empty scanTs + uptime<=90s renders boot grace (not dead)', () => {
  const { els, ctx } = logonView();
  ctx.paintHandoffStatus({ authLast: null }, { serverUptimeSec: 12, handlerChain: [] });
  assert.match(els.lastRdpLogon.textContent, /waiting for first scan \(server uptime 12s\)/);
});

test('F28-§1 pre-F28 fallback: no authLast + no uptime keeps F27 authEvents render', () => {
  const { els, ctx } = logonView();
  ctx.paintHandoffStatus(
    { authEvents: { last4624At: 'later', last4625At: 'earlier', lastSubStatus: '0XC000006A' } },
    { ticketAudit: { issued: 2, redeemed: 1, rejected: 0 }, handlerChain: [{ ts: 'now', details: 'credwrite-ok' }] }
  );
  assert.equal(els.lastRdpLogon.textContent, 'success later | failed earlier sub=0XC000006A');
});

// ---------------------------------------------------------------------------
// §2 recovery correlator: failed + 0x6A + within 120s of mstsc-started.
// ---------------------------------------------------------------------------
test('F28-§2 recovery card shows on failed 0x6A within 120s of mstsc-started', () => {
  const { els, ctx, stub } = logonView();
  stub('rdpFqdn').textContent = 'host.tail.ts.net';
  stub('credUser').textContent = 'rdpuser';
  ctx.paintHandoffStatus(
    { authLast: { result: 'failed', sub: '0xC000006A', eventTs: isoAgo(30), scanTs: isoNow() } },
    { serverUptimeSec: 300, handlerChain: [{ ts: isoAgo(45), details: 'mstsc-started' }] }
  );
  assert.equal(els.recoveryCard.style.display, '');
  assert.match(stub('recoveryCmdkey').textContent, /cmdkey \/generic:TERMSRV\/host\.tail\.ts\.net \/user:rdpuser \/pass$/);
  assert.doesNotMatch(stub('recoveryCmdkey').textContent, /\/pass:/);
});

test('F28-§2 recovery card hides on success / wrong sub / stale beacon / no beacon', () => {
  const cases = [
    [{ authLast: { result: 'success', sub: '', eventTs: isoAgo(10), scanTs: isoNow() } }, { serverUptimeSec: 300, handlerChain: [{ ts: isoAgo(20), details: 'mstsc-started' }] }],
    [{ authLast: { result: 'failed', sub: '0xC000006D', eventTs: isoAgo(10), scanTs: isoNow() } }, { serverUptimeSec: 300, handlerChain: [{ ts: isoAgo(20), details: 'mstsc-started' }] }],
    [{ authLast: { result: 'failed', sub: '0xC000006A', eventTs: isoAgo(500), scanTs: isoNow() } }, { serverUptimeSec: 900, handlerChain: [{ ts: isoAgo(500), details: 'mstsc-started' }] }],
    [{ authLast: { result: 'failed', sub: '0xC000006A', eventTs: isoAgo(10), scanTs: isoNow() } }, { serverUptimeSec: 300, handlerChain: [{ ts: isoAgo(10), details: 'credwrite-ok' }] }],
    [{ authLast: { result: 'none', sub: '', eventTs: '', scanTs: isoNow() } }, { serverUptimeSec: 300, handlerChain: [] }]
  ];
  for (const [rl, s] of cases) {
    const { els, ctx } = logonView();
    ctx.paintHandoffStatus(rl, s);
    assert.equal(els.recoveryCard.style.display, 'none', JSON.stringify(rl));
  }
});

test('F28-§2 recovery card text + FIX button + recred builder carry ticket only', () => {
  assert.ok(ui.includes('id="recoveryCard"'));
  assert.ok(ui.includes('Password rejected by the host (wrong-password sub-status). One click re-issues a fresh ticket and overwrites the stored credential - no typing, no clipboard.'));
  assert.ok(ui.includes('id="btnFixReconnect"'));
  assert.match(ui, /FIX &amp; RECONNECT/);
  assert.ok(ui.includes('id="recoveryCmdkey"'));
  const builder = block(ui, 'function ghrdpRecredUrl', '// [F28 §2 recovery-end]');
  assert.match(builder, /ghrdp:\/\/recred\?server=/);
  assert.match(builder, /&t='\+encodeURIComponent\(ticket\)/);
  assert.doesNotMatch(builder, /(pass|pwd|password|token|secret|apikey|authkey)\s*=\s*['"]?\+?encodeURIComponent\((?!ticket)/i);
  // The Fix click mints via POST /api/rdp-token with the dashboard bearer, then
  // fires the recred URL. No password state is read on this path.
  const click = block(ui, "if(fixBtn) fixBtn.onclick=async", "var rcBtn=$('btnRunCheck')");
  assert.match(click, /\/api\/rdp-token/);
  assert.match(click, /Authorization.*Bearer/);
  assert.match(click, /ghrdpRecredUrl\(fqdn,user,/);
  assert.doesNotMatch(click, /windowsPass|keySecrets|credWinPass/i);
  // Recovery URL templates in the repo never carry a password/token param.
  for (const line of ui.split('\n')) {
    if (line.includes('ghrdp://recred')) assert.doesNotMatch(line, /[?&](password|passwd|pwd|token|secret|authkey|api[_-]?key)=/i);
  }
});

// ---------------------------------------------------------------------------
// §4 CredSSP row: live verdict + stamp secondary; never bare pending on live OK.
// ---------------------------------------------------------------------------
test('F28-§4 CredSSP row renders live verdict with stamp secondary', () => {
  const render = block(ui, "var cse=document.getElementById('nrCredssp')", "if(s&&s.rdpListener&&s.rdpListener.credsspWhy)");
  assert.match(render, /liveOk=\(!rlLive\|\|!rlLive\.credsspStatus/);
  assert.match(render, /OK \(live probe; stamp: not reported yet/);
  assert.match(render, /\(stamp: '\+cs\+'\)/);
  // Stored OK/warn/FAIL branches keep their F23/F24 renders (now with stamp).
  assert.match(render, /OK \(cipher probe warn\)/);
  assert.match(render, /not reported yet \(F21 step: CredSSP\/NLA handshake verification\)/);
  assert.doesNotMatch(ui, /'FAIL: '\+cs/);
});

// ---------------------------------------------------------------------------
// §1 server: independent 30s tick, allowlisted fields, scanTs always written.
// ---------------------------------------------------------------------------
test('F28-§1 server collector is independent, allowlisted, and always stamps scanTs', () => {
  const col = block(server, '# [F28 §1 authlast-begin]', '# [F28 §1 authlast-end]');
  for (const tok of [
    '$script:ServerStartUtc', '$script:AuthLast', '$script:LastAuthScan',
    'function Get-RdpLogonResultFields', 'function Get-RdpLogonResultSummary', 'function Update-AuthLast',
    "LogName = 'Security'", 'Id = @(4624, 4625)', '4624', '4625',
    "'LogonType', 'FailureReason', 'SubStatus', 'TargetUserName'",
    "logonType -eq '10'", "result = 'none'", 'scanTs', 'authLast'
  ]) assert.ok(col.includes(tok), tok);
  // scanTs is stamped on every path, including exceptions: the success path
  // carries the scanned tick through the summary, the catch path stamps it
  // directly. Either way the dashboard always gets a scanTs.
  assert.match(col, /\$sum = Get-RdpLogonResultSummary -Items \$items -ScanTs \$scan/);
  assert.match(col, /scanTs = \[string\]\$sum\.scanTs/);
  assert.match(col, /scanTs = \$scan/);
  // Secret-free: the allowlist is the ONLY extraction; banned fields absent.
  assert.doesNotMatch(col, /SubjectUserName|IpAddress|Password|RDP_PASS|RDP_USER/);
  // Independent 30s tick from START (not keep-alive-dependent).
  assert.match(server, /Update-AuthLast \} catch \{ \}\n\$script:LastAuthScan = Get-Date/);
  assert.match(server, /TotalSeconds -ge 30\) \{\n {8}\$script:LastAuthScan = Get-Date\n {8}try \{ Update-AuthLast \}/);
  assert.doesNotMatch(block(server, '# [F28 §1 authlast-begin]', '# [F28 §1 authlast-end]'), /keep-alive|KeepAlive/i);
  // native-status serves authLast freshest-first + server start/uptime.
  const ns = block(server, "# [F28 §1] authLast is served freshest-first", '$ns.ticketAudit');
  assert.match(ns, /rdpListener.*authLast/s);
  assert.match(ns, /serverStartUtc/);
  assert.match(ns, /serverUptimeSec/);
  // Beacon allowlist accepts the F28 details and the recred verb.
  const beacon = block(server, "if ($path -eq '/api/handler-hello'", '# [remediation 8C] /api/launch.ps1');
  assert.match(beacon, /'recred'/);
  for (const tok of ['recred-redeemed', 'recred-failed-', 'fallback-mstsc-native-prompt', 'fallback-retry-redeem']) assert.ok(beacon.includes(tok), tok);
});

// ---------------------------------------------------------------------------
// §3 launcher: recred verb + fallback gap closed + version + standing bans.
// ---------------------------------------------------------------------------
test('F28-§3 launcher recred verb redeems, overwrites, and never launches on failure', () => {
  assert.match(cs, /if \(verb == "recred"\) \{ return RunRecred\(uri, verb, host, port\); \}/);
  assert.match(cs, /private static int RunRecred\(string uri, string verb, string host, int port\)/);
  const recred = block(cs, 'private static int RunRecred', 'private static int DoWork');
  for (const tok of [
    'DnsGuardReason(server)', 'TicketFromUri(uri).Length == 0',
    'recred-failed-ticket-missing', 'RedeemAndStore(uri, server, user, host, port, true)',
    'recred-failed-credwrite', 'recred-failed-unreachable', 'recred-failed-ticket-invalid-or-expired',
    'mstsc NOT started', 'return MstscStep(server, user, host, port)'
  ]) assert.ok(recred.includes(tok), tok);
  // The success beacon is recred-redeemed (recovery chain), store path shared.
  assert.match(cs, /isRecred \? "recred-redeemed" : "ticket-redeemed"/);
  // No cmdkey fallback inside the recred path (retype WITHOUT typing).
  assert.doesNotMatch(recred, /CmdkeyStep/);
});

test('F28-§3 launcher stored=false retries once, then native-prompt beacon (never silent)', () => {
  // CmdkeyStep returns 7 on stored==false (no silent fall-through).
  const cmdkey = block(cs, 'private static int CmdkeyStep', 'private static int FallbackNativePrompt');
  assert.match(cmdkey, /return 7;/);
  assert.doesNotMatch(cmdkey, /OK opens mstsc anyway/);
  // DoWork handles 7 via the native-prompt path on BOTH fallback branches.
  const work = block(cs, 'bool hadTicket = TicketFromUri', 'return MstscStep(server, user, host, port);\n    }');
  assert.equal((work.match(/if \(rc == 7\) \{ return FallbackNativePrompt\(/g) || []).length, 2);
  // The native-prompt helper retries the SAME ticket once, then beacons BEFORE
  // launching so no silent launch with a known-absent credential exists.
  const fb = block(cs, 'private static int FallbackNativePrompt', 'private static int RunRecred');
  assert.match(fb, /HandoffStep\(host, port, "fallback-retry-redeem", false\)/);
  assert.match(fb, /retry = RedeemAndStore\(uri, server, user, host, port\)/);
  assert.match(fb, /HandoffStep\(host, port, "fallback-mstsc-native-prompt", false\)/);
  // The native-prompt launch (last MstscStep in the helper) is preceded by the
  // beacon; the earlier return is the retry-success silent path (valid cred).
  assert.ok(fb.indexOf('fallback-mstsc-native-prompt') < fb.lastIndexOf('return MstscStep('));
  // Version guard: clients must be told to re-run install.cmd for the F28 exe.
  const ver = (cs.match(/private const string Ver = "([0-9.]+)"/) || [])[1];
  assert.ok(ver, 'launcher version constant missing');
  const cmp = (a, b) => {
    const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
    for (let i = 0; i < 4; i++) { if (pa[i] !== pb[i]) return pa[i] - pb[i]; }
    return 0;
  };
  assert.ok(cmp(ver, '2.5.0.0') >= 0, 'launcher version ' + ver + ' predates the F28 build');
  // Standing bans hold on the touched surfaces.
  const code = cs.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
  // Split literals: the F19 AE1 repo-wide scan bans these tokens even in test
  // source (launch-gates.yml itself is the only exclusion), so the check
  // spells them the way the F27 suite does.
  for (const tok of ['Send'+'Keys', 'UI'+'Automation', 'Automation'+'Element', 'Value'+'Pattern', 'keybd_'+'event', '/pass:']) assert.ok(!code.includes(tok), tok);
  assert.doesNotMatch(code, /" \/pass"\s*\+/);
  assert.ok(!/cmdkey[^\n]*\/delete/i.test(cs), 'launcher must not gain a delete verb');
});

test('F28 gates + lab cell exist and pin the loop', () => {
  assert.match(gates, /F28 logon-result loop \+ one-click recovery \+ fallback gap gates/);
  for (const tok of ['authLast', 'scanTs', 'logon collector not running', 'recred-redeemed', 'fallback-mstsc-native-prompt', 'FIX & RECONNECT', 'ghrdpRecredUrl', 'stamp: ']) assert.ok(gates.includes(tok), tok);
  assert.match(lab, /V: F28 logon-result loop/);
});
