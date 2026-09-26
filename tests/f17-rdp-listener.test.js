// [F17] RDP 0x904/0x7 diagnosis + self-reporting listener state.
// Run: node --test tests/f17-rdp-listener.test.js
const fs = require('fs');
const test = require('node:test');
const assert = require('node:assert');
const vm = require('node:vm');

const wf = fs.readFileSync('.github/workflows/main.yml', 'utf8');
const srv = fs.readFileSync('payloads/ghrdp-server.ps1', 'utf8');
const ui = fs.readFileSync('payloads/ui.html', 'utf8');
const cs = fs.readFileSync('payloads/ghrdp-rdp-launcher.cs', 'utf8');
const gates = fs.readFileSync('.github/workflows/launch-gates.yml', 'utf8');
const lab = fs.readFileSync('.github/workflows/rdp-listener-lab.yml', 'utf8');

// the probe step body (main.yml): from its name line to the next step
function probeBody(src) {
  const lines = src.split('\n');
  const start = lines.findIndex((l) => /name: RDP listener self-probe \(F17, fail-loud\)/.test(l));
  assert.ok(start > 0, 'F17 probe step not found in main.yml');
  const out = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^      - name: /.test(lines[i])) break;
    out.push(lines[i]);
  }
  return out.join('\n');
}

test('F17-1 probe: five self-reported fields, stored, then fail-loud', () => {
  const p = probeBody(wf);
  for (const f of ['listening', 'termService', 'fwRule', 'certThumb', 'nla']) {
    assert.match(p, new RegExp("\\$fields\\['" + f + "'\\]"), 'field missing: ' + f);
  }
  // the three fatal fields each throw the step (loud), and the step exits 1
  for (const f of ['listening', 'fwRule', 'certThumb']) {
    assert.ok(p.includes("if (-not $fields['" + f + "'])"), 'no loud-fail branch for ' + f);
  }
  assert.match(p, /exit 1/);
  assert.match(p, /::error::\[probe\]/);
  // the loud fail names the exact field values (summary + per-field detail)
  assert.match(p, /RDP listener self-probe FAILED/);
  assert.match(p, /listeningDetail/);
  assert.match(p, /termServiceDetail/);
  assert.match(p, /fwRuleDetail/);
  assert.match(p, /certThumbDetail/);
  assert.match(p, /nlaDetail/);
  // written where the stage step can carry it into config.json
  assert.match(p, /rdp-listener\.json/);
  assert.match(p, /Test-NetConnection 127\.0\.0\.1 -Port 3389/);
  assert.match(p, /ProbedAt|probedAt/);
});

test('F17-2 probe: firewall rule is GHRDP-RDP, all profiles, exactly 100.64.0.0/10', () => {
  const p = probeBody(wf);
  assert.match(p, /Get-NetFirewallRule -DisplayName 'GHRDP-RDP'/);
  assert.match(p, /New-NetFirewallRule -DisplayName 'GHRDP-RDP'.*RemoteAddress '100\.64\.0\.0\/10'/);
  assert.match(p, /\$rule \| Set-NetFirewallRule -RemoteAddress '100\.64\.0\.0\/10'/);
  // scope equality is EXACT and all profiles are required
  assert.match(p, /\$fwScopeNow -eq '100\.64\.0\.0\/10'/);
  assert.match(p, /-match 'Domain' -and \$profiles -match 'Private' -and \$profiles -match 'Public'/);
  // the repair path never WRITES a wider scope (naming it inside fix text is
  // allowed; a firewall write carrying it is not)
  const writes = p.split('\n').filter((l) => /-RemoteAddress[^\r\n]*0\.0\.0\.0\/0|remoteip=0\.0\.0\.0\/0/.test(l));
  assert.deepStrictEqual(writes, [], 'probe repair path writes a 0.0.0.0/0 scope');
  // a DISABLED rule is reported, not silently re-enabled
  assert.match(p, /rule DISABLED - fix: Enable-NetFirewallRule/);
  // the canonical rule name is what the enable step creates
  assert.match(wf, /@\{ name = 'GHRDP-RDP';\s+port = 3389; proto = 'TCP' \}/);
});

