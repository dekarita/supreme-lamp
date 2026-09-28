// [F45 S4] Explorer server routes — source contract + static security audit.
//
// Run: node --test tests/f45-s4-fx-routes.test.js
//
// The Windows lane executes the shipped Explorer core for real
// (tests/f45-s4-fx-server.ps1). This suite is the part that must run on every
// push in ~1s: it pins the SHAPE of the region (route table, status text,
// atomic writes, log discipline, range plumbing, sandbox headers) and fails on
// the two regressions that would be invisible otherwise: an Explorer answer that
// gains wildcard CORS, and a credential that reaches a log or a body.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const server = fs.readFileSync('payloads/ghrdp-server.ps1', 'utf8');
const api = fs.readFileSync('src/components/explorer/api/endpoints.ts', 'utf8');
const errors = fs.readFileSync('src/components/explorer/api/errors.ts', 'utf8');
const schema = fs.readFileSync('src/components/explorer/data/schema.ts', 'utf8');
const mimeMap = JSON.parse(fs.readFileSync('src/components/explorer/data/fixtures/preview-mime-map.json', 'utf8'));
const sandboxTest = fs.readFileSync('tests/f45-s4-fx-server.ps1', 'utf8');
const gates = fs.readFileSync('.github/workflows/launch-gates.yml', 'utf8');
const ledger = fs.readFileSync('docs/F45-EXPLORER-IMPLEMENTATION.md', 'utf8');

const BEGIN = '# [F45 S4 fx-core-begin]';
const END = '# [F45 S4 fx-core-end]';
const beginAt = server.indexOf(BEGIN);
const endAt = server.indexOf(END, beginAt);
const region = beginAt >= 0 && endAt > beginAt ? server.slice(beginAt, endAt) : '';
const routeGlue = server.slice(server.indexOf('# [F45 S4 fx-route-begin]'), server.indexOf('# [F45 S4 fx-route-end]'));

function psFunction(name) {
  const at = region.indexOf('function ' + name);
  assert.ok(at >= 0, `the Explorer core no longer defines ${name}`);
  // naive but sufficient: up to the next top-level 'function ' at column 0
  const rest = region.slice(at + 1);
  const next = rest.search(/\nfunction /);
  return next < 0 ? region.slice(at) : region.slice(at, at + 1 + next);
}

function psArrayLiteral(name) {
  const at = region.indexOf('$script:' + name + ' = @(');
  assert.ok(at >= 0, `the Explorer core no longer declares $script:${name}`);
  let depth = 0;
  let end = -1;
  for (let i = region.indexOf('(', at); i < region.length; i++) {
    const c = region[i];
    if (c === "'") { i = region.indexOf("'", i + 1); continue; }   // these lists hold no escaped quotes
    if (c === '(') depth += 1;
    else if (c === ')') { depth -= 1; if (depth === 0) { end = i; break; } }
  }
  assert.ok(end > at, `$script:${name} is not a closed array literal`);
  const body = region.slice(at, end);
  const quoted = [...body.matchAll(/'([^']*)'/g)].map((x) => x[1]);
  if (quoted.length > 0) return quoted;
  return [...body.matchAll(/(?<![\w$])(\d+)(?![\w])/g)].map((x) => x[1]);
}

