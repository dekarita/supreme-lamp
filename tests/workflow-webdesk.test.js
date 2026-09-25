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
// [F9n] Transport contracts (the serve proxy is retired - Windows SYSTEM
// operator lock returns 401 for every post-connect LocalAPI call):
//  - no serve-path code anywhere in the web-desktop steps
//  - bind address = config.json .rdpIp, validated against 100.64.0.0/10,
//    invalid => fail-closed 'tailnet-ip-unavailable' BEFORE any install
//  - CGNAT-only GHRDP-Webdesk firewall rule (idempotent, netsh fallback scoped)
//  - webdeskUrl = http://<rdpIp>:7333/vnc.html?autoconnect=1&resize=remote
//  - self-test curls the exact advertised URL, classifies
//    backend-dead | firewall | marker-missing, and stays fail-closed
//  - server + UI publish only allowlisted webdeskUrl shapes
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
  assert.equal(idxs.length, 5, 'expected 5 serve-failed reason writes (tailnet-ip, tightvnc, novnc, firewall, websockify)');
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
  assert.match(webdesk, /Set-WebdeskCfg '' 'serve-failed' 'firewall-rule'/);
  assert.match(webdesk, /Set-WebdeskCfg '' 'serve-failed' 'websockify-bind'/);
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

// [F9n] Transport contracts. The serve proxy is retired from the web desktop
// path: every post-connect LocalAPI call from the step returned
// '401 Unauthorized: Tailscale already in use by NT AUTHORITY\SYSTEM, pid <n>'
// (Windows operator lock - SYSTEM owns the connected node, the step-context CLI
// is locked out). The transport is now websockify bound to the node's own
// tailnet address on 7333, admitted by a CGNAT-only firewall rule.
test('F9n: no serve-path code remains in the web-desktop steps', () => {
  const region = lines.slice(webdeskStart, lines.findIndex(l => /^      - name: Start Mission Control/.test(l))).join('\n');
  const code = region.split('\n').filter(l => !/^\s*#/.test(l));
  for (const banned of ['$ts serve', 'serve set-raw', 'serve status', 'Get-WebdeskServeUrl', 'serve --help', "'--bg'"]) {
    assert.ok(!code.some(l => l.includes(banned)), 'serve-path code still present: ' + banned);
  }
  // the ONLY permitted mention is the mandated transport note that documents
  // why the transport was retired (it is required in the Step Summary).
  const mentions = code.filter(l => /tailscale serve/i.test(l));
  assert.ok(mentions.length > 0, 'the mandated transport note is missing');
  for (const m of mentions) assert.match(m, /transport: tailnet HTTP \(WireGuard-encrypted path\) \+ VNC password gate; tailscale serve retired due to Windows SYSTEM operator lock \(401\)/);
});

test('F9n: bind address comes from config.json .rdpIp and is CGNAT-validated', () => {
  assert.match(webdesk, /\$cW\.rdpIp/, 'the bind address must be read from config.json .rdpIp');
  assert.ok(webdesk.includes("^100\\.(6[4-9]|[7-9]\\d|1[01]\\d|12[0-7])\\.\\d{1,3}\\.\\d{1,3}$"), 'bind address must be validated against 100.64.0.0/10');
  // invalid => fail-closed, and BEFORE any install work
  const ipGuard = lineIndex(l => l.includes("'serve-failed' 'tailnet-ip-unavailable'"), webdeskStart);
  const installer = lineIndex(l => l.includes('choco install tightvnc'), webdeskStart);
  assert.ok(ipGuard > 0, 'tailnet-ip-unavailable reason write missing');
  assert.ok(ipGuard < installer, 'the tailnet-IP guard must run BEFORE the installer');
  const tail = lines.slice(ipGuard, ipGuard + 4).join('\n');
  assert.match(tail, /throw 'tailnet-ip-unavailable/);
  assert.doesNotMatch(tail, /exit 0/);
});

test('F9n: tailnet-only firewall rule for 7333 is created, CGNAT-scoped, idempotent', () => {
  assert.match(webdesk, /New-NetFirewallRule -DisplayName \$fwName -Direction Inbound -Protocol TCP -LocalPort 7333 -RemoteAddress '100\.64\.0\.0\/10' -Action Allow/);
  assert.match(webdesk, /Remove-NetFirewallRule -DisplayName \$fwName/, 'the rule must be idempotent (same-name rule removed first)');
  assert.match(webdesk, /remoteip=100\.64\.0\.0\/10/, 'the netsh fallback must stay CGNAT-scoped');
  assert.doesNotMatch(webdesk, /RemoteAddress +(Any|0\.0\.0\.0)/);
  assert.doesNotMatch(wf, /0\.0\.0\.0:7333/);
  assert.doesNotMatch(webdesk, /remoteip=(any|0\.0\.0\.0)/i);
  // a missing rule is fail-closed (no false LIVE behind a denied port)
  const fwIdx = webdesk.indexOf("Set-WebdeskCfg '' 'serve-failed' 'firewall-rule'");
  assert.ok(fwIdx > 0, 'firewall-rule reason write missing');
  assert.match(webdesk.slice(fwIdx, fwIdx + 400), /throw 'Web desktop not deployed: tailnet-only firewall rule/);
});

test('F9n: advertised URL is built only from the validated bind address', () => {
  assert.match(webdesk, /\$webdeskUrl = 'http:\/\/' \+ \$bindIp \+ ':7333\/' \+ 'vnc\.html\?autoconnect=1&resize=remote'/);
  assert.match(webdesk, /Set-WebdeskCfg \$webdeskUrl ''/);
  // no fabricated host, no https-to-plaintext, no explicit ts.net concatenation
  assert.doesNotMatch(webdesk, /serveUrl = 'https:\/\/' \+ \$/);
  assert.doesNotMatch(webdesk, /'https:\/\/' \+ \$/);
});

test('F9n: summary carries the URL and the mandated transport note', () => {
  assert.match(webdesk, /'### Web desktop LIVE \(tailnet-only, VNC-password-gated\)'/);
  assert.match(webdesk, /\('URL: ' \+ \$webdeskUrl\)/);
  assert.match(webdesk, /transport: tailnet HTTP \(WireGuard-encrypted path\) \+ VNC password gate; tailscale serve retired due to Windows SYSTEM operator lock \(401\)/);
  assert.match(selftest, /transport: tailnet HTTP \(WireGuard-encrypted path\) \+ VNC password gate; tailscale serve retired due to Windows SYSTEM operator lock \(401\)/);
});

test('F9n: server + UI publish only allowlisted webdeskUrl shapes', () => {
  const srv = fs.readFileSync('payloads/ghrdp-server.ps1', 'utf8');
  const codeLines = srv.split('\n').filter(l => l.includes('$wd -match'));
  assert.ok(codeLines.length >= 1, 'the server must test $wd against an allowlist');
  assert.ok(codeLines.some(l => l.includes('^http://100\\.(6[4-9]|[7-9]\\d|1[01]\\d|12[0-7])\\.\\d{1,3}\\.\\d{1,3}:7333/')), 'tailnet-HTTP shape missing from the server allowlist');
  assert.ok(codeLines.some(l => l.includes('^https://[a-z0-9.-]+\\.ts\\.net/')), 'tailnet *.ts.net shape missing from the server allowlist');
  assert.match(srv, /invalid-webdesk-url/, 'a rejected URL must be reported as invalid-webdesk-url');
  const ui = fs.readFileSync('payloads/ui.html', 'utf8');
  const uiLines = ui.split('\n').filter(l => /WEBDESK_TAILNET_HTTP_RE=|WEBDESK_TSNET_HTTPS_RE=|deskAllowed=/.test(l));
  assert.ok(uiLines.some(l => l.includes('100\\.(6[4-9]|[7-9]\\d|1[01]\\d|12[0-7])\\.')), 'tailnet-HTTP shape missing from the UI allowlist');
  assert.ok(uiLines.some(l => l.includes('ts\\.net\\/')), 'tailnet *.ts.net shape missing from the UI allowlist');
  assert.ok(uiLines.some(l => l.includes('WEBDESK_TAILNET_HTTP_RE.test(rawDesk)||WEBDESK_TSNET_HTTPS_RE.test(rawDesk)')), 'the UI must gate on both shapes');
  assert.match(ui, /tailnet-only HTTP over WireGuard \+ VNC password; nothing installed on client/);
});

// [F9n] Idempotent websockify launcher: kill stale + paired redirects + wait
// for a LISTEN socket on <tailnet ip>:7333 specifically, returning a bool, and
// REFUSING any bind address outside 100.64.0.0/10.
test('F9n: Start-Websockify is idempotent, paired-redirect and tailnet-exact', () => {
  assert.match(webdesk, /function Start-Websockify\(/);
  const from = webdesk.indexOf('function Start-Websockify(');
  const rest = webdesk.slice(from);
  // bound the slice to the function body (the step continues with unrelated code)
  const fn = rest.slice(0, rest.indexOf('\n          }\n'));
  assert.match(fn, /Stop-Process/, 'stale websockify processes must be killed (idempotent re-entry)');
  assert.match(fn, /RedirectStandardOutput \$wsLog/);
  assert.match(fn, /RedirectStandardError \$wsErr/);
  assert.doesNotMatch(fn, /-WindowStyle Hidden/, 'websockify must not be launched with a hidden window');
  const waits = fn.match(/-LocalAddress \$BindIp -LocalPort 7333 -State Listen/g) || [];
  assert.ok(waits.length >= 2, 'must wait for the tailnet-address listener before and after starting');
  assert.match(fn, /\(\$BindIp \+ ':7333'\)/, 'websockify must bind <tailnet ip>:7333');
  assert.doesNotMatch(fn, /'127\.0\.0\.1:7333'/, 'a loopback bind would leave the advertised tailnet URL dead');
  assert.match(fn, /100\\\.\(6\[4-9\]/, 'the launcher must refuse non-CGNAT bind addresses');
  assert.match(fn, /return \$false/);
  assert.match(fn, /return \$true/);
  assert.match(webdesk, /\$wsUp = Start-Websockify \$bindIp/, 'the deploy step must call the function with the bind address');
  // the launcher must not carry the VNC password anywhere
  assert.doesNotMatch(fn, /\$vp\b|VNC_PASS/);
  const lab = fs.readFileSync('.github/workflows/webdesk-lab.yml', 'utf8');
  const labStart = lab.split('\n').find(line => line.includes('Start-Process -FilePath python'));
  assert.ok(labStart, 'fallback lab must still seed websockify');
  assert.doesNotMatch(labStart, /-WindowStyle Hidden/, 'fallback lab must not hide websockify');
});

// [F9n] Classified, self-healing self-test: the EXACT advertised URL is curled
// first (3x5s); on failure the backend root on the tailnet address is probed,
// the transport is healed (firewall rule + the SAME launcher), and everything
// is classified - with status, headers and body bytes kept.
test('F9n: self-test curls the exact advertised URL, then the backend root', () => {
  assert.match(selftest, /\$probeA = Invoke-Probe \$url \('adv-' \+ \$i\)/, 'the advertised URL must be probed exactly as advertised');
  assert.match(selftest, /\$backendUrl = 'http:\/\/' \+ \$bindIp \+ ':7333\/'/, 'backend root probe on the tailnet address missing');
  assert.match(selftest, /\$backendOk = \(\$probeB\.Code -eq '200'\)/, 'backend health must be a 200 check');
  assert.match(selftest, /\$started = Start-Websockify \$bindIp/, 'a dead backend must call the launcher');
  assert.match(selftest, /\$fwHeal = Set-WebdeskFirewall/, 'the heal must re-assert the CGNAT-only firewall rule');
  assert.match(selftest, /backend re-probe/, 'the backend must be re-probe after healing');
  // both helper copies in the self-test must be the same text as the deploy copies
  const all = fs.readFileSync('.github/workflows/main.yml', 'utf8');
  const copies = all.match(/^          function Start-Websockify\(.*?^          \}\n/gms) || [];
  assert.equal(copies.length, 2, 'expected exactly two Start-Websockify copies');
  assert.equal(copies[0], copies[1], 'the two Start-Websockify copies must be identical');
  const fw = all.match(/^          function Set-WebdeskFirewall \{.*?^          \}\n/gms) || [];
  assert.equal(fw.length, 2, 'expected exactly two Set-WebdeskFirewall copies');
  assert.equal(fw[0], fw[1], 'the two Set-WebdeskFirewall copies must be identical');
});

test('F9n: advertised-URL leg records status/headers/body and retries 3x5s', () => {
  assert.match(selftest, /first200=/, 'first 200 body bytes must be captured');
  assert.match(selftest, /headers=/, 'response headers must be captured');
  assert.match(selftest, /for \(\$i = 1; \$i -le 3; \$i\+\+\)/, 'the advertised URL must be probed 3 times');
  assert.match(selftest, /Start-Sleep -Seconds 5/, 'a 5s wait must separate the advertised-URL attempts');
  assert.match(selftest, /advertised re-probe/);
  assert.match(selftest, /noVNC/, 'the self-test must require the noVNC marker');
});

test('F9n: failures are classified (backend-dead | firewall | marker-missing) and fail-closed', () => {
  assert.match(selftest, /backend-dead/);
  assert.match(selftest, /'firewall'/);
  assert.match(selftest, /marker-missing/);
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
  assert.match(stage, /transport-state\.txt/, 'the transport snapshot (listener + firewall rule) must be staged');
  assert.match(stage, /firewallRuleGHRDP-Webdesk=/);
  assert.doesNotMatch(stage, /serve status --json/, 'no serve diagnostics may remain');
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
  assert.match(ui, /host-side startup\/transport failure - this is NOT a missing VNC_PASS; do not re-add the secret\./);
  assert.match(ui, /textContent='WEB DESKTOP ready'/);
});
