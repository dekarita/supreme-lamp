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
  // [F9o] direct-msiexec ladder (L1): the installer entry is the MSI download.
  const installer = lineIndex(l => l.includes('tightvnc-2.8.85-gpl-setup-64bit.msi'), webdeskStart);
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
  // [F9o] the vncdotool fallback also uses Start-Process -FilePath python, so
  // scope to the websockify launcher line (contains 'websockify').
  const procLines = webdesk.split('\n').filter(l => l.includes('Start-Process -FilePath python') && l.includes('websockify'));
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
  assert.equal(idxs.length, 6, 'expected 6 serve-failed reason writes (tailnet-ip, tightvnc, novnc, websockify, firewall, vnc-auth-unverifiable)');
  const webdeskLines = webdesk.split('\n');
  for (const i of idxs) {
    const tail = webdeskLines.slice(i, i + 8).join('\n');
    assert.match(tail, /\bthrow\b/, 'serve-failed path must throw (fail-closed)');
    assert.doesNotMatch(tail, /exit 0/, 'serve-failed path must not exit 0 (false-green run)');
  }
});

test('serve-failed paths carry fixed, secret-free detail codes', () => {
  assert.match(webdesk, /Set-WebdeskCfg '' 'serve-failed' 'tailnet-ip-unavailable'/);
  assert.match(webdesk, /Set-WebdeskCfg '' 'serve-failed' 'tightvnc-install'/);
  assert.match(webdesk, /Set-WebdeskCfg '' 'serve-failed' 'novnc-assets'/);
  assert.match(webdesk, /Set-WebdeskCfg '' 'serve-failed' 'websockify-bind'/);
  assert.match(webdesk, /Set-WebdeskCfg '' 'serve-failed' 'firewall-rule'/);
  assert.match(webdesk, /Set-WebdeskCfg '' 'serve-failed' 'vnc-auth-unverifiable'/);
  // serve-mapping is retired with serve: no deploy path may stamp it.
  assert.doesNotMatch(webdesk, /serve-mapping/);
});

test('present-but-short VNC_PASS is vnc-pass-too-short, never vnc-pass-missing', () => {
  const shortBlock = webdesk.slice(webdesk.indexOf('$vp.Length -lt 8'));
  const installerTail = shortBlock.slice(0, shortBlock.indexOf('tightvnc-2.8.85-gpl-setup-64bit.msi'));
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
  // [F9o] probe/installer outputs are redacted in place; only exit codes log.
  assert.match(webdesk, /\.Replace\(\$Password, '\[redacted\]'\)/);
  assert.match(webdesk, /\.Replace\(\$vp, '\[redacted\]'\)/);
  assert.match(webdesk, /vnc-auth-probe tag=.*exit=/);
  // installer argument lists are never printed (only the msiexec exit code).
  assert.doesNotMatch(webdesk, /Write-Host.*\$margs/);
  assert.doesNotMatch(webdesk, /Write-Host.*\$vpArg/);
  // websockify args carry no password (only dir + loopback ports)
  const procLine = webdesk.split('\n').find(l => l.includes('Start-Process -FilePath python'));
  assert.doesNotMatch(procLine, /\$vp|VNC_PASS/);
});

test('web-desktop step still records >= 6 reason writes (launch-gate F8)', () => {
  const n = webdesk.split("Set-WebdeskCfg ''").length - 1;
  assert.ok(n >= 6, 'only ' + n + ' reason writes (need >= 6)');
});

