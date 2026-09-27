// [F44] Mirror upload classification: retry-policy unit tests (executable in
// CI without PowerShell), structural pins, and a live mock-server run.
// Zero-dependency (node:test only): runs BEFORE `pnpm install` in launch-gates.
// Run: node --test tests/f44-mirror-diag.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { spawn } = require('node:child_process');

const lf = (s) => s.replace(/\r\n?/g, '\n');
const mod = lf(fs.readFileSync('payloads/ghrdp-mirror-diag.ps1', 'utf8'));
const lib = lf(fs.readFileSync('payloads/ghrdp-lib.ps1', 'utf8'));
const watch = lf(fs.readFileSync('payloads/ghrdp-watcher.ps1', 'utf8'));
const wf = lf(fs.readFileSync('.github/workflows/main.yml', 'utf8'));
const lab = lf(fs.readFileSync('.github/workflows/autologin-lab.yml', 'utf8'));
const gates = lf(fs.readFileSync('.github/workflows/launch-gates.yml', 'utf8'));
const card = lf(fs.readFileSync('src/components/domain/MirrorCard.tsx', 'utf8'));
const progress = lf(fs.readFileSync('src/lib/domain/progress.ts', 'utf8'));
const ui1 = lf(fs.readFileSync('payloads/ui.html', 'utf8'));
const driver = lf(fs.readFileSync('tests/f44-mirror-lab-driver.ps1', 'utf8'));
const probe = lf(fs.readFileSync('tests/f44-host-probe.ps1', 'utf8'));
const mock = lf(fs.readFileSync('tests/mirror-mock-server.js', 'utf8'));

// --- §5 retry-policy unit tests: parse the SHIPPED table and execute it ---
function parsePolicy(src) {
  const start = src.indexOf('$global:GhrdpMirrorRetryPolicy = @(');
  assert.ok(start > 0, 'retry policy table missing');
  const end = src.indexOf('\n)', start);
  assert.ok(end > start, 'retry policy table unterminated');
  const block = src.slice(start, end);
  const rules = [];
  const re = /phases = @\(([^)]*)\);\s*statuses = @\(([^)]*)\);\s*retry = \$(true|false);\s*reason = '([^']+)'/g;
  let m;
  while ((m = re.exec(block))) {
    const phases = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
    const statuses = m[2].trim() ? m[2].split(',').map((x) => parseInt(x.trim(), 10)) : [];
    rules.push({ phases, statuses, retry: m[3] === 'true', reason: m[4] });
  }
  assert.ok(rules.length >= 2, 'policy table parsed to ' + rules.length + ' rules (expected >= 2)');
  return rules;
}
function decide(rules, phase, status) {
  for (const r of rules) {
    if (!r.phases.includes(phase)) continue;
    if (r.statuses.length === 0 || r.statuses.includes(status)) return { retry: r.retry, reason: r.reason };
  }
  return { retry: false, reason: 'fail-fast-default' };
}

test('F44-1 retry policy: transient-only set is EXACTLY tcp|tls + 429/500/502/503/504', () => {
  const rules = parsePolicy(mod);
  const transientHttp = new Set();
  const transientPhases = new Set();
  for (const r of rules.filter((x) => x.retry)) {
    for (const p of r.phases) transientPhases.add(p);
    for (const s of r.statuses) transientHttp.add(s);
  }
  assert.deepEqual([...transientPhases].sort(), ['http', 'tcp', 'tls']);
  assert.deepEqual([...transientHttp].sort((a, b) => a - b), [429, 500, 502, 503, 504]);
  // grid
  assert.equal(decide(rules, 'tcp', 0).retry, true);
  assert.equal(decide(rules, 'tls', 0).retry, true);
  for (const s of [429, 500, 502, 503, 504]) assert.equal(decide(rules, 'http', s).retry, true, 'http ' + s);
  // fail-fast grid (§1.3: 401/403/413/451/content-policy)
  for (const s of [400, 401, 402, 403, 404, 405, 408, 410, 413, 415, 418, 451, 501]) {
    assert.equal(decide(rules, 'http', s).retry, false, 'http ' + s + ' must fail fast');
  }
  for (const p of ['size', 'type', 'auth', 'encrypt', 'parse', 'dns']) {
    assert.equal(decide(rules, p, 413).retry, false, p + ' must fail fast');
    assert.equal(decide(rules, p, 403).retry, false, p + ' must fail fast');
  }
  // every §1.1 vocabulary phase is covered by SOME rule
  for (const p of ['dns', 'tcp', 'tls', 'encrypt', 'size', 'type', 'auth', 'http', 'parse']) {
    assert.ok(rules.some((r) => r.phases.includes(p)), p + ' missing from policy table');
  }
});

