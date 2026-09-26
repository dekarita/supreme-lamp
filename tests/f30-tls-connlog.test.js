// [F30] TLS/CIPHER HANDSHAKE FIX + CREDENTIAL TYPE NORMALIZATION + STALE PURGE.
// Run: node --test tests/f30-tls-connlog.test.js
//
// §3 is proven by EXECUTING the shipped renderer (the real nativeStatus()
// path out of payloads/ui.html under a DOM stub) with synthetic connLog
// events. §1/§2/§5 pin the workflow, the launcher and the server on their
// literal contracts. §6 pins the gate step + the lab cell.
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

const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].map(m => m[1]);
const native = scripts.find(s => s.includes('async function nativeStatus()'));
const fqdn = 'vps.example.ts.net';

// same page harness as the F24/F27/F28 matrices
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
      authLast: null, logonCollector: { alive: true, uptimeSec: 120, intervalSec: 30, scans: 4 },
      connLog: null, connCollector: { alive: true, uptimeSec: 120, intervalSec: 30, scans: 4 }
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
  }, { filename: 'ui-f30.js' });
  node('rdpFqdn').textContent = fqdn;
  node('credUser').textContent = 'rdpuser';
  return { node, status, intervals };
}

async function refresh(view) {
  await view.intervals.find(f => f.name === 'bootstrapConfig')();
  await view.intervals.find(f => f.name === 'nativeStatus')();
}

const ev = (logShort, id, reason, timeUtc, desc) => ({ logShort, id, reason, timeUtc, desc });

// ---------------------------------------------------------------------------
// §3 SERVER CONN LOG: synthetic connLog events -> the dashboard row
// ---------------------------------------------------------------------------
test('F30-1 SERVER CONN LOG renders newest 3 with reason codes + scanTs verbatim', async () => {
  const view = page({
    rdpListener: {
      listening: true, fwRule: true, certOk: true, nla: true, credsspLive: 'ok',
      connCollector: { alive: true, uptimeSec: 300, intervalSec: 30, scans: 10 },
      connLog: {
        events: [
          ev('RdpCoreTS', '131', 'tcp-connection-accepted', '2026-09-26T18:00:12.0000000Z', 'The server accepted a new TCP connection from client 100.64.0.1:51234.'),
          ev('RemoteConnMgr', '261', 'listener-received-connection', '2026-09-26T18:00:12.1000000Z', 'Listener RDP-Tcp received a connection'),
          ev('RemoteConnMgr', '1149', 'user-auth-succeeded', '2026-09-26T18:00:13.0000000Z', 'Remote Desktop Services: User authentication succeeded'),
          ev('RdpCoreTS', '226', 'tcp-transition-error', '2026-09-26T17:59:00.0000000Z', 'fourth - must not render')
        ],
        scanTs: '2026-09-26T18:00:30.1234567Z', probeError: ''
      }
    }
  });
  await refresh(view);
  const text = view.node('serverConnLog').textContent;
  assert.match(text, /\[RdpCoreTS 131\] tcp-connection-accepted 2026-09-26T18:00:12\.0000000Z The server accepted a new TCP connection/);
  assert.match(text, /\[RemoteConnMgr 261\] listener-received-connection/);
  assert.match(text, /\[RemoteConnMgr 1149\] user-auth-succeeded/);
  assert.doesNotMatch(text, /fourth - must not render/, 'only the newest 3 render');
  assert.match(text, / - scanned 2026-09-26T18:00:30\.1234567Z$/);
  assert.notEqual(view.node('serverConnLog').style.color, '#f5b7b7');
});