function tsUnion(name) {
  const m = schema.match(new RegExp('export type ' + name + ' = ([^;]+);'));
  assert.ok(m, `schema.ts no longer declares ${name}`);
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

test('F45-S4-1 the Explorer core is one delimited, self-contained region', () => {
  assert.ok(region.length > 20000, 'the fx core region looks truncated');
  assert.equal(server.indexOf(BEGIN, beginAt + 1), -1, 'the begin marker must appear exactly once');
  assert.equal(server.split(END).length - 1, 1, 'the end marker must appear exactly once');
  // The region must not depend on the parent response writer (wildcard CORS).
  assert.ok(region.includes('function Send-FxResponse'), 'the region owns its response writer');
  const regionCode = region.split('\n').filter((line) => !/^\s*#/.test(line)).join('\n');
  assert.ok(!regionCode.includes('Send-ClientResponse'), 'Explorer responses must not use the parent writer');
  assert.ok(!regionCode.includes('Access-Control-Allow-Origin'), 'Explorer responses must never carry wildcard CORS');
  // The route glue is inside the shipped handler, before the parent gate.
  assert.ok(routeGlue.length > 0, 'the fx route glue markers are present');
  const glueAt = server.indexOf('# [F45 S4 fx-route-begin]');
  const parentGateAt = server.indexOf('if (-not (Test-ClientAllowed -Client $Client -Query $parts.query -Token $Token))', glueAt);
  assert.ok(glueAt > 0 && parentGateAt > glueAt, 'the Explorer dispatch must precede the parent gate');
  assert.ok(routeGlue.includes('Invoke-FxRoute'), 'the glue calls the Explorer router');
  assert.ok(routeGlue.includes('Protect-FxText'), 'the glue redacts a handler failure before logging it');
  assert.ok(routeGlue.includes('Write-FxLog'), 'the glue logs through the redacting writer');
});

test('F45-S4-2 the route table is exactly the S3 client contract', () => {
  const table = [];
  const block = region.match(/\$script:FxRouteTable = @\(([\s\S]*?)\n\)/);
  assert.ok(block, 'the route table is declared');
  for (const row of block[1].matchAll(/\{([^}]*)\}/g)) {
    const method = row[1].match(/method = '([A-Z]+)'/);
    const path = row[1].match(/path = '([^']+)'/);
    const csrf = row[1].match(/csrf = (\$true|\$false)/);
    assert.ok(method && path && csrf, `unparsable route row: ${row[1]}`);
    table.push({ method: method[1], path: path[1], csrf: csrf[1] === '$true' });
  }
  const clientPaths = [...api.matchAll(/^\s+(\w+): '(\/api\/fx[^']*)'/gm)].map((m) => m[2]);
  assert.ok(clientPaths.length >= 6, 'the S3 client declares its paths');
  const serverPaths = table.map((r) => r.path);
  for (const path of serverPaths) {
    assert.ok(clientPaths.includes(path), `the server route ${path} is not a client path`);
  }
  // /upload/events is S8 (SSE); it must NOT be routable yet.
  assert.ok(!serverPaths.includes('/api/fx/upload/events'), 'SSE events land with S8, not S4');
  assert.deepEqual(serverPaths.sort(), ['/api/fx/gofile/status', '/api/fx/list', '/api/fx/meta', '/api/fx/op', '/api/fx/preview', '/api/fx/upload']);
  assert.deepEqual(table.filter((r) => r.method === 'POST').map((r) => r.path).sort(), ['/api/fx/op', '/api/fx/upload']);
  assert.deepEqual(table.filter((r) => r.csrf).map((r) => r.path).sort(), ['/api/fx/op', '/api/fx/upload']);
  // op vocabulary parity with the client
  const ops = psArrayLiteral('FxOps');
  const clientOps = api.match(/export const FX_OPS = \[([^\]]*)\]/)[1].match(/'([^']+)'/g).map((s) => s.replace(/'/g, ''));
  assert.deepEqual(ops, clientOps, 'the op vocabulary must match endpoints.ts');
  // the router must actually dispatch every declared route
  for (const path of serverPaths) {
    assert.ok(region.includes(`'${path}'`), `the router does not name ${path}`);
  }
});

test('F45-S4-3 status codes and the F44 phase envelope are complete', () => {
  const wanted = [200, 202, 204, 206, 400, 401, 403, 404, 405, 413, 415, 416, 500, 502, 504];
  const statusFn = psFunction('Get-FxStatusText');
  for (const code of wanted) {
    assert.ok(new RegExp(`-eq ${code}\\b`).test(statusFn), `Get-FxStatusText lacks ${code}`);
  }
  for (const code of [401, 403, 413, 415, 500, 502, 504]) {
    assert.ok(new RegExp(`Code ${code}\\b`).test(region) || new RegExp(`code = ${code}\\b`).test(region), `no route produces ${code}`);
  }
  const envelope = psFunction('New-FxErrorResponse');
  for (const field of ['ok', 'phase', 'error']) {
    assert.ok(envelope.includes(field), `the error envelope lacks ${field}`);
  }
  // every phase the envelope can carry must be a real UploadPhase
  const phases = psArrayLiteral('FxUploadPhases');
  for (const phase of ['auth', 'parse', 'size', 'type', 'http', 'dns', 'tcp']) {
    assert.ok(phases.includes(phase), `phase vocabulary missing ${phase}`);
  }
  const failFast = psArrayLiteral('FxFailFastStatus').map(Number);
  const clientFailFast = errors.match(/FAIL_FAST_HTTP: readonly number\[\] = \[([^\]]*)\]/)[1].match(/\d+/g).map(Number);
  assert.deepEqual(failFast, clientFailFast, 'the fail-fast statuses must match errors.ts');
});

