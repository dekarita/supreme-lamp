// [F50 + F51] LARGE-FILE STREAMING TRANSPORT + ALWAYS-ON DOWNLOADS AUTO-UPLOAD.
//
// F50 (Thread B): the mirror upload path is HttpClient + MultipartFormDataContent
// + StreamContent(FileStream). No whole-file byte array and no buffering request
// stream may return (the .NET 2GB in-box buffer produced the runner failure
// "Stream was too long"). The F44 policy (fail-fast 401/403/413/415 = 1 attempt,
// jittered backoff for transients, Retry-After capped at 120s), the F48 guest
// contract and the F49 ledger logging are preserved verbatim.
//
// F51 (brief override of Locked Rule 5, Downloads root only): any file landing
// in the Downloads root is queued for mirror upload automatically - no
// mirror_enable input, no F49 opt-in modal. Desktop/Documents/Temp/RDP-Storage
// stay fully gated. The override is in-memory only; the F49 modal contract for
// the other roots is untouched.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const lf = (s) => s.replace(/\r\n?/g, '\n');
const code = (text) => text.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
const read = (p) => lf(fs.readFileSync(p, 'utf8'));
const mod = read('payloads/ghrdp-mirror.ps1');
const watcher = read('payloads/ghrdp-watcher.ps1');
const lab = read('tests/f46-mirror-policy.ps1');
const gates = read('.github/workflows/launch-gates.yml');
const doc = read('docs/MIRROR-HOSTS.md');
const ui = read('payloads/ui.html');
const state = read('STATE.md');

const fnSlice = (text, startMarker, endMarker) => {
  const a = text.indexOf(startMarker);
  const b = text.indexOf(endMarker, Math.max(a, 0));
  if (a < 0 || b <= a) return '';
  return text.slice(a, b);
};
const send = fnSlice(mod, 'function Send-F46GofileUpload', 'function ConvertFrom-F46UploadResponse');

test('F50-1 the upload transport is streamed: HttpClient + MultipartFormDataContent + StreamContent(FileStream)', () => {
  assert.match(send, /System\.Net\.Http\.HttpClient/, 'the transport must be HttpClient');
  assert.match(send, /MultipartFormDataContent/, 'the body must be a MultipartFormDataContent');
  assert.match(send, /System\.Net\.Http\.StreamContent/, 'the file part must be a StreamContent');
  assert.match(send, /System\.IO\.File\]::Open\(/, 'the stream must come from a FileStream (File::Open)');
  assert.match(send, /FileShare\]::ReadWrite/, 'the source must stay share-readable while it grows');
});

test('F50-2 no whole-file buffering exists in the upload path (the 2GB "Stream was too long" class is gone)', () => {
  assert.ok(!send.includes('ReadAllBytes'), 'the upload path may not materialise the file (ReadAllBytes)');
  assert.ok(!send.includes('MemoryStream'), 'the upload path may not buffer into a MemoryStream');
  assert.ok(!code(send).includes('AllowWriteStreamBuffering'), 'the buffering request stream must be gone');
  assert.ok(!code(send).includes('[System.Net.WebRequest]::Create'), 'the old HttpWebRequest staging must be gone');
});

test('F50-3 the F44 policy is preserved verbatim (fail-fast, budget, Retry-After cap 120s)', () => {
  assert.match(mod, /\$script:F46FailFastStatuses = @\(401, 403, 413, 415\)/, 'fail-fast statuses drifted');
  assert.match(mod, /\$script:F46MaxAttempts = 5/, 'the transient attempt budget drifted');
  assert.match(mod, /\$script:F46RetryAfterCapMs = 120000/, 'the Retry-After cap drifted');
  assert.match(mod, /Retry-After hint is a FLOOR/, 'the Retry-After floor rule must stay documented');
  assert.match(send, /ConvertFrom-F46UploadResponse/, 'the response classifier must still be used');
  const httpCodes = fnSlice(mod, '$script:F46TransientPhases', 'policy-end');
  assert.match(httpCodes, /'dns', 'tcp', 'tls', 'http'/, 'the transient ladder drifted');
});

