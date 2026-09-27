// [F37] RDP TELESCOPE - SELF-EXPLAINING OBSERVABILITY (client+runner+lab).
// Run: node --test tests/f37-telescope.test.js
//
// The telescope format is single-sourced in payloads/rdp-telescope.ps1; the
// lab, the live keep-alive tick, the server beacon channel, the launcher diag
// verb and the dashboard timeline all share its field names. The timeline
// merger (telescopeTimeline out of payloads/ui.html) is EXECUTED here over
// synthetic client+runner states; the Windows lab lane then drives the real
// module against the real listener (bind-effectiveness prints every field).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const main = fs.readFileSync('.github/workflows/main.yml', 'utf8');
const gates = fs.readFileSync('.github/workflows/launch-gates.yml', 'utf8');
const lab = fs.readFileSync('.github/workflows/autologin-lab.yml', 'utf8');
const tele = fs.readFileSync('payloads/rdp-telescope.ps1', 'utf8');
const srv = fs.readFileSync('payloads/ghrdp-server.ps1', 'utf8');
const ui = fs.readFileSync('payloads/ui.html', 'utf8');
const cs = fs.readFileSync('payloads/ghrdp-rdp-launcher.cs', 'utf8');

const SHARED = ['servedThumb', 'chainStatus', 'failurePoint', 'rst-before-cert', 'aclSids', 'deathPoint', 'traceId'];

test('F37-1 the telescope module carries every stage + the death classifier', () => {
  for (const tok of ['function Get-RdpTelescopeDns', 'function Get-RdpTelescopeTls',
    'function Get-RdpTelescopeCred', 'function Get-RdpTelescopeLogon',
    'function Get-RdpTelescopeSchannel', 'function Get-RdpTelescopeListener',
    'function Get-RdpTelescopeDeathPoint', 'function Invoke-RdpTelescope',
    'function Format-RdpTelescopeSummary', '0x03,0x00,0x00,0x13',
    'RemoteCertificateValidationCallback', 'SSLCertificateSHA1Hash',
    '36870', '36871', '36888', '12018', '4624', '4625', 'S-1-5-20', 'certutil']) {
    assert.ok(tele.includes(tok), 'telescope module lost: ' + tok);
  }
  // the TLS probe is permissive (reads RemoteCertificate even on chain
  // failure) so rst-before-cert and chain rejects are distinguishable - via a
  // STATIC .NET callback: handshake threads have no PowerShell runspace, so a
  // scriptblock callback dies with 'There is no Runspace available'.
  assert.ok(tele.includes('return true;'), 'the TLS callback is not permissive');
  assert.ok(tele.includes('CreateDelegate'), 'the callback is not a static delegate');
  assert.ok(!tele.includes('RemoteCertificateValidationCallback]{'), 'a scriptblock callback cannot run on handshake threads');
  assert.ok(tele.includes("'rst-before-cert'") && tele.includes("'chain='"),
    'the module cannot distinguish rst-before-cert from chain rejects');
});

test('F37-2 the telescope module is secret-free (handshake metadata only)', () => {
  // the two sub-status MEANING labels are the repo's existing classifier
  // vocabulary (same strings as the F24 collector), not secret reads.
  const code = tele.split('\n').filter(l => !/^\s*#/.test(l) &&
    !l.includes("subMeaning = 'wrong-password'") && !l.includes("subMeaning = 'bad-user-or-password'")).join('\n');
  for (const bad of ['password', 'passwd', 'securestring', 'credentialblob',
    'get-credential', 'read-host', 'networkcredential']) {
    assert.ok(!code.toLowerCase().includes(bad), 'secret-shaped token in telescope code: ' + bad);
  }
  // cmdkey /list never prints a secret; any other cmdkey switch is banned here.
  assert.ok(tele.includes('cmdkey.exe /list'), 'cred stage must use cmdkey /list');
  assert.ok(!/cmdkey\.exe\s+\/(add|delete|generic)/i.test(tele), 'telescope must never write/delete credentials');
});