test('F45-S4-4 every index write is atomic and emits schema v2 + gofileHosts', () => {
  const save = psFunction('Save-FxJsonAtomic');
  assert.ok(save.includes('.tmp'), 'the atomic writer uses a temp file');
  assert.ok(/File\]::Move|File\]::Replace/.test(save), 'the atomic writer renames rather than rewrites');
  const tmpAt = save.indexOf('.tmp');
  const moveAt = save.indexOf('File]::Move') >= 0 ? save.indexOf('File]::Move') : save.indexOf('File]::Replace');
  assert.ok(tmpAt > 0 && moveAt > tmpAt, 'the temp file is created before the rename');
  const set = psFunction('Set-FxIndexDoc');
  assert.ok(set.includes("'schemaVersion' -Value $script:FxSchemaVersion"), 'every index write stamps schemaVersion 2');
  assert.ok(set.includes("'gofileHosts'"), 'every index write carries the gofileHosts array');
  assert.ok(set.includes('Save-FxJsonAtomic'), 'the index write is atomic');
  // the F44 mirror index is read-only for Explorer
  assert.ok(region.includes("Join-Path $script:FxRoot 'mirror-index.json'"), 'the F44 mirror index is the read source');
  assert.ok(!region.includes("'mirror-index.json' -Object"), 'the mirror index is never written');
  const init = psFunction('Initialize-FxIndex');
  assert.ok(init.includes('Set-FxIndexDoc'), 'startup re-emits the index in v2 form');
  const version = region.match(/\$script:FxSchemaVersion = (\d+)/);
  const clientVersion = schema.match(/INDEX_SCHEMA_VERSION = (\d+)/);
  assert.equal(version[1], clientVersion[1], 'the server schema version must match the client constant');
});

test('F45-S4-5 logs are redacted and no credential can be echoed', () => {
  const logFn = psFunction('Write-FxLog');
  assert.ok(logFn.includes('Protect-FxText'), 'Write-FxLog must redact before it writes');
  const redactFn = psFunction('Protect-FxText');
  assert.ok(redactFn.includes('$script:FxRedacted'), 'the redaction marker is used');
  assert.ok(redactFn.includes('$script:FxGofileToken'), 'the configured host token is always redacted');
  assert.ok(/\$\$1|'\$1'|\$1/.test(redactFn), 'credential-shaped name=value pairs are redacted by pattern');
  assert.ok(region.includes("$script:FxRedacted = '***REDACTED***'"), 'the marker is ***REDACTED***');
  // no host-level logging primitive inside the region except the one writer
  assert.equal((region.match(/Write-Host/g) || []).length, 0, 'the region must not print to the console');
  const appends = region.match(/AppendAllText|Add-Content/g) || [];
  assert.equal(appends.length, 1, 'exactly one append site (Write-FxLog) exists in the region');
  // no token literal can be pasted into a surface
  const tokenLiterals = [...region.matchAll(/go_[A-Za-z0-9_-]{16,}/g)].map((m) => m[0]);
  assert.deepEqual(tokenLiterals, [], 'a gofile-shaped literal was pasted into the server');
  // redaction is applied to every failure string the region persists or returns
  for (const fn of ['Save-FxJsonAtomic', 'Read-FxJson', 'Invoke-FxHttpRequest', 'Initialize-FxServer']) {
    assert.ok(psFunction(fn).includes('Protect-FxText') || psFunction(fn).includes('Write-FxLog'), `${fn} must redact its error text`);
  }
  // the gofile poller passes the token as an explicit secret, and the router
  // redacts the message again before it becomes a response body
  const poller = psFunction('Get-FxGofileStatusResponse');
  assert.ok(poller.includes('Protect-FxText'), 'the host poller redacts host text with the request token');
  assert.ok(region.includes('-Error (Protect-FxText ([string]$st.message))'), 'the status route redacts the host message');
  assert.ok(poller.includes("never log the request URL"), 'the tokenised URL is deliberately not logged');
  // the preview log line must never carry the request URL of a tokenised call
  assert.ok(!/Write-FxLog[^\n]*\$url/i.test(region), 'a tokenised request URL must never be logged');
  assert.ok(region.includes('never log the request URL'), 'the deliberate non-log is documented');
});