test('F30-1 a dead collector renders RED, a scan without events is honest', async () => {
  // dead collector: up >90s, no connLog at all
  const dead = page({
    rdpListener: { listening: true, fwRule: true, certOk: true, nla: true, credsspLive: 'ok',
      connLog: null, connCollector: { alive: false, uptimeSec: 400, intervalSec: 30, scans: 5 } }
  });
  await refresh(dead);
  assert.match(dead.node('serverConnLog').textContent, /conn-log collector not running/);
  assert.equal(dead.node('serverConnLog').style.color, '#f5b7b7');
  // a scan without scanTs is also a dead collector, never 'scanning...'
  const noTs = page({
    rdpListener: { listening: true, fwRule: true, certOk: true, nla: true, credsspLive: 'ok',
      connCollector: { alive: true, uptimeSec: 400 },
      connLog: { events: [], probeError: '' } }
  });
  await refresh(noTs);
  assert.match(noTs.node('serverConnLog').textContent, /conn-log collector not running \(the last conn-log scan carried no scanTs\)/);
  assert.equal(noTs.node('serverConnLog').style.color, '#f5b7b7');
  // inside the startup window: honest 'scanning...'
  const boot = page({
    rdpListener: { listening: true, fwRule: true, certOk: true, nla: true, credsspLive: 'ok',
      connLog: null, connCollector: { alive: true, uptimeSec: 10, intervalSec: 30 } }
  });
  await refresh(boot);
  assert.match(boot.node('serverConnLog').textContent, /^scanning\.\.\./);
  assert.notEqual(boot.node('serverConnLog').style.color, '#f5b7b7');
  // empty logs still carry the scan stamp + probe error
  const empty = page({
    rdpListener: { listening: true, fwRule: true, certOk: true, nla: true, credsspLive: 'ok',
      connCollector: { alive: true, uptimeSec: 300 },
      connLog: { events: [], scanTs: '2026-09-26T18:05:00.0000000Z', probeError: 'connlog-unreadable-RdpCoreTS' } }
  });
  await refresh(empty);
  assert.match(empty.node('serverConnLog').textContent, /none yet - scanned 2026-09-26T18:05:00\.0000000Z \(no RdpCoreTS\/RemoteConnectionManager events\) \| collector=connlog-unreadable-RdpCoreTS/);
  assert.notEqual(empty.node('serverConnLog').style.color, '#f5b7b7');
});

