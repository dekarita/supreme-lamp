// [F87 §C.1/§E.A] POST /api/f87-selftest - pinned in bytes + mirrored where it
// counts. The route is the operator's one-click production proof, so this file
// proves (1) the route ships in payloads/ghrdp-server.ps1 with the four probes
// in order, (2) the body is validated as a SUBSET of the eleven operator sites
// (the allowlist is payloads/data/f88-site-hints.json - the same file the Lab
// hints read), (3) the response shape the panel renders, (4) the 1 call / 60 s
// per-token rate limit, (5) the download stub never downloads, and (6) the
// e2e mock answers the same envelope with the same fixture names.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SERVER = fs.readFileSync('payloads/ghrdp-server.ps1', 'utf8').replace(/\r\n?/g, '\n');
const HINTS = JSON.parse(fs.readFileSync('payloads/data/f88-site-hints.json', 'utf8'));
const MOCK = fs.readFileSync('tests/e2e/fixtures/mock-backend.mjs', 'utf8');
const SITES = ['openculture.com', 'archive.org', 'openverse.org', 'awesome.re', 'gutenberg.org', 'standardebooks.org',
  'librivox.org', 'openlibrary.org', 'tubitv.com', 'pluto.tv', 'freemusicarchive.org'];

function routeBlock() {
  const start = SERVER.indexOf("if ($path -eq '/api/f87-selftest' -and $parts.method -eq 'POST')");
  assert.ok(start > 0, 'the /api/f87-selftest route is missing');
  const end = SERVER.indexOf('# [F81 §3.2/Q8] POST /api/preview', start);
  assert.ok(end > start, 'the route end marker is missing');
  return SERVER.slice(start, end);
}
const ROUTE = routeBlock();

/** JS mirror of the route's subset validation (same normalisation, same allowlist). */
function validateSites(requested, allowed = Object.keys(HINTS)) {
  const sites = [];
  const bad = [];
  for (const raw of Array.isArray(requested) ? requested : []) {
    const s = String(raw).trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
    if (!s) continue;
    if (allowed.includes(s)) { if (!sites.includes(s)) sites.push(s); } else bad.push(s);
  }
  return { sites, bad, ok: bad.length === 0 && sites.length > 0 && sites.length <= 11 };
}

/** JS mirror of the 1 call / 60 s per-token limiter. */
function makeLimiter(now = () => Date.now()) {
  const last = new Map();
  return (tok) => {
    const t = now();
    if (last.has(tok) && t - last.get(tok) < 60_000) return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((60_000 - (t - last.get(tok))) / 1000)) };
    last.set(tok, t);
    return { allowed: true };
  };
}

test('F87-C1-ROUTE: [F88 §C.2 supersession] the self-test ships the four probes + the real downloadTest', () => {
  for (const tok of [
    "Invoke-F78SecureFetch -Url $f87Home -ExpectedHost $f87Site -MaxBytes 65536 -TimeoutSec 8",
    "Invoke-F86SitemapFetch -Url ($f87Home + 'sitemap.xml') -f78Host $f87Site",
    "Get-F86HintList -Hint $f87Hint -Field 'sitemapPaths' -Max 3",
    'Invoke-F86LaunchUrl -Url $f87Home',
    "Join-Path $env:USERPROFILE 'Desktop\\RDP-Downloads'",
    '[System.IO.File]::WriteAllBytes($f87ProbeFile, [byte[]]@())',
    'Remove-Item -LiteralPath $f87ProbeFile -Force',
    // [F88 §C.2] step 5: a REAL download through the shared verified helper
    "Invoke-F88DownloadToRdp -Url ($f87Home + 'robots.txt') -ExpectedHost $f87Site",
    '$f87Row.downloadOk = [bool]$f88Dt.ok',
    "(?i)\\.pdf(\\?|$)",
  ]) assert.ok(ROUTE.includes(tok), 'route does not pin: ' + tok);
  const order = ['probeOk = [bool]$f87Probe.ok', '$f87Row.sitemapUrls = [int]$f87Urls.Count', '$f87Row.launchTier = [int]$f87Launch.tier', '$f87Row.downloadDirOk = $true', '$f87Row.downloadOk = [bool]$f88Dt.ok']
    .map((t) => ROUTE.indexOf(t));
  assert.ok(order.every((i) => i > 0), 'a probe is missing');
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'probe order must be HEAD -> sitemap -> launch -> download dir -> downloadTest');
  // [F88 §C.2 supersedes the F87 'never downloads' stub] the download runs
  // through the SHARED verified helper - still no Invoke-WebRequest, no
  // DownloadFile, no ?download=true re-entry from inside the server.
  assert.ok(!/Invoke-WebRequest|DownloadFile|\?download=true/.test(ROUTE), 'the self-test must download only via Invoke-F88DownloadToRdp');
  assert.ok(SERVER.includes('function Invoke-F88DownloadToRdp'), 'the shared helper is missing');
});