test('F45-S4-6 Range support: 206, Content-Range and bytes */total', () => {
  const range = psFunction('Get-FxContentRange');
  assert.ok(range.includes('bytes='), 'the Range header is parsed');
  assert.ok(range.includes('unsatisfiable'), 'an unsatisfiable range is reported');
  assert.ok(range.includes("'bytes */'"), 'the 416 header is emitted');
  assert.ok(/\$out\.header = 'bytes ' \+\s*\$start/.test(psFunction('Get-FxContentRange')) || range.includes("'bytes ' + $start"), 'Content-Range is built from the resolved window');
  const preview = psFunction('Get-FxPreviewResponse');
  assert.ok(preview.includes('206'), 'a partial response is 206');
  assert.ok(preview.includes('Content-Range'), 'the partial response carries Content-Range');
  assert.ok(preview.includes('Accept-Ranges: bytes'), 'the response advertises Accept-Ranges');
  assert.ok(preview.includes('416'), 'an unsatisfiable range is 416');
  assert.ok(preview.includes('413'), 'an oversized file is 413');
  assert.ok(preview.includes('415'), 'a refused type is 415');
  assert.ok(preview.includes('504') && preview.includes('502'), 'host failures are 502/504');
  const send = psFunction('Send-FxResponse');
  assert.ok(send.includes('65536') || send.includes('New-Object byte[] 65536'), 'the body is streamed in chunks');
  assert.ok(send.includes('Content-Length'), 'Content-Length is always set');
  assert.ok(send.includes('Length'), 'the streamed length is bounded');
  // the MIME allowlist and the S2 fixture must be the same set
  const allow = psArrayLiteral('FxPreviewMimeAllow');
  const fixture = mimeMap.map((e) => e.mime);
  assert.deepEqual([...allow].sort(), [...fixture].sort(), 'the server MIME allowlist must equal preview-mime-map.json');
});

test('F45-S4-7 the sandbox shell carries the mandated isolation headers', () => {
  const sandbox = psFunction('Get-FxSandboxResponse');
  assert.ok(sandbox.includes('Origin-Agent-Cluster: ?1'), 'Origin-Agent-Cluster is required');
  assert.ok(sandbox.includes('Cross-Origin-Resource-Policy: same-site'), 'CORP same-site is required');
  assert.ok(sandbox.includes('SameSite=Strict'), 'the sandbox cookie is SameSite=Strict');
  assert.ok(sandbox.includes('Path=/preview-sandbox'), 'the sandbox cookie is path-scoped');
  assert.ok(sandbox.includes('HttpOnly'), 'the sandbox cookie is HttpOnly');
  assert.ok(sandbox.includes("sandbox allow-scripts"), 'the CSP carries the sandbox directive');
  assert.ok(sandbox.includes("default-src 'none'"), 'the CSP denies by default');
  assert.ok(sandbox.includes("connect-src 'none'"), 'the sandbox cannot call out');
  assert.ok(sandbox.includes("frame-ancestors 'self'"), 'the sandbox cannot be framed cross-site');
  assert.ok(sandbox.includes("script-src 'nonce-"), 'scripts are nonce-pinned');
  assert.ok(sandbox.includes("style-src 'nonce-"), 'styles are nonce-pinned too');
  assert.ok(sandbox.includes('text/html; charset=utf-8'), 'the shell is served as explicit HTML');
  const shell = psFunction('Get-FxSandboxShell');
  assert.ok(shell.includes('<!DOCTYPE html>'), 'the shell has an explicit doctype');
  assert.ok(shell.includes('<meta charset="utf-8">'), 'the shell declares its charset');
  assert.ok(!/<script(?![^>]*nonce=)/.test(shell), 'every script tag in the shell must carry the nonce');
});

