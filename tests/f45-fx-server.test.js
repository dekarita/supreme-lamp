// [F45 S4 §2.1/§2.2] Server-side contract lock for the Explorer file-API routes.
// Zero-dependency (node:test only): this file runs BEFORE `pnpm install` in
// launch-gates (the `node --test tests/*.test.js` step) and pins what the
// PowerShell lane cannot pin by itself:
//   * the module's route table is the documented contract (and the dispatcher is
//     the only place a route is answered),
//   * the preview allowlist is the S2 fixture, value for value, so the two
//     cannot drift across languages,
//   * the redaction funnel is the only log writer, with the ***REDACTED*** marker,
//   * the deployment stages the module NEXT TO the server (the dot-source path),
//   * both CI lanes carry the module, the dynamic test and the mjs auditor,
//   * the dynamic test itself asserts every error path the brief lists.
//
// Run: node --test tests/f45-fx-server.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n?/g, '\n');
const exists = (p) => fs.existsSync(p);

const fx = read('payloads/ghrdp-fx.ps1');
const srv = read('payloads/ghrdp-server.ps1');
const main = read('.github/workflows/main.yml');
const gates = read('.github/workflows/launch-gates.yml');
const psTest = read('tests/f45-fx-server.ps1');
const audit = read('scripts/ps-balance-audit.mjs');
const fixture = JSON.parse(read('src/components/explorer/data/fixtures/preview-mime-map.json'));

const FX_ROUTES = [
  '/api/fx/list',
  '/api/fx/meta',
  '/api/fx/gofile/status',
  '/api/fx/preview',
  '/api/fx/op',
  '/api/fx/upload',
];
const SANDBOX = '/preview-sandbox';

// --- §1 the module exists and is the single implementation --------------------
test('F45-S4-1 the fx module exists and is dot-sourced by the server (never copied)', () => {
  assert.ok(exists('payloads/ghrdp-fx.ps1'), 'payloads/ghrdp-fx.ps1 is missing');
  assert.match(srv, /Join-Path \$Root 'ghrdp-fx\.ps1'/, 'the server must resolve the module next to its Root');
  assert.match(srv, /Join-Path \$PSScriptRoot 'ghrdp-fx\.ps1'/, 'the server must also resolve the module next to itself');
  assert.match(srv, /\. \$fxCand/, 'the module must be dot-sourced, not copied');
  assert.match(srv, /\$script:FxReady = \$true/, 'the load flag is missing');
  assert.ok(srv.includes('Explorer API unavailable'), 'a missing module must be fail-visible');
  assert.match(srv, /-Code 503 -CType 'application\/json; charset=utf-8'/, 'the missing-module answer must be a 503 JSON body');
});

// --- §2 route table -----------------------------------------------------------
test('F45-S4-2 every documented route is dispatched exactly once, in the dispatcher', () => {
  const dispatcher = fx.slice(fx.indexOf('function Invoke-FxRoute {'));
  assert.ok(dispatcher.length > 0, 'the dispatcher is missing');
  for (const route of FX_ROUTES) {
    const hits = dispatcher.split(`'${route}'`).length - 1;
    assert.equal(hits, 1, `${route} must be answered exactly once by the dispatcher (found ${hits})`);
  }
  assert.ok(dispatcher.includes(`'${SANDBOX}'`) || dispatcher.includes("'/preview-sandbox/"), 'the sandbox prefix is not routed');
  // the routes the S4 brief does NOT scope must not silently exist
  assert.ok(!dispatcher.includes("'/api/fx/upload/events'"), 'upload/events belongs to S8, not S4');
});

test('F45-S4-3 the module produces the contract status codes', () => {
  for (const code of [400, 401, 403, 404, 405, 413, 415, 416, 500, 502, 504, 202, 206]) {
    const produced = fx.includes(`-Code ${code}`) || new RegExp(`\\$code = ${code}\\b`).test(fx);
    assert.ok(produced, `status ${code} is never produced by the module`);
  }
  // the server's status-text table knows every code the module can return
  for (const code of [202, 206, 400, 401, 403, 404, 405, 409, 413, 415, 416, 429, 500, 502, 503, 504]) {
    assert.ok(srv.includes(`if ($Code -eq ${code})`), `Send-ClientResponse has no status text for ${code}`);
  }
});