// ---------------------------------------------------------------------------
// §1 server-side TLS/cipher normalization (main.yml, after cert-bind)
// ---------------------------------------------------------------------------
test('F30-2 cipher suites are enabled in order (GCM/ChaCha20 first) and TLS 1.2+1.3 are forced on', () => {
  const a = main.indexOf('Bind tailnet LE cert to RDP-Tcp (U5b)');
  const b = main.indexOf('# [F30 §1 tls-cipher-begin]');
  const c = main.indexOf('CredSSP/NLA handshake verification (F21 - fail loud on mismatch)');
  assert.ok(a > 0 && b > a && c > b, 'the F30 step must sit after cert-bind and before the F21 verification');
  const blk = main.slice(b, main.indexOf('# [F30 §1 tls-cipher-end]', b));
  const order = [
    'Enable-TlsCipherSuite TLS_AES_256_GCM_SHA384',
    'Enable-TlsCipherSuite TLS_CHACHA20_POLY1305_SHA256',
    'Enable-TlsCipherSuite TLS_AES_128_GCM_SHA256',
    'Enable-TlsCipherSuite TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384',
    'Enable-TlsCipherSuite TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305_SHA256'
  ];
  let prev = -1;
  for (const cmd of order) {
    const at = blk.indexOf(cmd);
    assert.ok(at > prev, 'cipher enable missing or out of order: ' + cmd);
    prev = at;
  }
  for (const tok of [
    "Set-ItemProperty -Path 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\SecurityProviders\\SCHANNEL\\Protocols\\TLS 1.2\\Client' -Name Enabled -Value 1 -Type DWord",
    "Set-ItemProperty -Path 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\SecurityProviders\\SCHANNEL\\Protocols\\TLS 1.2\\Server' -Name Enabled -Value 1 -Type DWord",
    "Set-ItemProperty -Path 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\SecurityProviders\\SCHANNEL\\Protocols\\TLS 1.3\\Client' -Name Enabled -Value 1 -Type DWord -ErrorAction SilentlyContinue",
    "Set-ItemProperty -Path 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\SecurityProviders\\SCHANNEL\\Protocols\\TLS 1.3\\Server' -Name Enabled -Value 1 -Type DWord -ErrorAction SilentlyContinue",
    "-Name 'SecurityLayer' -Value 2", "-Name 'MinEncryptionLevel' -Value 3",
    'Restart-Service TermService', 'Restart-Service WinRM'
  ]) {
    assert.ok(blk.includes(tok), 'F30 step lacks: ' + tok);
  }
  // TLS 1.2 Disabled=0 anywhere in the block would be a silent 1.2 kill - banned.
  assert.doesNotMatch(blk, /TLS 1\.2[^']*'? -Name Disabled -Value 1/s, 'TLS 1.2 must never be disabled');
});

// ---------------------------------------------------------------------------
// §2 credential type normalization + stale purge + .rdp read-back guard
// ---------------------------------------------------------------------------
test('F30-3 launcher purges same-target stale entries BEFORE the Domain write, with the beacon', () => {
  const handoff = launcher.slice(launcher.indexOf('// [F27 handoff-begin]'), launcher.indexOf('// [F27 handoff-end]'));
  for (const tok of ['CredEnumerateW', 'CredDeleteW', 'int WriteCredential(string fqdn, string user, string pass)',
                     'string exact = "TERMSRV/" + fqdn', 'found.Type != 1 && found.Type != 2', 'return purged;']) {
    assert.ok(handoff.includes(tok), 'handoff lacks: ' + tok);
  }
  const purgeAt = handoff.indexOf('int purged = PurgeStaleTargetCredentials(fqdn);');
  const writeAt = handoff.indexOf('if (!CredWrite(ref c, 0))');
  assert.ok(purgeAt > 0 && writeAt > purgeAt, 'the purge must run before the write');
  assert.ok(handoff.includes('c.Type = 2; // CRED_TYPE_DOMAIN_PASSWORD'), 'the fresh entry is CRED_TYPE_DOMAIN_PASSWORD');
  assert.ok(launcher.includes('HandoffStep(host, port, "purged " + purged + " stale entries, wrote new as Domain", true);'),
    'the purge beacon is missing');
  const redeemAt = launcher.indexOf('HandoffStep(host, port, "purged " + purged');
  const okAt = launcher.indexOf('HandoffStep(host, port, "credwrite-ok", true);');
  assert.ok(redeemAt > 0 && okAt > redeemAt, 'the purge beacon must precede credwrite-ok');
  // the server's beacon allowlist accepts it verbatim
  assert.ok(server.includes('purged [0-9]+ stale entries, wrote new as Domain'), 'beacon allowlist rejects the purge beacon');
  // the purge is the ONLY deletion surface: no cmdkey, no verb, no /pass:
  const code = launcher.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
  assert.doesNotMatch(code, /cmdkey[^\n]*\/delete/i);
  assert.doesNotMatch(code, /verb == "delete"/);
  assert.doesNotMatch(code, /\/pass:\s*[^"'\s]/);
  assert.ok(launcher.includes('if (IsPurgeSelfTest(args)) { return PurgeSelfTestMain(); }'), 'the lab harness is not dispatched');
});

test('F30-3 the .rdp read-back guard exists and the real template exceeds 400 bytes', () => {
  const m = launcher.indexOf('private static void AssertRdpFileHealthy');
  const call = launcher.indexOf('AssertRdpFileHealthy(lines, rdp);');
  assert.ok(m > 0 && call > m, 'the read-back guard must be defined and called by MstscStep');
  const write = launcher.indexOf('File.WriteAllLines(rdp, lines);');
  assert.ok(write > 0 && call > write, 'the guard runs after the write');
  assert.ok(launcher.includes('lines.Length < 19'), 'the 19+ directive assert is missing');
  assert.ok(launcher.includes('bytes < 400'), 'the >400 byte assert is missing');
  assert.ok(launcher.includes('File.ReadAllText(rdp)'), 'the file is not read back');
  // compute the real template size: every literal line plus the live fqdn/user
  const rl = launcher.slice(launcher.indexOf('private static string[] RdpLines'));
  const lit = [...rl.slice(0, rl.indexOf('};')).matchAll(/"([^"]+)"/g)].map(x =>
    x[1].replace('full address:s:', 'full address:s:' + 'lab-host-0123456789abcdef0123456789abcdef.dekarita-lab.ts.net')
        .replace('username:s:', 'username:s:rdpuser'));
  const bytes = Buffer.byteLength(lit.join('\n') + '\n', 'utf8');
  assert.equal(lit.length, 19, 'the template must carry exactly 19+ directives');
  assert.ok(bytes > 400, 'the real template must exceed 400 bytes, got ' + bytes);
});

// ---------------------------------------------------------------------------
// §2.2 purge-stale-creds endpoint + §3 conn-log collector (server)
// ---------------------------------------------------------------------------
test('F30-4 /api/purge-stale-creds is dash-token gated and serves the 7-day sweep one-liner', () => {
  const route = server.slice(server.indexOf('# [F30 §2.2 purge-route-begin]'), server.indexOf('# [F30 §2.2 purge-route-end]'));
  assert.ok(route.includes("/api/purge-stale-creds"), 'the route is missing');
  assert.ok(route.includes("Test-TicketBearer"), 'the bearer check is missing');
  assert.ok(route.includes('dashboard authorization required'), 'the 401 path is missing');
  const routeAt = server.indexOf('# [F30 §2.2 purge-route-begin]');
  assert.ok(routeAt > 0, 'route markers missing');
  // the one-liner: enum + 7-day LastWritten cutoff + delete + TERMSRV scope
  const blk = server.slice(server.indexOf('# [F30 §3 connlog-begin]'), server.indexOf('# [F30 §3 connlog-end]'));
  for (const tok of ['$script:PurgeCredsOneLiner', 'CredEnumerateW', 'CredDeleteW', 'AddDays(-7)',
                     'LastWritten.dwHighDateTime -shl 32', "StartsWith('TERMSRV/')"]) {
    assert.ok(blk.includes(tok), 'purge one-liner lacks: ' + tok);
  }
  assert.doesNotMatch(blk, /rdpPass|vncPass|dashToken/, 'the one-liner must never carry a secret');
});

test('F30-4 the server-side conn-log collector is complete and wired', () => {
  assert.ok(server.includes('$script:ConnLogStatePath = Join-Path $Root \'rdp-connlog.json\''), 'state path missing');
  const blk = server.slice(server.indexOf('# [F30 §3 connlog-begin]'), server.indexOf('# [F30 §3 connlog-end]'));
  for (const tok of [
    "$script:F30ConnIntervalSec = 30", "$script:F30ConnStaleSec = 90", "$script:F30ConnMaxEvents = 10",
    "$script:F30ConnDescChars = 200",
    'Microsoft-Windows-RemoteDesktopServices-RdpCoreTS/Operational',
    'Microsoft-Windows-TerminalServices-RemoteConnectionManager/Operational',
    'function Get-RdpConnReason', 'function Get-RdpConnLogLast', 'function Update-RdpConnLog',
    'function Get-RdpConnCollectorState',
    "'RdpCoreTS|131'", "'RdpCoreTS|226'", "'RemoteConnMgr|261'", "'RemoteConnMgr|1149'",
    '$scanTs = (Get-Date)'
  ]) {
    assert.ok(blk.includes(tok), 'connlog block lacks: ' + tok);
  }
  // scanTs is stamped BEFORE the sort/verdict (same contract as F28)
  const fn = blk.slice(blk.indexOf('function Get-RdpConnLogLast'));
  assert.ok(fn.indexOf('$scanTs = (Get-Date)') < fn.indexOf('$sorted ='), 'scanTs must precede the event handling');
  // startup scan + 30s tick in the accept loop, never in main.yml
  assert.ok(server.includes('try { Update-RdpConnLog -StatePath $script:ConnLogStatePath | Out-Null } catch { }'), 'startup scan missing');
  assert.ok(server.includes('if (((Get-Date) - $lastConnScan).TotalSeconds -ge $script:F30ConnIntervalSec)'), 'the 30s tick is missing');
  assert.ok(!main.includes('Update-RdpConnLog'), 'the conn-log scan leaked into the keep-alive workflow');
  for (const tok of ['-NotePropertyName connLog', '-NotePropertyName connCollector', 'connCollector = $connState.connCollector']) {
    assert.ok(server.includes(tok), 'native-status wiring lacks: ' + tok);
  }
  // the collector never reads credential-bearing logs
  assert.doesNotMatch(blk, /Password|rdpPass|CredentialBlob/, 'the collector must not touch credential material');
});

// ---------------------------------------------------------------------------
// §3/§4 dashboard surface + copy-lines
// ---------------------------------------------------------------------------
test('F30-5 the SERVER CONN LOG row and the TLS copy-lines exist on the shipped page', () => {
  assert.ok(html.includes('<span class="k">SERVER CONN LOG</span>'), 'the row label is missing');
  assert.ok(html.includes('id="serverConnLog"'), 'the row value cell is missing');
  assert.ok(html.includes('function connLogRowText(connLog,collector)'), 'the renderer is missing');
  assert.ok(html.includes("connLogRowText((rl&&rl.connLog)||null,(rl&&rl.connCollector)||(s&&s.connCollector)||null)"), 'the paint wiring is missing');
  for (const tok of [
    'id="connDiagPurgeAll"', 'cmdkey /list | findstr TERMSRV | ForEach-Object { cmdkey /delete:($_ -split \':\')[1].Trim() }',
    'id="connDiagTlsSuites"', 'Get-TlsCipherSuite | Select-Object Name, CipherLength | Format-Table',
    'id="connDiagMstscTls13"', 'mstsc /v:&lt;fqdn&gt; /admin /tls13',
    "d13.textContent='mstsc /v:'+diagF+' /admin /tls13'",
    'id="connDiagTshark"', 'tshark -i "Tailscale" -f "tcp port 3389" -w %TEMP%\\rdp-tls.pcap -a duration:30'
  ]) {
    assert.ok(html.includes(tok), 'ui.html lacks: ' + tok);
  }
  // every copy-line control is copyById (nothing executes)
  for (const id of ['connDiagPurgeAll', 'connDiagTlsSuites', 'connDiagMstscTls13', 'connDiagTshark']) {
    assert.ok(html.includes("copyById('" + id + "',this)"), id + ' needs its own copyById control');
  }
});

// ---------------------------------------------------------------------------
// §5 gates + §6 lab cell
// ---------------------------------------------------------------------------
test('F30-6 the gate step and the lab cell pin the whole fix', () => {
  assert.ok(gates.includes('F30 TLS handshake + credential normalization + conn-log gates'), 'the F30 gate step is missing');
  const gate = gates.slice(gates.indexOf('F30 TLS handshake + credential normalization + conn-log gates'));
  for (const tok of [
    'TLS_AES_256_GCM_SHA384', 'TLS_CHACHA20_POLY1305_SHA256', 'tls-cipher-begin', 'purge-route-begin',
    'PurgeStaleTargetCredentials', 'connlog-begin', 'rdpTrun', 'connLogRowText', 'purge-stale-creds',
    'purged ', 'connDiagPurgeAll'
  ]) {
    assert.ok(gate.includes(tok), 'the F30 gate lacks ' + tok);
  }
  assert.ok(gates.includes('F30 launcher purge+rdp-guard matrix (csc compile + --purge-selftest)'), 'the Windows purge-matrix gate step is missing');
  assert.ok(lab.includes('W: F30 TLS handshake + credential purge + conn-log'), 'the lab cell W is missing');
  assert.ok(lab.includes('W_result=pass'), 'the lab cell W never reports a result');
  assert.ok(lab.includes("Nt 'W' 'W_result'"), 'the lab cell W is not announced');
  assert.ok(lab.includes('--purge-selftest'), 'the lab does not run the shipped purge matrix');
  assert.ok(lab.includes('tests/f30-tls-connlog.test.js'), 'the lab does not run this renderer matrix');
});
