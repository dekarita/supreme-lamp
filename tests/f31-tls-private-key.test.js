// [F31/F31b] RDP-Tcp PRIVATE-KEY PERSISTENCE FIX + SELF-PROBE + MATRIX
// Run: node --test tests/f31-tls-private-key.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const main = fs.readFileSync('.github/workflows/main.yml', 'utf8');
const script = fs.readFileSync('payloads/Enable-RdpTlsCertificate.ps1', 'utf8');
const srv = fs.readFileSync('payloads/ghrdp-server.ps1', 'utf8');
const ui = fs.readFileSync('payloads/ui.html', 'utf8');
const lab = fs.readFileSync('.github/workflows/autologin-lab.yml', 'utf8');
const gates = fs.readFileSync('.github/workflows/launch-gates.yml', 'utf8');

test('F31-1 cert bind step in main.yml carries CreateFromPem, PFX re-import with MachineKeySet+PersistKeySet, HasPrivateKey assert and ACLs', () => {
  assert.match(main, /CreateFromPem/);
  assert.match(main, /MachineKeySet/);
  assert.match(main, /PersistKeySet|Persistable/);
  assert.match(main, /HasPrivateKey/);
  assert.match(main, /cert-imported-without-persisted-key/);
  assert.match(main, /Crypto\\Keys/);
  assert.match(main, /RSA\\MachineKeys/);
  assert.match(main, /NETWORK SERVICE/);
  assert.match(main, /SYSTEM/);
});

test('F31-2 cert bind step in main.yml includes local TLS self-probe and fails LOUD if private key is unusable', () => {
  assert.match(main, /AuthenticateAsClient\('localhost'\)/);
  assert.match(main, /listener-handshake-ok/);
  assert.match(main, /rdp-tls-credential-unusable/);
  assert.match(main, /36870/);
});

test('F31-3 Enable-RdpTlsCertificate.ps1 matches CreateFromPem, MachineKeySet+PersistKeySet, HasPrivateKey assert, dual path key lookup, and self-probe', () => {
  assert.match(script, /CreateFromPem/);
  assert.match(script, /MachineKeySet/);
  assert.match(script, /PersistKeySet|Persistable/);
  assert.match(script, /HasPrivateKey/);
  assert.match(script, /cert-imported-without-persisted-key/);
  assert.match(script, /Crypto\\Keys/);
  assert.match(script, /RSA\\MachineKeys/);
  assert.match(script, /NETWORK SERVICE/);
  assert.match(script, /SYSTEM/);
  assert.match(script, /AuthenticateAsClient/);
  assert.match(script, /listener-handshake-ok/);
  assert.match(script, /rdp-tls-credential-unusable/);
});

test('F31-4 ghrdp-server.ps1 includes Schannel 36870, 36871, 12017, 12018 in connLog and maps 36870 to private-key/ACL', () => {
  assert.match(srv, /36870/);
  assert.match(srv, /36871/);
  assert.match(srv, /12017/);
  assert.match(srv, /12018/);
  assert.match(srv, /private-key\/ACL/);
  assert.match(srv, /cipher/);
  assert.match(srv, /no-cred/);
});

test('F31-5 ui.html handles 36870 and private-key/ACL in connlog rendering', () => {
  assert.match(ui, /private-key\/ACL|36870/);
});

test('F31-6 autologin-lab.yml contains step Y for F31 cross-process matrix with per-cell self-reporting summary lines', () => {
  assert.match(lab, /Y: F31/);
  assert.match(lab, /CELL /);
  assert.match(lab, /EXPECT /);
  assert.match(lab, /OBSERVED /);
  assert.match(lab, /RESULT /);
  assert.match(lab, /negative/);
  assert.match(lab, /positive/);
  assert.match(lab, /acl-denied/);
});

test('F31-7 launch-gates.yml carries F31 gates and runs f31-tls-private-key.test.js', () => {
  assert.match(gates, /F31/);
  assert.match(gates, /f31-tls-private-key\.test\.js/);
});
