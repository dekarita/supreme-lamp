// F52: run the SHIPPED classic DOM renderer and pin socket/lane/cap contracts.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const crypto = require('node:crypto');
const read = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n?/g, '\n');
const ui = read('payloads/ui.html');
const mod = read('payloads/ghrdp-mirror.ps1');
const cs = read('payloads/ghrdp-mirror-progress.cs');
const watcher = read('payloads/ghrdp-watcher.ps1');
const wf = read('.github/workflows/main.yml');
const gates = read('.github/workflows/launch-gates.yml');
const between = (s, a, b) => {
  const start = s.indexOf(a), end = s.indexOf(b, start + a.length);
  assert.ok(start >= 0 && end > start, 'missing shipped block: ' + a);
  return s.slice(start, end);
};
function context() {
  const elements = new Map();
  const c = vm.createContext({
    $: (id) => {
      if (!elements.has(id)) elements.set(id, { textContent: '', innerHTML: '', hidden: false, className: '', style: {} });
      return elements.get(id);
    },
    setRing() {}, drawSpark() {}, speedHist: [],
  });
  const funcs = ['esc', 'fmtBytes', 'fmtSpeed', 'fmtDurShort'].map((name) => ui.split('\n').find((l) => l.startsWith('function ' + name + '('))).join('\n');
  vm.runInContext(funcs + '\n' + between(ui, '// [F52 byte-window-begin]', '// [F52 byte-window-end]'), c);
  return { c, elements };
}
function renderMirror(payload) {
  const { c, elements } = context();
  c.d = payload; c.pData = payload.progress || payload;
  vm.runInContext(between(ui, '  var agg=pData.agg||{};', '  if(!logPaused){'), c);
  return elements;
}
function frozen() {
  return {
    mirror: true, encryptMode: 'all',
    agg: { total: 2, done: 1, failed: 0, bytesDone: 917340, bytesTotal: 8290172928, speedBps: 1 },
    active: { name: 'benign.iso', phase: 'http', bytesSent: '0', bytesTotal: '8290172928', windowBytes: '0', windowSeconds: 60, noBytesSeconds: 60, speedBps: 1 },
    telemetry: { scans: 26, roots: ['Downloads'] },
    files: [
      { name: 'benign.iso', phase: 'http', status: 'active', bytesSent: '0', size: '8290172928', auto: 'True', encrypted: 'False', encryptMode: 'all' },
      { name: 'small.txt', phase: 'done', status: 'done', bytesSent: 917340, size: 917340, encrypted: 'True', encryptMode: 'all' },
    ],
  };
}

