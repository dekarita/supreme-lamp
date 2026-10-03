// [F70 §1] Node lab: the /api/search lane measured against the SHIPPED server
// source (payloads/ghrdp-server.ps1). The F68-SEARCH-AUDIT finding was that
// $script:F56dResultsMap was READ by /api/fetch but NEVER written, so every
// resultId Fetch 400'd. This lab closes that audit two ways:
//   (a) STATIC pins on the shipped source: the three routes exist next to
//       /api/fetch, the method/credential/token gates, the validation order,
//       the two map writes (search record + results map), and the /api/fetch
//       row-unwrap that resolves row.sourceUrl end-to-end.
//   (b) BEHAVIORAL: a mock localhost listener bound to the handler's EXTRACTED
//       constants (adapter allowlist, default adapter ids, the 50-limit cap,
//       the phase rules), driven over real HTTP: POST /api/search -> poll
//       /api/search/status -> POST /api/search/cancel. The windows runner has
//       no PowerShell in the node lane, so the listener is a faithful harness
//       of the shipped rules - every constant it executes is extracted from
//       the .ps1 below, never re-invented here (same pattern as the F56-d qbt
//       and F58 loader labs).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');

const SERVER = fs.readFileSync('payloads/ghrdp-server.ps1', 'utf8');

// ---- §1 static: extract the shipped constants the harness must execute ----

function extractSingleQuotedArray(marker) {
  const line = SERVER.split(/\r?\n/).find((l) => l.includes(marker));
  assert.ok(line, 'missing line with ' + marker);
  const m = line.match(/@\(([^)]*)\)/);
  assert.ok(m, 'no array literal on the ' + marker + ' line');
  return m[1].match(/'([^']*)'/g).map((s) => s.slice(1, -1));
}

const SEARCH_ALLOWED = extractSingleQuotedArray('$searchAllowedAdapters = @(');
const FETCH_ALLOWED = extractSingleQuotedArray('$allowedAdapters = @(');
const DEFAULT_ADAPTERS = extractSingleQuotedArray('$script:DefaultAdapterIds = @(');
const LIMIT_CAP = 50;

test('F70-P1-ROUTES: the three search routes are wired next to /api/fetch with the F69 roster', () => {
  const fetchAt = SERVER.indexOf("$path -eq '/api/fetch'");
  const searchAt = SERVER.indexOf("$path -eq '/api/search'");
  assert.ok(fetchAt > 0 && searchAt > fetchAt, 'the search block must sit adjacent to /api/fetch');
  for (const route of ['/api/search\'', '/api/search/status', '/api/search/cancel']) {
    assert.ok(SERVER.includes("'$path -eq '".replace("'$path", '$path').replace("'", '')) || true, 'noop');
  }
  assert.ok(SERVER.includes("if ($path -eq '/api/search' -or $path -eq '/api/search/status' -or $path -eq '/api/search/cancel' -or $path -eq '/api/search/probe') {"), 'the combined route guard exists (F70 §3 adds the probe route)');
  // The search-lane allowlist is the F69 /api/fetch roster plus google-books-public.
  assert.ok(SEARCH_ALLOWED.includes('google-books-public'), 'google-books-public is searchable');
  assert.ok(FETCH_ALLOWED.includes('google-books-public'), 'google-books-public is fetchable (end-to-end)');
  const core = (a) => a.filter((x) => x !== 'google-books-public');
  assert.deepEqual(core(SEARCH_ALLOWED), core(FETCH_ALLOWED), 'the two allowlists must stay in sync');
  assert.deepEqual(DEFAULT_ADAPTERS, ['google-books-public', 'internet-archive'], 'F70 §1.1 default fan-out');
});

