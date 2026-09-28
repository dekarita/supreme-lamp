#!/usr/bin/env node
/**
 * [F45 S4] ps-balance-audit.mjs - the Node twin of tests/ps-balance-audit.py,
 * extended with the Explorer file-API route contract.
 *
 * Why a second auditor exists at all: the agent environment has no PowerShell
 * interpreter, and the py audit predates payloads/ghrdp-fx.ps1. This script
 * tokenizes every PowerShell surface the F45 work touches (the fx module, the
 * server that dot-sources it, and every pwsh/powershell block in the three
 * workflows) exactly the way the py audit does - strings, here-strings, comments
 * and backtick escapes removed - and fails closed on an unbalanced brace/paren,
 * an unterminated quote/here-string, or a `catch`/`else` that does not follow a
 * closed block (the shape a mis-nested try/foreach produces).
 *
 * On top of the structural pass it asserts the F45 S4 CONTRACT against the
 * shipped sources:
 *   * every documented fx route is dispatched exactly once,
 *   * POST routes validate CSRF and refuse the `hard` flag,
 *   * index writes are atomic and stamped schemaVersion 2 with gofileHosts,
 *   * the preview allowlist is the 41-case S2 fixture, value for value,
 *   * credential redaction is the SINGLE funnel for every log line, with the
 *     ***REDACTED*** marker, and no log line can echo a token,
 *   * the deployment (main.yml) and the CI lane (launch-gates.yml) carry the
 *     module, the node contract test and this audit.
 *
 * Run: node scripts/ps-balance-audit.mjs
 */
import { existsSync, readFileSync } from 'node:fs';

const repo = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const read = (rel) => readFileSync(`${repo}/${rel}`, 'utf8');
const lf = (s) => s.replace(/\r\n?/g, '\n');

// ---------------------------------------------------------------------------
// §1 structural tokenizer (faithful port of tests/ps-balance-audit.py)
// ---------------------------------------------------------------------------
export function tokenize(text) {
  const depth = { '{': 0, '(': 0, '[': 0 };
  const pairs = { '}': '{', ')': '(', ']': '[' };
  const events = [];
  let i = 0;
  let line = 1;
  const n = text.length;
  let lastSig = '';
  while (i < n) {
    const c = text[i];
    if (c === '\n') { line += 1; i += 1; continue; }
    if (c === '@' && i + 1 < n && (text[i + 1] === '"' || text[i + 1] === "'") && (i + 2 >= n || text[i + 2] === '\n')) {
      const quote = text[i + 1];
      const end = text.indexOf(`\n${quote}@`, i);
      if (end < 0) { events.push(['unterminated-here-string', line]); break; }
      line += (text.slice(i, end + quote.length + 2).match(/\n/g) || []).length;
      i = end + quote.length + 2;
      lastSig = '@';
      continue;
    }
    if (c === "'") {
      let j = i + 1;
      while (j < n) {
        if (text[j] === "'") {
          if (j + 1 < n && text[j + 1] === "'") { j += 2; continue; }
          break;
        }
        if (text[j] === '\n') line += 1;
        j += 1;
      }
      if (j >= n) { events.push(['unterminated-single-quote', line]); break; }
      i = j + 1;
      lastSig = "'";
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < n) {
        if (text[j] === '`') { j += 2; continue; }
        if (text[j] === '"') break;
        if (text[j] === '\n') line += 1;
        j += 1;
      }
      if (j >= n) { events.push(['unterminated-double-quote', line]); break; }
      i = j + 1;
      lastSig = '"';
      continue;
    }
    if (c === '#') { const j = text.indexOf('\n', i); i = j < 0 ? n : j; continue; }
    if (c === '`') { i += 2; continue; }
    if (c in depth) { depth[c] += 1; events.push(['open' + c, line]); lastSig = c; i += 1; continue; }
    if (c in pairs) {
      depth[pairs[c]] -= 1;
      events.push(['close' + c, line]);
      if (depth[pairs[c]] < 0) events.push(['negative-depth:' + c, line]);
      lastSig = c;
      i += 1;
      continue;
    }
    if (/\s/.test(c)) { i += 1; continue; }
    const m = /^(catch|finally|elseif|else)\b/.exec(text.slice(i));
    if (m) {
      const kw = m[1];
      if ((kw === 'catch' || kw === 'finally') && lastSig !== '}') events.push(['dangling-' + kw, line]);
      if ((kw === 'else' || kw === 'elseif') && lastSig !== '}') events.push(['dangling-' + kw, line]);
      lastSig = kw;
      i += kw.length;
      continue;
    }
    lastSig = c;
    i += 1;
  }
  return { depth, events };
}

