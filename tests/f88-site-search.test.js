// [F88] Per-site search endpoints + launch-url Tier 0/4 + verified download.
// Three spec sections pinned against the shipped bytes:
//   §1 (A.1/A.2)  f88-site-hints.json carries a searchStrategy + fallback for
//                 all 11 operator sites, the server switches on it, and the
//                 sitemap ladder only runs when the search yields < 5 rows.
//   §2 (B.1-B.4)  the launch ladder is 0,1,2,3,4 with Tier 0 = user-session
//                 spawn (quser/schtasks/psexec + 3s browser verification) and
//                 Tier 4 = Shell.Application; every rung appends to the
//                 verbose log the diag route returns as verboseLog; the gate
//                 that houses the route admits it (the F88 §B.1 reachability
//                 fix); the 503 reason names the no-active-RDP-session case.
//   §3 (C.1/C.2)  /api/fetch?download=true answers verified/writeTime (or a
//                 specific 500), and the F87 selftest runs a REAL download
//                 through the same helper.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const SERVER = fs.readFileSync('payloads/ghrdp-server.ps1', 'utf8').replace(/\r\n?/g, '\n');
const HINTS = JSON.parse(fs.readFileSync('payloads/data/f88-site-hints.json', 'utf8'));
const EN = JSON.parse(fs.readFileSync('src/i18n/en.json', 'utf8'));
const BANNER = fs.readFileSync('src/components/search/F86DiagnosticBanner.tsx', 'utf8');
const INSPECTOR = fs.readFileSync('src/pages/search/LabInspector.tsx', 'utf8');
const LAUNCH_TS = fs.readFileSync('src/lib/launchUrl.ts', 'utf8');
const FIXTURE_DIR = 'tests/e2e/fixtures/f88-real-responses';

const STRATEGIES = ['html', 'json', 'markdown-section'];

test('F88-A1-HINTS: all 11 sites declare searchStrategy + fallback (old fallback paths kept)', () => {
  const sites = Object.keys(HINTS);
  assert.equal(sites.length, 11, 'the operator fixture must stay 11 sites');
  for (const site of sites) {
    const h = HINTS[site];
    assert.ok(STRATEGIES.includes(h.searchStrategy), site + ' strategy: ' + h.searchStrategy);
    assert.ok(['sitemap', 'homepage'].includes(h.fallback), site + ' fallback');
    if (h.fallback === 'sitemap') assert.ok(Array.isArray(h.sitemapPaths) && h.sitemapPaths.length >= 1, site + ' lost sitemapPaths');
    assert.ok(!JSON.stringify(h).includes('{{q}}') || h.searchStrategy === 'markdown-section' || h.searchEndpoint || h.searchPaths, site);
  }
  assert.equal(HINTS['openculture.com'].searchEndpoint, 'https://www.openculture.com/?s={{q}}');
  assert.equal(HINTS['openculture.com'].resultSelector, 'article.post h2 a');
  assert.equal(HINTS['archive.org'].resultsPath, 'response.docs');
  assert.equal(HINTS['archive.org'].mapUrl, 'https://archive.org/details/{{identifier}}');
  assert.ok(HINTS['archive.org'].searchPaths[0].includes('tab=all'), 'the operator expected URL carries tab=all');
  assert.equal(HINTS['openverse.org'].searchEndpoint, 'https://api.openverse.org/v1/images/?q={{q}}&page_size=50');
  assert.equal(HINTS['openverse.org'].mapUrl, 'foreign_landing_url');
  assert.equal(HINTS['awesome.re'].searchStrategy, 'markdown-section');
  assert.equal(HINTS['awesome.re'].readmeUrl, 'https://raw.githubusercontent.com/sindresorhus/awesome/main/readme.md');
  assert.equal(HINTS['awesome.re'].redirectTo, 'https://github.com/sindresorhus/awesome');
  assert.equal(HINTS['openlibrary.org'].mapUrl, 'https://openlibrary.org{{key}}');
  assert.equal(HINTS['tubitv.com'].fallback, 'homepage');
  assert.equal(HINTS['pluto.tv'].fallback, 'homepage');
});

test('F88-A1-RENAME: the server reads f88-site-hints.json (f86 file is gone)', () => {
  assert.ok(!fs.existsSync('payloads/data/f86-site-hints.json'), 'the old hints file must be renamed away');
  assert.ok(SERVER.includes("$script:F86HintsPath = Join-Path $Root 'data\\f88-site-hints.json'"));
  assert.ok(!SERVER.includes("data\\f86-site-hints.json"), 'server still references the f86 hints file');
});

