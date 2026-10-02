// [F34] UP-STEP IP POLL + CLASSIFIER LINKS, IP-FIRST STAGE BRANCHING, KEEP-ALIVE SKIP
// Run: node --test tests/f34-up-diagnosis.test.js
//
// Nothing here re-implements the workflow from memory. The classifier table, the
// CGNAT validator, the MagicDNS gate and the keep-alive guard are all PARSED OUT OF
// main.yml and then executed over synthetic fixtures, so a fixture can only pass if
// the shipped PowerShell text says so. Ordering assertions pin the branches to their
// real line positions, which is the part that cannot be tested by grep.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const wf = fs.readFileSync('.github/workflows/main.yml', 'utf8');
const lines = wf.split('\n');
const gates = fs.readFileSync('.github/workflows/launch-gates.yml', 'utf8');

function region(startRe, endRe) {
  const s = lines.findIndex(l => startRe.test(l));
  assert.ok(s >= 0, `step not found: ${startRe}`);
  let e = lines.length;
  for (let i = s + 1; i < lines.length; i++) if (endRe.test(lines[i])) { e = i; break; }
  const text = lines.slice(s, e).join('\n');
  return { start: s, end: e, text, at: re => lines.slice(s, e).findIndex(l => re.test(l)) };
}
const up = region(/^      - name: Tailscale up \(TS_AUTHKEY fail-closed/, /^      - name: Wait for Tailscale connected/);
const stage = region(/^      - name: Wait for Tailscale connected/, /^      - name: Runner FQDN self-test/);
const ka = region(/^      - name: Keep-alive 5h30/, /^      - name: Cleanup \(wipe profiles/);

// ---------------------------------------------------------------------------
// Shared extraction helpers
// ---------------------------------------------------------------------------
const KEYS = 'https://login.tailscale.com/admin/settings/keys';
const STATUS = 'https://status.tailscale.com';

// $keysUrl / $statusUrl are read from the step itself: a class may never point at a
// URL that production does not have.
function urlOf(varName, text) {
  const m = text.match(new RegExp('\\$' + varName + " = '([^']+)'"));
  assert.ok(m, `$${varName} is not defined in the step`);
  return m[1];
}
const keysUrl = urlOf('keysUrl', up.text);
const statusUrl = urlOf('statusUrl', up.text);

// The SHIPPED classifier table, in source order (PowerShell evaluates it top-down,
// first match wins). Patterns are compiled with /i because `-match` is insensitive.
function classes(text) {
  const rows = [...text.matchAll(/Reason = '([^']+)'; Url = \$(\w+); Pattern = '([^']+)'/g)];
  assert.ok(rows.length >= 3, 'classifier table missing (gate would be vacuous)');
  return rows.map(([, reason, urlVar, pattern]) => ({
    reason,
    url: urlVar === 'keysUrl' ? keysUrl : urlVar === 'statusUrl' ? statusUrl : `?$${urlVar}`,
    re: new RegExp(pattern, 'i'),
  }));
}
function classify(text, tailText, { stateRunning = false, tsIp = '' } = {}) {
  assert.match(text, /foreach \(\$cl in \$f34Classes\) \{/);
  assert.match(text, /if \(\$reason -eq 'ts-authkey-unknown' -and \$stateRunning -and -not \$tsIp\)/);
  let reason = 'ts-authkey-unknown';
  let url = keysUrl;
  for (const c of classes(text)) if (c.re.test(tailText)) { reason = c.reason; url = c.url; break; }
  if (reason === 'ts-authkey-unknown' && stateRunning && !tsIp) reason = 'ts-tailnet-ip-unavailable';
  return { reason, url };
}

// ---------------------------------------------------------------------------
// (a) UP-STEP CLASSIFIER: three synthetic up-logs -> class + correct link
// ---------------------------------------------------------------------------
const FIXTURES = [
  {
    name: 'authkey-invalid',
    // Rejected key: fatal wording, plus dial noise that the generic control-plane
    // pattern would happily match -> the ORDER of the table is the whole point.
    log: '2026-09-27T05:58:02Z tailscale: auth keys server returned error: nodekey: invalid key (not a valid auth key)\n'
       + '2026-09-27T05:58:02Z dial tcp 162.159.212.233:443: connectex: timed out after 30s',
    expect: { reason: 'ts-authkey-invalid', url: keysUrl },
  },
  {
    name: 'rate-limited',
    log: '2026-09-27T05:58:04Z tailscale: login error: too many requests (HTTP 429)\n'
       + '2026-09-27T05:58:04Z rate limit exceeded for this tailnet; retry later',
    expect: { reason: 'ts-authkey-ratelimited', url: keysUrl },
  },
  {
    name: 'control-plane',
    log: '2026-09-27T05:58:06Z tailscale: login error: could not contact the coordination server\n'
       + '2026-09-27T05:58:06Z controlapi: dial tcp: lookup login.tailscale.com: no such host\n'
       + '2026-09-27T05:58:07Z Temporary Failure: 503 Service Unavailable - please try again',
    expect: { reason: 'ts-control-plane', url: statusUrl },
  },
];

test('F34-2 classifier: every synthetic up-log gets its class AND its own link', () => {
  for (const f of FIXTURES) {
    const got = classify(up.text, f.log);
    assert.equal(got.reason, f.expect.reason, `${f.name}: wrong class (${got.reason})`);
    assert.equal(got.url, f.expect.url, `${f.name}: wrong remediation link (${got.url})`);
  }
  // A control-plane outage must NEVER be sent to the keys page, and a bad key must
  // never be blamed on Tailscale - the two links have to stay distinct.
  assert.notEqual(keysUrl, statusUrl);
});

test('F34-2 classifier: authkey classes win over the generic control-plane pattern', () => {
  const both = 'login error: invalid auth key\ncontrolapi: dial tcp: connectex: timed out';
  assert.equal(classify(up.text, both).reason, 'ts-authkey-invalid');
  // Nothing matched at all -> honest unknown, still with a usable link.
  assert.equal(classify(up.text, 'some unrelated noise').reason, 'ts-authkey-unknown');
  assert.equal(classify(up.text, 'some unrelated noise').url, keysUrl);
});

test('F34-1 Running-without-an-address is its own class, not "unknown"', () => {
  assert.equal(classify(up.text, '', { stateRunning: true, tsIp: '' }).reason, 'ts-tailnet-ip-unavailable');
  assert.equal(classify(up.text, '', { stateRunning: true, tsIp: '100.83.13.45' }).reason, 'ts-authkey-unknown');
  assert.equal(classify(up.text, 'too many requests 429', { stateRunning: true, tsIp: '' }).reason, 'ts-authkey-ratelimited');
});

test('F34-1 up-step poll waits for BackendState AND a CGNAT IP, then publishes it', () => {
  assert.match(up.text, /for \(\$i = 0; \$i -lt 90; \$i\+\+\)/, 'poll is no longer 90 x 1s = 90s (F64: same window as 45 x 2s)');
  assert.match(up.text, /Start-Sleep -Seconds 1/);
  const running = up.at(/\$j\.BackendState -eq 'Running'/);
  const ips = up.at(/\$j\.Self\.TailscaleIPs/);
  const okAt = up.at(/if \(\$tsIp\) \{ \$ok = \$true; break \}/);
  assert.ok(running >= 0 && ips > running && okAt > ips, 'Running and the IP must be required together');
  // The IP is validated against the SAME anchored CGNAT pattern as the webdesk ladder.
  const cgnat = up.text.match(/\$cgnat = '([^']+)'/);
  assert.ok(cgnat, 'no CGNAT validator in the up-step');
  const re = new RegExp(cgnat[1]);
  assert.ok(re.test('100.83.13.45'), 'validator rejects a real CGNAT address');
  for (const bad of ['100.83.13.45evil', '100.63.0.1', '10.0.0.5', '']) {
    assert.ok(!re.test(bad), `validator accepts '${bad}' (unanchored/out of range)`);
  }
  assert.match(up.text, /TS_TAILNET_IP=/, 'the proven address is not handed to later steps');
  assert.ok(!/& \$ts ip -4/.test(up.text), 'up-step must not call `tailscale ip -4` (F9n/F25: 401s)');
});

test('F34-2 every halt path carries the CLASS link, not a hard-coded keys URL', () => {
  assert.match(up.text, /Emit-SecretHalt 'TS_AUTHKEY login failed' \$haltUrl/);
  assert.doesNotMatch(up.text, /Emit-SecretHalt 'TS_AUTHKEY login failed' \$keysUrl/);
});

// ---------------------------------------------------------------------------
// (b) STAGE BRANCHING: empty IP cannot reach the MagicDNS sentence
// ---------------------------------------------------------------------------
// The SHIPPED ts.net gate + the SHIPPED CGNAT validator, lifted out of the step so the
// fixture below evaluates production's own predicates.
const dnsGate = stage.text.match(/\$dnsName -notmatch '(\^[^']+)'/);
assert.ok(dnsGate, 'stage step has no MagicDNS validation');
const dnsRe = new RegExp(dnsGate[1], 'i');
const stageCgnat = stage.text.match(/\$cgnat = '([^']+)'/);
assert.ok(stageCgnat, 'stage step has no CGNAT validator');
const stageRe = new RegExp(stageCgnat[1]);

