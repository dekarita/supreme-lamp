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

test('F9j: serve exit code is printed (no more swallowed serve failures)', () => {
  // The old code reset $LASTEXITCODE without ever printing it, so a failed
  // `tailscale serve` was undiagnosable from the run log.
  assert.match(webdesk, /tailscale serve \{0\} -> exit \{1\}/);
  // An explicit-443 retry form covers the implicit-default-port form.
  assert.match(webdesk, /'--bg', '443', 'http:\/\/127\.0\.0\.1:7333'/);
});

test('F9j: URL is derived from a verified mapping, normalized to the default port', () => {
  // The raw `serve status --json` Web key ('<host>.ts.net:<port>' on current
  // tailscale) must never be concatenated verbatim into the URL - that
  // produced 'https://host.ts.net:443/...' which the dashboard's port-less
  // URL validator rejects (green run, dead button).
  assert.doesNotMatch(webdesk, /'https:\/\/' \+ \$k(?![a-zA-Z0-9_])/);
  // A mapping on any non-default port is treated as NO mapping (no false LIVE).
  assert.match(webdesk, /portPart -ne '443'/);
  // The derived host must be validated against an anchored *.ts.net pattern
  // before any URL is derived (checked by shape, not by backslash-escaping,
  // so the assertion is stable across editor/CI text handling).
  const hostCheck = webdesk.split('\n').find(l => l.includes('hostPart -notmatch'));
  assert.ok(hostCheck, 'hostPart ts.net validation line missing');
  assert.ok(hostCheck.includes('ts'), 'hostPart pattern must reference ts.net');
  assert.ok(hostCheck.trimEnd().endsWith("net$') { return '' }"), 'hostPart must be anchored with .net$ : ' + hostCheck.trim());
  // Bare-port Web keys (older tailscale) resolve the host from Self.DNSName.
  assert.match(webdesk, /Self\.DNSName/);
});

test('F9j: serve-mapping failure prints secret-free diagnostics before halting', () => {
  const failIdx = webdesk.indexOf("Set-WebdeskCfg '' 'serve-failed' 'serve-mapping'");
  assert.ok(failIdx > 0, 'serve-mapping failure write missing');
  const serveBlock = webdesk.slice(webdesk.indexOf('# Expose ONLY on the tailnet.'), failIdx);
  assert.match(serveBlock, /serve output tail/);
  assert.match(serveBlock, /serve status: /);
  assert.match(serveBlock, /serve status --json: /);
  assert.match(serveBlock, /tailscale state: /);
  // 5s settle re-check still guards against slow serve registration.
  assert.match(serveBlock, /Start-Sleep -Seconds 5/);
});

test('F9j: watcher websockify auto-heal is loopback-only (no 0.0.0.0:7333)', () => {
  // A 0.0.0.0 bind exposes the bridge on the Tailscale interface without
  // tailnet TLS, bypassing the serve mapping entirely.
  assert.doesNotMatch(wf, /0\.0\.0\.0:7333/);
  assert.match(wf, /'--web','C:\\ghrdp\\novnc','127\.0\.0\.1:7333','127\.0\.0\.1:5900'/);
});

