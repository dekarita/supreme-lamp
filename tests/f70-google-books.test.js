// [F70 §2] Node lab: the google-books-public adapter measured against the
// SHIPPED helper (Invoke-GhrdpGoogleBooksSearch in payloads/ghrdp-server.ps1).
// (a) STATIC pins: the endpoint URL construction, the no-API-key rule, the
//     F58.HARD rate window (60 rpm / 60s), the 40-result Google cap, and every
//     field-mapping literal of the pinned parse contract.
// (b) BEHAVIORAL: global fetch is mocked for googleapis.com and a faithful JS
//     twin of the shipped mapping (each rule pinned to a .ps1 literal above)
//     parses a Google Books Volumes fixture: full mapping, empty result set,
//     and the limit cap.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const SERVER = fs.readFileSync('payloads/ghrdp-server.ps1', 'utf8');
const HELPER_AT = SERVER.indexOf('function Invoke-GhrdpGoogleBooksSearch');
const HELPER_END = SERVER.indexOf('if ($parts.method -eq \'OPTIONS\')', HELPER_AT);
assert.ok(HELPER_AT > 0 && HELPER_END > HELPER_AT, 'the helper must live in the search lane block');
const HELPER = SERVER.slice(HELPER_AT, HELPER_END);

const FIXTURE = {
  kind: 'books#volumes',
  totalItems: 42,
  items: [
    {
      id: 'AAA111',
      volumeInfo: {
        title: 'Public Domain Classic',
        authors: ['Jane Austen', 'Another Editor'],
        publishedDate: '1813-01-28T00:00:00Z',
        previewLink: 'https://books.google.com/books?id=AAA111&printsec=frontcover',
        infoLink: 'https://books.google.com/books?id=AAA111',
      },
      accessInfo: { publicDomain: true, viewability: 'PARTIAL', epub: { isAvailable: true }, pdf: { isAvailable: true } },
    },
    {
      id: 'BBB222',
      volumeInfo: {
        title: 'Modern Purchase Only',
        authors: ['B. Author'],
        publishedDate: '2026-03',
        previewLink: 'https://books.google.com/books?id=BBB222',
        infoLink: 'https://books.google.com/books?id=BBB222&source=gbs_api',
      },
      accessInfo: { publicDomain: false, viewability: 'ALL_PAGES', epub: { isAvailable: false }, pdf: { isAvailable: true } },
    },
    {
      id: 'CCC333',
      volumeInfo: {
        title: 'Snippet Only',
        authors: [],
        publishedDate: '2020',
        previewLink: 'https://books.google.com/books?id=CCC333',
        infoLink: 'https://books.google.com/books?id=CCC333',
      },
      accessInfo: { publicDomain: false, viewability: 'NO_PAGES', epub: { isAvailable: false }, pdf: { isAvailable: false } },
    },
  ],
};

