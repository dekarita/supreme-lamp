// [F81 §4.2 + §1.2 + §3.1 + §3.2 + §5.0] Server-pinning for the F81 routes
// and the persistence/delete/launch-url/preview/sitemap/max-sites blocks.
// Same shape as tests/f78-lab-server.test.js: assert that the shipped
// payloads/ghrdp-server.ps1 contains the F81 contract VERBATIM, so a drift
// (a dropped fence, a removed constant-time compare, a widened scheme,
// a max-sites check, a sitemap fetch path) fails here at CI time, never at
// dispatch time.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const SERVER = fs.readFileSync('payloads/ghrdp-server.ps1', 'utf8').replace(/\r\n?/g, '\n');

function f81block() {
  // The F81 block sits inside the F78 /api/f58/sources /api/lab/inspect
  // block; it is the DELETE route + the launch-url route + the preview
  // route + the sitemap-first branch + the encrypted-store helpers. The
  // sitemap code is in /api/lab/inspect, which is AFTER the helpers, so
  // we read the whole F78 block (anchored by the F78 route gate) to
  // ensure we also see the sitemap-first branch.
  const start = SERVER.indexOf("if ($path -eq '/api/f58/sources' -or $path -eq '/api/lab/inspect' -or");
  assert.ok(start > 0, 'F78 block missing');
  const end = SERVER.indexOf('# [remediation] C2 / agent-payload / .bat endpoints removed', start);
  assert.ok(end > start, 'F78 block end marker missing');
  return SERVER.slice(start, end);
}

const BLOCK = f81block();

test('F81-A1-PERSIST: encrypted store helpers are present + wired', () => {
  for (const tok of [
    'function Write-F81LabStore',
    'function Read-F81LabStore',
    "F81StorePath",
    "Write-F81LabStore -Map $script:F78Sources",
    'F81-Lab-Store-v1',
  ]) {
    assert.ok(BLOCK.includes(tok), 'missing: ' + tok);
  }
});

test('F81-A1-HYDRATE: startup hydration reads the store file', () => {
  assert.ok(
    BLOCK.includes("if ($script:F81StorePath -and (Test-Path -LiteralPath $script:F81StorePath))"),
    'hydration gate missing'
  );
  assert.ok(BLOCK.includes('$f81Hydrated = Read-F81LabStore'), 'hydration call missing');
});

test('F81-A2-DELETE: DELETE /api/f58/sources/<id> is wired + 404s on unknown id', () => {
  for (const tok of [
    "$path -like '/api/f58/sources/*' -and $parts.method -eq 'DELETE'",
    '$f78DelId.Contains',
    '$script:F78Sources.Remove($f78DelId)',
    "$script:F78AllowHosts.Remove($f78DelHost)",
    "404 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes (New-F78Error -Code 'NOT_FOUND' -MessageKey 'lab.notFound' -RetryAfter 0))",
    'f78 delete site id=',
  ]) {
    assert.ok(BLOCK.includes(tok), 'missing: ' + tok);
  }
});

test('F81-D2-LAUNCH-URL: HTTPS-only + userinfo refused + scheduled task', () => {
  for (const tok of [
    "$path -eq '/api/launch-url' -and $parts.method -eq 'POST'",
    "if (-not $f81Url.StartsWith('https://'))",
    '$f81Uri.UserInfo',
    "New-ScheduledTaskPrincipal -UserId $f81ActiveUser -LogonType Interactive -RunLevel Highest",
    "Register-ScheduledTask -TaskName $f81TaskName",
    'Unregister-ScheduledTask -TaskName $f81TaskName',
    'f81 launch-url',
  ]) {
    assert.ok(BLOCK.includes(tok), 'missing: ' + tok);
  }
});

test('F81-D2-LIMIT: launch-url is rate-limited (20/min/X-Dash-Token)', () => {
  assert.ok(BLOCK.includes('$f81Hits.Count -ge 20'), 'rate-limit threshold missing');
  assert.ok(BLOCK.includes('$script:F81LaunchRate'), 'rate-limit map missing');
});

test('F81-C2-PREVIEW: POST /api/preview is wired + bounded maxBytes', () => {
  for (const tok of [
    "$path -eq '/api/preview' -and $parts.method -eq 'POST'",
    '$f81PrevBytes',
    'Invoke-F78SecureFetch -Url $f81PrevUrl -ExpectedHost',
    'f81 preview host=',
  ]) {
    assert.ok(BLOCK.includes(tok), 'missing: ' + tok);
  }
});

test('F81-C1-SITEMAP: sitemap-first branch + homepage fallback + 500 link cap', () => {
  for (const tok of [
    "Invoke-F78SecureFetch -Url ($f78Src.baseUrl.TrimEnd('/') + '/sitemap.xml')",
    "'sitemap-ok'",
    "'homepage-fallback'",
    '<loc>',
    '</loc>',
    "if ($f78LinksOut.Count -ge 500) { break }",
    'source = $f78SourceLabel',
    'sourceUrls = $f78SourceUrls',
    'adapterStatus = [ordered]@{ phase = $f78Phase; sourceLabel = $f78SourceLabel }',
  ]) {
    assert.ok(BLOCK.includes(tok), 'missing: ' + tok);
  }
});

test('F81-E1-CAP: POST /api/f58/sources enforces 50-site cap before persist', () => {
  assert.ok(BLOCK.includes('$f78Cap = 50'), 'cap constant missing');
  assert.ok(BLOCK.includes("Code 'MAX_SITES'") || BLOCK.includes("'MAX_SITES'"), 'MAX_SITES code missing');
  assert.ok(BLOCK.includes('if ($f78LabCount -ge $f78Cap)'), 'cap gate missing');
});

test('F81-E1-FIELD-ERRORS: POST /api/f58/sources returns errors{name,url} envelope', () => {
  for (const tok of [
    '$f78FieldErrors',
    '$f78FieldErrors[\'name\']',
    '$f78FieldErrors[\'url\']',
    'errors = $f78FieldErrors',
  ]) {
    assert.ok(BLOCK.includes(tok), 'missing: ' + tok);
  }
});

test('F81-PRESERVED-F78: the F78 fences survive untouched', () => {
  for (const tok of [
    // [F99 §2.5 / B5] rewritten in place: the F78 fence is now the shared
    // rotation-aware validator call, and Test-TicketBearer lives inside it.
    "$f78TokenOk = Test-GhrdpDashToken -Presented $f78Presented",
    "function Test-GhrdpDashToken",
    "foreach ($f78Qk in @('key','token','dash-token','dash_token','dashtoken','access-token','access_token','password'))",
    "Invoke-F78SecureFetch -Url ([string]$f78Src.baseUrl)",
    // [F84 §2.2] the strict href fence was replaced by the www-tolerant
    // Test-F78SameHost compare; the cross-domain refusal is asserted by
    // tests/f84-same-host.test.js (openculture.com vs youtube.com stays false).
    'Test-F78SameHost -Allowed $f78Host -Actual $f78LinkHost',
    "$f78Hits.Count -ge 10",
  ]) {
    assert.ok(SERVER.includes(tok), 'F78 fence regressed: ' + tok);
  }
});