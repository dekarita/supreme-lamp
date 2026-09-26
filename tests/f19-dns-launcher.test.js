// [F19] Client-DNS self-diagnosis (in-page probe) + launcher version guard.
// Run: node --test tests/f19-dns-launcher.test.js
//
// §1 and §2 are proven three ways:
//   1. THIS file EXECUTES the shipped probe decision core (extracted verbatim
//      from payloads/ui.html between the [F19 §1 client-DNS probe-begin/end]
//      markers) against the full A/B matrix - real JS, real assertions.
//   2. The launcher's DNS-guard DECISION is executed for real by the
//      windows-native job in launch-gates.yml (csc compile of the SHIPPED .cs +
//      --dns-selftest with injected resolver/TCP results) and by autologin-lab
//      cell S; here we pin the same matrix contract at source level plus a
//      mirror table so a divergence is caught in the fast lane too.
//   3. The beacon version compare is proven against the REAL server in
//      autologin-lab cell S; here we pin the server/extraction contract and
//      mirror the numeric compare.
const fs = require('fs');
const test = require('node:test');
const assert = require('node:assert');

const ui = fs.readFileSync('payloads/ui.html', 'utf8');
const launcher = fs.readFileSync('payloads/ghrdp-rdp-launcher.cs', 'utf8');
const server = fs.readFileSync('payloads/ghrdp-server.ps1', 'utf8');
const mainYml = fs.readFileSync('.github/workflows/main.yml', 'utf8');
const gates = fs.readFileSync('.github/workflows/launch-gates.yml', 'utf8');
const lab = fs.readFileSync('.github/workflows/autologin-lab.yml', 'utf8');
const migration = fs.readFileSync('docs/MIGRATION.md', 'utf8');

// executable C# lines only: comments legitimately NAME the F17 texts / lab
// switches, and the bans must be scannable on code alone.
const csCode = launcher.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');

function markedBlock(src, begin, end) {
  const a = src.indexOf(begin);
  const b = src.indexOf(end);
  assert.ok(a > 0 && b > a, `markers missing: ${begin} / ${end}`);
  return src.slice(a + begin.length, b);
}

// ---------------------------------------------------------------------------
// §1 in-page probe: execute the SHIPPED decision core
// ---------------------------------------------------------------------------
const coreSrc = markedBlock(ui, '[F19 §1 client-DNS probe-begin] */', '/* [F19 §1 client-DNS probe-end]');
// eslint-disable-next-line no-new-func
const core = new Function(`${coreSrc}; return { clientDnsCore, clientDnsProbeUrls };`)();

const FQDN = 'lab-host.dekarita.tailnet-lab.ts.net';
const IP = '100.118.42.7';

test('F19-1 probe core: A-ok/B-fail => client-dns-off; B-ok => client DNS ok (matrix)', () => {
  const cases = [
    // scheme, fqdn, ip, aOk, bOk, verdict
    ['http:', FQDN, IP, true, false, 'client-dns-off'],
    ['http:', FQDN, IP, true, true, 'ok'],
    ['http:', FQDN, IP, false, true, 'ok'],
    ['http:', FQDN, IP, false, false, 'unreachable'],
    ['http:', FQDN, '', true, false, 'unknown'],
    ['http:', 'not-a-magicdns-name', IP, true, false, 'unknown'],
    ['http:', '', IP, true, false, 'unknown'],
    ['https:', FQDN, IP, true, false, 'skipped'],
  ];
  for (const [scheme, fqdn, ip, aOk, bOk, want] of cases) {
    const r = core.clientDnsCore(fqdn, ip, scheme, aOk, bOk);
    assert.strictEqual(r.verdict, want,
      `A=${aOk} B=${bOk} scheme=${scheme} ip=${ip} => ${r.verdict}, want ${want}`);
    assert.ok(typeof r.why === 'string' && r.why.length > 0, 'every verdict carries copy');
  }
  const red = core.clientDnsCore(FQDN, IP, 'http:', true, false);
  assert.ok(red.why.includes("YOUR PC's Tailscale DNS is off (name not resolvable, IP reachable)"),
    'the red card must carry the exact F19 §1 sentence');
  assert.ok(core.clientDnsCore(FQDN, IP, 'http:', true, true).why.includes('client DNS ok'),
    'the green card must say client DNS ok');
});

