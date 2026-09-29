// [F50/F51] Streaming upload + Downloads auto-upload - source-contract lock.
//
// The behaviour is proven by tests/f50-mirror-streaming.ps1 on the Windows
// lane (100 MB/1 GB/3 GB/6 GB sparse files over a real loopback wire + a real
// watcher run); this suite pins the contract statically: the upload path is
// HttpClient + MultipartFormDataContent + StreamContent(FileStream) with NO
// whole-file buffer, the F51 helpers + watcher wiring exist, the non-Downloads
// roots keep the opt-in gate, the lanes run the lab, and the docs (incl. the
// canonical project context) pin the rule.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const lf = (s) => s.replace(/\r\n?/g, '\n');
const mod = lf(fs.readFileSync('payloads/ghrdp-mirror.ps1', 'utf8'));
const wat = lf(fs.readFileSync('payloads/ghrdp-watcher.ps1', 'utf8'));
const lab = lf(fs.readFileSync('tests/f50-mirror-streaming.ps1', 'utf8'));
const gates = lf(fs.readFileSync('.github/workflows/launch-gates.yml', 'utf8'));
const main = lf(fs.readFileSync('.github/workflows/main.yml', 'utf8'));
const docs = lf(fs.readFileSync('docs/MIRROR-HOSTS.md', 'utf8'));
const ctxDoc = lf(fs.readFileSync('PROJECT-CONTEXT-v2-CANONICAL.md', 'utf8'));

// Code-only view: comments may NAME a banned pattern while documenting its
// absence; only real code counts (the repo's established self-scan pattern).
const code = (text) => text.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');

// Extract one function body (from `function Name {` to the next top-level
// `function ` at column 0).
function fnBody(src, name) {
  const start = src.indexOf(`function ${name} {`);
  assert.ok(start > 0, `${name} not found`);
  const rest = src.slice(start);
  const next = rest.slice(1).indexOf('\nfunction ');
  return next > 0 ? rest.slice(0, next + 1) : rest;
}

