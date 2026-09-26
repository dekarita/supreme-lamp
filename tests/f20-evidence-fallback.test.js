// [F20] KILL THE nslookup FALSE ALARM + EVIDENCE-BASED 0x904/0x7 FALLBACK.
// Run: node --test tests/f20-evidence-fallback.test.js
//
// §1 is proven by EXECUTING the shipped renderer (the real nativeStatus() out of
// payloads/ui.html, driven through a DOM stub) and asserting what the user
// would actually see in CONNECTION DIAGNOSTICS - not by grepping the source.
// §2 pins the wevtutil export lines, the collapsed/copy-only contract and the
// launcher dialog + exit-code log; §3 pins the gates and the lab cell.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const html = fs.readFileSync('payloads/ui.html', 'utf8');
const launcher = fs.readFileSync('payloads/ghrdp-rdp-launcher.cs', 'utf8');
const gates = fs.readFileSync('.github/workflows/launch-gates.yml', 'utf8');
const lab = fs.readFileSync('.github/workflows/autologin-lab.yml', 'utf8');

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
  const requests = [];
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
  const fetch = async (url, options) => {
    requests.push({ url, options });
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
  }, { filename: 'ui-f20.js' });
  return { node, values, requests, status, intervals };
}

async function refresh(view) {
  await view.intervals[0](); // config
  await view.intervals[1](); // status
}

// ---------------------------------------------------------------------------
// §1 the nslookup false alarm is GONE from what the user is told to run
// ---------------------------------------------------------------------------
test('F20-1 rendered diagnostics: Resolve-DnsName replaces nslookup, ping/TNC unchanged', async () => {
  const view = page();
  await refresh(view);
  assert.equal(view.node('connDiagRd').textContent, 'Resolve-DnsName ' + fqdn,
    'the DNS copy-line must be Resolve-DnsName <fqdn> (DNS client service => Tailscale NRPT split-DNS applies)');
  assert.equal(view.node('connDiagPing').textContent, 'ping ' + fqdn, 'the ping line must be unchanged');
  assert.equal(view.node('connDiagTnc').textContent, 'Test-NetConnection ' + fqdn + ' -Port 3389',
    'the Test-NetConnection line must be unchanged');
  assert.equal(view.node('connDiagFqdn').textContent, fqdn);
  assert.equal(view.node('connDiagResolved').textContent, ip);
  assert.equal(view.node('connDiagRow').style.display, '', 'the row renders when the FQDN is known');
  // no rendered copy-line anywhere on the page tells the user to run nslookup.
  const codeLines = [...html.matchAll(/<code[^>]*>([\s\S]*?)<\/code>/g)].map(m => m[1]);
  assert.ok(codeLines.length > 5, 'the page should still carry copy-lines (gate sanity)');
  const nslookupLines = codeLines.filter(t => /nslookup/i.test(t));
  assert.deepEqual(nslookupLines, [], 'a copy-line still offers nslookup: ' + nslookupLines.join(' | '));
  // the retired element id is gone from markup and from the renderer.
  assert.ok(!/connDiagNs/.test(html), 'the retired nslookup element id survived');
  // the FALSE-ALARM note is the fix: nslookup is explained, not offered.
  assert.ok(html.includes('nslookup bypasses Tailscale split-DNS and queries your router directly; a nslookup timeout while ping works is EXPECTED and not a fault.'));
});

// ---------------------------------------------------------------------------
// §2 evidence-based 0x904/0x7 fallback
// ---------------------------------------------------------------------------
const FALLBACK_BEGIN = '<details id="connDiagFailBox"';
const FALLBACK_END = '</details>';

function fallbackBlock() {
  const a = html.indexOf(FALLBACK_BEGIN);
  const b = html.indexOf(FALLBACK_END, a);
  assert.ok(a > 0 && b > a, 'the collapsed 0x904/0x7 fallback block is missing from ui.html');
  return html.slice(a, b);
}