test('F44-2 attempt record shape is EXACTLY the §1.1 contract, keys in order', () => {
  const i = mod.indexOf('function New-MirrorAttemptRecord');
  const j = mod.indexOf('function Get-MirrorRetryDecision');
  assert.ok(i > 0 && j > i);
  const body = mod.slice(i, j);
  for (const k of ['host', 'ts', 'phase', 'httpStatus', 'hostMessage', 'bytesSent', 'durationMs']) {
    assert.ok(body.includes(k), k + ' missing from record');
  }
  const order = ['host        =', 'ts          =', 'phase       =', 'httpStatus  =', 'hostMessage =', 'bytesSent   =', 'durationMs  ='];
  let last = -1;
  for (const k of order) {
    const p = body.indexOf(k);
    assert.ok(p > last, 'record key out of order: ' + k);
    last = p;
  }
  assert.ok(mod.includes('Substring(0, 300)'), 'hostMessage 300-char cap with redaction missing');
  assert.ok(mod.includes("'<redacted>'"), 'secret redaction marker missing');
});

test('F44-3 per-host caps table: preflight before any attempt, zero network', () => {
  for (const h of ['catbox.moe', 'litter.catbox.moe', '0x0.st', 'tmpfiles.org', 'file.io', 'pixeldrain']) {
    assert.ok(mod.includes("name = '" + h + "'"), h + ' missing from caps table');
  }
  for (const k of ['maxBytes', 'deniedExt', 'parseKind', 'formField', 'apiRoot']) {
    assert.ok(mod.includes(k), k + ' missing from caps shape');
  }
  assert.ok(mod.includes('$global:GhrdpMirrorGlobalMaxBytes'), 'global hard cap missing');
  assert.ok(mod.includes('function Test-MirrorHostCaps'), 'preflight fn missing');
  assert.ok(mod.includes('(0 network tries)'), 'zero-network label missing');
  const pf = mod.indexOf('Test-MirrorHostCaps -Cap $cap');
  const at = mod.indexOf('Invoke-MirrorHostAttempt -Cap $cap');
  assert.ok(pf > 0 && at > pf, 'preflight must run BEFORE the attempt in the orchestrator');
});

test('F44-4 no host-policy evasion patterns in new surfaces (grep gate §5)', () => {
  const bad = /-A 'Mozilla|Referer:|Origin: https|X-Forwarded-For|--proxy|proxychains|socks4|socks5/i;
  for (const [name, src] of [['module', mod], ['driver', driver], ['probe', probe], ['mock', mock]]) {
    assert.equal(bad.test(src), false, name + ' carries an evasion pattern');
  }
  assert.ok(mod.includes("'-A', 'ghrdp-mirror-diag/1.0'"), 'honest UA missing in module');
  assert.ok(probe.includes("'ghrdp-mirror-diag/1.0'"), 'honest UA missing in probe');
  assert.ok(probe.includes('POLICY outcome: host blocks runner egress'), 'POLICY note missing in probe');
  assert.ok(!/tailscale ip -4/.test(probe), 'probe must not touch tailscale');
});

test('F44-5 classifier maps curl-exit + http-status to exact §1.1 phases', () => {
  for (const tok of ["6  { return @{ phase = 'dns'", 'tls', "413 { return @{ phase = 'size'", "415 { return @{ phase = 'type'", "401 { return @{ phase = 'auth'", "451 { return @{ phase = 'type'", 'content-policy']) {
    assert.ok(mod.includes(tok), tok + ' missing from classifier');
  }
  // encrypt verification BEFORE upload (§1.4)
  assert.ok(mod.includes('function Test-MirrorEncryptOutput'), 'encrypt verify fn missing');
  assert.ok(mod.includes('phase=encrypt'), 'encrypt phase label missing');
  // 403 body-text split (content-policy => type; else auth)
  assert.ok(mod.indexOf('content-policy') > 0);
});

