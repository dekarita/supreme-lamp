// [F25] MULTI-SOURCE TAILNET IP LADDER + WRITER-SIDE ASSERTION
// Run: node --test tests/f25-tailnet-ip-ladder.test.js
//
// The ladder is EXERCISED, not grepped: the CGNAT pattern is parsed out of
// main.yml and the L1/L2a/L2b/L3 rungs are driven in the same order the
// shipped PowerShell evaluates them, over the three §4 lab scenarios. A
// separate ordering assertion pins the port to the real source (each rung's
// guard expression must appear, and in ascending line order), so the port
// cannot silently drift from the workflow.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

const main = fs.readFileSync('.github/workflows/main.yml', 'utf8');
const gates = fs.readFileSync('.github/workflows/launch-gates.yml', 'utf8');
const mainLines = main.split('\n');

// ---------------------------------------------------------------------------
// Step regions, isolated the same way the launch gates isolate them.
// ---------------------------------------------------------------------------
function region(startRe, endRe) {
  const s = mainLines.findIndex(l => startRe.test(l));
  assert.ok(s >= 0, `step not found: ${startRe}`);
  let e = mainLines.length;
  for (let i = s + 1; i < mainLines.length; i++) {
    if (endRe.test(mainLines[i])) { e = i; break; }
  }
  return { start: s, text: mainLines.slice(s, e).join('\n') };
}
const webdesk = region(/^      - name: Web desktop \(noVNC/,
                       /^      - name: Web desktop self-test/);
const stage = region(/^      - name: Stage files \+ write config\.json/,
                     /^      - name: RDP listener self-probe/);

// ---------------------------------------------------------------------------
// The SHIPPED CGNAT pattern, lifted out of main.yml - the test can never
// validate against a different range than production does.
// ---------------------------------------------------------------------------
const cgnatMatch = webdesk.text.match(/\$cgnat = '([^']+)'/);
assert.ok(cgnatMatch, 'webdesk step does not define $cgnat');
const CGNAT = new RegExp(cgnatMatch[1]);

test('the CGNAT pattern is the real 100.64.0.0/10 range', () => {
  // The §2 CGNAT prefix, anchored end-to-end (see the comment in main.yml:
  // this is the one place the value is pasted into the advertised URL).
  assert.equal(cgnatMatch[1],
               '^100\\.(6[4-9]|[7-9]\\d|1[01]\\d|12[0-7])\\.(\\d{1,3})\\.(\\d{1,3})$');
  assert.ok(cgnatMatch[1].endsWith('$'), 'the ladder pattern must be anchored at the end');
  for (const ip of ['100.64.0.1', '100.83.13.45', '100.127.255.254']) {
    assert.match(ip, CGNAT, `${ip} must be CGNAT`);
  }
  for (const ip of ['100.63.0.1', '100.128.0.1', '192.168.1.5', '10.0.0.1',
                    'host.dekarita.ts.net', '', '100.83.13.45extra']) {
    assert.doesNotMatch(ip, CGNAT, `${ip} must NOT be CGNAT`);
  }
});