test('F52-DOM-V1-FROZEN RESULT: socket bytes frozen => stalled, no day-count ETA', () => {
  const e = renderMirror(frozen());
  assert.equal(e.get('stEta').textContent, '-');
  assert.match(e.get('pubTxt').textContent, /stalled \(no bytes in 60s\)/);
  assert.match(e.get('stSpeed').textContent, /stalled/);
  assert.match(e.get('fileRows').innerHTML, /stalled \(no bytes in 60s\)/);
  assert.doesNotMatch(e.get('pubTxt').textContent, /Waiting for first upload/);
  assert.doesNotMatch(e.get('stEta').textContent, /\d+d/);
});
test('F52-DOM-V1-DONE RESULT: done row forbids Waiting even when agg.done is stale', () => {
  const d = frozen(); d.active = { name: '', phase: 'idle' }; d.agg.done = 0;
  const e = renderMirror(d);
  assert.equal(e.get('pubTxt').textContent, '1 uploaded');
});
test('F52-DOM-V1-MOVING RESULT: speed/ETA use only the real 60s byte window', () => {
  const d = frozen(); Object.assign(d.active, { bytesSent: '1073741824', windowBytes: '1073741824', windowSeconds: 60, noBytesSeconds: 0 });
  const e = renderMirror(d);
  assert.doesNotMatch(e.get('stSpeed').textContent, /stalled|^1 B/);
  assert.notEqual(e.get('stEta').textContent, '-');
  assert.match(e.get('pubTxt').textContent, /^Uploading/);
});
test('F52-INT64-V1 RESULT: exact percent and subtraction beyond 2^53', () => {
  const { c } = context();
  assert.equal(vm.runInContext("f52Bytes('9007199254740993').toString()", c), '9007199254740993');
  assert.equal(vm.runInContext("f52Percent('9223372036854775806','9223372036854775807')", c), 99.9);
  assert.equal(vm.runInContext("f52Transfer({bytesSent:'9223372036854775806',size:'9223372036854775807',windowBytes:'2',windowSeconds:1},true).eta", c), 0.5);
  assert.equal(vm.runInContext('f52Bytes(9007199254740992).toString()', c), '0', 'unsafe numeric JSON cannot manufacture exact bytes');
});
test('F52-SOCKET-SOURCE RESULT: counter updates AFTER outgoing WriteAsync and FlushAsync, not reads', () => {
  const stream = between(cs, 'internal sealed class ProgressWriteStream', 'public sealed class ProgressContent');
  assert.ok(stream.indexOf('await destination.WriteAsync') < stream.indexOf('await destination.FlushAsync'));
  assert.ok(stream.indexOf('await destination.FlushAsync') < stream.lastIndexOf('state.Written(count)'));
  assert.match(cs, /public long BytesSent/);
  assert.match(cs, /checked\(sent \+ \(long\)count\)/);
  assert.match(cs, /now - 60/);
  assert.match(cs, /Failed = windows >= 3/);
  const send = between(mod, 'function Send-F46GofileUpload', 'function ConvertFrom-F46UploadResponse');
  assert.match(send, /Ghrdp\.Mirror\.ProgressContent/);
  assert.match(send, /while \(-not \$task52\.IsCompleted\)/);
  assert.match(send, /InfiniteTimeSpan/);
  assert.match(send, /StallWindowSec -ne 60.*IsLoopback/);
  assert.match(send, /last socket\/host text/);
  assert.match(watcher, /Update-F52MirrorProgress -Progress \$snapshot52/);
  assert.match(watcher, /stallRecords/);
  assert.match(read('payloads/ghrdp-server.ps1'), /\$path -eq '\/mirror'/);
  assert.match(ui, /setInterval\(poll,3000\)/);
  assert.match(read('src/hooks/useDashboardPolling.ts'), /setInterval\(pollProgress, 3000\)/);
});
test('F52-CAPS-SOURCE RESULT: matrix bytes, zero-upload preflight, null is not unlimited', () => {
  assert.match(mod, /function Get-F52ServersCap/);
  assert.match(mod, /Get-F46Prop \$srv 'maxFileBytes'/);
  assert.match(mod, /capSource.*GET \/servers maxFileBytes/);
  assert.match(mod, /maxFileBytes = \$null/);
  assert.match(mod, /maxProvenBytes = \$null/);
  const attempt = between(mod, 'function Invoke-F46MirrorAttempt', 'function Invoke-F46MirrorUploadWithPolicy');
  assert.ok(attempt.indexOf('Test-F46UploadPreflight') < attempt.indexOf('Send-F46GofileUpload'));
  assert.match(mod, /preflight \(0 network tries; network=0\)/);
  assert.match(watcher, /Set-F52HostCap -HostCfg \$mirrorHost -Rows \$f52ProbeRows/);
});
test('F52-LANES-SOURCE RESULT: explicit manual plaintext only; auto/runtime encrypt as pull-streams', () => {
  assert.match(wf, /mirror_encrypt:\n[^\n]*\n\s+type: boolean\n\s+default: true/);
  assert.match(wf, /MIRROR_PLAINTEXT_ELECTED:.*workflow_dispatch.*mirror_encrypt == 'false'/);
  assert.match(mod, /if \(\$Auto\) \{ return 'all' \}/);
  assert.match(mod, /if \(Get-F49RuntimeOptIn -Cfg \$Cfg\) \{ return 'all' \}/);
  assert.match(mod, /Name 'encryptMode' -Value 'all'/);
  assert.match(watcher, /Get-F52WorkerMode -Cfg \$cfg -Auto \$f51AutoFile/);
  assert.match(watcher, /Invoke-F46EncryptFile .* -StreamOnly/);
  const enc = between(mod, 'function Invoke-F46EncryptFile', 'function Invoke-F46DecryptFile');
  assert.doesNotMatch(enc, /ReadAllBytes|TransformFinalBlock|MemoryStream/);
  assert.match(cs, /CryptoStream\(file, transform, CryptoStreamMode.Read\)/);
  assert.match(cs, /public readonly long WireLength/);
  assert.match(cs, /GetMethod\("Pbkdf2"/);
  assert.match(cs, /GetConstructor\(new Type\[\]/);
  assert.doesNotMatch(cs, /new Rfc2898DeriveBytes\(/);
  assert.doesNotMatch(watcher, /#key=|decrypt =|media-plain/);
  assert.match(ui, /PLAINTEXT ELECTED: mirror_encrypt=false dispatch/);
  assert.match(read('src/components/domain/MirrorCard.tsx'), /mirror-plaintext-banner/);
});
test('F52-F44-VERBATIM RESULT: policy constants and retry functions byte-for-byte', () => {
  const hash = (s) => crypto.createHash('sha256').update(s).digest('hex');
  assert.equal(hash(between(mod, '# --- [F46 §2 policy-begin]', '# --- [F46 §3 contract-begin]')), 'f847df77213c45bb657aea73bb5f267bbade95bd30a7b9968f94f94840a19390');
  assert.equal(hash(between(mod, 'function Test-F46TransientPhase', 'function New-F46AttemptRecord')), '2cdfe25c2f9e94282a0624828c88f86c077e94d288ba039bf472b64508692890');
});
test('F52-KEY-SURFACES RESULT: runner-local key never reaches URLs, UI, snapshots or summaries', () => {
  assert.doesNotMatch(wf, /Current decrypt key|\$mirKeyS = \[string\]\$cfgS\.mirrorKey/);
  assert.doesNotMatch(ui, /d\.mirrorKey|#key=/);
  assert.doesNotMatch(read('src/components/domain/KeysCard.tsx'), /s\.mirrorKey/);
  assert.doesNotMatch(read('payloads/main.rs'), /cfg_str\(&cfg, "mirrorKey"\)|"mirrorKey": mirror_key/);
  assert.match(cs, /UseProxy = false, UseCookies = false, AllowAutoRedirect = false/);
});
test('F52-LAB-WIRING RESULT: native large cells and DOM cells are mandatory gates', () => {
  const lab = read('tests/f52-mirror-telemetry.ps1');
  for (const id of ['F52-S8', 'F52-S64', 'F52-S128', 'F52-HTTP-STALL', 'F52-CAP0', 'F52-ENCRYPT-WIRE', 'F52-GUEST-CAP']) assert.ok(lab.includes(id), id);
  assert.match(lab, /fsutil sparse setflag/);
  assert.match(gates, /F52 honest mirror telemetry/);
  assert.match(gates, /node --test tests\/f52-mirror-telemetry\.test\.js/);
  assert.match(gates, /tests\\f52-mirror-telemetry\.ps1/);
});

test('F52-LEDGER-COMPACTION RESULT: <=60 lines, EVERY landed line including F48/F49 unchanged', () => {
  const state = read('STATE.md');
  const hash = (s) => crypto.createHash('sha256').update(s).digest('hex');
  const hashes = new Set(state.split('\n').map(hash));
  assert.ok(state.trimEnd().split('\n').length <= 60);
  for (const lock of JSON.parse(read('tests/fixtures/f52-ledger-lock.json'))) assert.ok(hashes.has(lock.sha256), 'landed line changed/deleted: ' + lock.phase);
});
