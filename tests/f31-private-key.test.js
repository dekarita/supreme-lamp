// [F31] RDP-Tcp PRIVATE-KEY PERSISTENCE + TLS SELF-PROBE + SCHANNEL CONNLOG.
// Run: node --test tests/f31-private-key.test.js
//
// Ground truth 2026-09-26: Schannel 36870 x2 at the exact mstsc attempt
// timestamps (svchost TermService cannot open the bound cert's private key)
// => RST every ClientHello => client 0x904/0x7, zero 4624/4625. The cert was
// imported without a persisted MACHINE key (RSA-only ACL on a container path
// that never exists for CNG keys, ECDSA never ACL'd, no HasPrivateKey assert,
// no handshake proof). Every assertion here is on a SHIPPED surface; the
// Windows lab lane (autologin-lab step "Y:") then drives the same code
// against a real TermService (default-flags RST + 36870, persisted RSA/ECDSA
// handshake-ok, ACL-deny 36870 + dump).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const main = fs.readFileSync('.github/workflows/main.yml', 'utf8');
const gates = fs.readFileSync('.github/workflows/launch-gates.yml', 'utf8');
const lab = fs.readFileSync('.github/workflows/autologin-lab.yml', 'utf8');
const srv = fs.readFileSync('payloads/ghrdp-server.ps1', 'utf8');
const ui = fs.readFileSync('payloads/ui.html', 'utf8');

function certBody() {
  const a = main.indexOf('name: Bind tailnet LE cert to RDP-Tcp');
  const b = main.indexOf('name: CredSSP/NLA handshake verification');
  assert.ok(a > 0 && b > a, 'cert-bind step boundaries not found');
  return main.slice(a, b);
}

test('F31-1 the cert step builds a PERSISTED machine key (never default/ephemeral) and asserts HasPrivateKey before the bind', () => {
  const cert = certBody();
  // tailscale cert -> .crt + .key (unchanged fetch)
  assert.ok(cert.includes("'cert', '--cert-file'"), 'tailscale cert fetch is missing');
  // PEM -> PFX round-trip -> persisted machine import
  for (const tok of ['CreateFromPem', "Export('Pfx'", 'MachineKeySet', 'PersistKeySet', 'Persistable', 'Exportable',
      'HasPrivateKey', 'cert-imported-without-persisted-key', 'LocalMachine', "'My'"]) {
    assert.ok(cert.includes(tok), 'cert step missing token: ' + tok);
  }
  // the flags line uses -bor with the persisted set, never default/ephemeral
  const flagsLines = cert.split('\n').filter(l => l.includes('X509KeyStorageFlags') && l.includes('-bor'));
  assert.ok(flagsLines.length >= 1, 'no -bor flags line found');
  assert.ok(!/DefaultKeySet|EphemeralKeySet/.test(flagsLines.join('\n')), 'default/ephemeral flags on the persisted import');
  // the assert guards the bind
  assert.ok(cert.indexOf('cert-imported-without-persisted-key') < cert.indexOf('SetSSLCertificateSHA1Hash'),
    'the HasPrivateKey assert must precede the RDP-Tcp bind');
  // extractable blocks for lab cell Y
  for (const tok of ['# [F31 §1 import-begin]', '# [F31 §1 import-end]', '# [F31 §1 probe-begin]', '# [F31 §1 probe-end]',
      'function Import-F31PersistedCert', 'function Test-F31RdpTlsHandshake']) {
    assert.ok(cert.includes(tok), 'extractable block missing: ' + tok);
  }
  // F12 compat: retry + fail-closed + single exit 0 preserved
  assert.ok(cert.includes('for ($attempt = 1; $attempt -le 3; $attempt++)'), 'the 3-attempt fetch loop is missing');
  assert.ok(cert.includes('reason cert-not-bound'), 'the cert-not-bound reason is missing');
  const exits = cert.split('\n').filter(l => /^\s*exit 0\s*$/.test(l));
  assert.strictEqual(exits.length, 1, 'exactly one exit 0 must survive in the cert step');
});