test('F17-3 stage: the probe result lands in config.json as rdpListener', () => {
  assert.match(wf, /rdp-listener\.json/);
  assert.match(wf, /rdpListener = \$rdpListener/);
  assert.match(wf, /rdpListener = \$rdpListener\n/);
});

test('F17-4 server: UTC beacon parse, per-run beacon reset, rdpListener pass-through', () => {
  // never parse the beacon ts as machine-local time
  assert.match(srv, /RoundtripKind/);
  assert.match(srv, /AssumeUniversal/);
  assert.match(srv, /\[datetime\]::Parse\(\$tsStr, \[System\.Globalization\.CultureInfo\]::InvariantCulture, \$tsStyle\)/);
  assert.ok(!/\[datetime\]\$hh\.ts\)\.TotalSeconds/.test(srv),
    'beacon age still casts the raw ts (local-timezone bug)');
  // per-run store: server start clears the previous run's beacon
  assert.match(srv, /Remove-Item -LiteralPath \(Join-Path \$Root 'handler-hello-last\.json'\) -Force/);
  // rdpListener is built with strict booleans and capped detail strings
  assert.match(srv, /rdpListenerOut/);
  assert.match(srv, /listening = \[bool\]\$rl\.listening/);
  assert.match(srv, /fwRule = \[bool\]\$rl\.fwRule/);
  assert.match(srv, /certThumb = \[bool\]\$rl\.certThumb/);
  assert.match(srv, /nla = \[bool\]\$rl\.nla/);
  assert.match(srv, /rdpListener = \$rdpListenerOut/);
  assert.match(srv, /Substring\(0, 240\)/);
});

test('F17-5 ui: RDP LISTENER row renders every field with its exact fix text', () => {
  assert.match(ui, /id="nrRdpListenerRow"/);
  assert.match(ui, /id="nrRdpListener"/);
  assert.match(ui, /window\.__rdpListenerOk/);
  assert.match(ui, /'\\u2705'/);
  assert.match(ui, /'\\u274C'/);
  // the five fields, with fwRule surfaced as fwScope
  const block = ui.slice(ui.indexOf('function renderRdpListener'), ui.indexOf('window.__rdpListenerTxt=failed.join'));
  for (const f of ['listening', 'termService', 'fwScope', 'cert', 'nla']) {
    assert.ok(block.includes("'" + f + "'"), 'listener row misses ' + f);
  }
  assert.match(block, /rl\.listeningDetail/);
  assert.match(block, /rl\.fwRuleDetail/);
  assert.match(block, /rl\.certThumbDetail/);
  assert.match(block, /rl\.nlaDetail/);
  // fail-closed when the probe never ran
  assert.match(ui, /not probed - re-dispatch the workflow or re-run VPS provisioning/);
});

test('F17-6 ui: AUTO-LOGIN is gated on the listener row', () => {
  const start = ui.indexOf('function syncWinAuto()');
  const end = ui.indexOf('setInterval(syncWinAuto', start);
  assert.ok(start > 0 && end > start);
  const sync = ui.slice(start, end);
  assert.match(sync, /__rdpListenerOk===true/);
  assert.match(sync, /&&rlGate/);
  assert.match(sync, /RDP LISTENER not all OK/);
});