test('F19-2 probe urls: A = tailnet IP, B = MagicDNS FQDN, both port 7331', () => {
  const u = core.clientDnsProbeUrls(FQDN, IP);
  assert.strictEqual(u.a, `http://${IP}:7331/`);
  assert.strictEqual(u.b, `http://${FQDN}:7331/`);
  const empty = core.clientDnsProbeUrls('', '');
  assert.strictEqual(empty.a, '');
  assert.strictEqual(empty.b, '');
});

test('F19-3 probe wiring: no-cors + 3s timeout + 30s refresh + copy-only fix lines', () => {
  assert.ok(ui.includes("mode:'no-cors'"), 'probes must be no-cors (opaque is enough: we only need reach/no-reach)');
  assert.ok(ui.includes('CDNS_TIMEOUT_MS=3000'), '3s probe timeout missing');
  assert.ok(ui.includes('CDNS_PERIOD_MS=30000'), '30s refresh missing');
  assert.ok(ui.includes('setInterval(clientDnsProbe,CDNS_PERIOD_MS)'), 'probe is never rescheduled');
  assert.ok(ui.includes('try{clientDnsProbe();'), 'probe must run on load');
  assert.ok(ui.includes('credentials:\'omit\''), 'probes must not carry credentials');
  for (const tok of [
    'id="clientDnsRow"', 'id="clientDnsFix1"', 'id="clientDnsFix2"', 'id="clientDnsFix3"',
    'tailscale set --accept-dns=true', 'ipconfig /flushdns', 'Use Tailscale DNS',
  ]) assert.ok(ui.includes(tok), 'probe card missing: ' + tok);
  // copy-only, like the F17 diagnostics row: the only onclick is copyById.
  const row = ui.slice(ui.indexOf('id="clientDnsRow"'), ui.indexOf('id="clientDnsRow"') + 2400);
  assert.ok(!/onclick="(?!copyById)/.test(row), 'the probe card must be copy-only (no exec buttons)');
});

// ---------------------------------------------------------------------------
// §2 launcher guard: decision matrix + FQDN-stays-the-target + refusal
// ---------------------------------------------------------------------------
test('F19-4 launcher decision: injected resolver results drive the 5-case matrix', () => {
  for (const tok of [
    'GHRDP_LAB_DNS_RESULT', 'GHRDP_LAB_TCP_RESULT', '--dns-selftest', 'IsDnsSelfTest(args)',
    'private static string DnsDecision(string dnsReason, string ip, bool ipReachable)',
    'if (dnsReason == null) { return "mstsc"; }',
    'if (!string.IsNullOrEmpty(ip) && ipReachable) { return "client-dns-off"; }',
    'return "dns-fail";',
    'private static bool IpReachable(string ip, int port)',
    'private const int RdpPort = 3389;',
    'private static string TailnetIpFromUri(string uri)',
  ]) assert.ok(csCode.includes(tok) || launcher.includes(tok), 'launcher guard missing: ' + tok);
  // the matrix itself (executed in CI/lab by --dns-selftest) must cover exactly
  // the fail+reach => remediation, fail+unreachable => dns box, ok => mstsc set.
  const m = launcher.slice(launcher.indexOf('string[,] cases = new string[,] {'));
  const body = m.slice(0, m.indexOf('};'));
  assert.ok(body.includes('"client-dns-off"') && body.includes('"dns-fail"') && body.includes('"mstsc"'),
    'the selftest matrix must cover all three decisions');
  assert.ok(/verdict=FAIL/.test(launcher), 'the selftest must compute a failing verdict');
  assert.ok(launcher.includes('mstscLaunched=0 cmdkeyCalled=0'),
    'the selftest must assert it never launched mstsc / called cmdkey');
});

test('F19-5 launcher remediation copy + FQDN stays the mstsc target (IP is diagnosis only)', () => {
  assert.ok(launcher.includes('Your Tailscale DNS is off. Run once: tailscale set --accept-dns=true'),
    'the exact remediation sentence is missing');
  assert.ok(launcher.includes('(or tray -> Use Tailscale DNS), then ipconfig /flushdns, then retry.'),
    'the tray path + flushdns + retry line is missing');
  assert.ok(csCode.includes('false, "client-dns-off"'), 'the client-dns-off beacon detail is missing');
  assert.ok(csCode.includes('client-dns-off: name did not resolve but the tailnet IP is reachable'),
    'the JSONL diagnosis line is missing');
  assert.ok(csCode.includes('return MstscStep(server, user, host, port);'),
    'mstsc must keep the FQDN as its target');
  assert.ok(!/mstsc\.exe", "[^"]*dnsIp/.test(csCode), 'mstsc must never be pointed at the diagnosis IP');
  assert.ok(!/full address:s:" \+ dnsIp/.test(csCode), 'the .rdp must never carry the diagnosis IP');
  // the F17 guard is still intact: non-tailnet and resolver failures still block.
  assert.ok(csCode.includes('if (allTailnet) { return null; }'));
  assert.ok(csCode.includes('DNS stale/blocked - flushdns or check Tailscale'));
  // exactly one MessageBox.Show in the file (fail-visible contract kept).
  assert.strictEqual((launcher.match(/MessageBox\.Show\(/g) || []).length, 1);
});

test('F19-6 launcher refuses any credential-ish URL parameter before any work', () => {
  assert.ok(csCode.includes('CredentialParamName(uri)'), 'the refusal check is missing');
  assert.ok(csCode.includes('cred-param-rejected'), 'the refusal beacon detail is missing');
  for (const k of ['pass', 'password', 'passwd', 'pwd', 'token', 'secret', 'apikey', 'authkey']) {
    assert.ok(csCode.includes(k), 'the refusal list must cover ' + k);
  }
  const refusal = csCode.indexOf('string credParam = CredentialParamName(uri);');
  const dispatch = csCode.indexOf('if (verb == "check") { return RunCheck(uri, host, port); }');
  assert.ok(refusal > 0 && dispatch > refusal, 'the refusal must run before the verb dispatch');
  // /pass with a VALUE is still never produced anywhere.
  assert.ok(!csCode.includes('/pass:'), 'a password value could leak into a command line');
});

test('F19-7 ui: exactly ONE credential-free ghrdp:// builder, and it carries &ip=', () => {
  // count the executable TEMPLATE (comments may legitimately show the shape).
  const templates = ui.match(/ghrdp:\/\/rdp\?server='\+encodeURIComponent\(fqdn\)/g) || [];
  assert.strictEqual(templates.length, 1, 'expected exactly one ghrdp://rdp URL template');
  assert.ok(ui.includes('function ghrdpRdpUrl(fqdn,user,ip)'), 'the single builder is missing');
  const b = ui.slice(ui.indexOf('function ghrdpRdpUrl(fqdn,user,ip)'));
  const fn = b.slice(0, b.indexOf('\n}') + 2);
  assert.ok(fn.includes("u+='&ip='"), 'the builder must append the tailnet IP');
  assert.ok(fn.includes("'&user='+encodeURIComponent(user)"), 'the builder must carry the user');
  assert.ok(!/(pass|pwd|token|secret|apikey|authkey)=/i.test(fn), 'the builder must never carry a secret');
  // only a CGNAT address may enter the URL.
  assert.ok(fn.includes('^100\\.(6[4-9]|[7-9]\\d|1[01]\\d|12[0-7])\\.'), 'the builder must allowlist 100.64.0.0/10');
  assert.ok(ui.includes("launchProto(ghrdpRdpUrl(fqdn,user,"), 'the AUTO-LOGIN click must use the builder');
});

// ---------------------------------------------------------------------------
// §2 beacon version compare: repo constant -> config -> native-status
// ---------------------------------------------------------------------------
// Mirrors the PowerShell compare so the semantics are pinned in the fast lane;
// the REAL execution is autologin-lab cell S (old beacon => outdated=true).
function launcherOutdated(seen, repo) {
  const re = /^\d+(\.\d+){1,3}$/;
  if (!re.test(seen || '') || !re.test(repo || '')) return false;
  const a = seen.split('.').map(Number);
  const b = repo.split('.').map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] || 0, y = b[i] || 0;
    if (x !== y) return x < y;
  }
  return false;
}

test('F19-8 version compare semantics (mirror; real proof in lab cell S)', () => {
  assert.strictEqual(launcherOutdated('2.1.0.0', '2.2.0.0'), true, 'older client => outdated');
  assert.strictEqual(launcherOutdated('2.0.0.0', '2.2.0.0'), true);
  assert.strictEqual(launcherOutdated('2.2.0.0', '2.2.0.0'), false, 'equal => current');
  assert.strictEqual(launcherOutdated('2.10.0.0', '2.2.0.0'), false, 'numeric, not lexicographic');
  assert.strictEqual(launcherOutdated('', '2.2.0.0'), false, 'no beacon => no false alarm');
  assert.strictEqual(launcherOutdated('2.1.0.0', ''), false, 'no repo constant => no false alarm');
  // server side: constant + beacon exe extraction + numeric [version] compare.
  assert.ok(server.includes("$cfgN.PSObject.Properties['launcherVersion']"), 'config.launcherVersion is never read');
  assert.ok(server.includes('"exe"\\s*:\\s*"([^"]{0,200})"'), 'the exe stamp is never extracted from the beacon store');
  assert.ok(server.includes('[version]$launcherSeenVersion -lt [version]$launcherVersion'), 'the numeric compare is missing');
  assert.ok(server.includes('launcherOutdated = $launcherOutdated'), 'native-status does not serve launcherOutdated');
  assert.ok(server.includes('launcherSeenVersion = $launcherSeenVersion'), 'native-status does not serve launcherSeenVersion');
  assert.ok(server.includes('launcherVersion = $launcherVersion'), 'native-status does not serve launcherVersion');
  assert.ok(server.includes("$hh.exe = 'ghrdp-rdp-launcher ' + $Matches[1]"), 'the beacon handler does not persist the exe stamp');
  assert.ok(server.includes("$ns.lastHandlerVerb = @{ verb = [string]$lv.verb"), 'lastHandlerVerb must echo the beacon');
});

test('F19-9 launcher beacon carries the exe stamp and main.yml pins the repo constant', () => {
  assert.ok(launcher.includes(',\\"exe\\":\\"') || launcher.includes(',"exe":"'), 'the beacon body must carry exe');
  assert.ok(launcher.includes('private const string Ver = '), 'the repo constant is missing');
  assert.ok(/private const string Ver = "\d+(\.\d+){1,3}";/.test(launcher), 'the repo constant must be a dotted version');
  assert.ok(mainYml.includes("private const string Ver = \"(\\d+(\\.\\d+){1,3})\""),
    'main.yml must READ the constant out of the launcher source (never hand-typed)');
  assert.ok(mainYml.includes('launcherVersion = $launcherVer'), 'config.json must carry launcherVersion');
  assert.ok(mainYml.includes('F19: launcher version constant missing'), 'a missing constant must halt the run, not be skipped');
});

test('F19-10 ui: the outdated row is yellow guidance, never an AUTO-LOGIN blocker', () => {
  assert.ok(ui.includes('id="nrLauncherOutdatedRow"'), 'the outdated row is missing');
  assert.ok(ui.includes('launcher outdated - re-run install.cmd once'), 'the exact yellow copy is missing');
  assert.ok(ui.includes('href="/dl/ghrdp-handler-kit.zip"'), 'the row must offer the install kit');
  assert.ok(ui.includes("(s&&s.launcherOutdated===true)?'':'none'"), 'the row must follow launcherOutdated');
  // the AUTO-LOGIN gate stays exactly: valid fqdn + user + listener + runner DNS.
  assert.ok(ui.includes('var all=ok&&lOK&&dOK;'), 'the AUTO-LOGIN gate changed');
  assert.ok(!/launcherOutdated/.test(ui.slice(ui.indexOf('var all=ok&&lOK&&dOK;') - 400, ui.indexOf('var all=ok&&lOK&&dOK;'))),
    'launcherOutdated must NOT gate AUTO-LOGIN (yellow, never blocking)');
});

// ---------------------------------------------------------------------------
// §4 gates + §3 documentation-only
// ---------------------------------------------------------------------------
test('F19-11 launch gates: credential-UI automation ban + probe/version guard pins', () => {
  assert.match(gates, /name: F19 client-DNS probe \+ launcher version guard \+ no-credential-automation gates/);
  // The banned identifiers are ASSEMBLED here so this test file itself stays
  // clean for the gate it is pinning (the F19 block greps tests/ too).
  const BANNED = ['Send' + 'Keys', 'UIAuto' + 'mation'];
  for (const tok of [
    ...BANNED, 'CredentialParamName', 'cred-param-rejected',
    '[F19 §1 client-DNS probe-begin]', 'clientDnsCore', 'CDNS_TIMEOUT_MS=3000', 'CDNS_PERIOD_MS=30000',
    'launcherVersion = $launcherVer', 'launcherOutdated', 'client-dns-off', '--dns-selftest',
    'Your Tailscale DNS is off. Run once: tailscale set --accept-dns=true',
    '### 1.11 [F19 §3] Code-signed', 'F19 gates PASS',
  ]) assert.ok(gates.includes(tok), 'F19 gate does not pin: ' + tok);
  assert.match(gates, /name: F19 launcher DNS-guard decision matrix \(csc compile \+ injected resolver\)/);
  // the gate must really ban, not describe: an "if grep ... then exit 1" body.
  const step = gates.slice(gates.indexOf('name: F19 client-DNS probe'), gates.indexOf('F19 gates PASS'));
  assert.ok((step.match(/exit 1/g) || []).length >= 6, 'the F19 gate block is not enforcing anything');
  // and the repo really is clean of the banned identifiers (docs excluded from
  // the scan scope in the gate; here we check the shipped surface).
  const bannedRe = new RegExp([...BANNED, 'Automation' + 'Element', 'Value' + 'Pattern'].join('|'));
  for (const f of ['payloads/verify-ghrdp.ps1', 'payloads/ghrdp-rdp-launcher.cs', 'payloads/ui.html',
    'payloads/ghrdp-server.ps1', 'tests/f19-dns-launcher.test.js']) {
    const src = fs.readFileSync(f, 'utf8');
    assert.ok(!bannedRe.test(src), `${f} carries a credential-UI automation identifier`);
  }
});

test('F19-12 §3 code-signed .rdp stays DOCUMENTED ONLY (no implementation, no cert trust)', () => {
  assert.ok(migration.includes('### 1.11 [F19 §3] Code-signed'), 'the §1.11 note is missing');
  assert.ok(migration.includes('OPTIONAL FUTURE, NOT IMPLEMENTED'), 'the note must say it is not implemented');
  assert.ok(migration.includes('rdpsign'), 'the note must name the signing tool');
  assert.ok(migration.includes('certificate-validation bypass'), 'the note must keep the constraints');
  // nothing in the shipped code signs or trusts a code-signing certificate.
  for (const src of [launcher, ui, server, mainYml]) {
    assert.ok(!/rdpsign|CodeSigning|TrustedPublisher/i.test(src),
      'a code-signing implementation leaked into shipped code (F19 §3 is documentation only)');
  }
});

test('F19-13 lab fallback lane: cell S proves matrix + version guard against the REAL server', () => {
  assert.match(lab, /name: "S: F19 client-DNS probe \+ launcher version guard \(csc matrix \+ real server\)"/);
  for (const tok of [
    "'--dns-selftest'", 'GHRDP_LAB_OUT', 'launcherOutdated', 'launcherSeenVersion',
    'ghrdp-rdp-launcher 2.1.0.0 (F17 dns-guard)',
    // [F20] the CURRENT stamp is READ out of the shipped launcher source
    // (Ver + Stamp suffix), never hand-typed: the launcher moved to 2.3.0.0
    // with the F20 dialog and a hardcoded version here would silently unpin
    // the guard (and would have gone stale on every later bump).
    'private const string Ver = "(\\d+(\\.\\d+){1,3})"',
    'private const string Stamp = "ghrdp-rdp-launcher " \\+ Ver \\+ " \\(([^)]*)\\)"',
    "'ghrdp-rdp-launcher ' + $sVer", 'launcherVersion = $sVer',
    'outdated-not-flagged', 'S_result=pass',
  ]) assert.ok(lab.includes(tok), 'lab cell S does not prove: ' + tok);
  // ...and the old hand-typed constants are really gone (they would pin the
  // lab to a version the repo no longer ships).
  assert.ok(!/launcherVersion = '2\.2\.0\.0'/.test(lab), 'cell S still hand-types the repo constant');
  assert.ok(lab.includes("' s=' + $(if ($env:S_result -eq 'pass')"), 'cell s is not in the lab matrix readout');
});
