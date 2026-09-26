// [F30] TLS/CIPHER HANDSHAKE FIX + CREDENTIAL TYPE NORMALIZATION + STALE PURGE.
// Run: node --test tests/f30-tls-cipher.test.js
//
// Every assertion is on a SHIPPED surface, and the ones that can be EXECUTED are
// executed here: the server's conn-log collector fields/reason codes are proven
// by running the shipped renderer (the real paintSrvConnLog out of
// payloads/ui.html) over the state the shipped collector produces, and the .rdp
// byte floor is computed from the SHIPPED directive template (not a copy of it).
// The Windows lab lane (autologin-lab step "X:") then drives the same code with
// real cipher suites, the real credential store and synthetic event XML.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const main = fs.readFileSync('.github/workflows/main.yml', 'utf8');
const gates = fs.readFileSync('.github/workflows/launch-gates.yml', 'utf8');
const lab = fs.readFileSync('.github/workflows/autologin-lab.yml', 'utf8');
const srv = fs.readFileSync('payloads/ghrdp-server.ps1', 'utf8');
const ui = fs.readFileSync('payloads/ui.html', 'utf8');
const cs = fs.readFileSync('payloads/ghrdp-rdp-launcher.cs', 'utf8');

const F30_SUITES = [
  'TLS_AES_256_GCM_SHA384',
  'TLS_CHACHA20_POLY1305_SHA256',
  'TLS_AES_128_GCM_SHA256',
  'TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384',
  'TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305_SHA256',
];

// ---------------------------------------------------------------------------
// §1 server-side TLS/cipher normalization (main.yml)
// ---------------------------------------------------------------------------
test('F30-1 TLS/cipher normalization step exists AFTER cert bind and BEFORE the advertise steps', () => {
  const cert = main.indexOf('name: Bind tailnet LE cert to RDP-Tcp');
  const f30 = main.indexOf('name: TLS/cipher normalization (F30');
  const advertise = main.indexOf('name: RDP listener self-probe (F17');
  assert.ok(cert > 0 && f30 > 0 && advertise > 0, 'a required step is missing from main.yml');
  assert.ok(cert < f30, 'the F30 normalization must run AFTER the cert-bind step (the cert must exist first)');
  assert.ok(f30 < advertise, 'the F30 normalization must run BEFORE the run advertises the host');
  // the cert-bind body terminates at the F21 step, so the F30 step never leaks
  // into the F9-gated cert_body extraction (exactly one exit 0 in that body).
  assert.ok(main.indexOf('name: CredSSP/NLA handshake verification') < f30, 'F30 must sit after the F21 verification step');
});

test('F30-2 the ordered suite list is declared verbatim, in order, and applied through Enable-TlsCipherSuite', () => {
  const begin = main.indexOf('# [F30 §1 normalize-begin]');
  const end = main.indexOf('# [F30 §1 normalize-end]');
  assert.ok(begin > 0 && end > begin, 'the extractable F30 normalize block markers are missing');
  const block = main.slice(begin, end);
  let cursor = -1;
  for (const suite of F30_SUITES) {
    const at = block.indexOf("'" + suite + "'", cursor + 1);
    assert.ok(at > cursor, 'suite missing or out of order in the F30 list: ' + suite);
    cursor = at;
  }
  assert.ok(block.includes('Enable-TlsCipherSuite'), 'the block never enables a suite');
  // order is ENFORCED, not merely requested: the Schannel Functions list is
  // rewritten with the modern suites first, then verified by re-reading it.
  for (const token of ['Get-F30OrderedFunctions', 'Test-F30Order', 'Set-F30CipherOrder',
    'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Cryptography\\Configuration\\Local\\SSL\\00010002',
    "New-ItemProperty -Path $Key -Name 'Functions' -PropertyType MultiString"]) {
    assert.ok(block.includes(token), 'the order-enforcement token is missing: ' + token);
  }
  // a CBC/3DES/RC4 suite ahead of the modern ones is what the order test rejects
  assert.match(block, /_\(CBC\|3DES\|RC4\|NULL\)_/, 'the order verdict no longer rejects a weak suite offered first');
});