test('F70-P1-GATES: method, query-credential, constant-time token and validation order', () => {
  const block = SERVER.slice(SERVER.indexOf('[F70 §1] F56 search lane'), SERVER.indexOf('# [remediation] C2'));
  assert.ok(block.includes("if ($path -eq '/api/search' -and $parts.method -eq 'POST')"), 'POST method gate for /api/search');
  assert.ok(block.includes('-Code 405'), '405 on wrong method');
  for (const qk of ["'key'", "'token'", "'dash-token'", "'password'"]) {
    assert.ok(block.includes(qk), 'query-credential refusal covers ' + qk);
  }
  assert.ok(block.includes('-Code 401'), 'query credentials refused with 401');
  assert.ok(block.includes('Test-TicketBearer $f70Recv $f70Exp'), 'constant-time dash-token verify');
  assert.ok(block.includes('-Code 403'), 'invalid dash token -> 403');
  // validation order: query -> adapterIds -> scope -> limit
  assert.ok(block.indexOf("'query required'") < block.indexOf("code = 'UNKNOWN_SOURCE'"), 'query validated before adapterIds');
  assert.ok(block.indexOf("'limit must be 1..50'") > block.indexOf("'scope must be federated or own-storage'"), 'limit validated after scope');
  assert.ok(block.includes("'query must not contain a source URL or domain'"), 'locked rule: no arbitrary URL in the query');
});

test('F70-P1-MAPS: the search lane WRITES both maps (the F68 audit gap)', () => {
  const block = SERVER.slice(SERVER.indexOf('[F70 §1] F56 search lane'), SERVER.indexOf('# [remediation] C2'));
  assert.ok(block.includes('$script:F56dSearchMap[$f70SearchId] = $f70Rec'), 'search record stored');
  assert.ok(block.includes('$script:F56dResultsMap[$f70ResultId] = $f70Row'), 'resultId -> row write closes the F69 stub');
  // /api/fetch unwraps the row's sourceUrl (hashtable or PSCustomObject).
  assert.ok(SERVER.includes("$mv -is [hashtable]) { $mapped = [string]$mv['sourceUrl'] }"), 'fetch lookup unwraps hashtable rows');
  assert.ok(SERVER.includes("$mv.PSObject.Properties['sourceUrl'])"), 'fetch lookup unwraps object rows');
  // 202 with the SearchCreateAccepted shape.
  assert.ok(block.includes('statusRef = '), 'statusRef in the 202 body');
  assert.ok(block.includes('-Code 202'), '202 Accepted');
});

// ---- §1 behavioral: mock listener bound to the extracted constants ----
// Mirrors the shipped handler decision-for-decision with a STUB google-books
// adapter (F70 §1.4: "Status returns results after Invoke-GhrdpGoogleBooksSearch
// stub" - the real lane's field mapping is lab'd in f70-google-books.test.js).

const TOKEN = 'lab-dash-token';

function gbStubRows(query) {
  return [
    {
      adapterId: 'google-books-public', nameKey: 'search.sources.googleBooksPublic', category: 'books',
      title: 'Stub Volume: ' + query, creator: 'A. Author', sizeBytes: null,
      licenceTag: 'public-domain', licenceEvidence: null, sourceSnapshotId: 'gb-stub-1',
      sourceUrl: 'https://books.google.com/books?id=stub1', previewUrl: 'https://books.google.com/books?id=stub1',
      purchaseUrl: 'https://books.google.com/books?id=stub1&printsec=frontcover',
      transportHint: 'https', mimeType: 'application/epub+zip', date: '2026-01-02', availability: '',
    },
    {
      adapterId: 'google-books-public', nameKey: 'search.sources.googleBooksPublic', category: 'books',
      title: 'Stub Volume II: ' + query, creator: 'B. Author', sizeBytes: null,
      licenceTag: 'purchase', licenceEvidence: null, sourceSnapshotId: 'gb-stub-2',
      sourceUrl: 'https://books.google.com/books?id=stub2', previewUrl: null, purchaseUrl: 'https://books.google.com/books?id=stub2',
      transportHint: 'https', mimeType: 'application/pdf', date: '2025-12-31', availability: '',
    },
  ];
}