test('F37-3 one format everywhere: lab+live+server+launcher+dashboard share it', () => {
  for (const tok of SHARED) {
    assert.ok(tele.includes(tok), 'module lost shared token: ' + tok);
  }
  assert.ok(lab.includes('rdp-telescope.ps1'), 'lab does not source the module');
  assert.ok(main.includes('rdp-telescope.ps1'), 'main.yml does not stage/run the module');
  for (const tok of ['servedThumb', 'failurePoint', 'deathPoint', 'diag-dns', 'diag-tcp', 'diag-tls', 'diag-cred', 'diag-done']) {
    assert.ok(cs.includes(tok), 'launcher lost shared token: ' + tok);
  }
  for (const tok of ['servedThumb', 'failurePoint', 'deathPoint', 'traceTimeline', 'diag-done']) {
    assert.ok(ui.includes(tok), 'dashboard lost shared token: ' + tok);
  }
  for (const tok of ['trace=', 'hh.trace', 'diag-dns:', 'diag-tls:', 'diag-done death=']) {
    assert.ok(srv.includes(tok), 'server beacon channel lost token: ' + tok);
  }
  assert.ok(gates.includes('F37 RDP telescope'), 'launch-gates has no F37 step');
});

test('F37-4 lab self-explanation: ServerAuth EKU + SAN, pre/post print, served==bound gate', () => {
  assert.ok(lab.includes('2.5.29.37={text}1.3.6.1.5.5.7.3.1'), 'lab cert lacks ServerAuth EKU');
  assert.ok(lab.includes("'localhost'"), 'lab cert lacks the localhost SAN');
  assert.ok(lab.includes('$env:COMPUTERNAME'), 'lab cert lacks the machinename SAN');
  assert.ok(lab.includes("Write-Telescope 'pre-bind'"), 'no pre-bind telescope');
  assert.ok(lab.includes("Write-Telescope 'post-bind'"), 'no post-bind telescope');
  assert.ok(lab.includes('### TELESCOPE '), 'telescope fields never reach the step summary');
  assert.ok(lab.includes('telescope servedThumb != boundThumb'), 'served==bound gate missing');
  assert.ok(lab.includes('telescope handshake not ok'), 'handshake-ok gate missing');
  // no cert cell may exit red without telescope fields in the failure.
  const fails = lab.split('\n').filter(l => l.includes("R-Fail 'bind-effectiveness'"));
  assert.ok(fails.length >= 3, 'expected >=3 bind-effectiveness fail sites, got ' + fails.length);
  for (const f of fails) {
    assert.ok(f.includes('telescope'), 'a bind-effectiveness failure carries no telescope diagnosis: ' + f.slice(0, 120));
  }
});

test('F37-5 live runner: the 60s tick stamps rdpListener.telescope + prints bound vs served', () => {
  assert.ok(main.includes('[F37 telescope-begin]'), 'keep-alive telescope block markers missing');
  assert.ok(main.includes('Update-RdpTelescopeTick'), 'keep-alive never runs the telescope tick');
  assert.ok(main.includes('Add-Member -NotePropertyName telescope'), 'telescope never lands in rdpListener');
  assert.ok(main.includes('[F37] TELESCOPE bound='), 'keep-alive never prints bound vs served');
  assert.ok(main.includes('rdp-telescope.ps1'), 'telescope never staged to the runner');
  assert.ok(ui.includes('id="srvConnLogTele"'), 'SERVER CONN LOG lost the live bound/served line');
});