// [F9l-1] Idempotent websockify launcher: kill stale + paired redirects +
// wait for a LISTEN socket on 127.0.0.1:7333 specifically, returning a bool.
test('F9l-1: Start-Websockify is idempotent, paired-redirect and loopback-exact', () => {
  assert.match(webdesk, /function Start-Websockify\(/);
  const from = webdesk.indexOf('function Start-Websockify(');
  const rest = webdesk.slice(from);
  // bound the slice to the function body (the step continues with unrelated code)
  const fn = rest.slice(0, rest.indexOf('\n          }\n'));
  assert.match(fn, /Stop-Process/, 'stale websockify processes must be killed (idempotent re-entry)');
  assert.match(fn, /RedirectStandardOutput \$wsLog/);
  assert.match(fn, /RedirectStandardError \$wsErr/);
  const waits = fn.match(/-LocalAddress '127\.0\.0\.1' -LocalPort 7333 -State Listen/g) || [];
  assert.ok(waits.length >= 2, 'must wait for the loopback listener before and after starting');
  assert.match(fn, /return \$false/);
  assert.match(fn, /return \$true/);
  assert.match(webdesk, /\$wsUp = Start-Websockify/, 'the deploy step must call the function');
  // the launcher must not carry the VNC password anywhere
  assert.doesNotMatch(fn, /\$vp\b|VNC_PASS/);
});

// [F9l-2] Classified, self-healing self-test: the backend leg (loopback:7333)
// is probed directly, healed with the SAME launcher, and only then is the
// advertised tailnet URL curled - with status, headers and body bytes kept.
test('F9l-2: self-test probes the backend directly and can self-heal it', () => {
  assert.match(selftest, /\[F9l-2\]/);
  assert.match(selftest, /http:\/\/127\.0\.0\.1:7333\/vnc\.html/, 'direct backend curl missing');
  assert.match(selftest, /\$backendOk = \(\$probeB\.Code -eq '200'/, 'backend health must be a 200 check');
  assert.match(selftest, /\$started = Start-Websockify/, 'backend-dead must call the F9l-1 launcher');
  assert.match(selftest, /backend re-probe/, 'the backend must be re-probed after healing');
  // the launcher copy in the self-test must be the same text as the deploy copy
  const all = fs.readFileSync('.github/workflows/main.yml', 'utf8');
  const copies = all.match(/^          function Start-Websockify\(.*?^          \}\n/gms) || [];
  assert.equal(copies.length, 2, 'expected exactly two Start-Websockify copies');
  assert.equal(copies[0], copies[1], 'the two Start-Websockify copies must be identical');
});

test('F9l-2: serve leg records status/headers/body and resets the mapping on 502', () => {
  assert.match(selftest, /first200=/, 'first 200 body bytes must be captured');
  assert.match(selftest, /headers=/, 'response headers must be captured');
  assert.match(selftest, /'--bg', 'http:\/\/127\.0\.0\.1:7333'/, 'mapping reset must use the documented form');
  assert.match(selftest, /reset attempt/, 'each reset attempt must be logged');
  assert.match(selftest, /Start-Sleep -Seconds 5/, 'a 5s settle wait must precede the re-curl');
  assert.match(selftest, /serve re-probe/);
});

test('F9l-2: failures are classified (backend-dead | proxy-502 | dns-tls) and fail-closed', () => {
  assert.match(selftest, /backend-dead/);
  assert.match(selftest, /proxy-502/);
  assert.match(selftest, /dns-tls/);
  const failIdx = selftest.indexOf('self-test FAIL');
  const tail = selftest.slice(failIdx);
  assert.match(selftest, /\$evLines \+= \('classification=' \+ \$verdict\)/, 'classification must reach the artifact payload');
  assert.match(tail, /classification\.txt/, 'the summary must name the diagnostics payload');
  assert.match(tail, /\bthrow\b/, 'classified halt must throw (fail-closed)');
  // the classification must never be written into config.json (F9l-4 contract)
  assert.doesNotMatch(tail, /webdeskDetail.*(backend-dead|proxy-502|dns-tls)/);
  // no password reference anywhere in the classifier
  assert.doesNotMatch(selftest, /\$vp\b|VNC_PASS/);
});

// [F9l-3] Survivable diagnostics: the payload is staged INSIDE the workspace
// (upload-artifact v4 rejects absolute paths outside its root directory -
// observed in the lab) and uploaded with `if: always()` so a halt in either
// web-desktop step still leaves evidence behind.
test('F9l-3: webdesk-diag is staged in the workspace and uploaded on halt', () => {
  assert.match(selftest, /Web desktop diagnostics staging/);
  assert.match(selftest, /Web desktop diagnostics artifact/);
  assert.match(selftest, /actions\/upload-artifact@v4/);
  assert.match(selftest, /name: webdesk-diag/);
  const upload = selftest.slice(selftest.indexOf('Web desktop diagnostics artifact'));
  assert.match(upload, /if: always\(\)/, 'the upload must run even when a previous step halted');
  assert.match(upload, /path: webdesk-diag/, 'upload must use the workspace-relative staging dir');
  assert.doesNotMatch(upload, /[A-Z]:\\\\ghrdp/, 'absolute host paths cannot be uploaded by upload-artifact v4');
  assert.doesNotMatch(upload, /runner\.temp/);
  // staging copies the host-side websockify logs and the self-test payload
  const stage = selftest.slice(selftest.indexOf('Web desktop diagnostics staging'), selftest.indexOf('Web desktop diagnostics artifact'));
  assert.match(stage, /websockify\.log/);
  assert.match(stage, /websockify\.err\.log/);
  assert.match(stage, /MANIFEST\.txt/);
  assert.match(stage, /serve status --json/);
  assert.match(webdesk, /Diagnostics artifact: webdesk-diag/);
  assert.match(webdesk, /deploy-verbose\.txt/);
});
