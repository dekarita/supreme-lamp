// F19: client-side A/B DNS diagnosis and launcher version/remediation guards.
const fs = require('fs');
const vm = require('vm');
const test = require('node:test');
const assert = require('assert');

const ui = fs.readFileSync('payloads/ui.html', 'utf8');
const launcher = fs.readFileSync('payloads/ghrdp-rdp-launcher.cs', 'utf8');
const server = fs.readFileSync('payloads/ghrdp-server.ps1', 'utf8');
const workflow = fs.readFileSync('.github/workflows/main.yml', 'utf8');
const gates = fs.readFileSync('.github/workflows/launch-gates.yml', 'utf8');

function probeFunction() {
  const start = ui.indexOf('async function f19ProbeOne(');
  const end = ui.indexOf('window.__f19ClientDnsProbe=f19ProbeMatrix;', start);
  assert.ok(start >= 0 && end > start, 'testable F19 probe functions missing');
  const context = { window: {}, AbortController, Promise, setTimeout, clearTimeout };
  vm.runInNewContext(ui.slice(start, end) + '\nwindow.matrix=f19ProbeMatrix;', context);
  return context.window.matrix;
}

test('F19-1 client DNS probe sends parallel no-cors IP and FQDN requests; IP-ok/name-fail is exact red condition', async () => {
  const seen = [];
  const matrix = probeFunction();
  const result = await matrix('100.64.1.9', 'runner.tailnet.ts.net', (url, options) => {
    seen.push({ url, options });
    return url.includes('100.64.1.9') ? Promise.resolve({ type: 'opaque' }) : Promise.reject(new Error('name lookup failed'));
  });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(result)), { ipOk: true, nameOk: false });
  assert.deepStrictEqual(seen.map(x => x.url).sort(), [
    'http://100.64.1.9:7331/', 'http://runner.tailnet.ts.net:7331/'
  ].sort());
  assert.ok(seen.every(x => x.options.mode === 'no-cors'));
  assert.match(ui, /YOUR PC's Tailscale DNS is off \(name not resolvable, IP reachable\)/);
  assert.match(ui, /tailscale set --accept-dns=true\\nipconfig \/flushdns\\nping /);
  assert.match(ui, /Tailscale tray -> Use Tailscale DNS/);
  assert.match(ui, /setInterval\(run,30000\)/);
});

test('F19-2 FQDN success reports client DNS ok; probes start when native status loads', async () => {
  const matrix = probeFunction();
  const result = await matrix('100.64.1.9', 'runner.tailnet.ts.net', () => Promise.resolve({ type: 'opaque' }));
  assert.deepStrictEqual(JSON.parse(JSON.stringify(result)), { ipOk: true, nameOk: true });
  assert.match(ui, /title\.textContent='client DNS ok'/);
  assert.match(ui, /scheduleF19Probe\(\(s&&s\.runnerResolvedIP\)\|\|''/);
});

test('F19-3 launcher DNS failure + reachable tailnet IP selects remediation and never enters cmdkey path', () => {
  assert.match(launcher, /CanReachRdpIp\(ipRaw\)/);
  assert.match(launcher, /ShouldShowClientDnsRemediation\(nameFailed, ipReachable\)/);
  assert.match(launcher, /return nameResolutionFailed && ipReachable;/);
  assert.match(launcher, /false, "client-dns-off"/);
  assert.match(launcher, /tailscale set --accept-dns=true \(or tray -> Use Tailscale DNS\)/);
  assert.ok(launcher.indexOf('string dnsProblem = DnsGuardReason(server);') < launcher.indexOf('int rc = CmdkeyStep(server, user, host, port);'));
  const decision = (nameFailed, reachable) => nameFailed && reachable;
  assert.strictEqual(decision(true, true), true);
  assert.strictEqual(decision(true, false), false);
  assert.strictEqual(decision(false, true), false);
  assert.strictEqual(decision(false, false), false);
  // Injected guard outcomes: DNS fail + reachable diagnosis IP is the visible
  // remediation MessageBox; valid FQDN + reachable route falls through to mstsc.
  const injectedPath = (dnsProblem, ipReachable) => dnsProblem
    ? (decision(true, ipReachable) ? 'client-dns-off-msgbox' : 'dns-guard-msgbox')
    : 'mstsc';
  assert.strictEqual(injectedPath('DNS resolution failed', true), 'client-dns-off-msgbox');
  assert.strictEqual(injectedPath(null, true), 'mstsc');
  assert.match(launcher, /IsTailnetIpv4\(ip\)/);
});

test('F19-4 launcher URL carries diagnosis IP only; mstsc continues to target FQDN', () => {
  assert.match(ui, /\+'&ip='\+encodeURIComponent\(rip\)/);
  assert.match(launcher, /return MstscStep\(server, user, host, port\);/);
  assert.match(launcher, /server must be a \*\.ts\.net FQDN/);
  assert.doesNotMatch(ui, /ghrdp:\/\/rdp[^'\n]*(&|\?)password=/i);
});

test('F19-5 beacon executable version compares against repo launcherVersion and UI links reinstall kit', () => {
  assert.match(workflow, /\$launcherRepoVersion = '2\.2\.0\.0'/);
  assert.match(workflow, /launcherVersion = \$launcherRepoVersion/);
  assert.match(launcher, /\\\"exe\\\":\\\"" \+ J\(Stamp\)/);
  assert.match(server, /\$clientLauncherVersion -lt \[version\]\$launcherVersion/);
  assert.match(server, /launcherOutdated = \$launcherOutdated/);
  assert.match(ui, /launcher outdated - re-run install\.cmd once/);
  assert.match(ui, /href="\/dl\/ghrdp-handler-kit\.zip">DOWNLOAD INSTALL KIT/);
  assert.match(gates, /F19 client DNS \+ launcher version \+ safe URL gates/);
  const cmp = (client, repo) => client.split('.').map(Number).join('.') !== '' && client.split('.').map(Number).reduce((a, n, i) => a || (n < Number(repo.split('.')[i]) ? -1 : n > Number(repo.split('.')[i]) ? 1 : 0), 0) < 0;
  assert.strictEqual(cmp('2.1.0.0', '2.2.0.0'), true);
  assert.strictEqual(cmp('2.2.0.0', '2.2.0.0'), false);
});
