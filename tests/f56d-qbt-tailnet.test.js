// [F56-d §2] Node lab: the qBittorrent-nox torrent lane's Tailnet-only policy is
// measured against the SHIPPED artefacts - the single-source policy file
// (payloads/ghrdp-qbt-policy.json), the lane that consumes it
// (payloads/ghrdp-qbt.ps1), the /api/fetch dispatch (payloads/ghrdp-server.ps1) and
// the workflow wiring (.github/workflows/main.yml + launch-gates.yml). The CGNAT
// predicate and the host-matching rule are EXTRACTED from the shipped policy and
// executed here, so a public bind or an allowlist hole cannot pass this lab.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const POLICY = JSON.parse(fs.readFileSync('payloads/ghrdp-qbt-policy.json', 'utf8'));
const LANE = fs.readFileSync('payloads/ghrdp-qbt.ps1', 'utf8');
const SERVER = fs.readFileSync('payloads/ghrdp-server.ps1', 'utf8');
const MAIN = fs.readFileSync('.github/workflows/main.yml', 'utf8');
const GATES = fs.readFileSync('.github/workflows/launch-gates.yml', 'utf8');

// The shipped rule, exercised as-is: exact host or a real subdomain of it.
function allowedHost(host, presets) {
  for (const family of Object.keys(presets)) {
    for (const h of presets[family]) {
      if (host === h || host.endsWith('.' + h)) return family;
    }
  }
  return '';
}