test('F88-A2-SERVER: Invoke-F88SiteSearch switches on the strategy', () => {
  assert.ok(SERVER.includes('function Invoke-F88SiteSearch'), 'the search function is missing');
  for (const tok of [
    "if ($f88Strategy -eq 'json')", "if ($f88Strategy -eq 'markdown-section')", "if ($f88Strategy -eq 'html')",
    'resultsPath', 'mapUrl', 'sectionMatcher', 'subItemPattern', 'resultSelector',
    'Invoke-F78SecureFetch -Url $f88Ep', 'ConvertFrom-Json -ErrorAction Stop',
    "$f88Out.label = 'HTML search endpoint'", "$f88Out.label = 'JSON search endpoint'",
    "'GitHub README section - '", 'Test-F78SameHost -Allowed $HostName',
    ".Replace('%20', '+')", 'no-rows',
  ]) assert.ok(SERVER.includes(tok), 'search switch missing: ' + tok);
});

test('F88-A2-FALLBACK: search-first runs before the sitemap ladder; < 5 rows falls back', () => {
  const searchAt = SERVER.indexOf('function Invoke-F88SiteSearch');
  const routeAt = SERVER.indexOf('SEARCH-ENDPOINT FIRST');
  assert.ok(searchAt > 0 && routeAt > searchAt, 'the search-first route hook is missing');
  assert.ok(SERVER.includes('$f88SearchRows.Count -ge 5'), 'the <5-results fallback gate is missing');
  assert.ok(SERVER.includes('-not $f88Primary'), 'the sitemap ladder is not gated on the search outcome');
  const gate = SERVER.indexOf("if ($path -eq '/api/f58/sources' -or $path -eq '/api/lab/inspect' -or");
  assert.ok(gate > 0, '[F88 §B.1] the F78 gate no longer admits the routes it houses');
  for (const tok of ["$path -like '/api/f58/sources/*'", "$path -eq '/api/launch-url'", "$path -eq '/api/launch-url/diag'", "$path -eq '/api/f87-selftest'", "$path -eq '/api/preview'"]) {
    assert.ok(SERVER.includes(tok), 'gate misses: ' + tok);
  }
});

test('F88-A3-PAYLOAD: the inspect response carries sourceDisplay + sourceSets + tookMs', () => {
  for (const tok of ['sourceDisplay = $f88Display', 'sourceStrategy = $f88StrategyOut', 'tookMs = [int]$f88Sw.ElapsedMilliseconds', 'sourceSets = @($f88SourceSets)', "key = 'search-endpoint'", "$f78Phase = 'search-endpoint'"]) {
    assert.ok(SERVER.includes(tok), 'payload missing: ' + tok);
  }
});

test('F88-B-LADDER: 0,1,2,3,4 with Tier 0 user-session + Tier 4 Shell COM', () => {
  assert.ok(SERVER.includes('foreach ($f86Tier in @(0, 1, 2, 3, 4)) {'), 'ladder order');
  assert.ok(SERVER.includes('function Invoke-F88LaunchInUserSession'), 'Tier 0 missing');
  assert.ok(SERVER.includes('function Invoke-F88LaunchTier4'), 'Tier 4 missing');
  for (const tok of [
    '& quser.exe 2>$null', '($f88Line -match \'^\\s*>?\\s*(\\S+)\\s+\\S+\\s+(\\d+)\\s+(Active|Disc)\')',
    '/SC ONCE', '/RU $f88User', '/RL HIGHEST', '-accepteula -s -i ',
    'no-active-rdp-session; connect via WEB DESKTOP first',
    'Start-Sleep -Milliseconds 300', 'user-session-no-browser',
    'New-Object -ComObject Shell.Application', '$f88Shell.ShellExecute($Url, \'\', \'\', \'open\', 1)',
    'shell-com-no-browser-process',
  ]) assert.ok(SERVER.includes(tok), 'tier missing: ' + tok);
  // no credential-UI automation identifiers in the shipped server (F19 fence)
  assert.ok(!/SendKeys|UIAutomation/.test(SERVER), 'F19 banned identifier in ghrdp-server.ps1');
});

test('F88-B-VERBOSE: verbose log file + last 20 lines on GET /api/launch-url/diag', () => {
  assert.ok(SERVER.includes("Join-Path $f86LogDir 'launch-url-verbose.log'"), 'verbose log path');
  assert.ok(SERVER.includes('function Write-F88VerboseLaunchLog'), 'verbose writer');
  assert.ok(SERVER.includes('$f88VerboseLines = @($f88VerboseAll[($f88VerboseAll.Count - 20)..($f88VerboseAll.Count - 1)])'), 'last-20 slice');
  assert.ok(SERVER.includes('$f88DiagOut.verboseLog = @($f88VerboseLines)'), 'diag field');
  assert.ok(SERVER.includes('verboseLogPath = [string]$script:F88VerboseLogPath'), 'diag path field');
  // per-rung line carries pid + process name + outcome, host+path only
  assert.ok(SERVER.includes("'tier=' + [string]$f86Tier + ' ok=' + [string]$f86Outcome.ok + ' browser=' + [string]$f86Outcome.browser + ' pid=' + [string]$f86Outcome.pid"), 'per-rung verbose line');
  assert.ok(SERVER.includes("Write-F88VerboseLaunchLog -Line ('ladder-result"), 'ladder summary line');
});