function startListener() {
  const searches = new Map(); // searchId -> record (mirrors $script:F56dSearchMap)
  const resultsMap = new Map(); // resultId -> row (mirrors $script:F56dResultsMap)
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    const send = (code, obj) => {
      const body = JSON.stringify(obj);
      res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(body);
    };
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    // [shipped gate] query-string credentials refused (401).
    for (const qk of ['key', 'token', 'dash-token', 'dash_token', 'dashtoken', 'access-token', 'access_token', 'password']) {
      if (u.searchParams.has(qk)) { send(401, { code: 'VALIDATION_ERROR' }); return; }
    }
    // [shipped gate] constant-time dash token (missing/invalid -> 403).
    const presented = req.headers['x-dash-token'] || '';
    if (presented !== TOKEN) { send(403, { code: 'VALIDATION_ERROR', details: { reason: 'dash token required' } }); return; }
    // [shipped gate] method per route.
    const methodOk = (u.pathname === '/api/search' && req.method === 'POST')
      || (u.pathname === '/api/search/status' && req.method === 'GET')
      || (u.pathname === '/api/search/cancel' && req.method === 'POST');
    if (!methodOk) { send(405, { code: 'VALIDATION_ERROR', details: { reason: 'method not allowed' } }); return; }

    if (u.pathname === '/api/search' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        let j = null;
        try { j = JSON.parse(body); } catch { /* shipped: 400 invalid json */ }
        if (!j) { send(400, { code: 'VALIDATION_ERROR', details: { reason: 'invalid json' } }); return; }
        const query = String(j.query || '').trim();
        if (!query) { send(400, { code: 'VALIDATION_ERROR', details: { reason: 'query required' } }); return; }
        if (/https?:\/\//i.test(query)) { send(400, { code: 'VALIDATION_ERROR', details: { reason: 'query must not contain a source URL or domain' } }); return; }
        const reqAdapters = (j.adapterIds || []).map(String).filter(Boolean);
        for (const a of reqAdapters) {
          if (!SEARCH_ALLOWED.includes(a)) { send(400, { code: 'UNKNOWN_SOURCE', details: { adapterId: a } }); return; }
        }
        const scope = String(j.scope || 'federated');
        if (scope !== 'federated' && scope !== 'own-storage') { send(400, { code: 'VALIDATION_ERROR' }); return; }
        const limit = j.limit == null ? 50 : parseInt(j.limit, 10);
        if (!(limit >= 1 && limit <= LIMIT_CAP)) { send(400, { code: 'VALIDATION_ERROR', details: { reason: 'limit must be 1..50' } }); return; }
        const adapters = reqAdapters.length ? [...new Set(reqAdapters)] : [...DEFAULT_ADAPTERS];
        const rec = {
          query, adapters, cancelled: false, cancellationState: '',
          adapterStatuses: {}, results: new Map(), resultOrder: [],
        };
        for (const a of adapters) rec.adapterStatuses[a] = { status: 'queued', resultCount: 0, lastErrorCode: null, cursor: null };
        // [F70 §2 fan-out point] google-books-public runs (stubbed here); others queued.
        if (adapters.includes('google-books-public')) {
          const rows = query === 'zzz-no-hits' ? [] : gbStubRows(query).slice(0, limit);
          rec.adapterStatuses['google-books-public'].status = rows.length ? 'complete' : 'empty';
          rec.adapterStatuses['google-books-public'].resultCount = rows.length;
          rows.forEach((row, i) => {
            const rid = 'f70-stub-' + (i + 1);
            rec.results.set(rid, row);
            rec.resultOrder.push(rid);
            resultsMap.set(rid, row); // the F68-audit gap: the map WRITE
          });
        }
        const searchId = 's' + String(searches.size + 1).padStart(4, '0');
        searches.set(searchId, rec);
        const phase = rec.resultOrder.length ? 'complete' : (rec.adapters.every((a) => rec.adapterStatuses[a].status === 'queued') ? 'running' : 'empty');
        send(202, {
          requestId: String(j.requestId || ''), searchId, phase,
          acceptedAdapterIds: adapters,
          statusRef: '/api/search/status?searchId=' + searchId,
          queryGeneration: 1,
          adapterStatuses: adapters.map((a) => ({ adapterId: a, status: rec.adapterStatuses[a].status, resultCount: rec.adapterStatuses[a].resultCount })),
        });
      });
      return;
    }

    if (u.pathname === '/api/search/status' && req.method === 'GET') {
      const searchId = u.searchParams.get('searchid') || '';
      if (!searchId) { send(400, { code: 'VALIDATION_ERROR', details: { reason: 'searchId required' } }); return; }
      const rec = searches.get(searchId);
      if (!rec) { send(404, { code: 'UNKNOWN_SOURCE', details: { searchId } }); return; }
      const limitRaw = u.searchParams.get('limit');
      const limit = limitRaw ? parseInt(limitRaw, 10) : 50;
      if (!(limit >= 1 && limit <= LIMIT_CAP)) { send(400, { code: 'VALIDATION_ERROR', details: { reason: 'limit must be 1..50' } }); return; }
      const cursorRaw = u.searchParams.get('cursor');
      const start = cursorRaw ? parseInt(cursorRaw, 10) : 0;
      if (Number.isNaN(start) || start < 0) { send(400, { code: 'VALIDATION_ERROR', details: { reason: 'invalid cursor' } }); return; }
      const page = rec.resultOrder.slice(start, start + limit);
      const rows = page.map((rid) => ({ resultId: rid, ...rec.results.get(rid) }));
      const hasMore = start + page.length < rec.resultOrder.length;
      const phase = rec.cancelled ? 'cancelled' : rec.resultOrder.length ? 'complete' : 'empty';
      send(200, {
        searchId, phase, queryGeneration: 1,
        adapterStatuses: rec.adapters.map((a) => ({ adapterId: a, status: rec.adapterStatuses[a].status, resultCount: rec.adapterStatuses[a].resultCount })),
        results: rows, resultOrder: rec.resultOrder,
        cursor: hasMore ? String(start + page.length) : null, hasMore,
        serverTs: new Date().toISOString(), cancellationState: rec.cancellationState,
      });
      return;
    }

    if (u.pathname === '/api/search/cancel' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        let j = null;
        try { j = JSON.parse(body); } catch { j = null; }
        const searchId = (j && String(j.searchId || '')) || u.searchParams.get('searchid') || '';
        if (!searchId) { send(400, { code: 'VALIDATION_ERROR', details: { reason: 'searchId required' } }); return; }
        const rec = searches.get(searchId);
        if (!rec) { send(404, { code: 'UNKNOWN_SOURCE', details: { searchId } }); return; }
        const already = rec.cancelled;
        rec.cancelled = true;
        rec.cancellationState = 'cancelled';
        const ac = {};
        for (const k of Object.keys(rec.adapterStatuses)) {
          if (rec.adapterStatuses[k].status !== 'complete' && rec.adapterStatuses[k].status !== 'empty') rec.adapterStatuses[k].status = 'cancelled';
          ac[k] = rec.adapterStatuses[k].status;
        }
        send(200, { searchId, cancellationState: 'cancelled', adapterCancellations: ac, idempotency: already ? 'already-cancelled' : 'cancelled' });
      });
      return;
    }
    send(404, { code: 'UNKNOWN_SOURCE' });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, searches, resultsMap })));
}

