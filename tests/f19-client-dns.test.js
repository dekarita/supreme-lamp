const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ui = fs.readFileSync('payloads/ui.html','utf8');
const cs = fs.readFileSync('payloads/ghrdp-rdp-launcher.cs','utf8');
const server = fs.readFileSync('payloads/ghrdp-server.ps1','utf8');

test('probe matrix: only IP-reachable/name-failed diagnoses DNS', () => {
  const expr = ui.match(/function clientDnsState\(a,b\)\{[^}]+\}/)[0];
  const context = vm.createContext({}); vm.runInContext(expr,context);
  assert.match(context.clientDnsState(true,false),/Tailscale DNS is off/);
  assert.match(context.clientDnsState(true,true),/client DNS ok/);
  assert.doesNotMatch(context.clientDnsState(false,false),/DNS is off/);
  assert.match(ui,/Promise\.all\(\[probe\(ip\),probe\(fqdn\)\]\)/);
  assert.match(ui,/setInterval\(clientDnsProbe,30000\)/);
});
test('launcher DNS fail + reachable tailnet IP displays remediation, both-ok proceeds to mstsc', () => {
  assert.match(cs,/IsTailnetAddress\(parsedIp\)/);
  assert.match(cs,/dnsProblem\.StartsWith\("DNS resolution failed"\).*CanReachRdp\(diagnosticIp\)/);
  assert.match(cs,/HelloBounded\(diagnosticIp, port, verb, false, "client-dns-off"\)/);
  assert.match(cs,/tailscale set --accept-dns=true/);
  assert.ok(cs.indexOf('string dnsProblem = DnsGuardReason(server)') < cs.indexOf('return MstscStep(server'));
});
test('beacon version is compared, unknown client is not treated as current', () => {
  assert.match(cs,/"\\\",\\\"exe\\\":\\\"" \+ Stamp/);
  assert.match(server,/\[version\]\$Matches\[1\] -lt \$currentVersion/);
  assert.match(server,/\$ns.launcherOutdated = \$true/);
});
