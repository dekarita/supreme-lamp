// [F78 §4.1 / §6] Node lab: the stored-website Lab Mode server surface, measured
// against the SHIPPED source (payloads/ghrdp-server.ps1). The sandbox and the
// linux lane have no PowerShell interpreter, so - exactly like the F70 search
// lab - this file pins the route contract statically and never re-implements a
// rule: every token asserted below exists verbatim in the shipped .ps1, and a
// drift (a dropped host fence, a widened timeout, a cookie, an auth header, an
// unbounded read) fails here.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const SERVER = fs.readFileSync('payloads/ghrdp-server.ps1', 'utf8').replace(/\r\n?/g, '\n');
const UI_CLIENT = fs.readFileSync('src/api/lab/index.ts', 'utf8').replace(/\r\n?/g, '\n');
const EN = JSON.parse(fs.readFileSync('src/i18n/en.json', 'utf8'));
const SI = JSON.parse(fs.readFileSync('src/i18n/si.json', 'utf8'));

function block() {
  // [F88 §B.1] the gate now also admits the routes the block houses (launch-url,
  // diag, selftest, preview, sources/<id> DELETE) - anchor on the stable prefix.
  const start = SERVER.indexOf("if ($path -eq '/api/f58/sources' -or $path -eq '/api/lab/inspect' -or");
  assert.ok(start > 0, 'the F78 route block is missing');
  // The block ends at the remediation marker that follows it.
  const end = SERVER.indexOf('# [remediation] C2 / agent-payload / .bat endpoints removed', start);
  assert.ok(end > start, 'the F78 block end marker is missing');
  return SERVER.slice(start, end);
}
const BLOCK = block();

test('F78-P1-ROUTES: three routes, one block, after the search lane', () => {
  for (const tok of ["$path -eq '/api/f58/sources'", "$path -eq '/api/lab/inspect'", "$parts.method -eq 'GET'", "$parts.method -eq 'POST'"]) {
    assert.ok(BLOCK.includes(tok), 'missing: ' + tok);
  }
  const searchAt = SERVER.indexOf("$path -eq '/api/search' -or $path -eq '/api/search/status'");
  assert.ok(searchAt > 0 && SERVER.indexOf(BLOCK) > searchAt, 'the F78 block must sit after the search lane');
});

test('F78-P2-AUTH: dash token is constant-time and never a query credential', () => {
  assert.ok(BLOCK.includes("$parts.headers['x-dash-token']"), 'the dash token header is not read');
  assert.ok(BLOCK.includes('Test-TicketBearer $f78Recv $f78Exp'), 'the token compare is not the shipped constant-time compare');
  assert.ok(/\(\$f78Recv\.Length -eq \$f78Exp\.Length\)/.test(BLOCK), 'the length guard is missing');
  assert.ok(BLOCK.includes("foreach ($f78Qk in @('key','token','dash-token','dash_token','dashtoken','access-token','access_token','password'))"), 'the query-credential refusal set changed');
  assert.ok(BLOCK.includes('-Code 401'), 'the token gate must answer 401');
});

test('F78-P3-FETCH: https only, default port, no userinfo, exact host, no redirect follow', () => {
  assert.ok(BLOCK.includes("if (-not $f78Uri -or $f78Uri.Scheme -ne 'https' -or $f78Uri.UserInfo)"), 'the https/userinfo fence is missing');
  // [F84 §2.2] The fence is still exact-host, minus a leading www. on either
  // side (Test-F78SameHost); cross-domain is still refused and the
  // no-suffix/no-wildcard property is asserted in tests/f84-same-host.test.js.
  assert.ok(BLOCK.includes('Test-F78SameHost -Allowed $ExpectedHost -Actual $f78Uri.Host'), 'the exact-host fence is missing (suffix matching would be a cross-domain slip)');
  assert.ok(BLOCK.includes('$f78Req.AllowAutoRedirect = $false'), 'redirects must not be auto-followed');
  assert.ok(BLOCK.includes("$f78Req.UserAgent = 'GHRDP-Lab/1.0'"), 'the user agent must be a fixed literal');
  assert.ok(!/Authorization\s*=|\.Headers\[.Authorization.\]/.test(BLOCK), 'the helper must never set an Authorization header');
  assert.ok(!/Referer|Cookie\s*=/i.test(BLOCK), 'the helper must never send a cookie or a referer');
});