test('F37-6 client: diag verb + per-click trace + RUN DIAG + ONE timeline row', () => {
  assert.ok(cs.includes('ghrdp://diag'), 'launcher has no diag verb');
  assert.ok(cs.includes('RunDiag'), 'launcher RunDiag missing');
  assert.ok(cs.includes('TraceFromUri'), 'launcher never parses the trace-id');
  assert.ok(ui.includes('mintTraceId'), 'dashboard never mints a trace-id');
  assert.ok(ui.includes('btnRunDiag'), 'dashboard has no RUN DIAG button');
  assert.ok(ui.includes('ghrdpDiagUrl'), 'dashboard has no diag URL builder');
  assert.ok(ui.includes('telescopeTimeline'), 'dashboard timeline merger missing');
  assert.ok(ui.includes('death-point'), 'dashboard never names the death point');
  assert.ok(ui.includes('&trace='), 'clicks never carry the trace-id');
  // the diag block diagnoses only: no mstsc, no credential write/delete.
  const b = cs.indexOf('[F37] ghrdp://diag');
  const e = cs.indexOf('private static int DoWork');
  assert.ok(b > 0 && e > b, 'launcher diag block markers missing');
  const blk = cs.slice(b, e);
  for (const bad of ['MstscStep', 'CredWrite(', 'cmdkey /delete', '/pass:']) {
    assert.ok(!blk.includes(bad), 'diag block must not launch/write/delete: ' + bad);
  }
  // beacons carry the trace: the server strips the prefix into its own field.
  assert.ok(srv.includes("'^trace="), 'server never parses the trace= prefix');
});

// ---------------------------------------------------------------------------
// §7 the timeline merger is EXECUTED over synthetic client+runner states.
// ---------------------------------------------------------------------------
function loadTimeline() {
  const begin = ui.indexOf('// [F37 timeline-begin]');
  const end = ui.indexOf('// [F30 §3 connlog-render-begin]');
  assert.ok(begin > 0 && end > begin, 'timeline markers missing in ui.html');
  const src = ui.slice(begin, end);
  const ctx = {
    document: { getElementById: id => (ctx.els[id] || (ctx.els[id] = { id, style: {}, textContent: '' })) },
    els: {}, window: {},
    String, Number, RegExp, Array, Object, Math, Date, JSON,
  };
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  assert.strictEqual(typeof ctx.telescopeTimeline, 'function', 'telescopeTimeline did not load');
  assert.strictEqual(typeof ctx.paintTraceTimeline, 'function', 'paintTraceTimeline did not load');
  return ctx;
}

function greenTele() {
  return {
    ts: '2026-09-27T08:00:00.0000000Z',
    dns: { ok: true, ip: '100.118.42.7', ms: 4, why: '' },
    tcp: { ok: true, rttMs: 12, why: '' },
    tls: { ok: true, servedThumb: 'AABBCC', protocol: 'Tls12', cipher: 'Aes256/256', chainStatus: [], policyErrors: 'None', failurePoint: 'none', why: '' },
    cred: { target: 'TERMSRV/h.ts.net', exists: false, type: '', user: '', scope: 'server' },
    logon: { last4624: '2026-09-27T08:01:00.0000000Z', last4625: '', sub: '', subMeaning: '', probeError: '' },
    schannel: { tail: [], probeError: '' },
    listener: { boundThumb: 'AABBCC', inStore: true, hasKey: true, container: 'C:\\keys\\x', certutilContainer: 'x', aclSids: ['S-1-5-20:Read:Allow', 'S-1-5-18:FullControl:Allow'] },
    deathPoint: 'none',
  };
}

test('F37-7 timeline: all-green runner + logon success => death none', () => {
  const ctx = loadTimeline();
  const t = ctx.telescopeTimeline([], null, greenTele(),
    { result: 'success', eventTs: '2026-09-27T08:01:00.0000000Z', scanTs: '2026-09-27T08:01:30.0000000Z', sub: '' },
    null, 'ok', '');
  assert.strictEqual(t.death, 'none', 'expected death none, got ' + t.death);
  assert.ok(t.line.includes('dns✅') && t.line.includes('acl✅'), 'green line must carry checkmarks: ' + t.line);
  assert.strictEqual(t.segs.length, 7, 'exactly the 7 segments must render');
});