test('F44-6 watcher wiring: diag module, verified encrypt, orchestrator, ledger, fail-fast', () => {
  assert.ok(watch.includes('. $diagPath'), 'watcher must dot-source the diag module');
  assert.ok(watch.includes('Test-MirrorEncryptOutput -Path $encPath'), 'watcher must verify ciphertext');
  assert.ok(watch.includes('Invoke-MirrorUpload -Path ([string]$uploadPath)'), 'watcher must call the orchestrator');
  assert.ok(watch.includes("$entry['attempts']"), 'attempt ledger must land on the progress row');
  assert.ok(watch.includes('$up.errorText'), 'FULL error text (no truncation) must be used');
  assert.ok(watch.includes('$tries[$key] = $maxTries'), 'fail-fast must exhaust the retry counter');
  const ev = watch.indexOf('Test-MirrorEncryptOutput');
  const up = watch.indexOf('Invoke-MirrorUpload -Path');
  assert.ok(ev > 0 && up > ev, 'encrypt verification must precede the upload call');
  assert.ok(!watch.includes("'upload failed after 5 tries (all hosts; see log)'"), 'bare all-hosts-failed text must be gone');
  // §4(f) no concurrent-contention: single watcher instance; uniq temp files
  assert.ok(watch.includes('single instance'), 'watcher single-instance note missing');
  assert.ok(mod.includes("NewGuid().ToString('N')"), 'module temp body/err files must be GUID-unique');
});

test('F44-7 old publish/index fns stay neutered; ONLY encrypt is re-armed', () => {
  const fn = (name) => {
    const i = lib.indexOf('function ' + name);
    assert.ok(i > 0, name + ' missing');
    const brace = lib.indexOf('\n}', i);
    return lib.slice(i, brace);
  };
  for (const dead of ['Send-AnyUpload', 'Send-CurlUpload', 'Send-GofileStreamed', 'Publish-AllIndexes', 'Publish-MirrorRentry', 'Publish-TelegraphIndex']) {
    assert.ok(fn(dead).includes('function neutered'), dead + ' must STAY neutered (locked: no public index)');
  }
  assert.ok(!fn('Invoke-AesEncryptFile').includes('function neutered'), 'encrypt must be re-armed (F44 §1.4)');
});

test('F44-8 mirror default stays OFF (F11 invariants untouched)', () => {
  assert.ok(wf.includes("MIRROR_INPUT -eq 'true'"));
  assert.ok(!/^\s+mirror:/m.test(wf.split(/^permissions:/m)[0]), 'mirror dispatch input must not reappear');
});

test('F44-9 main.yml: diag module staged fail-visible + mirror-diag artifact each run', () => {
  assert.ok(wf.includes('ghrdp-mirror-diag.ps1'), 'module must be staged to the runner');
  assert.ok(wf.includes('name: mirror-diag'), 'mirror-diag artifact missing');
  assert.ok(wf.includes('path: mirror-diag'), 'artifact path missing');
  assert.ok(wf.includes('Stage mirror-diag artifact (F44)'), 'staging step missing');
  assert.ok(wf.includes("[F44] FATAL: ghrdp-mirror-diag.ps1 missing") || wf.includes('ghrdp-mirror-diag.ps1 missing - the F44 deploy-payloads step did not stage it') || wf.includes('F44] FATAL') || watch.includes('[F44] FATAL'), 'fail-visible staging assert missing');
});