test('F50-4 the F48 guest contract rides the new transport (field file, part mime, zero auth surface)', () => {
  assert.match(send, /\$spec\.fieldName/, 'the pinned field name must feed the disposition');
  assert.match(send, /\$spec\.partContentType/, 'the pinned part mime must feed the part header');
  assert.ok(!code(send).includes('Authorization'), 'no auth header may appear in the streamed transport');
  assert.ok(!code(send).includes('Cookie'), 'no cookie may appear in the streamed transport');
  assert.ok(!code(send).includes('X-Gofile-Token'), 'no host token may appear in the streamed transport');
  assert.match(send, /TryAddWithoutValidation|Accept/, 'request headers still come from the pinned spec only');
});

test('F50-5 the windows lab proves the streaming matrix (fsutil sparse files + discarding listener + retry paths)', () => {
  for (const size of ['100MB', '1GB', '3GB', '6GB']) {
    assert.ok(lab.includes(`'${size}'`), `the lab must stream a ${size} sparse file`);
  }
  assert.match(lab, /fsutil file createnew/, 'the sparse files must come from fsutil');
  assert.match(lab, /discarding listener/, 'the loopback listener must discard (never store) the body');
  assert.match(lab, /System\.Net\.HttpListener/, 'the lab listener must be a local HttpListener');
  for (const rc of ['429-then-success', '500-500-then-success', '502-budget', 'refused-tcp']) {
    assert.ok(lab.includes(rc), `the lab must cover the real-transport retry path ${rc}`);
  }
  assert.match(lab, /the Retry-After hint stayed a FLOOR/, 'the lab must prove the Retry-After floor on the wire');
  assert.match(lab, /preflight size refusal: phase=size with ZERO network tries/, 'the lab must prove size preflight network=0');
  assert.match(lab, /preflight type refusal: phase=type with ZERO network tries/, 'the lab must prove type preflight network=0');
});

test('F51-1 the watcher carries the always-on Downloads helpers (extracted + executed by the lab)', () => {
  for (const fn of ['function Test-F51DownloadsRoot', 'function Get-F51AutoUploadRoots', 'function Test-F51AutoUploadPath', 'function Split-F51AutoQueue', 'function New-F51AutoHost']) {
    assert.ok(watcher.includes(fn), 'watcher helper missing: ' + fn);
  }
  assert.match(lab, /Parser\]::ParseFile\(\$watcherPath/, 'the lab must extract the REAL watcher functions (no copies)');
  for (const fn of ['Test-F51DownloadsRoot', 'Get-F51AutoUploadRoots', 'Test-F51AutoUploadPath', 'Split-F51AutoQueue', 'New-F51AutoHost']) {
    assert.ok(lab.includes(`'${fn}'`), `the lab must execute the watcher helper ${fn}`);
  }
});

test('F51-2 the override is Downloads-only and in-memory (gated roots + F49 modal untouched)', () => {
  const helper = fnSlice(watcher, 'function New-F51AutoHost', '\n}');
  assert.match(helper, /enabled = \$false/, 'the fallback table starts from the documented disabled default');
  assert.match(helper, /\$h\['enabled'\] = \$true/, 'the override enables the host only in memory');
  assert.ok(!helper.includes('Save-MirrorCfg'), 'the override must never write config.json');
  assert.ok(!/mirror-enable\.flag|mirror-disable\.flag/.test(helper), 'the override must never read the F49 flag files');
  assert.match(helper, /authMode = 'guest'/, 'the override stays on the F48 guest contract');
  assert.match(helper, /id = 'gofile'/, 'the override rides the documented gofile guest host');
  const dlRoots = fnSlice(watcher, 'function Test-F51DownloadsRoot', 'function Get-F51AutoUploadRoots');
  assert.match(dlRoots, /downloads/, 'the Downloads family must be matched by name');
  for (const gated of ['Desktop', 'Documents', 'Temp', 'RDP-Storage']) {
    assert.match(lab, new RegExp(gated), `the lab must keep ${gated} in the gated set`);
  }
  assert.match(ui, /id="mirrorOptInModal"/, 'the F49 ConfirmModal must stay in the v1 UI');
  assert.match(ui, /openMirrorOptIn\(btn\)/, 'the F49 gated flush must stay in the v1 UI');
  assert.ok(watcher.includes("Join-Path $Root 'mirror-enable.flag'"), 'the F49 enable flag consumption must stay');
  assert.ok(watcher.includes("Join-Path $Root 'mirror-disable.flag'"), 'the F49 disable flag consumption must stay');
});