export function audit(name, text) {
  const { depth, events } = tokenize(text);
  const problems = [];
  for (const [k, v] of Object.entries(depth)) if (v !== 0) problems.push(`${k} imbalance ${v > 0 ? '+' : ''}${v}`);
  for (const [kind, line] of events) {
    if (kind.startsWith('open') || kind.startsWith('close')) continue;
    problems.push(`${kind} @ line ${line}`);
  }
  return problems;
}

/** Every `shell: pwsh|powershell` run block of a workflow, as [label, text]. */
export function workflowBlocks(relPath) {
  const lines = lf(read(relPath)).split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const m = /^(\s*)-\s+name:\s+(.*)$/.exec(lines[i]);
    if (m) {
      const name = m[2].trim().replace(/^"|"$/g, '');
      let j = i + 1;
      let shell = null;
      let runStart = null;
      let runIndent = 0;
      while (j < lines.length) {
        const cur = lines[j];
        if (cur.trim() && (cur.length - cur.trimStart().length) <= m[1].length && cur.trimStart().startsWith('- ')) break;
        const sm = /^\s*shell:\s*(\S+)/.exec(cur);
        if (sm) shell = sm[1];
        const rm = /^(\s*)run:\s*\|\s*$/.exec(cur);
        if (rm) { runStart = j + 1; runIndent = rm[1].length + 2; break; }
        j += 1;
      }
      if (runStart !== null && (shell === 'pwsh' || shell === 'powershell')) {
        const body = [];
        let k = runStart;
        while (k < lines.length) {
          const cur = lines[k];
          if (cur.trim() && (cur.length - cur.trimStart().length) < runIndent) break;
          body.push(cur.length >= runIndent ? cur.slice(runIndent) : cur.trimStart());
          k += 1;
        }
        out.push([`${relPath.split('/').pop()} :: ${name}`, body.join('\n')]);
        i = k;
        continue;
      }
    }
    i += 1;
  }
  return out;
}

// ---------------------------------------------------------------------------
// §2 F45 S4 contract checks
// ---------------------------------------------------------------------------
const FX_ROUTES = [
  '/api/fx/list',
  '/api/fx/meta',
  '/api/fx/gofile/status',
  '/api/fx/preview',
  '/api/fx/op',
  '/api/fx/upload',
];
const PREVIEW_FIXTURE = 'src/components/explorer/data/fixtures/preview-mime-map.json';