// [F9n] tailscale serve is retired from the webdesk path (Windows SYSTEM
// operator lock: post-connect LocalAPI calls 401). No serve invocation or
// serve machinery may survive in the deploy or self-test steps; the single
// allowed mention is the mandated retirement transport note.
test('F9n: no tailscale serve machinery survives in the webdesk steps', () => {
  const both = webdesk + '\n' + selftest;
  const code = both.split('\n').filter(l => !/^\s*#/.test(l)).join('\n');
  const rest = code.split('\n').filter(l => !l.includes('tailscale serve retired')).join('\n');
  assert.doesNotMatch(rest, /tailscale serve/);
  for (const tok of ['serve status', 'set-raw', 'Get-WebdeskServeUrl', "'--bg'"]) {
    assert.ok(!code.includes(tok), 'retired serve machinery survives: ' + tok);
  }
  // the mandated retirement note is still present (exactly once, in the summary)
  const notes = both.split('tailscale serve retired due to Windows SYSTEM operator lock (401)').length - 1;
  assert.equal(notes, 1, 'expected exactly one retirement transport note');
});

// [F9n] The tailnet IP comes ONLY from config.json .rdpIp (written pre-lock
// by the stage step): the step-context CLI is 401-locked, so `tailscale ip`
// must never be called here. CGNAT-validated, fail-closed, no fabrication.
test('F9n: tailnet IP comes from config.rdpIp with CGNAT validation (fail-closed)', () => {
  assert.ok(webdesk.includes('$cfgR.rdpIp'), 'config.rdpIp read missing');
  assert.match(webdesk, /rdpIp -notmatch/);
  assert.match(webdesk, /6\[4-9\]/, 'CGNAT 100.64-127 pattern missing');
  const webdeskCode = webdesk.split('\n').filter(l => !/^\s*#/.test(l)).join('\n');
  assert.doesNotMatch(webdeskCode, /tailscale ip/, 'must never call `tailscale ip` (401-locked)');
  const failIdx = webdesk.indexOf("Set-WebdeskCfg '' 'serve-failed' 'tailnet-ip-unavailable'");
  assert.ok(failIdx > 0, 'tailnet-ip-unavailable write missing');
  const tail = webdesk.slice(failIdx, failIdx + 400);
  assert.match(tail, /\bthrow\b/, 'tailnet-ip path must throw (fail-closed)');
  assert.match(tail, /tailnet-ip-unavailable/);
});

// [F9n] websockify binds the tailnet IP; VNC stays loopback-only. No
// loopback or wildcard websockify bind may survive (unreachable / spoofable).
test('F9n: websockify binds the tailnet IP; VNC stays loopback', () => {
  assert.ok(webdesk.includes('$wsUp = Start-Websockify -BindIp $rdpIp'), 'deploy must bind the tailnet IP');
  assert.ok(webdesk.includes("($BindIp + ':7333')"), 'launcher must bind <BindIp>:7333');
  assert.ok(webdesk.includes("'127.0.0.1:5900'"), 'VNC target must stay loopback');
  assert.doesNotMatch(webdesk, /'127\.0\.0\.1:7333'/, 'loopback websockify bind survives');
  assert.doesNotMatch(wf, /0\.0\.0\.0:7333/, 'wildcard websockify bind');
});

// [F9n] CGNAT-only firewall rule: idempotent (same-name rule removed first),
// inbound TCP 7333 from 100.64.0.0/10, fail-closed on error.
test('F9n: CGNAT-only firewall rule is idempotent and fail-closed', () => {
  const rmIdx = webdesk.indexOf("Remove-NetFirewallRule");
  const newIdx = webdesk.indexOf("New-NetFirewallRule -DisplayName 'GHRDP-Webdesk'");
  assert.ok(rmIdx > 0 && newIdx > 0 && rmIdx < newIdx, 'same-name rule must be removed before creating');
  assert.ok(webdesk.includes("RemoteAddress '100.64.0.0/10'"), 'rule must scope RemoteAddress to CGNAT');
  assert.ok(webdesk.includes('-LocalPort 7333'), 'rule must target port 7333');
  assert.ok(webdesk.includes('-Direction Inbound -Protocol TCP'), 'rule must be inbound TCP');
  const failIdx = webdesk.indexOf("Set-WebdeskCfg '' 'serve-failed' 'firewall-rule'");
  assert.ok(failIdx > 0, 'firewall-rule write missing');
  assert.match(webdesk.slice(failIdx, failIdx + 300), /\bthrow\b/, 'firewall path must throw (fail-closed)');
});

// [F9n] The advertised URL is built directly from the validated tailnet IP -
// no serve mapping to verify, no fabrication beyond the validated value.
test('F9n: advertised URL is built directly from the validated rdpIp', () => {
  assert.ok(webdesk.includes("$webdeskUrl = 'http://' + $rdpIp + ':7333/vnc.html?autoconnect=1&resize=remote'"));
  assert.ok(webdesk.includes("Set-WebdeskCfg $webdeskUrl ''"), 'URL must be advertised via Set-WebdeskCfg');
  assert.ok(webdesk.includes('transport: tailnet HTTP (WireGuard-encrypted path) + VNC password gate; tailscale serve retired due to Windows SYSTEM operator lock (401)'));
  assert.doesNotMatch(webdesk, /Get-WebdeskServeUrl/);
});

test('F9n: keepalive websockify auto-heal binds the tailnet IP (no loopback rebind)', () => {
  // A loopback rebind would be unreachable under the F9n transport AND would
  // hide the outage from the dashboard, so the heal binds config.rdpIp and
  // skips entirely without a valid tailnet IP.
  assert.doesNotMatch(wf, /0\.0\.0\.0:7333/);
  assert.doesNotMatch(wf, /'127\.0\.0\.1:7333'/, 'loopback websockify bind survives');
  const autoheal = wf.split('\n').find(line => line.includes("($ipNow + ':7333'),'127.0.0.1:5900'"));
  assert.ok(autoheal, 'keepalive websockify auto-heal launch must exist');
  // [F11-5.3] SUPERSEDES the F9n no-hidden form: every host helper (websockify
  // included) must run hidden so the first interactive RDP session shows no
  // stray console windows. Launch-gates F11 enforces the hidden form.
  assert.match(autoheal, /-WindowStyle Hidden/, 'websockify auto-heal must run hidden (F11-5.3)');
  assert.match(wf, /refusing loopback rebind/, 'heal must refuse without a valid tailnet IP');
});

// [F9n] Idempotent websockify launcher: CGNAT-guarded BindIp + kill stale +
// paired redirects + wait for a LISTEN socket on <BindIp>:7333 specifically,
// returning a bool.
test('F9n: Start-Websockify is idempotent, paired-redirect and tailnet-exact', () => {
  assert.match(webdesk, /function Start-Websockify\(/);
  assert.ok(webdesk.includes("[string]$BindIp = ''"), 'launcher must take a BindIp parameter');
  const from = webdesk.indexOf('function Start-Websockify(');
  const rest = webdesk.slice(from);
  // bound the slice to the function body (the step continues with unrelated code)
  const fn = rest.slice(0, rest.indexOf('\n          }\n'));
  assert.match(fn, /\$BindIp -notmatch/, 'non-tailnet binds must be refused');
  assert.match(fn, /refusing to bind a non-tailnet address/);
  assert.match(fn, /Stop-Process/, 'stale websockify processes must be killed (idempotent re-entry)');
  assert.match(fn, /RedirectStandardOutput \$wsLog/);
  assert.match(fn, /RedirectStandardError \$wsErr/);
  assert.match(fn, /-WindowStyle Hidden/, 'websockify must run hidden (F11-5.3 supersedes F9n)');
  const waits = fn.match(/-LocalAddress \$BindIp -LocalPort 7333 -State Listen/g) || [];
  assert.ok(waits.length >= 2, 'must wait for the tailnet listener before and after starting');
  assert.match(fn, /return \$false/);
  assert.match(fn, /return \$true/);
  assert.ok(webdesk.includes('$wsUp = Start-Websockify -BindIp $rdpIp'), 'the deploy step must call the function with the tailnet IP');
  // the launcher must not carry the VNC password anywhere
  assert.doesNotMatch(fn, /\$vp\b|VNC_PASS/);
  const lab = fs.readFileSync('.github/workflows/webdesk-lab.yml', 'utf8');
  assert.ok(lab.includes('function Start-Websockify'), 'fallback lab must exercise the production launcher');
  const labStart = lab.split('\n').find(line => line.includes('Start-Process -FilePath python'));
  if (labStart) assert.match(labStart, /-WindowStyle Hidden/, 'fallback lab mirrors the F11-5.3 hidden websockify form');
});

// [F9n] Classified, self-healing self-test: the EXACT advertised URL is
// curled 3x5s (status, headers and body bytes kept), a missing tailnet
// listener is healed with the SAME launcher, the backend root is probed for
// evidence, and the failure is classified backend-dead | firewall |
// marker-missing.
test('F9n: self-test curls the exact advertised URL and can self-heal the listener', () => {
  assert.match(selftest, /\[F9n\]/);
  assert.ok(selftest.includes('Invoke-Probe $url'), 'exact advertised-URL curl missing');
  assert.match(selftest, /for \(\$i = 1; \$i -le 3; \$i\+\+\)/, 'advertised URL must be tried 3x');
  assert.ok(selftest.includes("'backend-root'"), 'backend-root probe missing');
  assert.ok(selftest.includes("$backendRoot = 'http://' + $checkIp + ':7333/'"), 'backend root must target the tailnet IP');
  assert.ok(selftest.includes('$started = Start-Websockify'), 'missing listener must call the launcher');
  assert.match(selftest, /advertised re-probe/, 'the advertised URL must be re-probed after healing');
  // the launcher copy in the self-test must be the same text as the deploy copy
  const all = fs.readFileSync('.github/workflows/main.yml', 'utf8');
  const copies = all.match(/^          function Start-Websockify\(.*?^          \}\n/gms) || [];
  assert.equal(copies.length, 2, 'expected exactly two Start-Websockify copies');
  assert.equal(copies[0], copies[1], 'the two Start-Websockify copies must be identical');
});

test('F9n: probes record status/headers/body and capture firewall evidence (no serve reset)', () => {
  assert.match(selftest, /first200=/, 'first 200 body bytes must be captured');
  assert.match(selftest, /headers=/, 'response headers must be captured');
  assert.doesNotMatch(selftest, /'--bg'/, 'no serve reset may survive');
  assert.ok(selftest.includes('GHRDP-Webdesk'), 'firewall evidence missing');
  assert.match(selftest, /firewallRule=/, 'firewall rule state must reach the artifact payload');
  assert.match(selftest, /Start-Sleep -Seconds 5/, 'a 5s wait must separate the advertised-URL tries');
  assert.match(selftest, /backend-root probe/);
});

test('F9n: failures are classified (backend-dead | firewall | marker-missing) and fail-closed', () => {
  for (const tok of ['backend-dead', 'firewall', 'marker-missing']) {
    assert.ok(selftest.includes("$verdict = '" + tok + "'"), 'missing verdict: ' + tok);
  }
  assert.doesNotMatch(selftest, /proxy-502/, 'retired proxy-502 verdict survives');
  assert.doesNotMatch(selftest, /dns-tls/, 'retired dns-tls verdict survives');
  const failIdx = selftest.indexOf('self-test FAIL');
  const tail = selftest.slice(failIdx);
  assert.match(selftest, /\$evLines \+= \('classification=' \+ \$verdict\)/, 'classification must reach the artifact payload');
  assert.match(tail, /classification\.txt/, 'the summary must name the diagnostics payload');
  assert.match(tail, /\bthrow\b/, 'classified halt must throw (fail-closed)');
  // the classification must never be written into config.json (F9l-4 contract)
  assert.doesNotMatch(tail, /webdeskDetail.*(backend-dead|firewall|marker-missing|vnc-auth)/);
  // [F9o] VNC_PASS is referenced ONLY for the mode-matching probe (redacted);
  // the classifier itself never interpolates it into output.
  assert.match(selftest, /\$vpSelf = \[string\]\$env:VNC_PASS/);
  assert.match(selftest, /\.Replace\(\$Password, '\[redacted\]'\)/);
  assert.doesNotMatch(selftest, /Write-Host.*\$vpSelf/);
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
  assert.match(stage, /listener\.txt/, 'listener snapshot missing');
  assert.match(stage, /firewall\.txt/, 'firewall snapshot missing');
  assert.match(stage, /vncprobe-codes\.txt/, 'vncdotool probe codes missing from manifest');
  assert.match(stage, /tightvnc-tail\.txt/, 'TightVNC tail missing from manifest');
  assert.doesNotMatch(selftest, /serve-status\.json/, 'retired serve-status payload survives');
  assert.match(webdesk, /Diagnostics artifact: webdesk-diag/);
  assert.match(webdesk, /deploy-verbose\.txt/);
});

// [F9l-4] Fail-closed contract preserved: the classification is diagnostic
// only - config keeps the locked serve-failed / self-test-failed codes that
// /api/native-status and ui.html already render. No dashboard messaging
// change, no URL left behind on a failure.
test('F9l-4: config keeps serve-failed/self-test-failed and the UI contract is untouched', () => {
  const tail = selftest.slice(selftest.indexOf('self-test FAIL'));
  assert.match(tail, /\$cfgF\.webdeskReason = 'serve-failed'/);
  assert.match(tail, /\$cfgF\.webdeskDetail = 'self-test-failed'/);
  assert.match(tail, /\$cfgF\.webdeskUrl = ''/, 'the advertised URL must be cleared on failure');
  assert.match(tail, /\$cfgF\.webdeskUrl = ''/);
  const ui = fs.readFileSync('payloads/ui.html', 'utf8');
  assert.match(ui, /'self-test-failed':'the advertised URL did not serve the noVNC page \(self-test failed\)'/);
  assert.match(ui, /deskReason==='serve-failed'/);
  assert.match(ui, /host-side startup failure - this is NOT a missing VNC_PASS; do not re-add the secret\./);
  assert.match(ui, /tailnet-only HTTP over WireGuard \+ VNC password; nothing installed on client/);
  assert.match(ui, /TAILHTTP_RE/);
  assert.match(ui, /textContent='WEB DESKTOP ready'/);
});