test('F20-2 the 0x904/0x7 fallback is collapsed, inside CONNECTION DIAGNOSTICS, and names the case', () => {
  const blk = fallbackBlock();
  const rowStart = html.indexOf('id="connDiagRow"');
  const rowEnd = html.indexOf('</div>', html.indexOf('if mstsc still fails'));
  assert.ok(html.indexOf(FALLBACK_BEGIN) > rowStart && html.indexOf(FALLBACK_BEGIN) < rowEnd,
    'the fallback must live inside the CONNECTION DIAGNOSTICS row');
  assert.match(blk, /<summary[^>]*>if mstsc still fails \(0x904\/0x7\) - export the logs<\/summary>/,
    'the collapsed summary must name the exact case');
  // collapsed by default: <details> with no open attribute (never the first
  // thing a user is pointed at while the cheap probes are still running).
  assert.ok(!/<details[^>]*\bopen\b/.test(blk), 'the fallback must start collapsed');
});

test('F20-3 the fallback carries every wevtutil export line, client + runner side', () => {
  const blk = fallbackBlock();
  for (const tok of [
    // client: the RDP client ActiveX operational log + the provider inventory.
    'wevtutil epl Microsoft-Windows-TerminalServices-ClientActiveXCore/Operational %TEMP%\\rdp-client.evtx',
    'wevtutil el | findstr /i "terminal credssp schannel"',
    // runner: logon audit, TLS/Schannel, and the RemoteConnectionManager log.
    'wevtutil epl Security %TEMP%\\rdp-security.evtx /q:"*[System[(EventID=4624 or EventID=4625)]]"',
    "wevtutil epl System %TEMP%\\rdp-system.evtx /q:\"*[System[Provider[@Name='Schannel']]]\"",
    'wevtutil epl Microsoft-Windows-TerminalServices-RemoteConnectionManager/Operational %TEMP%\\rdp-termgr.evtx',
    // the instruction: map the error from the logs, never guess.
    'Paste the exports into this session',
    'never guessed',
  ]) assert.ok(blk.includes(tok), 'the fallback block is missing: ' + tok);
  // the copy-line text is what the user actually pastes: no entity escaping,
  // no markup, and a copy control per line.
  for (const id of ['connDiagEvtClient', 'connDiagEvtList', 'connDiagEvtSec', 'connDiagEvtSch', 'connDiagEvtTerm']) {
    const m = new RegExp('<code id="' + id + '"[^>]*>([\\s\\S]*?)</code>').exec(blk);
    assert.ok(m, 'export line ' + id + ' is missing');
    assert.match(m[1], /^wevtutil (epl|el) /, id + ' is not a wevtutil export line');
    assert.ok(!/[&<>]/.test(m[1].replace(/&amp;/g, '')), id + ' carries markup the user would copy');
    assert.match(blk, new RegExp('<a href="javascript:void\\(0\\)" onclick="copyById\\(\'' + id + "',this\\)"), id + ' has no copy control');
  }
});