test('F51-3 the scan loop consumes the partition: Downloads auto-queues without opt-in', () => {
  assert.match(watcher, /Split-F51AutoQueue -Queue \$queue -AutoRoots \$f51AutoRoots/, 'the queue must be partitioned each scan');
  assert.match(watcher, /\$uploadQueue = @\(\$queue\)/, 'the opted-in path uploads the whole queue');
  assert.match(watcher, /if \(\$f51AutoMode\) \{ \$uploadQueue = @\(\$f51Split\.auto\) \}/, 'the un-opted path uploads ONLY the Downloads slice');
  assert.match(watcher, /foreach \(\$f in @\(\$uploadQueue\)\)/, 'the worker loop must iterate the partitioned queue');
  assert.match(watcher, /if \(\$f51AutoMode -and \(-not \$mirrorHost\)\)/, 'the auto path must fall back to the in-memory override host');
  assert.match(watcher, /Invoke-F46MirrorAttempt -HostCfg \$mirrorHost -Path \$uploadPath -Name \$dispName -Size \$uploadLen -AttemptNo \$attemptNo/, 'the shared attempt engine call is unchanged');
  assert.match(watcher, /autoUpload = \$\(if \(\$f51AutoMode\)/, 'mirrorDiag must carry the auto-upload state');
  assert.match(watcher, /autoRoots = @\(\$f51AutoRoots\)/, 'mirrorDiag must carry the auto roots');
  assert.match(watcher, /autoQueued = @\(\$f51AutoFiles\.Keys\)\.Count/, 'mirrorDiag must carry the auto-queued count');
});

test('F51-4 the ledger lines exist (F49-style logging) and fire once per file / once per run', () => {
  assert.match(watcher, /\[mirror\] AUTO-UPLOAD: \{0\} \(Downloads root; F51 always-on, opt-in not required\)/, 'the per-file ledger line is missing');
  assert.match(watcher, /\[mirror\] F51 AUTO-UPLOAD: \{0\} file\(s\) in the Downloads root queued automatically/, 'the per-scan queue line is missing');
  assert.match(watcher, /\[mirror\] F51 AUTO: Downloads root always-on override applied/, 'the override ledger line is missing');
  assert.match(watcher, /F51AutoHostLedgered/, 'the once-per-run guard is missing');
  assert.match(watcher, /f51AutoFiles\.ContainsKey\(\$key\)/, 'the once-per-file guard is missing');
});

test('F51-5 the lab proves the trigger end-to-end and the gate wiring is pinned in CI', () => {
  assert.match(lab, /the new download lands in the AUTO queue by itself/, 'the download-into-Downloads trigger cell is missing');
  assert.match(lab, /the auto queue attempts WITHOUT opt-in and succeeds as guest/, 'the no-opt-in attempt cell is missing');
  assert.match(lab, /WITHOUT the override the same file is a labeled policy refusal/, 'the contrast cell is missing');
  assert.match(lab, /a Desktop file does NOT auto-queue/, 'the gated-roots contrast cell is missing');
  assert.match(gates, /\[F50\] streaming transport gates/, 'launch-gates must carry the F50 greps');
  assert.match(gates, /\[F51\] always-on Downloads gates/, 'launch-gates must carry the F51 greps');
  assert.match(gates, /node --test tests\/f50-f51-stream-auto\.test\.js/, 'this suite must run in CI');
});

test('F51-6 docs + ledger document the override (and keep the F48 hygiene bans)', () => {
  for (const needle of ['F51', 'Always-ON', 'Downloads', 'auto-upload', 'F50']) {
    assert.ok(doc.includes(needle), 'docs/MIRROR-HOSTS.md must document ' + needle);
  }
  assert.ok(!/Mozilla|proxy rotat|evade|bypass/i.test(doc), 'the doc must not describe evasion');
  assert.ok(!/GOFILE[_]TOKEN/.test(state), 'the ledger may not name the banished secret');
  assert.match(state, /F50/, 'the ledger must record F50');
  assert.match(state, /F51/, 'the ledger must record F51');
  assert.match(state, /PROJECT-CONTEXT-v2-CANONICAL\.md/, 'the ledger must point at the canonical rule update');
  assert.ok(fs.existsSync('PROJECT-CONTEXT-v2-CANONICAL.md'), 'the canonical context file must exist');
  const canon = read('PROJECT-CONTEXT-v2-CANONICAL.md');
  assert.match(canon, /Mirror is default-OFF, EXCEPT for the `Downloads` root which is Always-ON \(Auto-upload\)\./, 'Section 6 Rule 5 must read the override verbatim');
});