test('F45-S4-4 POSTs validate CSRF and refuse the hard flag', () => {
  const csrfChecks = (fx.match(/if \(-not \(Test-FxCsrf \$Ctx\)\)/g) || []).length;
  assert.ok(csrfChecks >= 2, `both POST routes must validate CSRF (found ${csrfChecks})`);
  assert.match(fx, /function Test-FxCsrf/, 'Test-FxCsrf is missing');
  assert.match(fx, /X-CSRF-Token/, 'the CSRF header name is missing');
  assert.match(fx, /Test-FxHasProp \$body 'hard'/, 'the hard flag is not detected');
  assert.ok(fx.includes('hard delete is not an Explorer operation'), 'the hard-op refusal text is missing');
  for (const op of ['trash', 'restore', 'move', 'tag', 'pin']) {
    assert.ok(fx.includes(`'${op}'`), `op ${op} is not implemented`);
  }
});

test('F45-S4-5 index writes are atomic and stamped schemaVersion 2 with gofileHosts', () => {
  assert.match(fx, /function Save-FxJsonAtomic/, 'the atomic writer is missing');
  assert.ok(fx.includes('fx-write-'), 'the atomic writer must use a temp file in the same directory');
  assert.ok(fx.includes('[System.IO.File]::Replace') && fx.includes('[System.IO.File]::Move'), 'temp file + rename is required');
  assert.ok(fx.includes('$script:FxSchemaVersion = 2'), 'schemaVersion must be pinned to 2');
  assert.match(fx, /gofileHosts = \(New-FxGofileHosts/, 'every index emission must carry gofileHosts');
  assert.match(fx, /function ConvertTo-FxIndexV2/, 'the v1 migration must live server-side');
  assert.match(fx, /Get-FxStableId/, 'the stable-id function is missing');
  assert.ok(fx.includes("SHA1") || fx.includes('Security.Cryptography.SHA1'), 'the id must be SHA-1(root+path)');
});

test('F45-S4-6 the preview allowlist equals the S2 MIME fixture, value for value', () => {
  const start = fx.indexOf('$script:FxPreviewMime = @(');
  assert.ok(start > 0, 'the preview allowlist is missing');
  const end = fx.indexOf(')', start);
  const values = fx.slice(start, end).match(/'([^']*)'/g).map((v) => v.slice(1, -1));
  const expected = fixture.map((entry) => entry.mime);
  assert.equal(values.length, 41, `the allowlist must hold 41 values (found ${values.length})`);
  assert.equal(new Set(values).size, 41, 'the allowlist must not repeat a value');
  for (const mime of expected) assert.ok(values.includes(mime), `the allowlist is missing ${mime}`);
  for (const mime of values) assert.ok(expected.includes(mime), `the allowlist has a non-fixture value ${mime}`);
  // every renderer the fixture knows is reachable from the server-side shell
  for (const renderer of new Set(fixture.map((entry) => entry.renderer))) {
    assert.ok(fx.includes(`'${renderer}'`), `no server-side shell branch mentions the ${renderer} renderer`);
  }
});