test('F37-8 timeline: rst-before-cert names tls-cert; missing ACE names acl', () => {
  const ctx = loadTimeline();
  const rst = greenTele();
  rst.tls = { ok: false, servedThumb: '', protocol: '', cipher: '', chainStatus: [], policyErrors: '', failurePoint: 'rst-before-cert', why: 'X.224 connection reset/EOF' };
  let t = ctx.telescopeTimeline([], null, rst, null, null, 'ok', '');
  assert.strictEqual(t.death, 'tls-cert', 'rst-before-cert must name tls-cert, got ' + t.death);
  assert.ok(t.line.includes('tls-cert❌'), 'the red segment must carry the cross: ' + t.line);
  const noace = greenTele();
  noace.listener.aclSids = ['S-1-5-18:FullControl:Allow'];
  t = ctx.telescopeTimeline([], null, noace, null, null, 'ok', '');
  assert.strictEqual(t.death, 'acl', 'a missing NETWORK SERVICE ACE must name acl, got ' + t.death);
});

test('F37-9 timeline: client stages win the merge; first red is the death point', () => {
  const ctx = loadTimeline();
  const chain = [
    { ts: '2026-09-27T08:00:01Z', verb: 'diag', ok: false, details: 'diag-dns:fail dns-failed-SocketException', trace: 't-abc' },
    { ts: '2026-09-27T08:00:02Z', verb: 'diag', ok: false, details: 'diag-tcp:fail tcp-skipped-no-target', trace: 't-abc' },
    { ts: '2026-09-27T08:00:03Z', verb: 'diag', ok: true, details: 'diag-dns:ok ip=100.1.2.3 ms=9', trace: 't-other' },
  ];
  const t = ctx.telescopeTimeline(chain, 't-abc', greenTele(), null, null, 'ok', '');
  assert.strictEqual(t.death, 'dns', 'the client dns failure must be the death point, got ' + t.death);
  assert.strictEqual(t.segs[0].ok, false, 'dns segment must be red');
  assert.ok(t.segs[0].text.includes('client diag-dns'), 'client beacon must win the dns merge: ' + t.segs[0].text);
  // another trace-id must not leak into this timeline.
  const t2 = ctx.telescopeTimeline(chain, 't-other', null, null, null, '', '');
  assert.strictEqual(t2.segs[0].ok, true, 'the other trace must merge its own dns stage');
});

test('F37-10 timeline: chain reject => tls-chain; wrong-password => logon; painter names death', () => {
  const ctx = loadTimeline();
  const ch = greenTele();
  ch.tls = { ok: false, servedThumb: 'AABBCC', protocol: 'Tls12', cipher: 'Aes256/256', chainStatus: ['UntrustedRoot'], policyErrors: 'RemoteCertificateChainErrors', failurePoint: 'chain=UntrustedRoot', why: 'chain statuses: UntrustedRoot' };
  let t = ctx.telescopeTimeline([], null, ch, null, null, 'ok', '');
  assert.strictEqual(t.death, 'tls-chain', 'a chain reject must name tls-chain, got ' + t.death);
  t = ctx.telescopeTimeline([], null, greenTele(),
    { result: 'failed', sub: '0xC000006A', subMeaning: 'wrong-password', eventTs: '2026-09-27T08:02:00Z', scanTs: '2026-09-27T08:02:30Z' },
    null, 'ok', '');
  assert.strictEqual(t.death, 'logon', 'a refused password must name logon, got ' + t.death);
  // the DOM painter renders the one row + the red death line.
  ctx.window.__lastTraceId = 't-paint';
  ctx.paintTraceTimeline({ rdpListener: { telescope: greenTele(), authLast: { result: 'success', eventTs: 'e', scanTs: 's' }, credsspLive: 'ok' }, handlerChain: [] });
  assert.match(ctx.els.traceTimelineLine.textContent, /trace t-paint:/);
  assert.match(ctx.els.traceTimelineDeath.textContent, /death-point: none/);
  ctx.paintTraceTimeline({ rdpListener: { telescope: ch }, handlerChain: [] });
  assert.match(ctx.els.traceTimelineDeath.textContent, /death-point: tls-chain/);
  assert.strictEqual(ctx.els.traceTimelineDeath.style.color, '#f5b7b7', 'a death point must render red');
});