test('F78-P4-LIMITS: 10s timeout and a hard 2MB cap (pre-checked and enforced while reading)', () => {
  assert.ok(BLOCK.includes('$f78Req.Timeout = $TimeoutSec * 1000'), 'the request timeout is not derived from $TimeoutSec');
  assert.ok(BLOCK.includes('$f78Req.ReadWriteTimeout = $TimeoutSec * 1000'), 'the read timeout is missing');
  assert.ok(BLOCK.includes('-MaxBytes 2097152 -TimeoutSec 10'), 'the call site must pin 2MB and 10s');
  assert.ok(BLOCK.includes('$f78Len -gt $MaxBytes'), 'the Content-Length pre-check is missing');
  assert.ok(BLOCK.includes('($f78Ms.Length + $f78Read) -gt $MaxBytes'), 'the streaming cap is missing (an oversized body would be buffered)');
  assert.ok(BLOCK.includes("$f78Req.CookieContainer = $null"), 'CookieContainer must be explicitly null');
});

test('F78-P5-RATELIMIT: 10 fetches/minute per sourceId, 429 + retryAfterSeconds', () => {
  assert.ok(BLOCK.includes('$script:F78LabInspectRateLimiter'), 'the per-source limiter is missing');
  assert.ok(BLOCK.includes('if ($f78Hits.Count -ge 10)'), 'the 10/min budget is missing');
  assert.ok(BLOCK.includes('($f78Now - $_).TotalSeconds -lt 60'), 'the 60s window is missing');
  assert.ok(BLOCK.includes("-Code 429"), 'the limiter must answer 429');
  assert.ok(BLOCK.includes("New-F78Error -Code 'RATE_LIMITED' -MessageKey 'lab.rateLimited' -RetryAfter $f78Retry"), 'the 429 envelope must carry the retry delay');
});

test('F78-P6-FENCE: only the save path writes the host fence, and inspect re-checks it', () => {
  const saveAt = BLOCK.indexOf("$script:F78AllowHosts[$f78Host] = $true");
  assert.ok(saveAt > 0, 'the save-time host fence write is missing');
  assert.equal((BLOCK.match(/\$script:F78AllowHosts\[\$f78Host\] = \$true/g) || []).length, 1, 'exactly ONE write may add a host');
  assert.ok(BLOCK.includes('-not $script:F78AllowHosts.ContainsKey($f78Host)'), 'inspect must re-check the fence');
  assert.ok(BLOCK.includes("$f78Src.labMode -ne $true"), 'a non-Lab source must be refused');
  assert.ok(BLOCK.includes("-Code 403"), 'the fence must answer 403');
  assert.ok(!/AddContent|Form-UrlEncoded|urlencoded/i.test(BLOCK), 'no form encoding: the routes take JSON bodies only');
});

test('F78-P7-SAVE: name/URL validation is fail-closed and mirrors the client', () => {
  // [F81 §4.1/Q9 + §5.0/Q10] The 50-char cap + HTTPS-only + userinfo-refusal
  // are now expressed as a per-field error envelope, but the original
  // validation intent is preserved verbatim. The shape changed from
  //   if (-not $f78Name -or $f78Name.Length -gt 50) { 400 + single key }
  // to
  //   $f78FieldErrors['name'] = 'newSiteNameRequired' | 'newSiteNameTooLong'
  //   $f78FieldErrors['url']  = 'newSiteHttpsRequired' | 'newSiteAuthNotAllowed'
  //   return 400 + errors envelope.
  assert.ok(BLOCK.includes("$f78Name.Length -gt 50"), 'the 50-char name cap is missing');
  assert.ok(BLOCK.includes("https://'"), 'the https-only save gate is missing');
  assert.ok(BLOCK.includes('$f78Uri.UserInfo'), 'the userinfo refusal on save is missing');
  assert.ok(BLOCK.includes("'newSiteHttpsRequired'") && BLOCK.includes("'newSiteAuthNotAllowed'"), 'the save path must reuse the shared i18n keys');
  assert.ok(BLOCK.includes("'newSiteNameRequired'") && BLOCK.includes("'newSiteNameTooLong'"), 'the per-field name keys must be present');
  assert.ok(BLOCK.includes('labMode = $true'), 'a quick-added source is always a Lab Mode source');
  assert.ok(BLOCK.includes('$f78FieldErrors'), 'per-field error envelope is missing');
  assert.ok(BLOCK.includes('$f78Cap = 50'), 'the Q10 50-site cap is missing');
});