test('F50-1 the upload path streams: HttpClient + multipart + StreamContent, no whole-file buffer', () => {
  const send = fnBody(mod, 'Send-F46GofileUpload');
  assert.match(send, /System\.Net\.Http\.HttpClient/, 'the uploader must use HttpClient');
  assert.match(send, /System\.Net\.Http\.MultipartFormDataContent/, 'the uploader must build MultipartFormDataContent');
  assert.match(send, /System\.Net\.Http\.StreamContent/, 'the file part must be StreamContent');
  assert.match(send, /\[System\.IO\.File\]::Open\(/, 'the file must be opened as a FileStream');
  assert.match(send, /GetAwaiter\(\)\.GetResult\(\)/, 'the send must be driven to completion');
  // NO whole-file byte array, NO MemoryStream, NO legacy HttpWebRequest
  // request-stream path anywhere in the upload function.
  const sendCode = code(send);
  for (const banned of ['ReadAllBytes', 'MemoryStream', 'GetRequestStream', 'WebRequest]::Create', 'ReadToEnd']) {
    assert.ok(!sendCode.includes(banned), `the upload path must not contain ${banned} (whole-file buffering / legacy path)`);
  }
  assert.match(send, /TryGetValues\('Retry-After'/, 'Retry-After must still be read from the response');
  assert.match(send, /Test-F46FailFastStatus|ConvertFrom-F46UploadResponse/, 'the response must keep the F46 classification');
  const phaseFn = fnBody(mod, 'Get-F46TransportPhase');
  for (const needle of ['NameResolutionFailure', 'ConnectFailure', 'SecureChannelFailure', 'SocketException']) {
    assert.ok(phaseFn.includes(needle), `the transport classifier must map ${needle}`);
  }
});

test('F50-2 the F44/F46 policy surface is unchanged by the streaming rewrite', () => {
  assert.match(mod, /\$script:F46FailFastStatuses = @\(401, 403, 413, 415\)/, 'fail-fast statuses must stay');
  assert.match(mod, /\$script:F46TransientPhases = @\('dns', 'tcp', 'tls', 'http'\)/, 'transient phases must stay');
  assert.match(mod, /\$script:F46MaxAttempts = 5/, 'the attempt budget must stay');
  assert.match(mod, /\$script:F46RetryAfterCapMs = 120000/, 'the Retry-After cap must stay');
  assert.match(mod, /function Invoke-F46MirrorUploadWithPolicy/, 'the policy loop must stay');
  assert.match(mod, /function Invoke-F46MirrorAttempt/, 'the attempt engine must stay');
  assert.match(mod, /function Invoke-F46EncryptFile/, 'the encryptor must stay (small files; labeled refusal for big ones)');
  assert.match(mod, /Format-F48AuthReason/, 'the F48 labeled auth reason must stay');
  assert.ok(!/Authorization|X-Gofile-Token|Cookie/.test(mod.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n')), 'no auth header may target the host (code lines)');
});

test('F51-1 the module carries the Downloads always-on helpers + ledger needle', () => {
  assert.match(mod, /F51 auto-upload-begin/, 'the F51 marker block is missing');
  for (const fn of ['function Test-F51AutoUploadPath', 'function Select-F51AutoUploadHost', 'function Format-F51AutoLedger']) {
    assert.ok(mod.includes(fn), 'helper missing: ' + fn);
  }
  assert.match(mod, /\$script:F51AutoUploadLeaf = 'downloads'/, 'the auto root leaf constant drifted');
  assert.match(mod, /\[mirror\] AUTO-UPLOAD: root=Downloads scope=this-run source=auto host=/, 'the F51 ledger format drifted');
  assert.match(mod, /Downloads always-on per F51/, 'the ledger line must name the F51 rule');
  // the host copy is per-attempt ONLY: the config list must not be mutated.
  const sel = fnBody(mod, 'Select-F51AutoUploadHost');
  assert.match(sel, /\$c\['enabled'\] = \$true/, 'the copy must be enabled for the attempt');
  assert.ok(sel.includes('blockedExtensions'), 'the copy must keep the preflight knobs');
});

test('F51-2 the watcher wires the always-on path and keeps the opt-in gate for every other root', () => {
  assert.match(wat, /Test-F51AutoUploadPath/, 'the watcher never calls the classifier');
  assert.match(wat, /Select-F51AutoUploadHost/, 'the watcher never selects the auto host');
  assert.match(wat, /Format-F51AutoLedger/, 'the F51 ledger call is missing');
  assert.match(wat, /\$uploadQueue/, 'the auto upload queue is missing');
  assert.match(wat, /F51AutoLedgered/, 'the per-run ledger guard is missing');
  assert.match(wat, /autoUpload = \$\(if \(@\(\$autoFiles\.Keys\)\.Count -gt 0\) \{ 'downloads' \} else \{ 'off' \}\)/, 'mirrorDiag does not carry the auto state');
  // the non-auto path still requires the mirror master switch
  assert.match(wat, /if \(\(\(\[bool\]\$cfg\.mirror\) -or \(@\(\$uploadQueue\)\.Count -gt 0\)/, 'the mirror gate must still open for the opt-in path');
  assert.match(wat, /if \(-not \[bool\]\$cfg\.mirror\) \{\n      \$uploadQueue = \[System\.Collections\.ArrayList\]@\(@\(\$queue\) \| Where-Object \{ \$autoFiles\.ContainsKey/, 'a non-Downloads file must not upload while the mirror is off');
  // the F49 surfaces stay byte-for-byte
  for (const needle of ["Join-Path $Root 'mirror-enable.flag'", "Join-Path $Root 'mirror-disable.flag'", 'Format-F49OptInLedger', 'Format-F49OptOutLedger', 'optIn = $f49OptInDiag']) {
    assert.ok(wat.includes(needle), 'the F49 watcher surface drifted: ' + needle);
  }
});

test('F51-3 the opt-in inputs stay default-off and no auto-upload dispatch input was added', () => {
  const inputsBlock = main.slice(main.indexOf('workflow_dispatch:'), main.indexOf('\npermissions:'));
  const enable = inputsBlock.match(/mirror_enable:\n(?:.*\n)*?\s+default: (true|false)/);
  assert.ok(enable && enable[1] === 'false', 'mirror_enable must stay default false');
  assert.equal(/^\s+auto_?upload:/im.test(inputsBlock), false, 'auto-upload must need NO dispatch input (that is the point of F51)');
  assert.equal(/^\s+downloads_/im.test(inputsBlock), false, 'no Downloads-specific dispatch input may appear');
  assert.match(main, /MIRROR_INPUT -eq 'true'/, 'the unchanged mirror gate must stay');
});

test('F50-4 the lab covers the mandated cells and the lanes run it', () => {
  // sizes: 100 MB / 1 GB / 3 GB / 6 GB
  for (const bytes of ['104857600', '1073741824', '3221225472', '6442450944']) {
    assert.ok(lab.includes(bytes), `the lab must stream a file of ${bytes} bytes`);
  }
  assert.match(lab, /fsutil\.exe file createnew/, 'the lab must create its big files with fsutil');
  assert.match(lab, /fsutil\.exe sparse setflag/, 'the big files must be sparse');
  assert.match(lab, /PeakWorkingSet64/, 'the lab must measure the client memory profile');
  assert.match(lab, /2147483648L/, 'the lab must assert the sub-2 GiB memory bound');
  // retry + preflight cells over the REAL transport
  for (const cell of ["'429', '429', '429', '429', '429'", "'500', '500', 'ok'", "'502', '502', '502', '502', '502'", "'abort', 'ok'", "'403', 'ok'", "'413'", 'transportCalls -eq 0']) {
    assert.ok(lab.includes(cell), 'the lab must drive the real-transport cell: ' + cell);
  }
  // the auto-upload end-to-end cell
  assert.match(lab, /AUTO-UPLOAD: root=Downloads/, 'the lab must assert the F51 ledger line');
  assert.match(lab, /f51-auto-proof\.bin/, 'the lab must simulate a real download into Downloads');
  assert.match(lab, /f51-desktop-proof\.bin/, 'the lab must prove the Desktop file stays tracked-not-uploaded');
  // lanes: parse + execute
  assert.ok(gates.includes("'tests/f50-mirror-streaming.ps1'"), 'windows-native must parse the lab');
  assert.match(gates, /F50\/F51 mirror streaming \+ Downloads auto-upload lab/, 'windows-native must execute the lab');
  assert.ok(gates.includes('tests/f50-f51-mirror-stream.test.js'), 'the gates step must run this suite');
  // the balance audits cover the new lab too
  for (const audit of ['tests/ps-balance-audit.py', 'scripts/ps-balance-audit.mjs']) {
    assert.ok(lf(fs.readFileSync(audit, 'utf8')).includes('tests/f50-mirror-streaming.ps1'), audit + ' must audit the lab');
  }
});

test('F50-5 the docs pin the rule: canonical context + mirror contract', () => {
  assert.ok(fs.existsSync('PROJECT-CONTEXT-v2-CANONICAL.md'), 'PROJECT-CONTEXT-v2-CANONICAL.md must exist');
  assert.match(ctxDoc, /Mirror is default-OFF, EXCEPT for the `Downloads` root which is\s+Always-ON \(Auto-upload\)\./, 'Section 6 Rule 5 must read exactly as the operator dictated');
  assert.match(ctxDoc, /operator override, 2026-09-29/i, 'the override provenance must be recorded');
  assert.match(docs, /## 11\. F51 Downloads-root auto-upload/, 'MIRROR-HOSTS.md must document the auto-upload section');
  assert.match(docs, /## 12\. F50 streaming transport/, 'MIRROR-HOSTS.md must document the streaming transport');
  assert.match(docs, /Always-ON/, 'the doc must state the Downloads exception');
  assert.match(docs, /Test-F51AutoUploadPath/, 'the doc must name the classifier');
  assert.ok(docs.includes('`HttpClient` + `MultipartFormDataContent` + `StreamContent(FileStream)`'), 'the doc must name the streaming stack');
  assert.ok(!/bypass|evade/i.test(docs), 'the doc must not use evasion wording');
});