test('F20-4 the fallback stays copy-only and never suggests weakening NLA/CredSSP/certs', () => {
  const blk = fallbackBlock();
  const handlers = [...blk.matchAll(/onclick="([^"]*)"/g)].map(m => m[1]);
  assert.ok(handlers.length >= 5, 'every export line needs its own copy control');
  for (const h of handlers) assert.match(h, /^copyById\(/, 'a non-copy control reached the fallback: ' + h);
  for (const bad of [
    /powershell/i, /mshta/i, /wscript|cscript/i, /Invoke-Expression/i,
    /authentication level/i, /enablecredsspsupport/i, /authlvloverride/i,
    /prompt for credentials/i, /disable\s+NLA/i, /bypass.{0,20}cert/i, /cert.{0,20}bypass/i,
  ]) assert.ok(!bad.test(blk), 'the fallback suggests something forbidden: ' + bad);
});

// ---------------------------------------------------------------------------
// §2 launcher: exit code logged, dialog points at the evidence path
// ---------------------------------------------------------------------------
test('F20-5 launcher: mstsc exit code logged (dec + hex) and the dialog sends the user to the exports', () => {
  const code = launcher.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
  assert.match(code, /mstsc exited within 2s, code=/, 'the exit code is not logged');
  // hex too: the 0x904/0x7 class is reported in hex.
  assert.match(code, /0x" \+\s*$|code\.ToString\("X", CultureInfo\.InvariantCulture\)/, 'the exit code must also be logged in hex');
  assert.ok(code.includes('see dashboard -> CONNECTION DIAGNOSTICS -> \\"if mstsc still fails\\" and send the exports'),
    'the immediate-exit dialog does not point at the dashboard fallback');
  assert.ok(code.includes('mstsc exit code " + code'), 'the dialog must still show the exit code');
  assert.match(code, /HelloBounded\(host, port, "rdp", false, "mstsc-exited=" \+ code\)/, 'the beacon must carry the exit code');
  // the F15 fail-visible contract is untouched.
  assert.strictEqual((launcher.match(/MessageBox\.Show\(/g) || []).length, 1, 'MessageBox.Show must stay single');
  assert.ok(!/CreateNoWindow|WindowStyle\.Hidden/.test(code), 'hidden-window flag survived');
  // the exe changed, so the repo constant it stamps must be the F20 build.
  const ver = /private const string Ver = "(\d+(?:\.\d+){1,3})"/.exec(launcher);
  assert.ok(ver, 'the launcher version constant is missing');
  const cmp = (a, b) => {
    const x = a.split('.').map(Number), y = b.split('.').map(Number);
    for (let i = 0; i < 4; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) < (y[i] || 0) ? -1 : 1; }
    return 0;
  };
  assert.ok(cmp(ver[1], '2.3.0.0') >= 0, 'the launcher still stamps a pre-F20 version (' + ver[1] + ')');
  assert.match(launcher, /assembly: AssemblyVersion\("2\.4\.0\.0"\)/);
  assert.match(launcher, /\(F20 evidence-fallback\+nslookup-kill\)/, 'the beacon stamp must name the F20 build');
});

// ---------------------------------------------------------------------------
// §3 gates + §4 lab
// ---------------------------------------------------------------------------
test('F20-6 the F20 gate block exists and really enforces', () => {
  assert.match(gates, /name: F20 nslookup false alarm killed \+ evidence-based 0x904 fallback/);
  const step = gates.slice(gates.indexOf('name: F20 nslookup false alarm killed'), gates.indexOf('F20 gates PASS'));
  assert.ok(step.length > 500, 'the F20 gate block is missing its body');
  assert.ok((step.match(/exit 1/g) || []).length >= 10, 'the F20 gate block is not enforcing anything');
  for (const tok of [
    '<code[^>]*>[^<]*nslookup', 'id="connDiagRd"', 'nslookup bypasses Tailscale split-DNS',
    'if mstsc still fails (0x904/0x7)', 'wevtutil epl Microsoft-Windows-TerminalServices-ClientActiveXCore/Operational',
    'wevtutil el | findstr', 'EventID=4624 or EventID=4625', 'Schannel',
    'TerminalServices-RemoteConnectionManager', 'mstsc exited within 2s, code=',
    'see dashboard -> CONNECTION DIAGNOSTICS', '2.3.0.0',
  ]) assert.ok(step.includes(tok), 'the F20 gate does not pin: ' + tok);
});

test('F20-7 lab cell T renders the corrected diagnostics against the shipped files', () => {
  assert.match(lab, /name: "T: F20 nslookup false alarm \+ evidence-based 0x904 fallback"/);
  const cell = lab.slice(lab.indexOf('name: "T: F20 nslookup false alarm'), lab.indexOf('T_result=pass'));
  for (const tok of [
    'id="connDiagRd"', 'Resolve-DnsName', 'nslookup', 'if mstsc still fails (0x904/0x7)',
    'ClientActiveXCore', 'EventID=4624', 'Schannel', 'RemoteConnectionManager',
    'see dashboard -> CONNECTION DIAGNOSTICS', '2.3.0.0', 'csc',
  ]) assert.ok(cell.includes(tok), 'lab cell T does not prove: ' + tok);
  assert.ok(lab.includes("' t=' + $(if ($env:T_result -eq 'pass')"), 'cell T is not in the lab matrix readout');
});