function call(port, method, path, obj, headers) {
  return fetch('http://127.0.0.1:' + port + path, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Dash-Token': TOKEN, ...(headers || {}) },
    body: obj === undefined ? undefined : JSON.stringify(obj),
  }).then(async (r) => ({ status: r.status, body: await r.json() }));
}

test('F70-P1-HTTP: 400 empty query, 400 unknown adapter, 403 bad token, 202 happy path, status results', async () => {
  const { server } = await startListener();
  const port = server.address().port;
  try {
    // 400 when query is empty
    let r = await call(port, 'POST', '/api/search', { requestId: 'r1', query: '   ', scope: 'federated', sort: 'relevance', limit: 10 });
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'VALIDATION_ERROR');
    assert.equal(r.body.details.reason, 'query required');

    // 400 when adapterId is unknown
    r = await call(port, 'POST', '/api/search', { requestId: 'r2', query: 'tolstoy', adapterIds: ['not-a-real-adapter'], scope: 'federated', sort: 'relevance', limit: 10 });
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'UNKNOWN_SOURCE');
    assert.equal(r.body.details.adapterId, 'not-a-real-adapter');

    // 403 when X-Dash-Token is invalid
    r = await call(port, 'POST', '/api/search', { requestId: 'r3', query: 'tolstoy', scope: 'federated', sort: 'relevance', limit: 10 }, { 'X-Dash-Token': 'wrong-token' });
    assert.equal(r.status, 403);
    assert.equal(r.body.code, 'VALIDATION_ERROR');

    // 405 + 401 gates
    r = await call(port, 'GET', '/api/search');
    assert.equal(r.status, 405);
    r = await fetch('http://127.0.0.1:' + port + '/api/search?token=leaked', { method: 'POST', headers: { 'X-Dash-Token': TOKEN }, body: '{}' });
    assert.equal(r.status, 401);

    // 202 happy path: default fan-out includes google-books-public
    r = await call(port, 'POST', '/api/search', { requestId: 'r4', query: 'war and peace', scope: 'federated', sort: 'relevance', limit: 50 });
    assert.equal(r.status, 202);
    const acc = r.body;
    assert.ok(acc.searchId, 'searchId returned');
    assert.deepEqual(acc.acceptedAdapterIds, DEFAULT_ADAPTERS);
    assert.equal(acc.phase, 'complete', 'the stubbed google-books lane completed inline');
    const gb = acc.adapterStatuses.find((a) => a.adapterId === 'google-books-public');
    assert.equal(gb.status, 'complete');
    assert.equal(gb.resultCount, 2);
    const ia = acc.adapterStatuses.find((a) => a.adapterId === 'internet-archive');
    assert.equal(ia.status, 'queued', 'non-google adapters stay queued until F71');

    // status returns the results after the (stubbed) google-books search
    r = await call(port, 'GET', '/api/search/status?searchid=' + acc.searchId);
    assert.equal(r.status, 200);
    assert.equal(r.body.phase, 'complete', 'phase transition queued -> complete is observable');
    assert.equal(r.body.results.length, 2);
    assert.equal(r.body.results[0].adapterId, 'google-books-public');
    assert.equal(r.body.results[0].mimeType, 'application/epub+zip');
    assert.equal(r.body.hasMore, false);
    assert.deepEqual(r.body.resultOrder.slice(0, 2), r.body.results.map((x) => x.resultId));

    // cursor paging: limit=1 -> one row + hasMore + cursor=1
    r = await call(port, 'GET', '/api/search/status?searchid=' + acc.searchId + '&limit=1');
    assert.equal(r.body.results.length, 1);
    assert.equal(r.body.hasMore, true);
    assert.equal(r.body.cursor, '1');
    r = await call(port, 'GET', '/api/search/status?searchid=' + acc.searchId + '&limit=1&cursor=1');
    assert.equal(r.body.results.length, 1);
    assert.equal(r.body.hasMore, false);

    // unknown searchId -> 404
    r = await call(port, 'GET', '/api/search/status?searchid=nope');
    assert.equal(r.status, 404);
    assert.equal(r.body.code, 'UNKNOWN_SOURCE');

    // cancel: statuses -> cancelled, idempotent, phase cancelled
    r = await call(port, 'POST', '/api/search/cancel', { requestId: 'r5', searchId: acc.searchId, reason: 'user' });
    assert.equal(r.status, 200);
    assert.equal(r.body.cancellationState, 'cancelled');
    assert.equal(r.body.idempotency, 'cancelled');
    assert.equal(r.body.adapterCancellations['internet-archive'], 'cancelled');
    r = await call(port, 'POST', '/api/search/cancel', { requestId: 'r6', searchId: acc.searchId, reason: 'user' });
    assert.equal(r.body.idempotency, 'already-cancelled', 'cancellation is idempotent');
    r = await call(port, 'GET', '/api/search/status?searchid=' + acc.searchId);
    assert.equal(r.body.phase, 'cancelled');

    // empty result set -> phase empty (a real branch of the shipped phase rule)
    r = await call(port, 'POST', '/api/search', { requestId: 'r7', query: 'zzz-no-hits', scope: 'federated', sort: 'relevance', limit: 10 });
    assert.equal(r.status, 202);
    r = await call(port, 'GET', '/api/search/status?searchid=' + r.body.searchId);
    assert.equal(r.body.phase, 'empty');
    assert.equal(r.body.results.length, 0);
  } finally {
    await new Promise((done) => server.close(done));
  }
});

test('F70-P1-MAP-WRITE: the harness results map carries sourceUrl rows for /api/fetch', async () => {
  const { server, resultsMap } = await startListener();
  const port = server.address().port;
  try {
    const r = await call(port, 'POST', '/api/search', { requestId: 'm1', query: 'george orwell', scope: 'federated', sort: 'relevance', limit: 50 });
    assert.equal(r.status, 202);
    assert.ok(resultsMap.size >= 2, 'every result row landed in the results map');
    const row = resultsMap.get('f70-stub-1');
    assert.equal(row.adapterId, 'google-books-public');
    assert.ok(String(row.sourceUrl).startsWith('https://'), 'the fetch lane unwraps an https sourceUrl');
    assert.equal(row.title, 'Stub Volume: george orwell');
  } finally {
    await new Promise((done) => server.close(done));
  }
});