test('F45-S4-8 the upload queue persists to %TEMP%\\ghrdp and the worker is bounded', () => {
  assert.ok(region.includes("'ghrdp'"), 'the queue directory is ghrdp');
  assert.ok(region.includes("'fx-upload-queue.json'"), 'the queue file name is fx-upload-queue.json');
  assert.ok(region.includes('[System.IO.Path]::GetTempPath()'), 'the queue lives under %TEMP%');
  const add = psFunction('Add-FxUploadJobs');
  assert.ok(add.includes('Save-FxJsonAtomic'), 'queuing is an atomic write');
  assert.ok(add.includes('202'), 'queuing answers 202');
  assert.ok(add.includes('uploadJobId'), 'each job carries an uploadJobId');
  const worker = psFunction('Step-FxUploadQueue');
  assert.ok(worker.includes('Test-FxPhaseRetryable'), 'the worker applies the retry policy');
  assert.ok(worker.includes('Get-FxJobMaxAttempts'), 'the worker honours the attempt budget');
  assert.ok(worker.includes('Set-FxUploadQueue'), 'every transition is persisted');
  assert.ok(worker.includes('lastError'), 'a terminal failure records the error');
  assert.ok(worker.includes('Get-FxSafeDirectUrl'), 'a stored link is re-validated');
  // the main loop runs the worker on its own tick, in-process
  assert.ok(server.includes('Step-FxUploadQueue'), 'the shipped server runs the worker');
  assert.ok(/\$script:FxIntervalSec/.test(server), 'the worker tick interval is declared');
  const loopAt = server.indexOf('$lastFxTick');
  assert.ok(loopAt > 0, 'the worker tick is seeded at startup');
});

test('F45-S4-9 the windows lane and the ubuntu gates actually run these tests', () => {
  assert.ok(sandboxTest.includes('# [F45 S4 fx-core-begin]'), 'the lane extracts the core by marker');
  assert.ok(sandboxTest.includes('Invoke-ClientRequest'), 'the lane drives the shipped handler');
  assert.ok(sandboxTest.includes('X-Dash-Token'), 'the lane exercises header authentication');
  assert.ok(sandboxTest.includes('Range'), 'the lane exercises Range requests');
  assert.ok(sandboxTest.includes('202'), 'the lane exercises the upload acceptance path');
  assert.ok(sandboxTest.includes('500'), 'the lane exercises the parse-failure path');
  assert.ok(/run: \.\/tests\/f45-s4-fx-server\.ps1/.test(gates), 'launch-gates runs the server lane');
  // the windows-native job is halt-on-error: the Explorer lane must be last
  const windowsJob = gates.slice(gates.indexOf('windows-native:'));
  const fxStep = windowsJob.indexOf('f45-s4-fx-server.ps1');
  const f27Step = windowsJob.indexOf('./tests/f27-windows.ps1');
  assert.ok(f27Step > 0 && fxStep > f27Step, 'the Explorer lane runs AFTER every existing windows lane');
  const linesAfterFx = windowsJob.slice(fxStep).split('\n').slice(1);
  assert.ok(!linesAfterFx.some((line) => /^\s*- name:/.test(line)), 'the Explorer lane is the LAST step of the windows job');
  assert.ok(/node --test tests\/f45-s4-fx-routes\.test\.js/.test(gates), 'launch-gates runs the source contract audit');
  assert.ok(/python3 tests\/ps-balance-audit\.py/.test(gates), 'launch-gates runs the redaction audit');
  assert.ok(fs.existsSync('tests/ps-balance-audit.py'), 'the redaction audit exists');
  assert.ok(fs.readFileSync('tests/ps-balance-audit.py', 'utf8').includes('Explorer server region'), 'the audit covers the Explorer region');
  assert.ok(ledger.includes('## S4'), 'the ledger documents S4');
});

test('F45-S4-10 no workflow dispatch is added by this stage', () => {
  assert.ok(!/gh workflow run|workflow_dispatch: *\n/.test(region), 'the server must not dispatch workflows');
  assert.ok(!region.includes('gh run'), 'the server must not call the GitHub CLI');
  // the fx surface must not add any dispatch input to main.yml
  const main = fs.readFileSync('.github/workflows/main.yml', 'utf8');
  const onBlock = main.slice(main.indexOf('\non:'), main.indexOf('\npermissions:'));
  assert.ok(!/fx/i.test(onBlock), 'no Explorer dispatch input may exist (operator-only dispatch)');
});