test('F44-10 UI: error text NEVER truncated; expandable + host matrix (§1.2 §5)', () => {
  assert.ok(card.includes('data-testid="mirror-error-full"'), 'full-error testid missing');
  assert.ok(card.includes('data-testid="mirror-host-matrix"'), 'per-host failure matrix card missing');
  assert.ok(card.includes('data-testid="mirror-attempt-row"'), 'expandable attempt rows missing');
  assert.ok(!card.includes('.slice(0, 40'), 'v2 error slicing must be gone');
  assert.ok(!ui1.includes('esc(f.error).substring(0,40)'), 'v1 error slicing must be gone');
  assert.ok(progress.includes('attempts'), 'progress.ts must map attempts');
  assert.ok(progress.includes('hostMatrix'), 'progress.ts must derive the host matrix');
});

test('F44-11 lab wiring: mirror-cell job, mock matrix, probe, paths, gates', () => {
  assert.ok(/ {2}mirror-cell:/m.test(lab), 'autologin-lab mirror-cell job missing');
  assert.ok(lab.includes('tests/mirror-mock-server.js'), 'lab must start the mock server');
  assert.ok(lab.includes('tests/f44-mirror-lab-driver.ps1'), 'lab must run the driver');
  assert.ok(lab.includes('tests/f44-host-probe.ps1'), 'lab must run the read-only probe');
  assert.ok(lab.includes('payloads/ghrdp-mirror-diag.ps1'), 'lab push paths must include the module');
  assert.ok(driver.includes('F44MATRIX'), 'driver matrix lines missing');
  for (const c of ['/e413', '/e403', '/e429x2', '/e500x1', '/malformed-json', '/tls-reset']) {
    assert.ok(mock.includes("'" + c + "'"), 'mock route ' + c + ' missing');
    assert.ok(driver.includes(c), 'driver case for ' + c + ' missing');
  }
  assert.ok(driver.includes('8.3'), '8.3-path case missing');
  assert.ok(driver.includes('networkTries=0'), 'zero-network assertion missing');
  assert.ok(gates.includes('F44 mirror diagnostics gates'), 'launch-gates F44 step missing');
});

// --- executable mock-side verification (ubuntu lane, no PowerShell needed) ---
test('F44-12 mock server behaves exactly per scenario matrix', { timeout: 30000 }, async () => {
  const port = 8899;
  const srv = spawn(process.execPath, ['tests/mirror-mock-server.js'], { env: { ...process.env, MIRROR_MOCK_PORT: String(port) }, stdio: 'pipe' });
  try {
    const base = 'http://127.0.0.1:' + port;
    let up = false;
    for (let i = 0; i < 40 && !up; i++) {
      try { const r = await fetch(base + '/health'); up = r.ok; } catch { await new Promise((r) => setTimeout(r, 250)); }
    }
    assert.ok(up, 'mock server did not start');
    const post = async (path) => {
      const fd = new FormData();
      fd.append('file', new Blob(['f44-bytes']), 'sample.bin');
      const r = await fetch(base + path, { method: 'POST', body: fd });
      return { status: r.status, text: (await r.text()).slice(0, 120) };
    };
    assert.equal((await post('/success-plain')).status, 200);
    assert.match((await post('/success-plain')).text, /^https:\/\/mock\.local\//);
    const j = await post('/success-json');
    assert.ok(JSON.parse(j.text).data.url.startsWith('https://mock.tmpfiles.local/'));
    assert.equal((await post('/e413')).status, 413);
    assert.match((await post('/e403')).text, /content policy/i);
    assert.equal((await post('/e403')).status, 403);
    assert.equal((await post('/e401')).status, 401);
    assert.equal((await post('/e451')).status, 451);
    assert.equal((await post('/e429x2')).status, 429);
    assert.equal((await post('/e429x2')).status, 429);
    assert.equal((await post('/e429x2')).status, 200);
    assert.equal((await post('/e500x1')).status, 500);
    assert.equal((await post('/e500x1')).status, 200);
    assert.match((await post('/malformed-json')).text, /not json/);
    assert.ok(!JSON.parse((await post('/ok-nolink')).text).data.url);
    assert.equal(JSON.parse((await post('/err-json')).text).success, false);
    await assert.rejects(() => post('/tls-reset'));
    const counts = await (await fetch(base + '/counts')).json();
    assert.ok(counts.counts['/success-plain'] >= 2, 'request counting broken');
  } finally {
    srv.kill('SIGKILL');
  }
});