// ---------------------------------------------------------------------------
// Faithful port of the shipped ladder. `dns` resolves .dnsName the way
// Resolve-DnsName would; null = no A record.
// ---------------------------------------------------------------------------
function ladder(cfg, envIp, dnsResolver = () => null) {
  const rawL1 = String((cfg && cfg.rdpIp) ?? '').trim();
  const rawL2 = String((cfg && cfg.runnerResolvedIP) ?? '').trim();
  const rawDns = String((cfg && cfg.dnsName) ?? '').trim();
  const rawL3 = String(envIp ?? '').trim();

  const diag = { L1: 'rdpIp=ABSENT', L2: 'runnerResolvedIP=ABSENT dns=ABSENT',
                 L3: 'env=ABSENT' };
  if (cfg) {
    diag.L1 = `rdpIp=${rawL1 || 'ABSENT'}`;
    diag.L2 = `runnerResolvedIP=${rawL2 || 'ABSENT'} dns=` +
      (rawDns ? `${rawDns}->${(dnsResolver(rawDns) || 'no-A')}` : 'ABSENT');
  }
  diag.L3 = `env=${rawL3 || 'ABSENT'}`;

  let rdpIp = '', src = '';
  if (CGNAT.test(rawL1)) { rdpIp = rawL1; src = 'L1'; }                     // L1
  if (!rdpIp && CGNAT.test(rawL2)) { rdpIp = rawL2; src = 'L2'; }           // L2a
  let dnsCand = '';
  if (!rdpIp && rawDns) dnsCand = String(dnsResolver(rawDns) || '');        // L2b
  if (!rdpIp && CGNAT.test(dnsCand)) { rdpIp = dnsCand; src = 'L2'; }
  if (!rdpIp && CGNAT.test(rawL3)) { rdpIp = rawL3; src = 'L3'; }           // L3

  const dump = `L1 ${diag.L1} | L2 ${diag.L2} | L3 ${diag.L3}`;
  return { rdpIp, src, dump };
}

// The port must mirror the real source: every rung guard present, in order.
test('the port mirrors the shipped rung order in main.yml', () => {
  const rungs = [
    ['L1',  'if ($rawL1.Trim() -match $cgnat) { $rdpIp = $rawL1.Trim(); $ipSrc = \'L1\' }'],
    ['L2a', '-not $rdpIp -and $rawL2.Trim() -match $cgnat'],
    ['L2b', '-not $rdpIp -and $dnsCand -match $cgnat'],
    ['L3',  '-not $rdpIp -and $rawL3.Trim() -match $cgnat'],
  ];
  let prev = -1;
  for (const [name, tok] of rungs) {
    const i = webdesk.text.indexOf(tok);
    assert.ok(i >= 0, `rung ${name} missing from the webdesk step: ${tok}`);
    const line = webdesk.start + webdesk.text.slice(0, i).split('\n').length;
    assert.ok(line > prev, `rung ${name} is out of order (line ${line} <= ${prev})`);
    prev = line;
  }
});

// ---------------------------------------------------------------------------
// §4 lab scenarios
// ---------------------------------------------------------------------------
test('(a) config without rdpIp but env set -> recovers via L3 and advertises a URL', () => {
  // Ground-truth shape: vncPass stamp succeeded, so config.json EXISTS, but
  // .rdpIp is empty; RUNNER_RESOLVED_IP=100.83.13.45 is in the step env.
  const cfg = { rdpIp: '', runnerResolvedIP: '', dnsName: 'host.dekarita.ts.net' };
  const r = ladder(cfg, '100.83.13.45', () => null);
  assert.equal(r.src, 'L3');
  assert.equal(r.rdpIp, '100.83.13.45');
  assert.equal('http://' + r.rdpIp + ':7333/vnc.html?autoconnect=1&resize=remote',
               'http://100.83.13.45:7333/vnc.html?autoconnect=1&resize=remote');
  assert.match(r.dump, /L1 rdpIp=ABSENT \| L2 runnerResolvedIP=ABSENT dns=host\.dekarita\.ts\.net->no-A \| L3 env=100\.83\.13\.45/);
});

test('(a2) ground-truth variant: runnerResolvedIP present -> L2 wins over L3', () => {
  const cfg = { rdpIp: '', runnerResolvedIP: '100.83.13.45', dnsName: 'host.dekarita.ts.net' };
  const r = ladder(cfg, '100.83.13.45');
  assert.equal(r.src, 'L2');
  assert.equal(r.rdpIp, '100.83.13.45');
});