test('F88-B-UI: toast names the failed tier + diag link; banner shows the log', () => {
  assert.ok(LAUNCH_TS.includes('export function launchFailureToast'), 'toast helper missing');
  assert.ok(LAUNCH_TS.includes('search.launchUrl.failedTier'), 'failedTier key not used');
  assert.ok(EN.search.launchUrl.failedTier.includes('/#/search?diag=1'), 'the toast must link the diag panel');
  assert.ok(EN.search.launchUrl.failedTier.includes('{{tier}}'), 'the toast must name the tier');
  assert.ok(BANNER.includes('data-testid="f88-verbose-log"'), 'banner verbose section missing');
  assert.ok(BANNER.includes('data-testid="f88-verbose-log-body"'), 'banner verbose body missing');
  assert.ok(BANNER.includes('data-testid="f88-verbose-log-copy"'), 'banner copy button missing');
  assert.ok(BANNER.includes('verboseLog ?? []'), 'banner does not read diag.verboseLog');
});

test('F88-C1-DOWNLOAD: verified write or a specific 500', () => {
  assert.ok(SERVER.includes('function Invoke-F88DownloadToRdp'), 'shared helper');
  for (const tok of [
    'if (-not (Test-Path -LiteralPath $f88Path))', 'file-missing-after-write',
    'if ([int64]$f88Fi.Length -ne [int64]$f88Written)', 'size-mismatch',
    'verified = [bool]$f88Dl.verified; writeTime = [string]$f88Dl.writeTime',
    "code = 'DOWNLOAD_VERIFY_FAILED'", 'Code 500',
    'LastWriteTimeUtc.ToString',
  ]) assert.ok(SERVER.includes(tok), 'download verify missing: ' + tok);
});

test('F88-C2-SELFTEST: per-site downloadTest runs a real robots.txt download', () => {
  for (const tok of [
    'downloadOk = $false', "downloadPath = ''", 'downloadBytes = 0',
    "Invoke-F88DownloadToRdp -Url ($f87Home + 'robots.txt') -ExpectedHost $f87Site",
    '$f87Row.downloadOk = [bool]$f88Dt.ok', '$f87Row.downloadPath = [string]$f88Dt.path', '$f87Row.downloadBytes = [int]$f88Dt.bytes',
  ]) assert.ok(SERVER.includes(tok), 'selftest downloadTest missing: ' + tok);
});

test('F88-C3-UI: Lab inspector has the Source line, tabs and the download button', () => {
  for (const tok of ['data-testid="lab-source-line"', 'data-testid="lab-source-tabs"', 'data-testid="lab-source-tab"', 'data-testid="lab-link-download"', 'isFileLikeUrl(l.href)', 'lab.sourceLine']) {
    assert.ok(INSPECTOR.includes(tok), 'inspector missing: ' + tok);
  }
});

test('F88-D-FIXTURES: 11 cached real responses ship with the spec', () => {
  const files = fs.readdirSync(FIXTURE_DIR).sort();
  assert.equal(files.length, 11, 'fixture count: ' + files.join(','));
  for (const f of files) {
    const size = fs.statSync(FIXTURE_DIR + '/' + f).size;
    assert.ok(size > 200, f + ' is suspiciously small');
  }
  const openverse = JSON.parse(fs.readFileSync(FIXTURE_DIR + '/openverse-org-search.json', 'utf8'));
  assert.ok(openverse.results.length >= 10, 'openverse needs >= 10 image results');
  const archive = JSON.parse(fs.readFileSync(FIXTURE_DIR + '/archive-org-search.json', 'utf8'));
  assert.ok(archive.response.docs.some((d) => /A Matter of Life and Death/i.test(String(d.title))), 'archive fixture lost the operator query');
  const openculture = fs.readFileSync(FIXTURE_DIR + '/openculture-com-search.html', 'utf8');
  assert.ok(openculture.includes('https://www.openculture.com/freeonlinecourses'), 'openculture fixture lost the expected URL');
  assert.ok(openculture.includes('walter_kaufmanns_lectures.html'), 'openculture fixture lost the alternate URL');
  const awesome = fs.readFileSync(FIXTURE_DIR + '/awesome-readme.md', 'utf8');
  assert.ok(/^## Networking/m.test(awesome), 'awesome fixture lost the section heading');
  for (const item of ['PCAPTools', 'Real-Time Communications', 'SNMP', 'Scapy', 'Cilium']) {
    assert.ok(awesome.includes(item), 'awesome fixture missing sub-item ' + item);
  }
});

test('F88-D-SCRIPT: the refresh script exists for the operator', () => {
  const s = fs.readFileSync('scripts/f88-refresh-fixtures.sh', 'utf8');
  assert.ok(s.includes('f88-real-responses'), 'refresh script output dir');
  assert.ok(s.includes('curl'), 'refresh script must fetch with curl');
});