// --- §3 redaction -------------------------------------------------------------
test('F45-S4-7 redaction is ONE funnel with the plan marker and no console writer', () => {
  assert.ok(fx.includes("$script:FxRedacted = '***REDACTED***'"), 'the marker must be exactly ***REDACTED***');
  assert.match(fx, /function Protect-FxText/, 'Protect-FxText is missing');
  assert.match(fx, /Protect-FxText -Text \$Message -Secrets \$secrets/, 'Write-FxAudit must redact before it writes');
  assert.match(fx, /function Write-FxAudit/, 'the audit writer is missing');
  assert.ok(!fx.includes('Write-Host'), 'the module must not write to the console outside the funnel');
  assert.ok(!/\bInvoke-WebRequest\b/.test(fx), 'the module must use its injectable HTTP seam');
  assert.match(fx, /Bearer\s*\+ \$script:FxRedacted|Bearer ' \+ \$script:FxRedacted/, 'a Bearer token pattern must be redacted');
  // no credential in a URL: the S3 client refuses to build one, the server refuses to accept one
  assert.match(fx, /Test-FxQueryCredential/, 'query-string credentials must be refused');
  for (const needle of ['[uri]::TryCreate', 'if ($uri.UserInfo) { return $null }', 'if ($uri.Query) { return $null }', 'if ($uri.Fragment) { return $null }']) {
    assert.ok(fx.includes(needle), `Get-FxSafeDirectUrl is missing ${needle}`);
  }
  // the token is never echoed by the server wrapper either
  assert.match(srv, /Protect-FxText -Text \$fxErr -Secrets @\(\[string\]\$Token\)/, 'a thrown fx error must be redacted before it is returned');
});

test('F45-S4-8 the CSRF cookie is SameSite=Strict and the sandbox carries the isolation headers', () => {
  assert.match(fx, /@\('Set-Cookie: ghrdp_fx_csrf=' \+ \$tok \+ '; Path=\/; SameSite=Strict'\)/, 'the CSRF cookie line is missing');
  for (const header of [
    "Content-Security-Policy: default-src ''none''",
    'X-Content-Type-Options: nosniff',
    'Referrer-Policy: no-referrer',
    'Origin-Agent-Cluster: ?1',
    'Cross-Origin-Resource-Policy: same-site',
    'Cross-Origin-Opener-Policy: same-origin',
    'X-Frame-Options: SAMEORIGIN',
  ]) {
    assert.ok(fx.includes(header), `the sandbox shell is missing '${header}'`);
  }
  assert.ok(fx.includes("script-src ''none''"), 'the sandbox shell must not allow scripts');
});

test('F45-S4-9 the upload queue is %TEMP%\\ghrdp and the worker is a singleton', () => {
  assert.match(fx, /GetTempPath/, 'the queue path must come from the temp directory');
  assert.match(fx, /fx-upload-queue\.json/, 'the queue file name is missing');
  assert.match(fx, /function Invoke-FxUploadStep/, 'the state machine is missing');
  assert.match(fx, /fx-upload-worker\.pid/, 'the worker must be a singleton per Root');
  for (const phase of ['dns', 'tcp', 'tls', 'encrypt', 'size', 'type', 'auth', 'http', 'parse']) {
    assert.ok(fx.includes(`'${phase}'`), `the upload phase ${phase} is not modelled`);
  }
  assert.match(srv, /Start-FxUploadWorker/, 'the server never starts the queue worker');
});

// --- §4 CI wiring -------------------------------------------------------------
test('F45-S4-10 the deployment stages the module next to the server', () => {
  assert.match(main, /cp "\$GITHUB_WORKSPACE\/payloads\/ghrdp-fx\.ps1" "\$RUNNER_TEMP\/ghrdp-stage\/ghrdp-fx\.ps1"/, 'main.yml must stage the module');
  assert.match(main, /\[fx\] ghrdp-fx\.ps1 written/, 'the staging step must log the module');
  assert.ok(main.indexOf('payloads/ghrdp-fx.ps1') > 0, 'main.yml does not mention the module');
});

test('F45-S4-11 both lanes carry the module, the dynamic test and the auditor', () => {
  assert.ok(gates.includes("'payloads/ghrdp-fx.ps1'"), 'windows-native must parse the module');
  assert.ok(gates.includes('tests/f45-fx-server.ps1'), 'no lane runs the server test');
  assert.ok(/name: F45 S4/.test(gates), 'the F45 lane step is missing');
  assert.ok(gates.includes('node scripts/ps-balance-audit.mjs'), 'the gates lane must run the mjs auditor');
  assert.ok(gates.includes('node scripts/ps-balance-audit.mjs') && gates.includes('F45 gates PASS'), 'the F45 gates step is missing');
  assert.ok(exists('scripts/ps-balance-audit.mjs'), 'the mjs auditor is missing');
  assert.ok(!/f45-fx-server\.ps1[^\n]*\n[^\n]*workflow_dispatch/.test(gates), 'no F45 gate may dispatch a workflow');
});

test('F45-S4-12 the dynamic test covers every error path the brief lists', () => {
  for (const name of [
    'wrong dash token 401',
    'meta unknown id 404',
    'list corrupt index 500',
    'gofile/status unreachable 502',
    'gofile/status timeout 504',
    'preview 415',
    'preview 413',
    'preview range 206',
    'op without CSRF 403',
    'upload 202',
    'hard flag refused 400',
    'no log line contains the dash token',
  ]) {
    assert.ok(psTest.includes(name), `tests/f45-fx-server.ps1 does not assert '${name}'`);
  }
  assert.ok(psTest.includes('Invoke-FxRoute -Ctx'), 'the dynamic test must drive the real dispatcher');
  assert.ok(psTest.includes('Start-Process') && psTest.includes('ghrdp-server.ps1'), 'the integration half must start the REAL server');
  assert.ok(psTest.includes('Set-Cookie') || psTest.includes('set-cookie'), 'the integration half must assert the CSRF cookie');
  assert.ok(psTest.includes('System.Net.Sockets.TcpClient'), 'the integration half must speak raw HTTP (Range headers)');
});

// --- §5 the auditor is not vacuous -------------------------------------------
test('F45-S4-13 the mjs auditor catches the failure classes it claims', async () => {
  const { audit } = await import(path.resolve('scripts/ps-balance-audit.mjs').replace(/^/, 'file://'));
  assert.deepEqual(audit('probe', 'function A { if ($x) { return 1 }'), ['{ imbalance +1']);
  assert.deepEqual(audit('probe', 'if ($x) { }'), []);
  assert.ok(audit('probe', "try { foo } catch { }").length === 0, 'a well-formed catch must pass');
  assert.ok(audit('probe', "$x = 1\ncatch { }").includes('dangling-catch @ line 2'), 'a dangling catch must be caught');
  assert.ok(audit('probe', "$s = @'\nunterminated").includes('unterminated-here-string @ line 1'), 'an unterminated here-string must be caught');
  assert.ok(audit('probe', "$s = 'unterminated").some((p) => p.startsWith('unterminated-single-quote')), 'an unterminated quote must be caught');
  assert.ok(audit('probe', '$x = "a`nb"').length === 0, 'a backtick escape must not unbalance anything');
});

test('F45-S4-14 no typed parameter defaults to an incompatible literal', () => {
  // A [hashtable] parameter whose default is @() throws
  // ParameterBindingArgumentTransformationException on every call that omits
  // the argument, turning error routes into 500s (found by CI, fixed once).
  const psFiles = ['payloads/ghrdp-fx.ps1', 'tests/f45-fx-server.ps1', 'payloads/ghrdp-server.ps1'];
  for (const f of psFiles) {
    const text = read(f);
    for (const line of text.split('\n')) {
      assert.ok(
        !/\[hashtable\]\s*\$\w+\s*=\s*@\(\)/.test(line),
        `${f}: a [hashtable] parameter defaults to @() -> ${line.trim()}`
      );
      assert.ok(
        !/\[string\[\]\]\s*\$\w+\s*=\s*@\{\}/.test(line),
        `${f}: a [string[]] parameter defaults to @{} -> ${line.trim()}`
      );
    }
  }
});

test('F45-S4-15 the auditor audits the new surfaces and pins the contract', () => {
  assert.match(audit, /'payloads\/ghrdp-fx\.ps1'/, 'the module is not in the audit target list');
  assert.match(audit, /'tests\/f45-fx-server\.ps1'/, 'the dynamic test is not structurally audited');
  for (const needle of [
    'the dispatcher answers',
    'both POST routes must validate CSRF',
    'hard delete is not an Explorer operation',
    'atomic write lacks',
    'preview allowlist',
    'the redaction marker is not',
    'an audit call site can echo a credential',
    'the upload queue path is not',
    'the fx module is not dot-sourced',
    'is not staged next to the server',
  ]) {
    assert.ok(audit.includes(needle), `the auditor does not check '${needle}'`);
  }
});