test('(b) rdpIp holds the dnsName string -> L1 skipped, L2/L3 used', () => {
  const cfg = { rdpIp: 'host.dekarita.ts.net', runnerResolvedIP: '100.83.13.45',
                dnsName: 'host.dekarita.ts.net' };
  const r = ladder(cfg, '');
  assert.equal(r.src, 'L2');
  assert.equal(r.rdpIp, '100.83.13.45');
  assert.match(r.dump, /L1 rdpIp=host\.dekarita\.ts\.net \|/);
});

test('(b2) rdpIp holds a dnsName and L2 is empty -> Resolve-DnsName supplies the A record', () => {
  const cfg = { rdpIp: 'host.dekarita.ts.net', runnerResolvedIP: '',
                dnsName: 'host.dekarita.ts.net' };
  const r = ladder(cfg, '', () => '100.83.13.45');
  assert.equal(r.src, 'L2');
  assert.equal(r.rdpIp, '100.83.13.45');
});

test('(b3) a non-CGNAT L1 (RFC1918) is skipped, never used', () => {
  const cfg = { rdpIp: '192.168.1.5', runnerResolvedIP: '100.83.13.45', dnsName: '' };
  const r = ladder(cfg, '');
  assert.equal(r.src, 'L2');
  assert.notEqual(r.rdpIp, '192.168.1.5');
});

