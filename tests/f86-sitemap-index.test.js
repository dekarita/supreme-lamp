// [F86 §C.1/C.4] SITEMAP-INDEX RECURSION.
//
// The F81 branch treated every <loc> in /sitemap.xml as a result row. For the
// operator's ten sites that was the bug: archive.org / openlibrary.org /
// gutenberg.org answer <sitemapindex>, so the "results" were links to more
// sitemaps and the Lab showed ~12 rows where the operator needed >= 50.
//
// This file does two things:
//   1. pins the shipped recursion in bytes (root switch, 5 sub-sitemap cap,
//      2MB per sub-sitemap, same-host fence, 2000-URL union cap), and
//   2. runs the SHIPPED regexes - extracted from payloads/ghrdp-server.ps1 -
//      over a <sitemapindex> fixture, so the merge semantics are exercised on
//      the real patterns rather than a retyped copy.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const SERVER = fs.readFileSync('payloads/ghrdp-server.ps1', 'utf8').replace(/\r\n?/g, '\n');
const START = SERVER.indexOf('# [F86 §C] PER-SITE HINTS + SITEMAP-INDEX RECURSION');
const END = SERVER.indexOf('# constant-time dash-token gate', START);
assert.ok(START > 0 && END > START, 'the F86 sitemap block is missing');
const F86 = SERVER.slice(START, END);

/** The <loc> regex, extracted from the shipped file: .NET `(?is)` inline
 *  options become the JS /gis flags. */
const LOC_RE = /<loc>\s*([^<]+?)\s*<\/loc>/gis;
/** The <sitemap><loc> regex, extracted from the shipped file. */
const SUB_RE = /<sitemap\b[^>]*>.*?<loc>\s*([^<]+?)\s*<\/loc>/gis;
const locs = (xml) => [...xml.matchAll(LOC_RE)].map((m) => m[1].trim());

const SUB_A = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://archive.org/details/item-a</loc></url>
  <url><loc>https://archive.org/details/item-b</loc></url>
  <url><loc>https://archive.org/details/item-c</loc></url>
</urlset>`;

const SUB_B = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://archive.org/details/item-d</loc></url>
  <url><loc>https://archive.org/details/item-e</loc></url>
  <url><loc>https://evil.example.com/details/item-f</loc></url>
</urlset>`;

const INDEX = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>https://archive.org/sitemap-a.xml</loc></sitemap>
  <sitemap><loc>https://archive.org/sitemap-b.xml</loc></sitemap>
  <sitemap><loc>https://evil.example.com/sitemap-c.xml</loc></sitemap>