test('F78-P8-LINKS: hrefs stay inside the added host, text/href matching is case-insensitive', () => {
  assert.ok(BLOCK.includes("'(?is)<a\\b[^>]*href\\s*=\\s*[\"'']([^\"'']+)[\"''][^>]*>(.*?)</a>'"), 'the anchor extraction regex is missing');
  assert.ok(BLOCK.includes('Test-F78SameHost -Allowed $f78Host -Actual $f78LinkHost'), 'off-host hrefs must be dropped before they are returned');
  assert.ok(BLOCK.includes('if (-not $f78Abs.StartsWith(\'https://\')) { continue }'), 'non-https hrefs must be dropped');
  assert.ok(BLOCK.includes('$f78Hay.ToLowerInvariant().Contains($f78Needle)'), 'the match test is not case-insensitive');
  assert.ok(BLOCK.includes('[System.Uri]::UnescapeDataString($f78Query)'), 'the query must be URL-decoded before matching');
  assert.ok(BLOCK.includes('$f78LinksOut.Count -ge 500'), 'the link payload must stay bounded');
  for (const key of ['hostname', 'title', 'links', 'fetchedAt', 'linkCount', 'matchCount']) {
    assert.ok(BLOCK.includes(key + ' = '), 'the JSON payload is missing ' + key);
  }
});

test('F78-P9-CLIENT: the UI client speaks the same three routes and keeps the token out of URLs', () => {
  for (const tok of ["/api/f58/sources", "/api/lab/inspect", '"X-Dash-Token"']) {
    assert.ok(UI_CLIENT.includes(tok), 'the client is missing: ' + tok);
  }
  assert.ok(UI_CLIENT.includes('method: "POST"') && UI_CLIENT.includes('method: "GET"'), 'the client must use real verbs');
  assert.ok(!/[?&](key|token)=/.test(UI_CLIENT), 'the client must never build a URL carrying a credential');
  assert.ok(UI_CLIENT.includes('validateNewSite'), 'the client must validate before the call');
});

test('F78-P10-I18N: every new key exists in en AND si with identical placeholders', () => {
  const flat = (d, p = '') => Object.entries(d).flatMap(([k, v]) => (v && typeof v === 'object' ? flat(v, p + k + '.') : [p + k]));
  const en = flat(EN);
  const si = flat(SI);
  const keys = [
    'search.addSite', 'search.yourSites', 'search.deepInspect', 'search.openInLabSite', 'search.labMode.badge',
    'lab.title', 'lab.query', 'lab.matchCount', 'lab.matchesFirst', 'lab.allLinks', 'lab.openInNewTab',
    'lab.refetch', 'lab.rateLimited', 'lab.timeout', 'lab.sizeLimit', 'lab.hostnameMismatch', 'lab.notFound',
    'newSiteName', 'newSiteUrl', 'newSiteSave', 'newSiteCancel', 'newSiteSuccess', 'newSiteHttpsRequired',
  ];
  for (const k of keys) {
    assert.ok(en.includes(k), 'en is missing ' + k);
    assert.ok(si.includes(k), 'si is missing ' + k);
  }
  const ph = (s) => (s.match(/\{\{\s*\w+\s*\}\}/g) || []).sort();
  const at = (d, path) => path.split('.').reduce((o, k) => (o ? o[k] : undefined), d);
  for (const k of keys) {
    assert.deepEqual(ph(at(SI, k)), ph(at(EN, k)), 'placeholder drift between en/si for ' + k);
  }
});