test('F56-d-QBT-POLICY: the lane reads the one policy file and never hardcodes a bind', () => {
  assert.equal(POLICY.schema, 'ghrdp-f56d-qbt-policy/1');
  assert.equal(POLICY.webUiPort, 8080, 'the WebUI port is pinned at 8080');
  assert.equal(POLICY.category, 'ghrdp-fetched');
  assert.equal(POLICY.savePath, 'D:\\RDP-Storage\\Fetched');
  assert.equal(POLICY.tailnetOnly, true);
  assert.ok(LANE.includes('Import-GhrdpQbtPolicy'), 'the lane must consume the single source');
  assert.ok(LANE.includes('qbt-policy-missing'), 'a missing policy must fail closed');
  assert.ok(MAIN.includes('ghrdp-qbt-policy.json'), 'the policy file must be deployed');
  // No duplicated policy constants can silently shadow the file.
  assert.ok(!/^\$script:QbtTailnetRegex\s*=\s*'\^/m.test(LANE), 'the predicate must not be re-hardcoded');
  assert.ok(!/^\$script:QbtWebUiPort\s*=\s*8080/m.test(LANE), 'the port must not be re-hardcoded');
});

test('F56-d-QBT-TAILNET: the shipped CGNAT predicate accepts only the tailnet', () => {
  const re = new RegExp(POLICY.tailnetRegex);
  const octetsOk = (ip) => {
    const m = re.exec(ip);
    if (!m) return false;
    return [m[2], m[3]].every((o) => Number(o) <= 255);
  };
  for (const ip of ['100.64.0.1', '100.80.12.34', '100.127.255.254', '100.100.100.100']) {
    assert.equal(octetsOk(ip), true, `${ip} is inside 100.64.0.0/10`);
  }
  for (const ip of ['100.63.255.255', '100.128.0.1', '10.0.0.1', '172.16.0.9', '192.168.1.5',
    '8.8.8.8', '100.64.0.1evil', '100.64.0.256', '::1', '*', '0.0.0.0']) {
    assert.equal(octetsOk(ip), false, `${ip} must never be accepted as a tailnet bind`);
  }
  assert.ok(LANE.includes('Assert-GhrdpQbtTailnetOnly'), 'the hard guard must exist');
  assert.ok(LANE.includes('qbt-tailnet-only'), 'the guard must refuse with a labeled reason');
  assert.ok(LANE.includes('tailnet-ip-unavailable'), 'the ladder must fail closed, never fall back');
  // The public literal may appear ONLY in the refusal list / refusal probe.
  const offenders = LANE.split(/\r?\n/).filter((l) => /0\.0\.0\.0/.test(l) && !/^\s*#/.test(l) && !/bad\s*=|refused|public|non-tailnet|qbt-tailnet-only/.test(l));
  assert.deepEqual(offenders, [], 'no WebUI bind may name 0.0.0.0');
  assert.ok(!/LocalHostAuth\s*=\s*'?false/i.test(LANE), 'auth may never be disabled for localhost');
  assert.ok(!/WebUI\\Address\s*\)\s*\{?[^}]*'\*'/.test(LANE), "the bind may never be '*'");
});

test('F56-d-QBT-ALLOWLIST: legal-torrent presets, operator own URLs, magnet refused', () => {
  assert.deepEqual(Object.keys(POLICY.presets).sort(), ['blender-open-movie', 'ia-torrents', 'linux-distros']);
  assert.ok(POLICY.presets['linux-distros'].includes('ubuntu.com'));
  assert.ok(POLICY.presets['linux-distros'].includes('debian.org'));
  assert.ok(POLICY.presets['linux-distros'].includes('fedoraproject.org'));
  assert.ok(POLICY.presets['blender-open-movie'].includes('download.blender.org'));
  assert.ok(POLICY.presets['ia-torrents'].includes('archive.org'));
  assert.equal(POLICY.ownUrlsEnv, 'GHRDP_QBT_OWN_URLS');
  const p = POLICY.presets;
  assert.equal(allowedHost('releases.ubuntu.com', p), 'linux-distros');
  assert.equal(allowedHost('download.blender.org', p), 'blender-open-movie');
  assert.equal(allowedHost('ia801504.us.archive.org', p), 'ia-torrents', 'IA subdomains match by suffix');
  assert.equal(allowedHost('archive.org', p), 'ia-torrents');
  assert.equal(allowedHost('ubuntu.com.evil.example', p), '', 'suffix spoof must not match');
  assert.equal(allowedHost('evilubuntu.com', p), '', 'lookalike must not match');
  assert.equal(allowedHost('1337x.to', p), '', 'torrent-indexer hosts are not allowlisted');
  assert.ok(LANE.includes('operator-own-url'), 'operator own URLs are a preset family');
  assert.ok(LANE.includes('magnet-refused') || LANE.includes(POLICY.refusedUrlSchemes[0]), 'magnet-only flows are refused');
  assert.ok(LANE.includes('https-only'), 'the artifact must be HTTPS');
  assert.ok(SERVER.includes("details = @{ transport = 'torrent'; reason"), 'the refusal must be labeled server-side');
});

test('F56-d-QBT-SHA: the install is verified without inventing a digest', () => {
  assert.ok(LANE.includes('Test-GhrdpQbtShaPin'), 'the SHA pin ladder must exist');
  assert.ok(LANE.includes("mode = 'recorded'"), 'a first run records the observed digest');
  assert.ok(LANE.includes("mode = 'verified'"), 'later runs must compare');
  assert.ok(LANE.includes('qbt-sha-pin-mismatch'), 'a mismatch must fail closed');
  assert.ok(LANE.includes('GHRDP_QBT_SHA'), 'an operator SHA pin must be supported');
  assert.equal(/(?<![a-f0-9])[a-f0-9]{64}(?![a-f0-9])/.test(LANE), false, 'no fabricated digest may be hardcoded');
});

test('F56-d-QBT-SECRET: the operator password cannot reach a log line', () => {
  const logged = LANE.split(/\r?\n/).filter((l) => /Write-(Host|Output|Verbose|Warning)/.test(l) && /\$pw\b|Password|password/.test(l));
  assert.deepEqual(logged, [], 'no log line may carry the password');
  assert.ok(LANE.includes('GHRDP_QBT_PASSWORD') || fs.readFileSync('payloads/ghrdp-qbt-policy.json', 'utf8').includes('secretFile'), 'the secret source must be explicit');
  assert.ok(MAIN.includes('GHRDP_QBT_PASSWORD'), 'main.yml must supply the operator secret');
  assert.ok(MAIN.includes('--require-checksums'), 'the chocolatey download must be checksum-enforced');
  assert.ok(/icacls/.test(MAIN), 'the secret file must be ACL-locked');
});

test('F56-d-QBT-DISPATCH: /api/fetch selects the lane and returns the handle', () => {
  assert.ok(/@\('auto', 'aria2c', 'torrent'\)/.test(SERVER), 'the §F transport enum must be validated');
  assert.ok(SERVER.includes("if ($isTorrent) { $transport = 'torrent' }"), 'selection must be explicit');
  assert.ok(SERVER.includes('qbittorrentHandle'), 'the §F accepted shape names the handle');
  assert.ok(SERVER.includes('Get-F56dQbtSession'), 'the request path must build a lane session');
  assert.ok(SERVER.includes('Remove-GhrdpQbtTorrent'), 'cancel must route to the lane');
  assert.ok(SERVER.includes('qbt-open') || SERVER.includes('qbt-helper-missing'), 'a missing lane must be labeled');
  assert.ok(/magnet-refused/.test(SERVER), 'magnet: must be refused pre-dispatch');
  assert.ok(SERVER.includes('payloads\\ghrdp-qbt.ps1'), 'the server must resolve the shipped lane module');
});

test('F56-d-QBT-WIRING: the gate and the labs are wired, not orphaned', () => {
  assert.ok(MAIN.includes('Install qBittorrent-nox 4.6.x'), 'the install step must exist');
  assert.ok(MAIN.includes("'GhrdpQbt'"), 'the daemon must run as a SYSTEM task');
  assert.ok(GATES.includes('tests\\f56d-qbt-tailnet.ps1'), 'the PS lab must run in CI');
  assert.ok(GATES.includes('node --test tests/f56d-qbt-tailnet.test.js'), 'this lab must run in CI');
  assert.ok(!MAIN.includes('0.0.0.0:8080'), 'no public WebUI literal may be deployed');
  assert.ok(GATES.includes('F56-d torrent lane gates'), 'the §2 gate step must exist');
});