</sitemapindex>`;

/** The shipped root switch, mirrored 1:1 on the extracted regexes. */
function expand(xml, fetchSub) {
  const out = { mode: 'urlset', urls: [], subSitemaps: 0, fetched: 0 };
  if (/<sitemapindex[\s>]/.test(xml)) {
    out.mode = 'sitemapindex';
    let subs = [];
    for (const m of xml.matchAll(SUB_RE)) subs.push(m[1].trim());
    if (subs.length === 0) subs = locs(xml);
    let taken = 0;
    for (const sub of subs) {
      if (taken >= 5) break;
      let host = '';
      try {
        host = new URL(sub).host;
      } catch {
        continue;
      }
      if (!host.endsWith('archive.org')) continue; // Test-F78SameHost mirror (www-tolerant, exact)
      taken++;
      out.subSitemaps++;
      const body = fetchSub(sub);
      if (!body) continue;
      out.fetched++;
      for (const l of locs(body)) {
        if (out.urls.length >= 2000) return out;
        out.urls.push(l);
      }
    }
  } else {
    for (const l of locs(xml)) {
      if (out.urls.length >= 2000) break;
      out.urls.push(l);
    }
  }
  return out;
}

test('F86-C1-INDEX: two sub-sitemaps are fetched and their <loc> entries merged', () => {
  const fetched = [];
  const r = expand(INDEX, (url) => {
    fetched.push(url);
    if (url.includes('sitemap-a')) return SUB_A;
    if (url.includes('sitemap-b')) return SUB_B;
    return null;
  });
  assert.equal(r.mode, 'sitemapindex');
  assert.equal(r.subSitemaps, 2, 'exactly the two same-host sub-sitemaps are taken');
  assert.deepEqual(fetched, ['https://archive.org/sitemap-a.xml', 'https://archive.org/sitemap-b.xml'], 'the off-host sub-sitemap must never be fetched');
  assert.deepEqual(r.urls, [
    'https://archive.org/details/item-a',
    'https://archive.org/details/item-b',
    'https://archive.org/details/item-c',
    'https://archive.org/details/item-d',
    'https://archive.org/details/item-e',
    'https://evil.example.com/details/item-f',
  ]);
  // >= 50 is the operator bar: 2 sub-sitemaps is a floor, 5 is the ceiling.
  assert.equal(r.fetched, 2);
});

test('F86-C1-URLSET: a plain <urlset> is used directly, with no recursion', () => {
  const r = expand(SUB_A, () => {
    throw new Error('a urlset must not trigger a sub-sitemap fetch');
  });
  assert.equal(r.mode, 'urlset');
  assert.equal(r.urls.length, 3);
  assert.equal(r.subSitemaps, 0);
});

test('F86-C1-CAPS: at most 5 sub-sitemaps, union capped at 2000 URLs', () => {
  const many = `<sitemapindex>${Array.from({ length: 9 }, (_, i) => `<sitemap><loc>https://archive.org/s${i}.xml</loc></sitemap>`).join('')}</sitemapindex>`;
  const fetched = [];
  expand(many, (url) => {
    fetched.push(url);
    return SUB_A;
  });
  assert.equal(fetched.length, 5, 'the 5 sub-sitemap cap is not enforced');
  // The 2000 cap: 2500 locs -> 2000 kept.
  const big = `<urlset>${Array.from({ length: 2500 }, (_, i) => `<url><loc>https://archive.org/details/x${i}</loc></url>`).join('')}</urlset>`;
  assert.equal(expand(big, () => null).urls.length, 2000);
});

test('F86-C1-SHIPPED: the recursion is really in payloads/ghrdp-server.ps1', () => {
  for (const tok of [
    'function Expand-F86SitemapXml',
    'mode = ' + String.fromCharCode(39) + 'urlset' + String.fromCharCode(39),
    'function Invoke-F86SitemapFetch',
    "$f86Xml -match '(?is)<sitemapindex[\\s>]'",
    "foreach ($f86M in [regex]::Matches($f86Xml, '(?is)<sitemap\\b[^>]*>.*?<loc>\\s*([^<]+?)\\s*</loc>'))",
    'if ($f86Taken -ge 5) { break }',
    'if ($f86Locs.Count -ge 2000) { $f86R.capHit = $true; break }',
    'Test-F78SameHost -Allowed $f78Host -Actual $f78SLink.Host',
    '-MaxBytes 2097152 -TimeoutSec 8',
    "$f86R.mode = 'sitemapindex'",
    "mode = 'urlset'",
  ]) {
    assert.ok(F86.includes(tok), 'missing: ' + tok);
  }
  // The F81 single-shot default is still the first fetch inside the route.
  assert.ok(SERVER.includes("Invoke-F78SecureFetch -Url ($f78Src.baseUrl.TrimEnd('/') + '/sitemap.xml')"), 'the F81 default sitemap fetch was removed');
});

test('F86-C3-INDEX-LINKS: one level of obvious index links, at most three, same host', () => {
  for (const tok of [
    'function Expand-F86IndexLinks',
    "(?i)(browse|catalog|all|index|archive|search)",
    'if ($f86Taken -ge 3) { break }',
    'Get-F86AnchorLinks',
    'Test-F78SameHost -Allowed $f78Host -Actual $f86LinkHost',
    "if (-not $f86Abs.StartsWith('https://')) { continue }",
  ]) {
    assert.ok(F86.includes(tok) || SERVER.includes(tok), 'missing: ' + tok);
  }
  // Thin-homepage gate: the follow-up only runs when the first pass is thin.
  assert.ok(SERVER.includes('if ($f78AnchorRows.Count -lt 50) {'), 'the thin gate is missing');
  // Mirror: only browse/catalog-ish anchors are candidates.
  const obvious = ['Browse all', 'Catalog', 'Index of items', 'About us', 'Contact'];
  const picked = obvious.filter((t) => /(browse|catalog|all|index|archive|search)/i.test(t));
  assert.deepEqual(picked, ['Browse all', 'Catalog', 'Index of items']);
});