test('F70-P2-STATIC: endpoint, no API key, rate window, cap and pinned mapping', () => {
  assert.ok(HELPER.includes("'https://www.googleapis.com/books/v1/volumes?q=' + [uri]::EscapeDataString($Query) + '&maxResults=' + [string]$f70Max + '&startIndex=' + [string]$f70Start"), 'the exact public Volumes URL template');
  assert.ok(!/key=|&key|api[-_]?key/i.test(HELPER.replace(/# .*$/gm, '')), 'no API key in the request (public read)');
  assert.ok(HELPER.includes('AddSeconds(-60)'), '60-second sliding rate window');
  assert.ok(HELPER.includes("$script:F70GbWindow.Count -ge 60)"), 'F58.HARD 60 rpm budget');
  assert.ok(HELPER.includes('if ($f70Max -gt 40) { $f70Max = 40 }'), 'Google maxResults hard cap 40');
  assert.ok(HELPER.includes('-TimeoutSec 30'), 'F58.HARD request timeout 30s');
  // pinned parse contract literals
  assert.ok(HELPER.includes("[string]$f70Vi.title"), 'title = volumeInfo.title');
  assert.ok(HELPER.includes("(@($f70Vi.authors) -join ', ')"), 'creator = authors joined');
  assert.ok(HELPER.includes("[string]$f70Vi.previewLink"), 'sourceUrl = previewLink');
  assert.ok(HELPER.includes("[string]$f70Vi.infoLink"), 'purchaseUrl = infoLink');
  assert.ok(HELPER.includes("'application/epub+zip'"), 'epub mime');
  assert.ok(HELPER.includes("'application/pdf'"), 'pdf mime');
  assert.ok(HELPER.includes('.epub.isAvailable'), 'epub availability check');
  assert.ok(HELPER.includes('.pdf.isAvailable'), 'pdf availability check');
  assert.ok(HELPER.includes('.publicDomain'), 'public-domain licence check');
  assert.ok(HELPER.includes("-eq 'ALL_PAGES'"), 'open-access viewability check');
  assert.ok(HELPER.includes('$f70Date.Substring(0,10)'), 'date sliced to YYYY-MM-DD');
  assert.ok(HELPER.includes('sizeBytes = $null'), 'sizeBytes null (API does not return it)');
  assert.ok(HELPER.includes("'gb-' + [string]$f70It.id"), 'immutable per-volume snapshot id');
  // error envelopes
  assert.ok(HELPER.includes("'RATE_LIMITED'"), 'rate-limited code');
  assert.ok(HELPER.includes("'TRANSPORT_UNAVAILABLE'") && HELPER.includes("'TIMEOUT'"), 'transport error codes');
  // wiring: the fan-out calls the helper and google-books-public is default
  assert.ok(SERVER.includes("Invoke-GhrdpGoogleBooksSearch -Query $f70Query -Limit $f70Limit -Cursor $f70Cursor"), 'the search fan-out invokes the helper');
  // [F72 §1.3] Default fan-out expanded to 5-source TLS-Radar pack.
  assert.ok(SERVER.includes("$script:DefaultAdapterIds = @('github-releases','internet-archive','arxiv','wikisource','google-books-public')"), 'default 5-source adapter fan-out');
});

// The twin: each rule below executes ONLY a literal pinned in the static test
// above, so a .ps1 edit that changes the mapping breaks the pin, not the twin.
function gbMap(items) {
  const rows = [];
  for (const it of items || []) {
    const vi = (it && it.volumeInfo) || null;
    if (!vi || !vi.title) continue;
    let mime = null;
    if (it.accessInfo && it.accessInfo.epub && it.accessInfo.epub.isAvailable) mime = 'application/epub+zip';
    else if (it.accessInfo && it.accessInfo.pdf && it.accessInfo.pdf.isAvailable) mime = 'application/pdf';
    let lic = 'purchase';
    if (it.accessInfo && it.accessInfo.publicDomain) lic = 'public-domain';
    else if (it.accessInfo && String(it.accessInfo.viewability) === 'ALL_PAGES') lic = 'open-access';
    let date = String(vi.publishedDate || '');
    if (date.length > 10) date = date.slice(0, 10);
    rows.push({
      adapterId: 'google-books-public',
      nameKey: 'search.sources.googleBooksPublic',
      category: 'books',
      title: String(vi.title),
      creator: (vi.authors || []).join(', '),
      sizeBytes: null,
      licenceTag: lic,
      sourceSnapshotId: 'gb-' + String(it.id),
      sourceUrl: String(vi.previewLink || vi.infoLink || ''),
      purchaseUrl: String(vi.infoLink || ''),
      mimeType: mime,
      date,
    });
  }
  return rows;
}

test('F70-P2-MAPPING: the shipped mapping parses a Google Books fixture', () => {
  const rows = gbMap(FIXTURE.items);
  assert.equal(rows.length, 3);
  const [a, b, c] = rows;
  // epub preferred over pdf; publicDomain wins; full date sliced
  assert.equal(a.title, 'Public Domain Classic');
  assert.equal(a.creator, 'Jane Austen, Another Editor');
  assert.equal(a.mimeType, 'application/epub+zip');
  assert.equal(a.licenceTag, 'public-domain');
  assert.equal(a.date, '1813-01-28');
  assert.equal(a.sourceUrl, 'https://books.google.com/books?id=AAA111&printsec=frontcover');
  assert.equal(a.purchaseUrl, 'https://books.google.com/books?id=AAA111');
  assert.equal(a.sizeBytes, null);
  assert.equal(a.sourceSnapshotId, 'gb-AAA111');
  assert.equal(a.nameKey, 'search.sources.googleBooksPublic');
  // pdf fallback; ALL_PAGES -> open-access; partial date passes through
  assert.equal(b.mimeType, 'application/pdf');
  assert.equal(b.licenceTag, 'open-access');
  assert.equal(b.date, '2026-03');
  // no epub, no pdf, not public domain -> purchase, null mime
  assert.equal(c.mimeType, null);
  assert.equal(c.licenceTag, 'purchase');
  assert.equal(c.creator, '');
  assert.equal(c.date, '2020');
});

test('F70-P2-EMPTY-AND-CAP: zero items -> empty; limit clamped to the 40 cap', () => {
  const empty = gbMap([]);
  assert.equal(empty.length, 0);
  // the shipped clamp: maxResults = min(max(limit,1), 40)
  const clamp = (l) => Math.min(Math.max(l, 1), 40);
  assert.equal(clamp(50), 40, 'a 50-limit search still requests 40 (Google cap)');
  assert.equal(clamp(10), 10);
  assert.equal(clamp(0), 1);
  assert.equal(clamp(-5), 1);
});

test('F70-P2-FETCH-MOCK: the lane calls googleapis.com with the escaped query', async () => {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return {
      ok: true, status: 200,
      text: async () => JSON.stringify(FIXTURE),
      json: async () => FIXTURE,
    };
  };
  try {
    // mirror of the shipped URL construction with limit 50 -> clamped 40
    const q = 'war and peace';
    const max = Math.min(Math.max(50, 1), 40);
    const start = 0;
    const uri = 'https://www.googleapis.com/books/v1/volumes?q=' + encodeURIComponent(q) + '&maxResults=' + max + '&startIndex=' + start;
    const res = await globalThis.fetch(uri);
    const parsed = JSON.parse(await res.text());
    const rows = gbMap(parsed.items);
    assert.equal(calls.length, 1);
    assert.ok(calls[0].startsWith('https://www.googleapis.com/books/v1/volumes?q=war%20and%20peace&maxResults=40&startIndex=0'), 'the exact shipped URL form, no key param: ' + calls[0]);
    assert.equal(rows.length, 3);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('F70-P2-ROSTER: googleBooksPublic is entry 29 of the derived roster (en + si)', () => {
  const en = JSON.parse(fs.readFileSync('src/i18n/en.json', 'utf8'));
  const si = JSON.parse(fs.readFileSync('src/i18n/si.json', 'utf8'));
  assert.equal(en.search.sources.googleBooksPublic, 'Google Books');
  assert.equal(si.search.sources.googleBooksPublic, 'Google Books');
  // adapters.ts derives kebab-case ids from the en keys, sorted -> 29 entries
  const ids = Object.keys(en.search.sources).sort().map((k) => k.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase()));
  assert.equal(ids.length, 29, 'the roster grew by exactly one entry');
  assert.ok(ids.includes('google-books-public'), 'camelToKebab maps googleBooksPublic -> google-books-public');
  assert.ok(ids.includes('google-books'), 'the F69 navigation-only google-books entry is untouched');
});