test('F31-2 the key ACL covers RSA CNG + ECDSA CNG + legacy CSP and is asserted after the write', () => {
  const cert = certBody();
  for (const tok of ['GetRSAPrivateKey', 'GetECDsaPrivateKey', 'UniqueName', 'Microsoft\\Crypto\\Keys',
      'Microsoft\\Crypto\\RSA\\MachineKeys', 'NETWORK SERVICE', 'AddAccessRule', 'FullControl',
      'missing after write']) {
    assert.ok(cert.includes(tok), 'ACL token missing: ' + tok);
  }
  // both CNG shapes route to Crypto\Keys (the old code sent CNG UniqueNames
  // to RSA\MachineKeys, which never exists, and skipped ECDSA entirely)
  assert.match(cert, /RSACng[\s\S]{0,200}ECDsaCng|ECDsaCng[\s\S]{0,200}RSACng/,
    'RSA CNG + ECDSA CNG must share the Keys-container branch');
});

test('F31-3 the local TLS self-probe handshakes 127.0.0.1:3389 after the restart and fails closed with a 36870+ACL dump', () => {
  const cert = certBody();
  for (const tok of ['TcpClient', '127.0.0.1', '3389', 'SslStream', 'AuthenticateAsClient', 'localhost',
      'listener-handshake-ok', 'rdp-tls-credential-unusable', '36870',
      'ExpectedThumbprint', 'F31ServedThumbprint', 'not the bound',
      'F31LastProbeDump']) {
    assert.ok(cert.includes(tok), 'self-probe token missing: ' + tok);
  }
  // the handshake must present THE BOUND cert (a fallback self-signed cert is not a pass)
  assert.match(cert, /servedProbe -ne \$ExpectedThumbprint/,
    'the probe must compare the served cert to the bound thumbprint');
  // a throwing call cannot be captured with 6>&1, so the dump line must be
  // recorded in a script-scope variable for the caller to read
  assert.match(cert, /\$script:F31LastProbeDump = \$dumpLine/,
    'the probe must record its dump line in F31LastProbeDump');
  // permissive remote-callback (the probe proves the PRIVATE KEY, not the chain)
  assert.match(cert, /param\(\$snd,\$crt,\$chn,\$err\)[\s\S]{0,300}return \$true/,
    'the probe SslStream lacks the permissive remote-callback');
  // the probe call runs after the TermService restart
  assert.ok(cert.indexOf('Restart-Service TermService') < cert.indexOf('Test-F31RdpTlsHandshake -KeyFile'),
    'the self-probe must run after the TermService restart');
  // failure dumps the last 36870 + the key ACL, secret-free, then throws
  assert.match(cert, /Get-WinEvent[\s\S]{0,300}36870/, 'the failure path does not dump the last 36870');
  assert.ok(cert.includes('Get-Acl -LiteralPath $KeyFile'), 'the failure path does not dump the key ACL');
  assert.ok(cert.includes("throw 'rdp-tls-credential-unusable'"), 'the probe must throw rdp-tls-credential-unusable');
});

test('F31-4 the connLog collector adds System Schannel 36870/36871/12017/12018 (last 5) with ID-first reason codes', () => {
  const begin = srv.indexOf('# [F30 §3 connlog-begin]');
  const end = srv.indexOf('# [F30 §3 connlog-end]');
  assert.ok(begin > 0 && end > begin, 'conn-log block markers missing');
  const blk = srv.slice(begin, end);
  for (const tok of ['F31SchannelIds', '36870', '36871', '12017', '12018', 'F31SchannelMax',
      'schannel-private-key', 'schannel-cipher', 'schannel-no-cred', "LogName = 'System'"]) {
    assert.ok(blk.includes(tok), 'Schannel token missing: ' + tok);
  }
  // last 5
  assert.match(blk, /\$script:F31SchannelMax = 5/, 'Schannel window is not last-5');
  // ID branches precede generic text (a 36870 message also matches TLS-failed patterns)
  assert.ok(blk.indexOf("evt -eq '36870'") < blk.indexOf("t -match 'forcibly closed'"),
    'the 36870 ID branch must precede the generic text matches');
  // a healthy host (no Schannel errors) is NOT a probe failure
  assert.match(blk, /No events were found/, 'an empty Schannel window must not set probeError');
  // one scalar-Id query per ID: an ARRAY Id in the FilterHashtable is silently
  // unsatisfiable (lab-proven blind sweep)
  assert.ok(blk.includes('Id = $schId'), 'the sweep must query one scalar Id at a time');
  assert.ok(!blk.includes('Id = $script:F31SchannelIds'), 'the sweep must not pass an array Id to the FilterHashtable');
  // F30 shape preserved
  for (const tok of ['tls-forcibly-closed', 'cert-rejected', '$script:F30ConnLogIntervalSec = 30']) {
    assert.ok(blk.includes(tok), 'F30 token lost: ' + tok);
  }
});

