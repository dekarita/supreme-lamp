// F53: queue progress honesty + content-length source pins. The wire proof is
// tests/f53-content-length.ps1 on the windows-native lane.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const read = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n?/g, '\n');
const ui = read('payloads/ui.html');
const mod = read('payloads/ghrdp-mirror.ps1');
const cs = read('payloads/ghrdp-mirror-progress.cs');
const watcher = read('payloads/ghrdp-watcher.ps1');
const gates = read('.github/workflows/launch-gates.yml');
const between = (s, a, b) => {
  const start = s.indexOf(a), end = s.indexOf(b, start + a.length);
  assert.ok(start >= 0 && end > start, 'missing shipped block: ' + a);
  return s.slice(start, end);
};

function queue() {
  const c = vm.createContext({});
  vm.runInContext(between(ui, '// [F53 queue-progress-begin]', '// [F53 queue-progress-end]'), c);
  return (file) => vm.runInContext('f53QueueProgress(f)', Object.assign(c, { f: file }));
}

test('F53-QUEUE-PROGRESS pending row is 0% plus attempt, never 100%', () => {
  const q = queue();
  const frozen = q({ status: 'pending', phase: 'queued', bytesSent: 1170366464, size: 1170366464, pct: 100, attempt: 2, attempts: [{ n: 1 }] });
  assert.equal(frozen.pending, true);
  assert.equal(frozen.pct, 0);
  assert.equal(frozen.text, '0% · attempt 2');
  assert.equal(frozen.text.includes('100'), false);
  const fromAttempts = q({ status: 'retrying', phase: 'http', attempts: [{ n: 1 }, { n: 2 }] });
  assert.equal(fromAttempts.text, '0% · attempt 3');
  const active = q({ status: 'active', phase: 'http', bytesSent: 10, size: 10, attempt: 1 });
  assert.equal(active.pending, false);
  assert.equal(active.text, '');
});

test('F53-LEN-SOURCE formula length, one framing owner, retry zeroes bytesSent', () => {
  assert.match(cs, /class ContainerLength/);
  assert.match(cs, /return checked\(32L \+ checked\(\(plainLength \/ 16L \+ 1L\) \* 16L\)\)/);
  assert.match(cs, /return checked\(40L \+ plainLength\)/);
  assert.match(cs, /new SnapshotReadStream\(file, PlainLength\)/);
  assert.match(cs, /position >= WireLength\) return 0/);
  assert.equal(mod.split('New-Object System.Net.Http.MultipartFormDataContent').length - 1, 1);
  assert.match(mod, /function Get-F53DeclaredPartLength/);
  assert.match(mod, /function New-F46UploadContent/);
  assert.match(mod, /function Measure-F53Upload/);
  assert.match(mod, /framingMode = 'content-length'/);
  assert.match(mod, /\$state52\.Reset\(\)/);
  const send = between(mod, 'function Send-F46GofileUpload {', 'function ConvertFrom-F46UploadResponse {');
  assert.match(send, /Get-F53DeclaredPartLength/);
  assert.doesNotMatch(send, /\$Size/);
  assert.match(send, /New-F46UploadContent/);
  assert.match(watcher, /Set-F53PendingRetry -Entry \$entry/);
  assert.match(watcher, /bytesSent = \[long\]0/);
  assert.match(gates, /tests\/f53-content-length\.ps1/);
  assert.match(gates, /tests\/f53-content-length\.test\.js/);
});

test('F53-STATE ledger names F52 PR #92 and stays within 60 lines', () => {
  const state = read('STATE.md');
  assert.ok(state.split('\n').filter((l) => l.length > 0 || true).length <= 61);
  assert.equal(state.split('\n').filter((l, i, a) => i < a.length - 1 || l !== '').length <= 60, true);
  assert.match(state, /F52 via PR #92|PR #92/);
  assert.match(state, /F53/);
});
