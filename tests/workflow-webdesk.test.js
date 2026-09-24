const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

// [F9i] Workflow contracts for the web-desktop steps:
//  - F9h fail-closed VNC_PASS guard stays BEFORE any installer
//  - websockify Start-Process must use DIFFERENT files for stdout/stderr
//    (the same-file redirect made Start-Process throw on Windows, so
//    websockify never bound 7333 and every run degraded to 'serve-failed')
//  - every serve-failed path is fail-closed (throw, not exit 0)
//  - present-but-short VNC_PASS is 'vnc-pass-too-short', never 'vnc-pass-missing'
const wf = fs.readFileSync('.github/workflows/main.yml', 'utf8');
const lines = wf.split('\n');

function lineIndex(pred, from = 0) {
  for (let i = from; i < lines.length; i++) if (pred(lines[i])) return i;
  return -1;
}

const webdeskStart = lineIndex(l => /^      - name: Web desktop \(noVNC/.test(l));
const selftestStart = lineIndex(l => /^      - name: Web desktop self-test/.test(l));
const nextStepAfterSelftest = lineIndex(l => /^      - name: Start Mission Control/.test(l), selftestStart + 1);
assert.ok(webdeskStart > 0, 'web-desktop step not found');
assert.ok(selftestStart > webdeskStart, 'self-test step not found after web-desktop step');
assert.ok(nextStepAfterSelftest > selftestStart, 'step after self-test not found');
const webdesk = lines.slice(webdeskStart, selftestStart).join('\n');
const selftest = lines.slice(selftestStart, nextStepAfterSelftest).join('\n');

test('F9h guard runs before any installer and is fail-closed', () => {
  const guard = lineIndex(l => l.includes("::error::VNC_PASS secret missing"), webdeskStart);
  const installer = lineIndex(l => l.includes('choco install tightvnc'), webdeskStart);
  assert.ok(guard > 0, 'F9h ::error:: guard missing');
  assert.ok(installer > 0, 'TightVNC installer missing');
  assert.ok(guard < installer, 'F9h guard must run BEFORE the installer');
  assert.match(webdesk, /throw "VNC_PASS missing\. Halted by design/);
  assert.match(webdesk, /settings\/secrets\/actions/);
  assert.match(webdesk, /webdeskReason' -NotePropertyValue 'vnc-pass-missing'/);
  assert.match(webdesk, /vncPassAdminUrl/);
  assert.match(webdesk, /'webdeskUrl' -NotePropertyValue ''/);
});

test('F9h-belt marker retained (launch-gate dependency)', () => {
  assert.match(webdesk, /VNC_PASS not set - web desktop disabled/);
});

test('websockify Start-Process uses DIFFERENT files for stdout and stderr', () => {
  const procLines = webdesk.split('\n').filter(l => l.includes('Start-Process -FilePath python'));
  assert.equal(procLines.length, 1, 'expected exactly one python (websockify) Start-Process');
  const line = procLines[0];
  const out = line.match(/-RedirectStandardOutput\s+(\S+)/);
  const err = line.match(/-RedirectStandardError\s+(\S+)/);
  assert.ok(out, 'missing -RedirectStandardOutput');
  assert.ok(err, 'missing -RedirectStandardError');
  assert.notEqual(out[1], err[1], 'stdout and stderr must not be the same file (Start-Process throws on Windows; websockify then never binds 7333)');
});

test('no Start-Process in the web-desktop step shares one redirect file', () => {
  // Start-Process lines only - explanatory comments mention both flags too.
  const all = webdesk.split('\n').filter(l => l.includes('Start-Process') && l.includes('-RedirectStandardOutput') && l.includes('-RedirectStandardError'));
  assert.ok(all.length >= 1, 'expected at least one Start-Process with redirects');
  for (const line of all) {
    const out = line.match(/-RedirectStandardOutput\s+(\S+)/)[1];
    const err = line.match(/-RedirectStandardError\s+(\S+)/)[1];
    assert.notEqual(out, err, 'shared redirect file: ' + out);
  }
});

test('every serve-failed path is fail-closed (throw, never exit 0)', () => {
  const idxs = [];
  webdesk.split('\n').forEach((l, i) => {
    if (l.includes("Set-WebdeskCfg '' 'serve-failed'")) idxs.push(i);
  });
  assert.equal(idxs.length, 4, 'expected 4 serve-failed reason writes (tightvnc, novnc, websockify, serve)');
  const webdeskLines = webdesk.split('\n');
  for (const i of idxs) {
    const tail = webdeskLines.slice(i, i + 8).join('\n');
    assert.match(tail, /\bthrow\b/, 'serve-failed path must throw (fail-closed)');
    assert.doesNotMatch(tail, /exit 0/, 'serve-failed path must not exit 0 (false-green run)');
  }
});

test('serve-failed paths carry fixed, secret-free detail codes', () => {
  assert.match(webdesk, /Set-WebdeskCfg '' 'serve-failed' 'tightvnc-install'/);
  assert.match(webdesk, /Set-WebdeskCfg '' 'serve-failed' 'novnc-assets'/);
  assert.match(webdesk, /Set-WebdeskCfg '' 'serve-failed' 'websockify-bind'/);
  assert.match(webdesk, /Set-WebdeskCfg '' 'serve-failed' 'serve-mapping'/);
});

test('present-but-short VNC_PASS is vnc-pass-too-short, never vnc-pass-missing', () => {
  const shortBlock = webdesk.slice(webdesk.indexOf('$vp.Length -lt 8'));
  const installerTail = shortBlock.slice(0, shortBlock.indexOf('choco install tightvnc'));
  assert.match(installerTail, /Set-WebdeskCfg '' 'vnc-pass-too-short'/);
  assert.doesNotMatch(installerTail, /Set-WebdeskCfg '' 'vnc-pass-missing'/, 'short-but-present secret must not be reported as missing');
  // the missing-secret reason appears only in the single F9h belt line
  // (the F9h guard itself writes config via Add-Member, not Set-WebdeskCfg)
  const missingCount = webdesk.split("Set-WebdeskCfg '' 'vnc-pass-missing'").length - 1;
  assert.equal(missingCount, 1, 'vnc-pass-missing may only come from the F9h belt line');
  // short path stays a loud non-fatal skip (locked U5c design)
  assert.match(installerTail, /exit 0/);
});

test('self-test FAIL is fail-closed and records self-test-failed', () => {
  assert.match(selftest, /noVNC/);
  assert.match(selftest, /self-test PASS/);
  assert.match(selftest, /self-test FAIL/);
  assert.match(selftest, /'serve-failed'/);
  assert.match(selftest, /'self-test-failed'/);
  const failIdx = selftest.indexOf('self-test FAIL');
  const tail = selftest.slice(failIdx);
  assert.match(tail, /\bthrow\b/, 'self-test FAIL must throw (fail-closed)');
  assert.doesNotMatch(tail.slice(tail.indexOf("'serve-failed'")), /exit 0/, 'self-test FAIL must not exit 0');
  // PASS path still exits cleanly
  const passIdx = selftest.indexOf('self-test PASS');
  assert.ok(passIdx > -1 && passIdx < failIdx, 'PASS branch must precede FAIL branch');
});

test('no fabricated serve URL; no secret-bearing installer output', () => {
  assert.doesNotMatch(webdesk, /serveUrl = 'https:\/\/' \+ \$fq/);
  // installer output is still filtered for the password value
  assert.match(webdesk, /Where-Object \{ \$_ -notmatch \[regex\]::Escape\(\$vp\) \}/);
  // websockify args carry no password (only dir + loopback ports)
  const procLine = webdesk.split('\n').find(l => l.includes('Start-Process -FilePath python'));
  assert.doesNotMatch(procLine, /\$vp|VNC_PASS/);
});

test('web-desktop step still records >= 6 reason writes (launch-gate F8)', () => {
  const n = webdesk.split("Set-WebdeskCfg ''").length - 1;
  assert.ok(n >= 6, 'only ' + n + ' reason writes (need >= 6)');
});