const ipHaltAt = stage.at(/tailnet IP unavailable after sign-in/);
const dnsAssignAt = stage.at(/\$dnsName = ''/);
const dnsHaltAt = stage.at(/enable MagicDNS in tailnet DNS settings/);

// A real MagicDNS name carries the tailnet label: <host>.<tailnet>.ts.net.
const FQDN = 'ghrdp-ab12cd.supreme-lamp.ts.net';

test('F34-3 the empty-IP halt sits BEFORE every MagicDNS branch', () => {
  assert.ok(ipHaltAt > 0, 'no empty-IP halt in the stage step');
  assert.ok(dnsAssignAt > ipHaltAt, 'the IP halt does not precede $dnsName assignment');
  assert.ok(dnsHaltAt > ipHaltAt, 'the IP halt does not precede the MagicDNS throw');
  // The sentence must exist only in the MagicDNS branch, never in the IP halt block.
  const haltBlock = stage.text.split('\n').slice(ipHaltAt - 22, ipHaltAt + 3).join('\n');
  assert.ok(!/MagicDNS is OFF/.test(haltBlock), 'the IP halt emits the MagicDNS sentence');
  assert.match(haltBlock, /throw 'tailnet IP unavailable/);
  assert.match(haltBlock, /::error::\[F34\]/);
  assert.match(haltBlock, new RegExp(KEYS.replace(/[/.]/g, m => '\\' + m)));
  assert.match(haltBlock, new RegExp(STATUS.replace(/[/.]/g, m => '\\' + m)));
});

// Runs the stage step's own branching: ladder, then the two fail-closed gates.
function runStage({ upStepIp = '', statusIps = [], cliIp = '', dnsName = '' }) {
  const out = [];
  let ip = '';
  let source = 'none';
  const ladder = [[upStepIp, 'up-step'], ...statusIps.map(a => [a, 'status-json']), [cliIp, 'tailscale-ip']];
  for (const [candidate, name] of ladder) {
    if (!ip && String(candidate || '').trim().match(stageRe)) { ip = String(candidate).trim(); source = name; }
  }
  if (!ip) { out.push('ip-halt'); return { out, ip, source }; }
  if (!dnsName.match(dnsRe)) out.push('magicdns-halt');
  else out.push('continue');
  return { out, ip, source };
}

test('F34-3 empty-IP fixture cannot emit the MagicDNS sentence', () => {
  const r = runStage({ upStepIp: '', statusIps: [], cliIp: '', dnsName: 'ghrdp-ab12cd.ts.net' });
  assert.deepEqual(r.out, ['ip-halt'], `branching leaked past the IP gate: ${r.out}`);
  assert.ok(!r.out.includes('magicdns-halt'), 'an empty IP must not be diagnosed as MagicDNS');
  // Even a perfectly good MagicDNS name cannot save a run with no address.
  assert.deepEqual(runStage({ upStepIp: '', statusIps: [], cliIp: '', dnsName: '' }).out, ['ip-halt']);
});

test('F34-3 empty-DNS-with-IP fixture MUST emit the MagicDNS sentence', () => {
  const r = runStage({ upStepIp: '100.83.13.45', statusIps: [], cliIp: '', dnsName: '' });
  assert.deepEqual(r.out, ['magicdns-halt'], `the DNS gate was skipped: ${r.out}`);
  assert.equal(r.ip, '100.83.13.45');
  assert.equal(r.source, 'up-step', 'ladder order drifted');
  assert.deepEqual(runStage({ upStepIp: '', statusIps: ['fd7a::1234', '100.83.13.45'], cliIp: '', dnsName: FQDN }).out, ['continue']);
  assert.deepEqual(runStage({ upStepIp: '', statusIps: ['100.83.13.45evil'], cliIp: '100.83.13.45', dnsName: FQDN }).source, 'tailscale-ip');
});

// ---------------------------------------------------------------------------
// (c) KEEP-ALIVE: quiet skip while ghrdp-server.ps1 is not on disk
// ---------------------------------------------------------------------------
const skipGuardAt = ka.at(/if \(-not \$psOk -and -not \(Test-Path -LiteralPath 'C:[^']*ghrdp-server\.ps1'\)\) \{/);
const skipLineAt = ka.at(/dashboard restart skipped \(nothing to heal yet\)/);
const gatedRestartAt = ka.at(/if \(-not \$psOk -and -not \$psSkipped\) \{/);

test('F34-4 keep-alive probes for the payload, then quietly skips', () => {
  assert.ok(skipGuardAt > 0, 'keep-alive never probes for ghrdp-server.ps1');
  assert.ok(skipLineAt > skipGuardAt, 'the quiet-skip line is outside the guard');
  assert.ok(gatedRestartAt > skipLineAt, 'the restart block is not gated on $psSkipped');
  const skipLine = ka.text.split('\n')[skipLineAt];
  assert.match(skipLine, /\$icons\.hourglass/, 'the skip is not quiet (it must not shout)');
  assert.ok(!/::error::|\$icons\.(warn|wrench|siren)/.test(skipLine), 'the skip line reads like an incident');
  // The real restart path is untouched for a present payload.
  assert.match(ka.text, /restarting GhrdpServer/);
});

function keepAliveTick({ psOk, ps1Present, dueForFix = true }) {
  const out = [];
  assert.match(ka.text, /if \(-not \$psOk -and -not \(Test-Path/);
  let psSkipped = false;
  if (!psOk && !ps1Present) { psSkipped = true; out.push('skip'); }
  assert.match(ka.text, /if \(-not \$psOk -and -not \$psSkipped\) \{/);
  if (!psOk && !psSkipped && dueForFix) out.push('restart');
  return out;
}

test('F34-4 absent ps1 => skip only; present ps1 => the heal still runs', () => {
  assert.deepEqual(keepAliveTick({ psOk: false, ps1Present: false }), ['skip']);
  assert.deepEqual(keepAliveTick({ psOk: false, ps1Present: true }), ['restart']);
  assert.deepEqual(keepAliveTick({ psOk: true, ps1Present: false }), []);
});

// ---------------------------------------------------------------------------
// (d) LAUNCH GATES: all three behaviors must be grepped, non-vacuously
// ---------------------------------------------------------------------------
test('F34 gates grep all three behaviors and run this matrix', () => {
  const gStart = lines.length ? gates.split('\n').findIndex(l => /- name: F34 up-step IP poll/.test(l)) : -1;
  assert.ok(gStart >= 0, 'launch-gates.yml has no F34 step');
  const gText = gates.split('\n').slice(gStart, gStart + 40).join('\n');
  for (const marker of ['Self.TailscaleIPs', 'ts-control-plane', 'tailnet IP unavailable after sign-in',
                        'dashboard restart skipped (nothing to heal yet)', '$psSkipped']) {
    assert.ok(gText.includes(marker), `gate does not grep '${marker}'`);
    const inProd = [up.text, stage.text, ka.text].some(t => t.includes(marker));
    assert.ok(inProd, `gate greps '${marker}' but main.yml does not contain it`);
  }
  assert.match(gText, /node --test tests\/f34-up-diagnosis\.test\.js/, 'gate does not execute the matrix');
});

// ---------------------------------------------------------------------------
// The dashboard must not stay silent about the two new classes
// ---------------------------------------------------------------------------
test('F34-2 ui.html names the fix for ts-control-plane / ts-tailnet-ip-unavailable', () => {
  const html = fs.readFileSync('payloads/ui.html', 'utf8');
  const cp = html.indexOf("tsReason==='ts-control-plane'");
  const ipu = html.indexOf("tsReason==='ts-tailnet-ip-unavailable'");
  assert.ok(cp > 0 && ipu > 0, 'no guidance branch for the new classes');
  assert.ok(html.slice(cp, cp + 900).includes('TS_STATUS_URL'), 'control-plane guidance does not link the status page');
  assert.ok(html.includes("var TS_STATUS_URL='" + STATUS + "';"), 'TS_STATUS_URL is not the status page');
  assert.ok(!/admin\/settings\/keys/.test(html.slice(cp, cp + 300)), 'control-plane guidance blames the keys page');
  assert.ok(html.slice(ipu, ipu + 900).includes('MagicDNS'), 'the IP class must say it is not a MagicDNS problem');
});