test('F87-C1-SHAPE: the response carries results[{site, probeOk, sitemapUrls, launchTier, launchOk, downloadDirOk, errors[]}] + ok/ranAt/total/passed', () => {
  for (const f of ['site = $f87Site', 'probeOk = $false', 'sitemapUrls = 0', 'launchTier = 0', 'launchOk = $false', 'downloadDirOk = $false', 'errors = @()'])
    assert.ok(ROUTE.includes(f), 'result row lacks ' + f);
  assert.ok(ROUTE.includes("[ordered]@{ ok = $true; ranAt = $f87Now.ToString('yyyy-MM-ddTHH:mm:ssZ'); total = [int]$f87Results.Count; passed = [int]$f87Pass; results = @($f87Results) }"));
  assert.ok(SERVER.includes('selfTest = $true'), '/api/version must advertise features.selfTest');
});

test('F87-C1-SUBSET: the body is validated as a subset of the eleven operator sites (allowlist = f88-site-hints.json)', () => {
  assert.deepEqual(Object.keys(HINTS).sort(), [...SITES].sort(), 'the hints file IS the operator fixture');
  assert.ok(ROUTE.includes('(Get-F86SiteHints).Keys'), 'the allowlist must come from the hints file, not a second literal');
  assert.ok(ROUTE.includes("messageKey = 'selfTest.invalidSites'"), 'an off-list site must be a 400 with a key');
  assert.equal(validateSites(SITES).ok, true);
  assert.deepEqual(validateSites(['https://www.pluto.tv/us/', 'ARCHIVE.ORG']).sites, ['pluto.tv', 'archive.org']);
  assert.equal(validateSites(['example.com']).ok, false);
  assert.deepEqual(validateSites(['example.com', 'pluto.tv']).bad, ['example.com']);
  assert.equal(validateSites([]).ok, false);
  assert.equal(validateSites(['pluto.tv', 'pluto.tv']).sites.length, 1, 'duplicates collapse');
  // the mock mirrors it from the SAME eleven (f85-sites.json)
  assert.ok(MOCK.includes('const rejected = requested.filter((s) => !F87_SITES.includes(s));'));
});

test('F87-C1-RATELIMIT: 1 call / 60 s per X-Dash-Token -> 429 RATE_LIMITED + retryAfterSeconds', () => {
  assert.ok(ROUTE.includes("$f87Tok = [string]$parts.headers['x-dash-token']"));
  assert.ok(ROUTE.includes('if ($f87Age -lt 60) {'));
  assert.ok(ROUTE.includes("Send-ClientResponse -Stream $stream -Code 429 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes ([ordered]@{ code = 'RATE_LIMITED'; messageKey = 'selfTest.rateLimited'; retryAfterSeconds = $f87Retry }))"));
  // the limiter is armed AFTER validation (a 400 must not burn the minute)
  assert.ok(ROUTE.indexOf("messageKey = 'selfTest.invalidSites'") < ROUTE.indexOf('$script:F87SelfTestRate[$f87Tok] = $f87Now'));
  let t = 1_000_000;
  const limit = makeLimiter(() => t);
  assert.equal(limit('tok-a').allowed, true);
  const second = limit('tok-a');
  assert.equal(second.allowed, false);
  assert.ok(second.retryAfterSeconds >= 59 && second.retryAfterSeconds <= 60);
  assert.equal(limit('tok-b').allowed, true, 'the limit is per token');
  t += 60_001;
  assert.equal(limit('tok-a').allowed, true, 'the minute expires');
});

test('F87-B3-FIXTURES: eleven real-shaped sitemap fixtures, hostname-dashed names, >= 60 same-host https URLs each', () => {
  const dir = 'tests/e2e/fixtures/f86-sitemaps';
  for (const site of SITES) {
    const file = path.join(dir, site.replace(/\./g, '-') + '.xml');
    assert.ok(fs.existsSync(file), 'missing ' + file);
    const locs = [...fs.readFileSync(file, 'utf8').matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/g)].map((m) => m[1]);
    assert.ok(locs.length >= 60, `${site}: ${locs.length} URLs`);
    for (const u of locs) {
      assert.ok(u.startsWith('https://'), u);
      assert.equal(new URL(u).hostname.replace(/^www\./, ''), site, u);
      assert.ok(!/\/item\/\d{3}$/.test(u), 'synthetic row survived: ' + u);
    }
  }
  // the mock looks the file up by hostname with the same dots-to-dashes rule
  assert.ok(MOCK.includes('const f87FixtureName = (hostname) => String(hostname).replace(/\\./g, "-") + ".xml";'));
  assert.ok(MOCK.includes('deleted.delete(row.id);'), 'the mock must un-delete a re-added site (the F86 e2e root cause)');
  assert.ok(MOCK.includes('await sleep(100);'), 'the deep lane keeps its 100 ms latency');
});