test('F17-7 ui: beacon age parses UTC (parseTs / Date.UTC), never bare Date.parse', () => {
  assert.match(ui, /function parseTs\(s\)/);
  assert.match(ui, /Date\.UTC\(/);
  assert.match(ui, /parseTs\(b\.ts\)/);
  assert.match(ui, /parseTs\(hv\)/);
  const bad = ui.split('\n').filter((l) => /Date\.parse\((b\.ts|hv)\)/.test(l) && !/^\s*\/\//.test(l));
  assert.deepStrictEqual(bad, [], 'a bare Date.parse survives on the beacon timestamp');
});

test('F17-8 ui: CONNECTION diagnostics are copy-only (no buttons, no scripts)', () => {
  assert.match(ui, /id="nrConnDiagRow"/);
  assert.match(ui, /id="nrConnDiag1"/);
  assert.match(ui, /id="nrConnDiag2"/);
  assert.match(ui, /'ping '\+fqdn/);
  assert.match(ui, /'Test-NetConnection '\+fqdn\+' -Port 3389'/);
  assert.match(ui, /ipconfig \/flushdns/);
  const lines = ui.split('\n').filter((l) => /nrConnDiag/.test(l) && !/^\s*\/\//.test(l));
  for (const l of lines) {
    assert.ok(!/onclick|button/i.test(l), 'CONNECTION row carries a handler/button: ' + l.trim());
  }
  assert.ok(!/powershell\.exe|-EncodedCommand|-ExecutionPolicy/.test(ui));
});

test('F17-9 launcher: DNS guard blocks a dead name before mstsc (and before cmdkey)', () => {
  const body = cs.slice(cs.indexOf('private static int DoWork('), cs.indexOf('private static int Main('));
  const iTarget = body.indexOf('invalid target');
  const iGuard = body.indexOf('DnsGuard(server, host, port, out dnsWhy)');
  const iCmdkey = body.indexOf('CmdkeyStep(server, user, host, port)');
  const iMstsc = body.indexOf('MstscStep(server, user, host, port)');
  assert.ok(iTarget > 0 && iGuard > iTarget, 'DNS guard must run after target validation');
  assert.ok(iCmdkey > iGuard, 'DNS guard must run BEFORE the credential prompt');
  assert.ok(iMstsc > iGuard, 'DNS guard must run BEFORE mstsc');
  assert.match(cs, /private static bool DnsGuard/);
  assert.match(cs, /Dns\.GetHostAddresses\(fqdn\)/);
  assert.match(cs, /b\[0\] == 100 && b\[1\] >= 64 && b\[1\] <= 127/);
  assert.match(cs, /DNS stale\/blocked - flushdns or check tailscale/);
  assert.match(cs, /HelloBounded\(host, port, "rdp", false, "dns-guard: " \+ why\)/);
  assert.match(cs, /LogJson\("error", "rdp", "dns-guard: " \+ why/);
  assert.match(cs, /mstsc was NOT started - never launching into a dead name/);
  // F15 invariant: still exactly ONE MessageBox.Show call site
  assert.strictEqual((cs.match(/MessageBox\.Show/g) || []).length, 1);
});

test('F17-10 gates + lab: the F17 gate step and the lab proof exist', () => {
  assert.match(gates, /F17 RDP listener self-report gates/);
  assert.match(gates, /name: RDP listener self-probe \(F17, fail-loud\)/);
  assert.match(gates, /F17 gates PASS/);
  assert.match(gates, /0\.0\.0\.0\/0/);
  assert.match(gates, /parseTs\(b\\\.ts\)|parseTs\(b\.ts\)/);
  // lab: REAL probe step extracted from main.yml, break-then-fix proof
  assert.match(lab, /RDP listener self-probe \(F17, fail-loud\)/);
  assert.match(lab, /Get-Content -LiteralPath '\.github\/workflows\/main\.yml'/);
  assert.match(lab, /Substring\(\$indent\)/);
  assert.match(lab, /GHRDP-RDP/);
  assert.match(lab, /Disable-NetFirewallRule -DisplayName 'GHRDP-RDP'/);
  assert.match(lab, /F17_PROBE/);
  assert.match(lab, /rdpListener/);
  assert.match(lab, /beacon age/i);
});

// ---------------------------------------------------------------------------
// Functional proof of the row renderers: extract the REAL functions from
// ui.html and execute them against a DOM stub, so "❌ + exact fix text" and the
// AUTO-LOGIN gate are asserted on rendered output, not on source greps.
// ---------------------------------------------------------------------------
function extractFn(src, name) {
  const start = src.indexOf('function ' + name + '(');
  assert.ok(start > 0, name + ' not found in ui.html');
  let depth = 0, seen = false;
  for (let i = start; i < src.length; i++) {
    if (src[i] === '{') { depth++; seen = true; }
    else if (src[i] === '}') { depth--; if (seen && depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error('unbalanced body for ' + name);
}

function domHarness() {
  const els = {};
  function el(id) {
    return els[id] || (els[id] = {
      id, textContent: '', style: {}, children: [],
      appendChild(n) { this.children.push(n); },
    });
  }
  ['nrRdpListenerRow', 'nrRdpListener', 'nrConnDiagRow', 'nrConnDiag1', 'nrConnDiag2'].forEach(el);
  const created = [];
  const document = {
    getElementById: (id) => el(id),
    createElement(tag) { const n = { tag, textContent: '', style: {}, appendChild() {} }; created.push(n); return n; },
    createTextNode(t) { const n = { text: t }; created.push(n); return n; },
  };
  const window = {};
  const ctx = { window, document, FQDN_RE: /^[a-z0-9][a-z0-9\-]*(\.[a-z0-9\-]+)+\.ts\.net$/i };
  vm.createContext(ctx);
  vm.runInContext(extractFn(ui, 'renderRdpListener') + '\n' + extractFn(ui, 'renderConnDiag'), ctx);
  return { ctx, window, el, created, flat: () => created.map((n) => n.textContent || n.text).join('') };
}

test('F17-11 row: all-OK probe renders five ✅ and opens the AUTO-LOGIN gate', () => {
  const h = domHarness();
  h.ctx.renderRdpListener({
    listening: true, listeningDetail: 'TCP 127.0.0.1:3389 accepts',
    termService: true, termServiceDetail: 'TermService Running',
    fwRule: true, fwRuleDetail: 'GHRDP-RDP enabled, all profiles, scope 100.64.0.0/10',
    certThumb: true, certThumbDetail: 'bound chain valid for node.ts.net',
    nla: true, nlaDetail: 'UserAuthentication=1 (NLA on)',
  });
  const txt = h.el('nrRdpListener').children.map((c) => c.textContent || c.text).join('');
  assert.strictEqual((txt.match(/\u2705/g) || []).length, 5, 'expected five ✅: ' + txt);
  assert.ok(!txt.includes('\u274C'), 'no ❌ expected: ' + txt);
  assert.strictEqual(h.window.__rdpListenerOk, true);
  assert.strictEqual(h.window.__rdpListenerTxt, '');
});

test('F17-12 row: a failing field renders ❌ + the probe fix text and disables AUTO-LOGIN', () => {
  const h = domHarness();
  h.ctx.renderRdpListener({
    listening: true, listeningDetail: 'TCP 127.0.0.1:3389 accepts',
    termService: true, termServiceDetail: 'TermService Running',
    fwRule: false, fwRuleDetail: 'GHRDP-RDP scope=0.0.0.0/0 - fix: scope must equal the tailnet range 100.64.0.0/10 - never a wider scope',
    certThumb: true, certThumbDetail: 'bound chain valid for node.ts.net',
    nla: true, nlaDetail: 'UserAuthentication=1 (NLA on)',
  });
  const txt = h.el('nrRdpListener').children.map((c) => c.textContent || c.text).join('');
  assert.strictEqual((txt.match(/\u2705/g) || []).length, 4, 'expected four ✅: ' + txt);
  assert.ok(txt.includes('\u274C fwScope'), '❌ must name the failing field: ' + txt);
  assert.ok(txt.includes('fix: scope must equal the tailnet range'), 'exact fix text missing: ' + txt);
  assert.strictEqual(h.window.__rdpListenerOk, false);
  assert.strictEqual(h.window.__rdpListenerTxt, 'fwScope');
});

test('F17-13 row: no probe data is fail-closed (never a silent ✅)', () => {
  const h = domHarness();
  h.ctx.renderRdpListener(null);
  const row = h.el('nrRdpListener');
  assert.ok(/not probed/.test(row.textContent), 'fail-closed text missing');
  assert.strictEqual(h.window.__rdpListenerOk, false);
  // and the AUDIT of the gate expression: syncWinAuto must consult it
  const sync = ui.slice(ui.indexOf('function syncWinAuto()'), ui.indexOf('setInterval(syncWinAuto'));
  assert.match(sync, /window\.__rdpListenerOk===true/);
});

test('F17-14 CONNECTION: live FQDN renders the two manual commands, else hidden', () => {
  const h = domHarness();
  h.ctx.renderConnDiag('ghrdp-58d.tail1234.ts.net');
  assert.strictEqual(h.el('nrConnDiag1').textContent, 'ping ghrdp-58d.tail1234.ts.net');
  assert.strictEqual(h.el('nrConnDiag2').textContent, 'Test-NetConnection ghrdp-58d.tail1234.ts.net -Port 3389');
  assert.strictEqual(h.el('nrConnDiagRow').style.display, '');
  h.ctx.renderConnDiag('');
  assert.strictEqual(h.el('nrConnDiagRow').style.display, 'none');
});