test('F30-3 TLS 1.2 AND 1.3 are written for Client and Server, never 1.2-disabled', () => {
  const block = main.slice(main.indexOf('# [F30 §1 normalize-begin]'), main.indexOf('# [F30 §1 normalize-end]'));
  assert.ok(block.includes("foreach ($proto in @('TLS 1.2', 'TLS 1.3'))"), 'both TLS versions must be handled');
  assert.ok(block.includes("foreach ($side in @('Client', 'Server'))"), 'both sides must be written');
  assert.match(block, /Set-ItemProperty -Path \$p -Name 'Enabled' -Value 1 -Type DWord -ErrorAction Stop/,
    'Enabled=1 write missing');
  assert.match(block, /Set-ItemProperty -Path \$p -Name 'DisabledByDefault' -Value 0 -Type DWord -ErrorAction Stop/,
    'DisabledByDefault=0 write missing (a disabled-by-default TLS 1.2 is the regression this fixes)');
  assert.ok(!/DisabledByDefault' -Value 1/.test(block), 'TLS 1.2/1.3 must never be disabled by this step');
  // RDP security layer stays TLS-only + high encryption (no weakening).
  assert.match(block, /Set-ItemProperty -Path \$rdpKey -Name 'SecurityLayer' -Value 2 -Type DWord/);
  assert.match(block, /Set-ItemProperty -Path \$rdpKey -Name 'MinEncryptionLevel' -Value 3 -Type DWord/);
  // services are restarted so the listener re-reads Schannel
  assert.match(block, /foreach \(\$svc in @\('TermService', 'WinRM'\)\)/, 'TermService/WinRM restart missing');
  // fail loud when the host cannot be normalized at all (never advertise it)
  const step = main.slice(main.indexOf('name: TLS/cipher normalization (F30'), main.indexOf('name: Optimize Tailscale path'));
  assert.ok(step.includes('throw '), 'an un-normalizable host must halt the run loud');
  assert.ok(step.includes('reason cipher-normalization-failed'), 'the halt reason code is missing');
  assert.ok(step.includes('tls-norm.json'), 'the normalization state stamp is missing');
});

// ---------------------------------------------------------------------------
// §2.1 launcher: purge BEFORE write, and only through the store API
// ---------------------------------------------------------------------------
test('F30-4 the launcher purges every stale TERMSRV/<fqdn> entry before writing the fresh Domain credential', () => {
  const begin = cs.indexOf('// [F30 §2.1 purge-begin]');
  const end = cs.indexOf('// [F30 §2.1 purge-end]');
  assert.ok(begin > 0 && end > begin, 'the F30 purge markers are missing from the launcher');
  const purge = cs.slice(begin, end);
  for (const token of ['CredEnumerateW', 'CredDeleteW', 'CredEnumerate("TERMSRV/*", 0, out count, out array)',
    'CredDelete(target, c.Type, 0)', 'c.Type != 2 && c.Type != 1']) {
    assert.ok(purge.includes(token), 'purge token missing: ' + token);
  }
  // both entry shapes the ground truth names ("Domain:" type 2 + the legacy
  // "LegacyGeneric:" type 1) are covered, and only THIS fqdn is touched.
  assert.ok(purge.includes('TERMSRV/" + fqdn'), 'the purge target is not built from the launched fqdn');
  assert.ok(purge.includes('OrdinalIgnoreCase'), 'the target match is not case-insensitive');
  const wc = cs.slice(cs.indexOf('private static int WriteCredential'), cs.indexOf('// Only redemption errors'));
  assert.ok(wc.indexOf('PurgeStaleTermsvr(fqdn)') < wc.indexOf('CredWrite(ref c, 0)'),
    'the purge must run BEFORE the CredWrite of the fresh credential');
  assert.ok(wc.includes('c.Type = 2; // CRED_TYPE_DOMAIN_PASSWORD'), 'the fresh entry must be DomainPassword type');
  assert.ok(cs.includes('return "purged " + purged + " stale entries, wrote new as Domain"'), 'the purge beacon text is missing');
  // the beacon reaches the dashboard: the server allowlist must accept it and
  // must NOT collapse it to launcher-error.
  assert.ok(srv.includes('purged [0-9]+ stale entries, wrote new as Domain'), 'the server beacon allowlist rejects the purge beacon');
  assert.ok(srv.includes('rdp-truncated'), 'the server beacon allowlist rejects rdp-truncated');
  // no cmdkey shell-out deletion anywhere near the store path.
  assert.ok(!/cmdkey[^\n]*\/delete/i.test(cs), 'the launcher must never shell out a cmdkey delete');
});

test('F30-5 the server hands out an age-aware purge command, dash-token gated, and it is a real one-liner', () => {
  const begin = srv.indexOf('# [F30 §2.2 purge-cmd-begin]');
  const end = srv.indexOf('# [F30 §2.2 purge-cmd-end]');
  assert.ok(begin > 0 && end > begin, 'the F30 purge-command block is missing from the server');
  const blk = srv.slice(begin, end);
  for (const token of ['CredEnumerateW', 'CredDeleteW', 'DateTime.FromFileTimeUtc(c.LastWritten)',
    'AddDays(-days)', 'StartsWith("TERMSRV/",StringComparison.OrdinalIgnoreCase)']) {
    assert.ok(blk.includes(token), 'purge-command token missing: ' + token);
  }
  // the composed command is ONE line: no newline may be introduced by the join.
  assert.ok(blk.includes("+ [char]39 +"), 'the command must be composed as a single-quoted one-liner');
  const route = srv.slice(srv.indexOf("if ($path -eq '/api/purge-stale-creds')"));
  assert.ok(route.length > 0, 'the /api/purge-stale-creds route is missing');
  const body = route.slice(0, route.indexOf('\n        }'));
  assert.ok(body.includes("Test-TicketBearer"), 'the route is not dash-token gated');
  assert.ok(body.includes("Code 401"), 'an unauthenticated request must get 401');
  assert.ok(body.includes('olderThanDays = 7'), 'the 7-day window is not reported');
  assert.ok(body.includes('command       = [string]$script:F30PurgeCommand'), 'the route does not serve the command');
  assert.ok(!/pass|passwd|password/i.test(body), 'the purge response must carry no credential field');
});

// ---------------------------------------------------------------------------
// §2.3 .rdp completeness: the shipped template is above the floor
// ---------------------------------------------------------------------------
test('F30-6 the shipped .rdp template is a complete directive set well above the 400 byte floor', () => {
  const a = cs.indexOf('private static string[] RdpLines(');
  const b = cs.indexOf('private static int MstscStep(', a);
  assert.ok(a > 0 && b > a, 'RdpLines could not be extracted');
  const body = cs.slice(a, b);
  const directives = [...body.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map(m => m[1]).filter(s => s.length > 0);
  assert.strictEqual(directives.length, 19, 'the template must carry all 19 directives, got ' + directives.length);
  // Windows CRLF per line + the concatenated fqdn/user of a real target.
  const fqdn = 'ghrdp-lab-abcdefgh.dekarita.tailnet-lab.ts.net';
  const user = 'rdpuser';
  const bytes = directives.reduce((n, d) => n + Buffer.byteLength(d, 'utf8') + 2, 0) +
    Buffer.byteLength(fqdn, 'utf8') + Buffer.byteLength(user, 'utf8');
  assert.ok(bytes > 400, 'the shipped template is only ' + bytes + ' bytes - the F30 floor would false-fail');
  assert.ok(cs.includes('private const int RdpMinBytes = 400;'), 'the byte floor constant is missing');
  // the launcher READS the file back and refuses to start mstsc from a partial one.
  const mstsc = cs.slice(b, cs.indexOf('// [F28 §2] ONE-CLICK RECOVERY'));
  assert.ok(mstsc.includes('File.ReadAllText(rdp)'), 'the .rdp is never read back');
  assert.ok(mstsc.includes('bytes <= RdpMinBytes'), 'the byte floor is never asserted');
  assert.ok(mstsc.includes('templateComplete'), 'the directive completeness check is missing');
  assert.match(mstsc, /throw new InvalidOperationException\("rdp-file-truncated/, 'a truncated .rdp must throw loud');
  assert.ok(mstsc.indexOf('bytes <= RdpMinBytes') < mstsc.indexOf('Process.Start(msi)'),
    'the assert must run BEFORE mstsc is started');
});

// ---------------------------------------------------------------------------
// §3 conn-log collector + dashboard row
// ---------------------------------------------------------------------------
test('F30-7 the server collects BOTH RDP operational logs on its own 30s tick', () => {
  const begin = srv.indexOf('# [F30 §3 connlog-begin]');
  const end = srv.indexOf('# [F30 §3 connlog-end]');
  assert.ok(begin > 0 && end > begin, 'the F30 conn-log block is missing from the server');
  const blk = srv.slice(begin, end);
  for (const token of ["$script:F30ConnLogIntervalSec = 30", '$script:F30ConnLogStaleSec = 90', '$script:F30ConnLogPerLog = 10',
    'Microsoft-Windows-RemoteDesktopServices-RdpCoreTS/Operational',
    'Microsoft-Windows-TerminalServices-RemoteConnectionManager/Operational',
    'function Get-RdpConnLogEventFields', 'function Get-RdpConnLogReason', 'function Get-RdpConnLog',
    'function Update-RdpConnLog', 'function Get-RdpConnLogState', 'Get-WinEvent -FilterHashtable',
    'conn-logs-unreadable', 'partial:', 'tls-forcibly-closed', 'tls-handshake-failed', 'cert-rejected',
    'connection-reset', 'auth-succeeded', 'auth-failed', 'listener-lifecycle', 'session-state']) {
    assert.ok(blk.includes(token), 'conn-log token missing: ' + token);
  }
  // descriptions are clipped for display and credential-shaped text is redacted
  assert.ok(blk.includes('Substring(0, 200)'), 'the description clip is missing');
  assert.match(blk, /\(password\|passwd\|pwd\|subjectusername\|targetusername\|subjectdomainname\)\(\\s\*\[=:\]\\s\*\)\\S\+/, 'the display redaction is missing');
  assert.ok(blk.includes("$1$2[redacted]"), 'the redaction must replace the value, not the whole line');
  // the collector runs from SERVER START on its own tick, not from the workflow.
  assert.ok(srv.includes('Update-RdpConnLog -StatePath $script:ConnLogStatePath') &&
    srv.match(/F30ConnLogIntervalSec\)\s*\{[\s\S]{0,200}Update-RdpConnLog/), 'the 30s tick is not wired into the accept loop');
  // served to the page as rdpListener.connLog (+ collector liveness)
  assert.ok(srv.includes('$rlOut | Add-Member -NotePropertyName connLog -NotePropertyValue $connState.connLog -Force'));
  assert.ok(srv.includes('NotePropertyName connLogCollector'), 'the collector liveness is not served');
  // and MIRRORED into config.json rdpListener.connLog by the keep-alive step.
  assert.ok(main.includes('# [F30 §3 keepalive-begin]') && main.includes('# [F30 §3 keepalive-end]'),
    'the keep-alive mirror block is missing');
  assert.ok(main.includes("NotePropertyName connLog"), 'config.rlpListener.connLog is never written');
  assert.ok(main.includes("[F30] SERVER CONN LOG: "), 'the keep-alive never prints the newest reason codes');
});

test('F30-8 SERVER CONN LOG renders the newest 3 with reason codes, and never a clean log from a dead collector', () => {
  assert.ok(ui.includes('id="srvConnLogRow"') && ui.includes('id="srvConnLogState"') &&
    ui.includes('id="srvConnLogLines"') && ui.includes('id="srvConnLogTls"'), 'the SERVER CONN LOG row is missing');
  assert.ok(ui.includes('SERVER CONN LOG'), 'the row title is missing');
  const begin = ui.indexOf('// [F30 §3 connlog-render-begin]');
  const end = ui.indexOf('// [F30 §3 connlog-render-end]');
  assert.ok(begin > 0 && end > begin, 'the renderer markers are missing');
  const fn = ui.slice(begin, end);
  // EXECUTE the shipped renderer over the two states that matter.
  const ctx = { document: { getElementById: id => (ctx.els[id] || (ctx.els[id] = { id, style: {}, textContent: '' })) }, els: {}, String, Number, RegExp };
  vm.createContext(ctx);
  vm.runInContext(fn, ctx);
  const status = {
    rdpListener: {
      connLogCollector: { alive: true, probeError: '' },
      tlsNorm: { orderOk: true, tls12Sides: 2, tls13Sides: 2, securityLayer: 2, minEncryptionLevel: 3, ageSec: 12 },
      connLog: {
        ts: '2026-09-26T17:00:00.0000000Z', count: 4, probeError: '',
        items: [
          { id: '105', provider: 'RDPServer-RdpCoreTS', timeUtc: '2026-09-26T16:59:40.0000000Z', level: '2', reason: 'tls-forcibly-closed', desc: 'An error occurred when connecting to the server: the connection was forcibly closed' },
          { id: '1149', provider: 'TerminalServices-RemoteConnectionManager', timeUtc: '2026-09-26T16:58:10.0000000Z', level: '4', reason: 'auth-succeeded', desc: 'Remote Desktop Services: User authentication succeeded' },
          { id: '36888', provider: 'Schannel', timeUtc: '2026-09-26T16:57:00.0000000Z', level: '2', reason: 'cert-rejected', desc: 'The certificate received from the remote server is not valid' },
          { id: '100', provider: 'RDPServer-RdpCoreTS', timeUtc: '2026-09-26T16:50:00.0000000Z', level: '4', reason: 'listener-lifecycle', desc: 'Listener started' },
        ],
      },
    },
  };
  ctx.paintSrvConnLog(status);
  const lines = ctx.els.srvConnLogLines.textContent.split('\n');
  assert.strictEqual(lines.length, 3, 'exactly the newest 3 events must render');
  assert.match(lines[0], /#105 RDPServer-RdpCoreTS reason=tls-forcibly-closed level=2 - An error occurred/);
  assert.match(lines[1], /#1149 .* reason=auth-succeeded/);
  assert.match(lines[2], /reason=cert-rejected/);
  assert.match(ctx.els.srvConnLogState.textContent, /collector alive/);
  assert.match(ctx.els.srvConnLogState.textContent, /4 event\(s\) in window/);
  assert.match(ctx.els.srvConnLogTls.textContent, /server TLS: ordered=yes tls12Sides=2 tls13Sides=2 securityLayer=2 minEncryptionLevel=3/);
  assert.strictEqual(ctx.els.srvConnLogState.style.color, '', 'a live collector must not render as a warning');
  // (b) a STALE collector must never read as a clean log.
  ctx.paintSrvConnLog({ rdpListener: { connLog: status.rdpListener.connLog, connLogCollector: { alive: false, probeError: 'partial:RdpCoreTS' } } });
  assert.match(ctx.els.srvConnLogState.textContent, /collector STALE/);
  assert.match(ctx.els.srvConnLogState.textContent, /probeError=partial:RdpCoreTS/);
  assert.strictEqual(ctx.els.srvConnLogState.style.color, '#f5d9b7');
  // (c) nothing at all: no invented ✅
  ctx.paintSrvConnLog({});
  assert.match(ctx.els.srvConnLogState.textContent, /collector not reported yet/);
  assert.strictEqual(ctx.els.srvConnLogLines.textContent, '');
});

test('F30-9 the /api/purge-stale-creds line is offered copy-only, and the client copy-lines exist verbatim', () => {
  for (const id of ['connDiagPurgeAll', 'connDiagServerPurge', 'connDiagCiphers', 'connDiagTls13', 'connDiagTshark']) {
    assert.ok(ui.includes('id="' + id + '"'), 'copy-line element missing: ' + id);
  }
  assert.ok(ui.includes("cmdkey /list | Select-String TERMSRV | ForEach-Object { $t=($_ -split 'target=')[1]; if ($t) { cmdkey \"/delete:$t\" } }"),
    'the nuclear purge copy-line is missing');
  assert.ok(ui.includes('Get-TlsCipherSuite | Select-Object Name, CipherLength | Format-Table'), 'the cipher copy-line is missing');
  assert.ok(ui.includes('mstsc /v:&lt;fqdn&gt; /admin /tls13'), 'the TLS1.3 copy-line is missing');
  assert.ok(ui.includes('tshark -i "Tailscale" -f "tcp port 3389" -w %TEMP%\\rdp-tls.pcap -a duration:30'), 'the capture copy-line is missing');
  // the age-aware command is FETCHED (dash-token bearer) and only displayed.
  assert.ok(ui.includes("async function loadServerPurgeCmd()"), 'the loader for the server purge command is missing');
  assert.ok(ui.includes("fetch(apiBase()+'/api/purge-stale-creds',{headers:{Authorization:'Bearer '+key}"),
    'the loader must send the dash token as a bearer header (never in the URL)');
  assert.ok(!/purge-stale-creds[^'"]*\?key=/.test(ui), 'the dash token must never ride the purge URL');
  // nothing on this page executes a copy-line.
  assert.ok(!/powershell\.exe|-ExecutionPolicy|Invoke-Expression|-EncodedCommand|mshta|wscript|cscript/.test(ui),
    'a script-host launch token reappeared in the page');
});

// ---------------------------------------------------------------------------
// §5/§6 gates + lab cell pinned (the gate cannot go vacuous)
// ---------------------------------------------------------------------------
test('F30-10 the F30 gate step and the Windows lab cell are pinned in the workflows', () => {
  assert.ok(gates.includes('F30 TLS/cipher + purge + connlog gates'), 'the F30 gate step is missing');
  assert.ok(gates.includes('tests/f30-tls-cipher.test.js'), 'the gate step does not run this matrix');
  assert.ok(gates.includes('F30: '), 'the gate step carries no F30 failure message');
  assert.ok(lab.includes('X: F30 cipher order + TLS registry + purge cycle + .rdp floor + connLog'),
    'the Windows lab cell is missing');
  assert.ok(lab.includes('--purge-selftest'), 'the lab never runs the purge cycle');
  assert.ok(lab.includes('F30_CONNLOG_FIXTURE'), 'the lab never feeds the collector fixture into the renderer');
});

// Optional: the LAB feeds the REAL collector output here (env set by
// autologin-lab step X), so (e) is proven end to end: collector -> state file ->
// shipped renderer.
test('F30-11 a collector fixture (when the lab provides one) maps to the dashboard row', () => {
  const fx = process.env.F30_CONNLOG_FIXTURE;
  if (!fx) { console.log('[F30] no F30_CONNLOG_FIXTURE set - lab-only end-to-end cell skipped'); return; }
  const state = JSON.parse(fs.readFileSync(fx, 'utf8'));
  const begin = ui.indexOf('// [F30 §3 connlog-render-begin]');
  const end = ui.indexOf('// [F30 §3 connlog-render-end]');
  const ctx = { document: { getElementById: id => (ctx.els[id] || (ctx.els[id] = { id, style: {}, textContent: '' })) }, els: {}, String, Number, RegExp };
  vm.createContext(ctx);
  vm.runInContext(ui.slice(begin, end), ctx);
  ctx.paintSrvConnLog({ rdpListener: { connLog: state, connLogCollector: { alive: true, probeError: state.probeError || '' }, tlsNorm: null } });
  const lines = ctx.els.srvConnLogLines.textContent.split('\n').filter(l => l.length > 0);
  assert.strictEqual(lines.length, Math.min(3, state.items.length), 'the lab fixture did not render as newest-3');
  for (const l of lines) assert.match(l, / reason=[a-z0-9-]+/i, 'a rendered line lost its reason code: ' + l);
  assert.ok(!/undefined/.test(ctx.els.srvConnLogLines.textContent), 'the row rendered an undefined field');
});
