const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const read = p => fs.readFileSync(p, 'utf8');
const main = read('.github/workflows/main.yml');
const cert = main.split('- name: Bind tailnet LE cert to RDP-Tcp (U5b)')[1].split('- name: CredSSP/NLA')[0];
const helper = read('payloads/rdp-key-probe.ps1');
const server = read('payloads/ghrdp-server.ps1');
test('F31 PEM/PFX import explicitly persists a machine key and asserts HasPrivateKey', () => {
  for (const token of ['::CreateFromPem(', "$loaded.Export('Pfx'", '::MachineKeySet -bor', '::PersistKeySet -bor', '::Exportable', '$imported.HasPrivateKey -ne $true', 'cert-imported-without-persisted-key', "X509Store('My', 'LocalMachine')", 'SetSSLCertificateSHA1Hash']) assert.ok(cert.includes(token), token);
  assert.ok(!cert.includes('EphemeralKeySet'));
});
test('F31 key ACL fails closed, supports CNG RSA/ECDSA and legacy CSP', () => {
  for (const token of ['GetRSAPrivateKey', 'GetECDsaPrivateKey', 'Microsoft\\Crypto\\Keys', '$key.Key.UniqueName', 'UniqueKeyContainerName', 'S-1-5-20', 'S-1-5-18', 'AddAccessRule', 'GetAccessRules', 'key-acl-assert-failed', 'key-acl-denied']) assert.ok(helper.includes(token), token);
  assert.ok(cert.includes('Set-RdpKeyAcl $keyFile'));
  assert.ok(!cert.includes('ACL step skipped'));
});
test('F31 bounded protocol-aware TLS probe runs after mandatory restart', () => {
  assert.ok(cert.indexOf('Restart-Service TermService -Force -ErrorAction Stop') < cert.indexOf('Test-RdpListenerTls -Thumbprint'));
  assert.ok(cert.includes('payloads\\rdp-key-probe.ps1'));
  for (const token of ["ConnectAsync('127.0.0.1', 3389)", 'Read-RdpExact', '3,0,0,19,14,224,0,0,0,0,0,1,0,8,0,11,0,0,0', "AuthenticateAsClient('localhost')", 'GetCertHashString() -ine $Thumbprint', 'listener-handshake-ok', 'rdp-tls-credential-unusable', 'Write-RdpKeyDiagnostic', '$acl.Sddl', '$tcp.Dispose()']) assert.ok(helper.includes(token), token);
});
test('F31 Schannel queries are bounded and emit reason-only descriptions', () => {
  assert.match(server, /ProviderName = 'Schannel'; Id = 36870,36871,12017,12018; StartTime = \$since } -MaxEvents 5/);
  assert.ok(server.includes("if ($Provider -eq 'Schannel') { $desc = Get-RdpConnLogReason"));
  for (const [id, reason] of [['36870','private-key/ACL'], ['36871','cipher'], ['12018','no-cred']]) assert.ok(server.includes(`'${id}' { return '${reason}' }`));
});
test('F31 shipped dashboard renders Schannel ID and mapping with textContent', () => {
  const ui = read('payloads/ui.html');
  const script = ui.split('// [F30 §3 connlog-render-begin]')[1].split('// [F30 §3 connlog-render-end]')[0];
  const elements = Object.fromEntries(['srvConnLogRow','srvConnLogState','srvConnLogLines','srvConnLogTls'].map(id => [id, {style:{},textContent:''}]));
  const ctx = {document:{getElementById:id => elements[id]}}; vm.createContext(ctx); vm.runInContext(script, ctx);
  ctx.paintSrvConnLog({rdpListener:{connLog:{items:[{id:'36870',provider:'Schannel',reason:'private-key/ACL'}]},connLogCollector:{alive:true}}});
  assert.match(elements.srvConnLogLines.textContent, /#36870 Schannel reason=private-key\/ACL/);
});
test('F31 Windows matrix uses separate processes and demands real 36870 evidence', () => {
  const lab = read('tests/f31-private-key.ps1');
  for (const token of ['DefaultKeySet', 'MachineKeySet', 'PersistKeySet', 'import.ps1', 'probe.ps1', "@('RSA', 'ECDSA')", 'ACL-denied PASS', 'Id=36870', 'negative cell lacks observed Schannel 36870', 'finally']) assert.ok(lab.includes(token), token);
  assert.ok(read('.github/workflows/autologin-lab.yml').includes('run: ./tests/f31-private-key.ps1'));
});
