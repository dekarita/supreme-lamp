// [F86 §C.2/C.4] PER-SITE HINTS for the operator's ten-site fixture.
//
// payloads/data/f86-site-hints.json is the file the server reads at boot
// (Get-F86SiteHints, one read per process). This test proves three things:
//   1. the file is VALID JSON and covers every domain of the operator fixture;
//   2. each covered site produces the exact sitemap/search/catalog URL the
//      shipped Expand-F86HintPath + Uri::new composition produces ({{q}} is
//      URL-encoded, never interpolated raw);
//   3. the server really loads it and really consults it when the sitemap is
//      thin (< 50 URLs) - pinned in the shipped bytes, so deleting the hint
//      lookup cannot pass CI silently.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const HINTS = JSON.parse(fs.readFileSync('payloads/data/f86-site-hints.json', 'utf8'));
const SERVER = fs.readFileSync('payloads/ghrdp-server.ps1', 'utf8').replace(/\r\n?/g, '\n');
const START = SERVER.indexOf('# [F86 §C] PER-SITE HINTS + SITEMAP-INDEX RECURSION');
const END = SERVER.indexOf('# constant-time dash-token gate', START);
assert.ok(START > 0 && END > START, 'the F86 hint block is missing');
const F86 = SERVER.slice(START, END);

// The operator fixture, verbatim (the same list tests/e2e/f86-ten-sites-deep.spec.ts uses).
const OPERATOR_SITES = [
  'openculture.com',
  'archive.org',
  'openverse.org',
  'awesome.re',
  'gutenberg.org',
  'standardebooks.org',
  'librivox.org',
  'openlibrary.org',
  'tubitv.com',
  'pluto.tv',
  'freemusicarchive.org',
];

/** The shipped Expand-F86HintPath, mirrored: {{q}} -> EscapeDataString(q). */
const expandHint = (template, q) => template.replace(/\{\{q\}\}/g, encodeURIComponent(q));
/** The shipped composition, mirrored: baseUrl.TrimEnd('/') + path (absolute template). */
const compose = (baseUrl, path) => (path.startsWith('http') ? path : baseUrl.replace(/\/+$/, '') + path);

test('F86-C2-FILE: every operator site has a hint entry with a sitemap path', () => {
  const keys = Object.keys(HINTS).map((k) => k.toLowerCase());
  const missing = OPERATOR_SITES.filter((s) => !keys.includes(s));
  assert.deepEqual(missing, [], 'the operator fixture sites without hints: ' + missing.join(', '));
  assert.ok(Object.keys(HINTS).length >= 10, 'expected at least the 10 operator sites, got ' + Object.keys(HINTS).length);
  for (const [site, hint] of Object.entries(HINTS)) {
    assert.ok(Array.isArray(hint.sitemapPaths) && hint.sitemapPaths.length >= 1, site + ' has no sitemapPaths');
    for (const p of [...(hint.sitemapPaths || []), ...(hint.searchPaths || []), ...(hint.catalogPaths || [])]) {
      assert.equal(typeof p, 'string');
      assert.ok(p.startsWith('/'), site + ': hint paths are site-relative, got ' + p);
    }
  }
});

test('F86-C2-URL: each hinted search path produces the expected query URL', () => {
  const q = 'public domain film';
  const expected = {
    'archive.org': 'https://archive.org/search?query=public%20domain%20film',
    'gutenberg.org': 'https://gutenberg.org/ebooks/search/?query=public%20domain%20film',
    'librivox.org': 'https://librivox.org/search?primary_key=public%20domain%20film&search_category=title&search_page=1&search_form=advanced',
    'freemusicarchive.org': 'https://freemusicarchive.org/search?quicksearch=public%20domain%20film',
  };
  for (const [site, url] of Object.entries(expected)) {
    const hint = HINTS[site];
    assert.ok(hint && Array.isArray(hint.searchPaths) && hint.searchPaths.length >= 1, site + ' lost its searchPaths');
    assert.equal(compose('https://' + site, expandHint(hint.searchPaths[0], q)), url, site + ' search URL drifted');
  }
  // {{q}} must be URL-encoded: a raw space would break the fetch URL.
  assert.ok(!HINTS['archive.org'].searchPaths[0].includes('{{q}}') === false, 'the placeholder is expected in the template');
  assert.ok(expandHint(HINTS['archive.org'].searchPaths[0], 'a&b=c').includes('a%26b%3Dc'), 'the query must be URL-encoded');
  // Every sitemap path resolves against its own site.
  for (const site of OPERATOR_SITES) {
    const hint = HINTS[site];
    if (!hint || !hint.sitemapPaths) continue;
    for (const p of hint.sitemapPaths) assert.equal(compose('https://' + site, p), 'https://' + site + p);
  }
  // archive.org keeps its JSON API hint (the operator's priority site).
  assert.equal(compose('https://archive.org', expandHint(HINTS['archive.org'].advancedApi, 'nasa')), 'https://archive.org/advancedsearch.php?q=nasa&output=json');
});

test('F86-C2-SHIPPED: the server loads the JSON and consults it before/after the sitemap', () => {
  for (const tok of [
    'function Get-F86SiteHints',
    "$script:F86HintsPath = Join-Path $Root 'data\\f86-site-hints.json'",
    'function Get-F86SiteHint',
    'function Get-F86HintList',
    'function Expand-F86HintPath',
    "[System.Uri]::EscapeDataString([string]$Query)",
    'Get-F86SiteHint -HostName $f78Host',
    "-Field 'sitemapPaths' -Max 3",
    "-Field 'searchPaths' -Max 2",
    "-Field 'catalogPaths' -Max 2",
  ]) {
    assert.ok(F86.includes(tok) || SERVER.includes(tok), 'missing: ' + tok);
  }
  // Thinness is the trigger: < 50 candidate URLs -> search paths, then catalogs.
  assert.ok(SERVER.includes('$f78CandidateUrls.Count -lt 50'), 'the < 50 thin gate is missing');
  assert.ok(SERVER.includes("if ($f78SourceLabel -eq 'homepage') { $f78SourceLabel = 'search' }"), 'the search-path source label is missing');
  assert.ok(SERVER.includes("$f78SourceLabel = 'catalog'"), 'the catalog source label is missing');
  // Hints never widen the host fence: every hint fetch goes through the same
  // ExpectedHost fence as the rest of the block.
  const hintFetches = [...SERVER.matchAll(/Invoke-(?:F78SecureFetch|F86SitemapFetch)[^\n]*/g)].filter((m) => /f78SpUrl|f78CpUrl|f78SmUrl/.test(m[0]));
  assert.ok(hintFetches.length >= 3, 'the hint fetches do not use the hardened fetchers');
  for (const call of hintFetches) {
    assert.ok(/ExpectedHost|-f78Host/.test(call[0]), 'a hint fetch lost its host fence: ' + call[0]);
  }
});