test('(c) all sources absent -> loud throw with the per-source dump', () => {
  const cfg = { rdpIp: '', runnerResolvedIP: '', dnsName: '' };
  const r = ladder(cfg, '');
  assert.equal(r.rdpIp, '', 'no fabrication: nothing may be invented');
  assert.equal(r.src, '');
  assert.equal(r.dump, 'L1 rdpIp=ABSENT | L2 runnerResolvedIP=ABSENT dns=ABSENT | L3 env=ABSENT');
  // the shipped fail-closed path keeps the same classified halt as F9n
  assert.match(webdesk.text, /Set-WebdeskCfg '' 'serve-failed' 'tailnet-ip-unavailable'/);
  assert.match(webdesk.text, /throw 'Web desktop not deployed: tailnet-ip-unavailable/);
  // ...and prints the dump BEFORE it throws
  assert.ok(webdesk.text.indexOf('tailnet-ip-source-dump') <
            webdesk.text.indexOf("throw 'Web desktop not deployed: tailnet-ip-unavailable"));
});

test('L1 still wins whenever it is a valid CGNAT address (F9n order preserved)', () => {
  const cfg = { rdpIp: '100.83.13.45', runnerResolvedIP: '100.99.0.1', dnsName: '' };
  assert.equal(ladder(cfg, '100.77.0.1').src, 'L1');
  assert.equal(ladder(cfg, '100.77.0.1').rdpIp, '100.83.13.45');
});

test('no source is ever used unless it is CGNAT (no fabrication)', () => {
  for (const bad of ['', '10.0.0.7', '172.16.0.1', '100.63.255.255',
                     '100.128.0.1', 'not-an-ip', '100.83.13.45.evil']) {
    const r = ladder({ rdpIp: bad, runnerResolvedIP: bad, dnsName: '' }, bad, () => bad);
    assert.equal(r.rdpIp, '', `must reject ${JSON.stringify(bad)}`);
    assert.equal(r.src, '');
  }
});

// ---------------------------------------------------------------------------
// §3 FIX B - the stage writer keeps the IP, and the read-back asserts it
// ---------------------------------------------------------------------------
function stageWrite(tailscaleIp, envIp) {
  const CGNAT_S = new RegExp(cgnatMatch[1]);
  let ip = String(tailscaleIp ?? '').trim();
  let source = 'tailscale-cli';
  if (ip && CGNAT_S.test(ip)) { /* keep */ }
  else if (CGNAT_S.test(String(envIp ?? '').trim())) {
    ip = String(envIp).trim(); source = 'RUNNER_RESOLVED_IP';
  }
  return { ip, source };
}

function readBack(cfg) {
  const backIp = String((cfg && cfg.rdpIp) ?? '');
  const backRr = String((cfg && cfg.runnerResolvedIP) ?? '');
  const props = cfg ? Object.keys(cfg).join(',') : 'UNREADABLE';
  if (!CGNAT.test(backIp) || !backRr) {
    throw new Error(`config-writer lost tailnet IP (rdpIp=[${backIp}] ` +
                    `runnerResolvedIP=[${backRr}]; props: ${props})`);
  }
  return true;
}

test('stage writer falls back to RUNNER_RESOLVED_IP when the CLI 401s', () => {
  let r = stageWrite('', '100.83.13.45');
  assert.equal(r.ip, '100.83.13.45');
  assert.equal(r.source, 'RUNNER_RESOLVED_IP');
  r = stageWrite('100.83.13.45', '100.99.0.1');
  assert.equal(r.source, 'tailscale-cli', 'the CLI value is still preferred');
  assert.equal(r.ip, '100.83.13.45');
  r = stageWrite('', '');
  assert.equal(r.ip, '', 'nothing to write -> the read-back assertion halts');
});

test('read-back assertion passes on a good config and throws at the point of loss', () => {
  assert.equal(readBack({ rdpIp: '100.83.13.45', runnerResolvedIP: '100.83.13.45' }), true);
  assert.throws(() => readBack({ rdpIp: '', runnerResolvedIP: '100.83.13.45' }),
                /config-writer lost tailnet IP/);
  assert.throws(() => readBack({ rdpIp: '100.83.13.45', runnerResolvedIP: '' }),
                /config-writer lost tailnet IP/);
  assert.throws(() => readBack({ rdpIp: 'host.dekarita.ts.net', runnerResolvedIP: '100.83.13.45' }),
                /config-writer lost tailnet IP/);
});

test('the shipped stage step really reads config.json back after writing it', () => {
  assert.match(stage.text, /config-writer lost tailnet IP/);
  assert.match(stage.text, /F25 read-back assertion PASS/);
  const wr = stage.text.indexOf("WriteAllText((Join-Path $root 'config.json')");
  const rd = stage.text.indexOf('ReadAllText($cfgPathStage)');
  assert.ok(wr >= 0 && rd >= 0 && rd > wr,
            'the read-back must appear AFTER the config.json write');
});

test('the ladder is advertised in the log for the verify loop', () => {
  assert.match(webdesk.text, /\[webdesk\] tailnet IP source = /);
  assert.match(stage.text, /\[stage\] rdpIp source = /);
});

// ---------------------------------------------------------------------------
// §3.2/§3.3 - no overwrite-style config.json writer (single source of truth:
// the same audit script the launch gate runs).
// ---------------------------------------------------------------------------
test('config.json writer audit: every writer is read-modify-write of the full object', () => {
  try {
    const out = execFileSync('python3',
      ['tests/config-writer-audit.py', '.github/workflows/main.yml'],
      { encoding: 'utf8' });
    assert.match(out, /0 overwrite-style writers/);
  } catch (e) {
    if (e.code === 'ENOENT') return; // python3 absent locally; the gate still runs it
    assert.fail('overwrite-style config.json writer detected:\n' + (e.stderr || e.stdout));
  }
});

// ---------------------------------------------------------------------------
// §3.3 - the gate itself must exist and cover all four requirements
// ---------------------------------------------------------------------------
test('launch-gates pins the ladder, the dump, the assertion and the writer audit', () => {
  const g = gates.split('      - name: F25 tailnet IP ladder + writer assertion gates')[1] || '';
  assert.ok(g, 'F25 gate step missing from launch-gates.yml');
  for (const tok of ['cfgR.rdpIp', 'cfgR.runnerResolvedIP', 'env:RUNNER_RESOLVED_IP',
                     'Resolve-DnsName', 'tailnet-ip-source-dump',
                     'config-writer lost tailnet IP',
                     'tests/config-writer-audit.py']) {
    assert.ok(g.includes(tok), `F25 gate no longer checks: ${tok}`);
  }
});
