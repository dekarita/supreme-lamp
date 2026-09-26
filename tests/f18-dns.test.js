// [F18] Runner FQDN self-test + client DNS diagnostics + launcher guard.
const fs = require('fs');
const test = require('node:test');
const assert = require('assert');

const mainYml = fs.readFileSync('.github/workflows/main.yml', 'utf8');
const ui = fs.readFileSync('payloads/ui.html', 'utf8');
const server = fs.readFileSync('payloads/ghrdp-server.ps1', 'utf8');
const launcher = fs.readFileSync('payloads/ghrdp-rdp-launcher.cs', 'utf8');
const gates = fs.readFileSync('.github/workflows/launch-gates.yml', 'utf8');

function step(src, re) {
  const lines = src.split('\n');
  let start = -1, end = -1;
  for (let i = 0; i < lines.length; i++) {
    if (start < 0 && re.test(lines[i])) { start = i; continue; }
    if (start >= 0 && /^      - name: /.test(lines[i])) { end = i; break; }
  }
  assert.ok(start > 0, 'step not found');
  if (end < 0) end = lines.length;
  return lines.slice(start, end).join('\n');
}

test('F18-1 main.yml: runner FQDN self-test after tailscale-connect, loud fail', () => {
  const p = step(mainYml, /name: Runner FQDN self-test \(F18/);
  for (const tok of [
    'Resolve-DnsName',
    'Runner cannot resolve own FQDN',
    'throw',
    'Runner FQDN resolves to',
    'RUNNER_RESOLVED_IP=',
    '^100\\.(6[4-9]|[7-9]\\d|1[01]\\d|12[0-7])\\.',
  ]) assert.ok(p.includes(tok), 'self-test missing: ' + tok);
  const connectAt = mainYml.indexOf('name: Wait for Tailscale connected');
  const selfAt = mainYml.indexOf('name: Runner FQDN self-test (F18');
  const certAt = mainYml.indexOf('name: Bind tailnet LE cert to RDP-Tcp');
  assert.ok(connectAt > 0 && selfAt > connectAt && certAt > selfAt, 'self-test must sit after connect and before cert-bind');
  assert.ok(mainYml.includes('runnerResolvedIP'), 'config.json must store runnerResolvedIP');
});

test('F18-2 server + UI: runnerResolvedIP + AUTO-LOGIN gate + CONNECTION DIAGNOSTICS', () => {
  assert.ok(server.includes('runnerResolvedIP'), 'native-status must return runnerResolvedIP');
  assert.ok(server.includes("reasons += 'runner-dns-broken'"), 'must disable when runner DNS is broken');
  assert.ok(ui.includes('CONNECTION DIAGNOSTICS'), 'diagnostics heading missing');
  assert.ok(ui.includes('id="connDiagNs"'), 'nslookup copy line missing');
  assert.ok(ui.includes('id="connDiagResolved"'), 'runnerResolvedIP display missing');
  assert.ok(ui.includes('Runner DNS broken'), 'disabled AUTO-LOGIN copy missing');
  assert.ok(ui.includes('__runnerDnsOk'), 'UI DNS gate missing');
  assert.ok(ui.includes('var all=ok&&lOK&&dOK;'), 'AUTO-LOGIN must AND runner DNS');
  assert.ok(ui.includes('ipconfig /flushdns'), 'advisory flushdns missing');
  assert.ok(ui.includes('enable MagicDNS'), 'MagicDNS advisory missing');
});

test('F18-3 launcher: DNS guard MessageBox + log resolved IP, no mstsc on fail', () => {
  assert.ok(launcher.includes('Dns.GetHostAddresses'), 'must resolve before .rdp');
  assert.ok(launcher.includes('DNS resolution failed'), 'resolve-fail MessageBox missing');
  assert.ok(launcher.includes('DNS returned non-tailnet IP'), 'non-tailnet MessageBox missing');
  assert.ok(launcher.includes('DNS resolved '), 'success log missing');
  assert.ok(launcher.includes('hello ok') || launcher.includes('HelloBounded(host, port, verb, false'), 'hello ok:false on fail');
  const gw = launcher.indexOf('string dnsProblem = DnsGuardReason(server);');
  const ck = launcher.indexOf('int rc = CmdkeyStep(server, user, host, port);');
  assert.ok(gw > 0 && ck > gw, 'DNS guard must run before cmdkey/mstsc');
});

test('F18-4 gates pin the self-test and launcher guard', () => {
  assert.match(gates, /name: F18 runner FQDN self-test/);
  for (const tok of ['Resolve-DnsName', 'Runner cannot resolve own FQDN', 'Dns.GetHostAddresses', 'CONNECTION DIAGNOSTICS']) {
    assert.ok(gates.includes(tok), 'gate does not pin: ' + tok);
  }
});