test('F31-5 SERVER CONN LOG renders Schannel reasons with their human causes (shipped renderer executed)', () => {
  for (const tok of ['schannel-private-key', 'private-key/ACL', 'schannel-cipher', 'schannel-no-cred']) {
    assert.ok(ui.includes(tok), 'dashboard missing token: ' + tok);
  }
  const begin = ui.indexOf('// [F30 §3 connlog-render-begin]');
  const end = ui.indexOf('// [F30 §3 connlog-render-end]');
  assert.ok(begin > 0 && end > begin, 'renderer markers missing');
  const ctx = { document: { getElementById: id => (ctx.els[id] || (ctx.els[id] = { id, style: {}, textContent: '' })) }, els: {}, String, Number, RegExp };
  vm.createContext(ctx);
  vm.runInContext(ui.slice(begin, end), ctx);
  ctx.paintSrvConnLog({ rdpListener: {
    connLogCollector: { alive: true, probeError: '' }, tlsNorm: null,
    connLog: { ts: '2026-09-26T19:43:00.0000000Z', count: 2, probeError: '',
      items: [
        { id: '36870', provider: 'Schannel', timeUtc: '2026-09-26T19:43:11.0000000Z', level: '2', reason: 'schannel-private-key', desc: 'A fatal error occurred when attempting to access the TLS server credential private key' },
        { id: '36871', provider: 'Schannel', timeUtc: '2026-09-26T19:43:10.0000000Z', level: '2', reason: 'schannel-cipher', desc: 'A fatal error occurred while creating a TLS client credential' },
      ] } } });
  const lines = ctx.els.srvConnLogLines.textContent.split('\n');
  assert.strictEqual(lines.length, 2, 'both Schannel events must render');
  assert.match(lines[0], /#36870 Schannel reason=schannel-private-key \(private-key\/ACL\)/);
  assert.match(lines[1], /#36871 Schannel reason=schannel-cipher \(cipher\)/);
  assert.match(ctx.els.srvConnLogState.textContent, /collector alive/);
});

test('F31-6 the F31 gate step and the Windows lab cell Y are pinned in the workflows', () => {
  assert.ok(gates.includes('F31 private-key persistence + TLS self-probe + Schannel connlog gates'),
    'the F31 gate step is missing');
  assert.ok(gates.includes('tests/f31-private-key.test.js'), 'the gate step does not run this matrix');
  assert.ok(gates.includes('Parse the F31 extracted blocks'), 'the F31 parse step is missing');
  assert.ok(lab.includes('Y: F31 private-key persistence + TLS self-probe + Schannel connLog'),
    'the Windows lab cell is missing');
  assert.ok(lab.includes('Y_result=pass'), 'the lab cell never reports pass');
  assert.ok(lab.includes('| (y) RDP-Tcp private-key persistence + self-probe + Schannel log (F31) |'),
    'the lab matrix row is missing');
});

// Optional: the LAB feeds the REAL Schannel collector output here (env set by
// autologin-lab step Y), so (d) is proven end to end: collector -> state file
// -> shipped renderer.
test('F31-7 a Schannel collector fixture (when the lab provides one) maps to the dashboard row', () => {
  const fx = process.env.F31_SCHANNEL_FIXTURE;
  if (!fx) { console.log('[F31] no F31_SCHANNEL_FIXTURE set - lab-only end-to-end cell skipped'); return; }
  const state = JSON.parse(fs.readFileSync(fx, 'utf8'));
  const begin = ui.indexOf('// [F30 §3 connlog-render-begin]');
  const end = ui.indexOf('// [F30 §3 connlog-render-end]');
  const ctx = { document: { getElementById: id => (ctx.els[id] || (ctx.els[id] = { id, style: {}, textContent: '' })) }, els: {}, String, Number, RegExp };
  vm.createContext(ctx);
  vm.runInContext(ui.slice(begin, end), ctx);
  ctx.paintSrvConnLog({ rdpListener: { connLog: state, connLogCollector: { alive: true, probeError: state.probeError || '' }, tlsNorm: null } });
  const text = ctx.els.srvConnLogLines.textContent;
  assert.match(text, /reason=schannel-private-key \(private-key\/ACL\)/, 'the lab Schannel fixture did not render 36870 with its cause');
  assert.ok(!/undefined/.test(text), 'the row rendered an undefined field');
});