function pslArrayValues(source, name) {
  // Values of a `@( 'a', 'b' )` PowerShell array literal, comments ignored.
  const start = source.indexOf(`$${name} = @(`);
  if (start < 0) return null;
  const end = source.indexOf(')', start);
  if (end < 0) return null;
  return source
    .slice(start, end)
    .split('\n')
    .map((line) => line.replace(/#.*$/, ''))
    .join('\n')
    .match(/'([^']*)'/g)
    ?.map((v) => v.slice(1, -1)) ?? [];
}

function fxContractProblems() {
  const problems = [];
  const fxPath = 'payloads/ghrdp-fx.ps1';
  const srvPath = 'payloads/ghrdp-server.ps1';
  if (!existsSync(`${repo}/${fxPath}`)) return [`${fxPath} is missing`];
  const fx = lf(read(fxPath));
  const srv = lf(read(srvPath));

  // 2.1 the dispatcher answers each documented route exactly once
  const dispatcher = fx.slice(fx.indexOf('function Invoke-FxRoute {'));
  if (!dispatcher) problems.push(`${fxPath}: no dispatcher`);
  for (const route of FX_ROUTES) {
    const hits = (dispatcher.match(new RegExp(`'${route.replace(/[/.]/g, '\\$&')}'`, 'g')) ?? []).length;
    if (hits !== 1) problems.push(`${fxPath}: the dispatcher answers ${route} ${hits} time(s); expected exactly 1`);
  }
  for (const code of ['400', '401', '403', '404', '405', '413', '415', '416', '202', '206', '500', '502', '504']) {
    if (!fx.includes(`-Code ${code}`) && !new RegExp(`\\$code = ${code}\\b`).test(fx)) {
      problems.push(`${fxPath}: status ${code} is never produced`);
    }
  }
  if (!/Test-FxCsrf\s+\$Ctx/.test(fx)) problems.push(`${fxPath}: no route validates the CSRF token`);
  const csrfCalls = (fx.match(/if \(-not \(Test-FxCsrf \$Ctx\)\)/g) ?? []).length;
  if (csrfCalls < 2) problems.push(`${fxPath}: both POST routes must validate CSRF (found ${csrfCalls})`);
  if (!fx.includes('hard delete is not an Explorer operation')) problems.push(`${fxPath}: the hard-op refusal is missing`);
  if (!/Test-FxHasProp \$body 'hard'/.test(fx)) problems.push(`${fxPath}: the hard-op refusal does not detect the flag`);

  // 2.2 atomic write + schema v2 + gofileHosts
  if (!/function Save-FxJsonAtomic/.test(fx)) problems.push(`${fxPath}: no atomic index writer`);
  for (const token of ['[System.IO.File]::Replace', '[System.IO.File]::Move', 'fx-write-']) {
    if (!fx.includes(token)) problems.push(`${fxPath}: atomic write lacks ${token}`);
  }
  if (!fx.includes('$script:FxSchemaVersion = 2')) problems.push(`${fxPath}: schemaVersion is not pinned to 2`);
  if (!/gofileHosts = \(New-FxGofileHosts/.test(fx)) problems.push(`${fxPath}: index emission has no gofileHosts array`);

  // 2.3 the preview allowlist is exactly the S2 fixture
  const psList = pslArrayValues(fx, 'script:FxPreviewMime');
  const fixture = JSON.parse(read(PREVIEW_FIXTURE)).map((e) => e.mime);
  if (!psList) problems.push(`${fxPath}: the preview MIME array could not be read`);
  else {
    const missing = fixture.filter((m) => !psList.includes(m));
    const extra = psList.filter((m) => !fixture.includes(m));
    if (missing.length) problems.push(`${fxPath}: preview allowlist is missing ${missing.join(', ')}`);
    if (extra.length) problems.push(`${fxPath}: preview allowlist has non-fixture values ${extra.join(', ')}`);
    if (psList.length !== 41 || new Set(psList).size !== 41) problems.push(`${fxPath}: preview allowlist must be 41 unique values (found ${psList.length}/${new Set(psList).size})`);
  }

  // 2.4 redaction: ONE funnel, ***REDACTED***, no token in any log call
  if (!fx.includes("$script:FxRedacted = '***REDACTED***'")) problems.push(`${fxPath}: the redaction marker is not ***REDACTED***`);
  // typed-parameter defaults: [hashtable] $x = @() (and [string[]] $x = @{})
  // throw ParameterBindingArgumentTransformationException on every call that
  // omits the argument, so an error route silently becomes a 500. Found by CI.
  for (const [i, line] of fx.split('\n').entries()) {
    if (/\[hashtable\]\s*\$\w+\s*=\s*@\(\)/.test(line)) problems.push(`${fxPath}:${i + 1}: a [hashtable] parameter defaults to @() (binding throw on every call)`);
    if (/\[string\[\]\]\s*\$\w+\s*=\s*@\{\}/.test(line)) problems.push(`${fxPath}:${i + 1}: a [string[]] parameter defaults to @{} (binding throw on every call)`);
  }
  const srvText = read('payloads/ghrdp-server.ps1');
  for (const [i, line] of srvText.split('\n').entries()) {
    if (/\[hashtable\]\s*\$\w+\s*=\s*@\(\)/.test(line)) problems.push(`payloads/ghrdp-server.ps1:${i + 1}: a [hashtable] parameter defaults to @() (binding throw on every call)`);
  }
  if (!/Protect-FxText -Text \$Message -Secrets \$secrets/.test(fx)) problems.push(`${fxPath}: Write-FxAudit does not redact before writing`);
  if (!/function Protect-FxText/.test(fx)) problems.push(`${fxPath}: Protect-FxText is missing`);
  const auditCalls = fx.split('\n').filter((l) => /Write-FxAudit/.test(l) && !/^function /.test(l.trim()));
  for (const call of auditCalls) {
    if (/\$(presented|tok|token|hdrs|headers|csrf)\b/i.test(call)) {
      problems.push(`${fxPath}: an audit call site can echo a credential: ${call.trim().slice(0, 90)}`);
    }
  }
  if (!/@\('Set-Cookie: ghrdp_fx_csrf=' \+ \$tok/.test(fx)) problems.push(`${fxPath}: the CSRF cookie line is missing`);
  if (!/SameSite=Strict/.test(fx)) problems.push(`${fxPath}: the CSRF cookie is not SameSite=Strict`);
  for (const token of ['Origin-Agent-Cluster: ?1', 'Cross-Origin-Resource-Policy: same-site', 'Content-Security-Policy: default-src']) {
    if (!fx.includes(token)) problems.push(`${fxPath}: the sandbox shell lacks '${token}'`);
  }
  if (!fx.includes("/preview-sandbox")) problems.push(`${fxPath}: the preview-sandbox route is missing`);

  // 2.5 the queue lives in %TEMP%\ghrdp (never in the repository)
  if (!/GetTempPath/.test(fx) || !/fx-upload-queue\.json/.test(fx)) problems.push(`${fxPath}: the upload queue path is not %TEMP%\\ghrdp\\fx-upload-queue.json`);
  if (!/function Invoke-FxUploadStep/.test(fx)) problems.push(`${fxPath}: the upload state machine is missing`);

  // 2.6 no credential ever reaches a URL, and the proxy refuses credential URLs
  for (const needle of ['[uri]::TryCreate', 'if ($uri.UserInfo) { return $null }', 'if ($uri.Query) { return $null }', 'if ($uri.Fragment) { return $null }', "$uri.Scheme -ne 'https'"]) {
    if (!fx.includes(needle)) problems.push(`${fxPath}: Get-FxSafeDirectUrl is missing '${needle}'`);
  }
  if (/Invoke-WebRequest/.test(fx)) problems.push(`${fxPath}: the module must use its injectable HTTP seam, not Invoke-WebRequest`);

  // 2.7 server wiring: fail-visible module load + one dispatch block
  for (const token of ['[F45 S4 fx-module-begin]', '[F45 S4 fx-module-end]', '[F45 S4 fx-dispatch-begin]', '[F45 S4 fx-dispatch-end]', '[F45 S4 fx-worker-begin]', '[F45 S4 fx-worker-end]']) {
    if (!srv.includes(token)) problems.push(`${srvPath}: missing marker ${token}`);
  }
  if (!/\. \$fxCand/.test(srv) || !/\$script:FxReady = \$true/.test(srv)) problems.push(`${srvPath}: the fx module is not dot-sourced`);
  if (!/Invoke-FxRoute -Ctx \$fxCtx/.test(srv)) problems.push(`${srvPath}: the dispatch never calls Invoke-FxRoute`);
  if (!/-Code 503 -CType 'application\/json; charset=utf-8'/.test(srv)) problems.push(`${srvPath}: a missing module is not fail-visible (503)`);
  if (!/Protect-FxText -Text \$fxErr -Secrets @\(\[string\]\$Token\)/.test(srv)) problems.push(`${srvPath}: a thrown fx error is not redacted before it is returned`);
  if (!/RandomNumberGenerator/.test(srv) || !/\$script:FxCsrf/.test(srv)) problems.push(`${srvPath}: no per-process CSRF token is minted`);

  // 2.8 deployment + lane wiring
  const main = lf(read('.github/workflows/main.yml'));
  if (!/payloads\/ghrdp-fx\.ps1" "\$RUNNER_TEMP\/ghrdp-stage\/ghrdp-fx\.ps1"/.test(main)) problems.push('main.yml: ghrdp-fx.ps1 is not staged next to the server');
  const gates = lf(read('.github/workflows/launch-gates.yml'));
  if (!gates.includes("'payloads/ghrdp-fx.ps1'")) problems.push('launch-gates.yml: the fx module is not parsed in windows-native');
  if (!gates.includes('tests/f45-fx-server.ps1')) problems.push('launch-gates.yml: the fx server test is not executed');
  if (!gates.includes('node scripts/ps-balance-audit.mjs')) problems.push('launch-gates.yml: this audit is not executed');
  return problems;
}

// ---------------------------------------------------------------------------
// §3 run
// ---------------------------------------------------------------------------
export function runAudit() {
const targets = [
  'payloads/ghrdp-fx.ps1',
  'tests/f45-fx-server.ps1',
  'payloads/rdp-telescope.ps1',
  'payloads/ghrdp-server.ps1',
  'payloads/Grant-RdpKeyAccess.ps1',
  'payloads/Test-RdpListenerHandshake.ps1',
  'payloads/Enable-RdpTlsCertificate.ps1',
  'payloads/ghrdp-lib.ps1',
];

let failed = 0;
for (const t of targets) {
  if (!existsSync(`${repo}/${t}`)) continue;
  const problems = audit(t, read(t));
  console.log((problems.length ? 'FAIL ' : 'PASS ') + t + (problems.length ? ' :: ' + problems.slice(0, 6).join('; ') : ''));
  failed += problems.length ? 1 : 0;
}
for (const wf of ['.github/workflows/autologin-lab.yml', '.github/workflows/main.yml', '.github/workflows/launch-gates.yml']) {
  if (!existsSync(`${repo}/${wf}`)) continue;
  for (const [label, body] of workflowBlocks(wf)) {
    const problems = audit(label, body);
    if (problems.length) {
      console.log('FAIL ' + label + ' :: ' + problems.slice(0, 6).join('; '));
      failed += 1;
    }
  }
}
const fxProblems = fxContractProblems();
console.log((fxProblems.length ? 'FAIL ' : 'PASS ') + 'F45 S4 fx route contract');
for (const p of fxProblems) console.log('  - ' + p);
failed += fxProblems.length ? 1 : 0;
console.log(`ps-balance-audit(mjs): ${failed} surface(s) failed`);
return failed;
}

// Only run when executed directly: importing this module (tests/f45-fx-server.test.js
// exercises the auditor's own failure classes) must never call process.exit.
import { pathToFileURL } from 'node:url';
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(runAudit() ? 1 : 0);
}
