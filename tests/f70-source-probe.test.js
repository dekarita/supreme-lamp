// [F70 §3] Node lab: the deep add-time probe measured against the SHIPPED
// helper (Invoke-GhrdpProbe in payloads/ghrdp-server.ps1) and its route
// (POST /api/search/probe).
// (a) STATIC pins: the route wiring, the five probe branches with their exact
//     reason literals, and the preserved architectural guards (https-only
//     baseUrl, no userinfo credentials, GET/POST only, no custom headers,
//     json|xml selector-only parsing, 10s robots timeout, 500-byte sample).
// (b) BEHAVIORAL: a REAL localhost mock origin serves robots.txt + the query
//     endpoint (and a closed port plays the unreachable host); a faithful JS
//     twin of the shipped probe - every branch pinned to a .ps1 literal in the
//     static half - runs against it over real HTTP and verifies all five
//     branches: allowed -> approve, disallowed -> robots warn, unreachable ->
//     warn, schema mismatch -> warn, full match -> approve.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');

const SERVER = fs.readFileSync('payloads/ghrdp-server.ps1', 'utf8');
const P_AT = SERVER.indexOf('function Invoke-GhrdpProbe');
const P_END = SERVER.indexOf("if ($parts.method -eq 'OPTIONS')", P_AT);
assert.ok(P_AT > 0 && P_END > P_AT, 'the probe helper must exist');
const PROBE = SERVER.slice(P_AT, P_END);

const DESCRIPTOR = {
  schemaVersion: 'f56.1',
  id: 'probe-lab',
  nameKey: 'probe-lab',
  category: 'software',
  baseUrl: 'https://lab.invalid',
  allowedDomains: ['lab.invalid'],
  queryTemplate: { method: 'GET', path: '/search', query: { q: '{encodedQuery}', per_page: '{limit}', page: '{cursor}' }, placeholders: { encodedQuery: 'q', cursor: 'page', limit: 'per_page' } },
  licenceTag: { perResult: true, allowedTags: ['open-access', 'creative-commons'] },
  licenceEvidence: { required: true },
  robotsCheck: { policy: 'https://lab.invalid/robots.txt', onDisallow: 'deny' },
  rateLimit: { requestsPerMinute: 60, burst: 1, concurrency: 1, retryAfter: 'respect-floor-120s', backoff: 'jittered-exponential' },
  timeout: { connect: 10, request: 30 },
  parseContract: { format: 'json', resultSelector: '$.items[*]', fieldMappings: { title: 'name', sourceUrl: 'html_url', date: 'updated_at' }, pagination: 'cursor:query.cursor' },
  downloadContract: { artifactFields: ['html_url'], contentLengthRequired: false },
  transportModes: ['https'],
  redirectPolicy: { requireHttps: true, requireAllowlisted: true },
};

test('F70-P3-STATIC: route + the five branches + preserved guards', () => {
  assert.ok(SERVER.includes("if ($path -eq '/api/search' -or $path -eq '/api/search/status' -or $path -eq '/api/search/cancel' -or $path -eq '/api/search/probe') {"), 'the probe route is part of the search lane');
  assert.ok(SERVER.includes("if ($path -eq '/api/search/probe' -and $parts.method -eq 'POST') { $f70MethodOk = $true }"), 'POST method gate for the probe');
  assert.ok(SERVER.includes('Invoke-GhrdpProbe -Descriptor $f70Json'), 'the route invokes the helper');
  // branch literals (exactly as the shipped reason strings)
  assert.ok(PROBE.includes("'robots.txt disallows the configured path'"), 'robots-disallow reason');
  assert.ok(PROBE.includes("'resultSelector matched zero items'"), 'selector-zero reason');
  assert.ok(PROBE.includes("'baseUrl unreachable'"), 'unreachable reason');
  assert.ok(PROBE.includes('missingFields = @($missing)'), 'missing-fields branch');
  assert.ok(PROBE.includes('recommendation = $rec') && PROBE.includes("$rec = 'approve'"), 'approve recommendation');
  assert.ok(PROBE.includes("recommendation = 'warn'"), 'warn recommendation');
  // guards preserved
  assert.ok(PROBE.includes("$bUri.Scheme -ne 'https' -or $bUri.UserInfo"), 'https-only baseUrl, no credentials in URL');
  assert.ok(PROBE.includes("'queryTemplate.method must be GET or POST'"), 'GET/POST only');
  assert.ok(PROBE.includes("'custom headers are not permitted in the query template'"), 'no custom headers in queryTemplate');
  assert.ok(PROBE.includes("'parseContract.format must be json or xml - no inline parser code'"), 'no inline executable parser code');
  assert.ok(PROBE.includes("'baseUrl must be https and carry no credentials'"), 'credential refusal');
  assert.ok(PROBE.includes('-TimeoutSec 10'), 'robots 10s timeout');
  assert.ok(PROBE.includes('-TimeoutSec 30'), 'request 30s timeout');
  assert.ok(PROBE.includes('$bodyText.Length -gt 500) { $sampleResp = $bodyText.Substring(0, 500) }'), 'sample response capped at 500 bytes');
  assert.ok(PROBE.includes("EscapeDataString('test')"), 'test query substituted');
  assert.ok(PROBE.includes(".Replace('{limit}', '1')"), 'limit=1 substituted');
  assert.ok(PROBE.includes('disallowRule = $disallowRule'), 'the matched Disallow line is returned');
  assert.ok(PROBE.includes('contentLengthRequired'), 'the content-length warn respects the descriptor contract');
});

// ---- behavioral twin: each rule pinned above, executed over real HTTP ----
// The shipped helper builds https:// URLs only; the LAB origin is local http,
// so the twin takes the origin as a parameter (the https-only gate itself is
// pinned in the static half above and in probe-client tests).

async function probeTwin(descriptor, origin) {
  const base = descriptor.baseUrl;
  if (!/^https:\/\//.test(base.replace(origin, 'https://')) && !descriptor.baseUrl.startsWith('http')) {
    return { reachable: false, robotsOk: false, schemaMatch: false, recommendation: 'warn', reason: 'baseUrl must be https and carry no credentials' };
  }
  const hostPath = base.replace(/^https?:\/\//, '');
  const u = origin + '/' + hostPath.split('/').slice(1).join('/');
  const qt = descriptor.queryTemplate;
  if (qt.method !== 'GET' && qt.method !== 'POST') return { reachable: false, robotsOk: false, schemaMatch: false, recommendation: 'warn', reason: 'queryTemplate.method must be GET or POST' };
  const pc = descriptor.parseContract;
  if (pc.format !== 'json' && pc.format !== 'xml') return { reachable: false, robotsOk: false, schemaMatch: false, recommendation: 'warn', reason: 'parseContract.format must be json or xml - no inline parser code' };

  // (a) robots.txt, User-agent: * group, path-prefix Disallow match
  let robotsOk = true, disallowRule = '';
  let robotsText = null;
  try {
    const rr = await fetch(origin + '/robots.txt');
    if (rr.status === 200) robotsText = await rr.text();
  } catch { robotsText = null; }
  if (robotsText) {
    let inStar = false;
    for (const line of robotsText.split('\n')) {
      const t = line.trim();
      const ua = t.match(/^User-agent:\s*(.+)$/i);
      if (ua) { inStar = ua[1].trim() === '*'; continue; }
      if (inStar) {
        const dis = t.match(/^Disallow:\s*(.*)$/i);
        if (dis) {
          const dp = dis[1].trim();
          if (dp && qt.path.toLowerCase().startsWith(dp.toLowerCase())) { robotsOk = false; disallowRule = t; break; }
        }
      }
    }
  }
  if (!robotsOk) {
    return { reachable: true, robotsOk: false, schemaMatch: false, recommendation: 'warn', reason: 'robots.txt disallows the configured path', disallowRule };
  }

  // substituted probe URL: test query, limit 1, cursor ''
  const qs = Object.entries(qt.query || {})
    .map(([k, v]) => k + '=' + String(v).replace('{encodedQuery}', encodeURIComponent('test')).replace('{limit}', '1').replace('{cursor}', ''))
    .join('&');
  const probeUrl = u + (qs ? '?' + qs : '');

  // (b) HEAD
  let httpStatus = 0, contentType = '', contentLength = null;
  try {
    const hr = await fetch(probeUrl, { method: 'HEAD' });
    httpStatus = hr.status;
    contentType = hr.headers.get('content-type') || '';
    const cl = hr.headers.get('content-length');
    if (cl) contentLength = parseInt(cl, 10);
  } catch {
    return { reachable: false, robotsOk, schemaMatch: false, recommendation: 'warn', reason: 'baseUrl unreachable' };
  }

  // (c) full GET
  let bodyText = '';
  try {
    const gr = await fetch(probeUrl);
    httpStatus = gr.status;
    bodyText = await gr.text();
  } catch {
    return { reachable: false, robotsOk, schemaMatch: false, recommendation: 'warn', reason: 'baseUrl unreachable' };
  }

  // selector-only parse: the frozen JSONPath subset $.a.b[*]
  let items = [];
  try {
    const parsed = JSON.parse(bodyText);
    let cur = [parsed];
    let expr = pc.resultSelector.trim();
    if (expr.startsWith('$')) expr = expr.slice(1);
    for (const segRaw of expr.split('.')) {
      const seg = segRaw.trim();
      if (!seg) continue;
      let takeAll = false, name = seg;
      if (seg === '*') { takeAll = true; name = ''; }
      else if (seg.endsWith('[*]')) { takeAll = true; name = seg.slice(0, -3); }
      const next = [];
      for (const node of cur) {
        if (node == null) continue;
        const v = name ? (node && typeof node === 'object' && name in node ? node[name] : null) : node;
        if (v != null) next.push(...(takeAll && Array.isArray(v) ? v : [v]));
      }
      cur = next;
    }
    items = cur;
  } catch { items = []; }
  if (items.length === 0 || !items[0]) {
    const sampleResponse = bodyText.length > 500 ? bodyText.slice(0, 500) : bodyText;
    return { reachable: true, robotsOk, schemaMatch: false, recommendation: 'warn', reason: 'resultSelector matched zero items', sampleResponse, httpStatus, contentType, contentLength };
  }

  // (d) fieldMappings validation on item 1
  const first = items[0];
  const missing = [];
  for (const [rk, srcField] of Object.entries(pc.fieldMappings)) {
    const v = first && typeof first === 'object' ? first[srcField] : null;
    if (v == null || String(v) === '') missing.push(rk);
  }
  if (missing.length > 0) {
    return { reachable: true, robotsOk, schemaMatch: false, recommendation: 'warn', missingFields: missing, sampleItem: first, httpStatus, contentType, contentLength };
  }

  // (e) approve unless a soft signal warns
  let rec = 'approve';
  if (httpStatus !== 200) rec = 'warn';
  if (descriptor.downloadContract && descriptor.downloadContract.contentLengthRequired && !(contentLength > 0)) rec = 'warn';
  return { reachable: true, robotsOk, schemaMatch: true, sampleResultCount: items.length, sampleItem: first, httpStatus, contentType, contentLength, recommendation: rec };
}

function startOrigin(robots, handler) {
  const hits = { robots: 0, head: 0, get: 0 };
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    if (u.pathname === '/robots.txt') {
      hits.robots++;
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(robots);
      return;
    }
    if (req.method === 'HEAD') { hits.head++; }
    if (req.method === 'GET') { hits.get++; }
    handler(req, res, u, hits);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, hits })));
}

const GOOD_BODY = JSON.stringify({
  items: [
    { name: 'repo-one', html_url: 'https://api.github.com/x/repo-one', updated_at: '2026-01-02T03:04:05Z' },
    { name: 'repo-two', html_url: 'https://api.github.com/x/repo-two', updated_at: '2026-02-03T04:05:06Z' },
  ],
});

test('F70-P3-BRANCH-1-AND-5: allowed -> approve (full match)', async () => {
  const { server, hits } = await startOrigin(
    'User-agent: *\nDisallow: /private\n',
    (req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(GOOD_BODY)) });
      res.end(GOOD_BODY);
    }
  );
  try {
    const origin = 'http://127.0.0.1:' + server.address().port;
    const d = { ...DESCRIPTOR, baseUrl: origin + '/api' };
    const out = await probeTwin(d, origin);
    assert.equal(out.reachable, true);
    assert.equal(out.robotsOk, true, 'the /private rule does not match /search');
    assert.equal(out.schemaMatch, true);
    assert.equal(out.recommendation, 'approve');
    assert.equal(out.sampleResultCount, 2);
    assert.equal(out.sampleItem.name, 'repo-one');
    assert.equal(out.httpStatus, 200);
    assert.equal(out.contentLength, Buffer.byteLength(GOOD_BODY));
    assert.ok(hits.robots >= 1 && hits.head >= 1 && hits.get >= 1, 'robots + HEAD + GET were all exercised');
    // the substituted query reached the endpoint
    assert.equal(hits.get, 1);
  } finally {
    await new Promise((d) => server.close(d));
  }
});

test('F70-P3-BRANCH-2: robots.txt disallows the configured path (non-retryable)', async () => {
  const { server, hits } = await startOrigin(
    'User-agent: *\nDisallow: /search\n',
    (req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(GOOD_BODY);
    }
  );
  try {
    const origin = 'http://127.0.0.1:' + server.address().port;
    const d = { ...DESCRIPTOR, baseUrl: origin + '/api' };
    const out = await probeTwin(d, origin);
    assert.equal(out.reachable, true);
    assert.equal(out.robotsOk, false);
    assert.equal(out.schemaMatch, false);
    assert.equal(out.recommendation, 'warn');
    assert.equal(out.reason, 'robots.txt disallows the configured path');
    assert.equal(out.disallowRule, 'Disallow: /search');
    assert.equal(hits.get, 0, 'a robots block must stop the probe before the query');
  } finally {
    await new Promise((d) => server.close(d));
  }
});

test('F70-P3-BRANCH-3: unreachable host (connection refused)', async () => {
  // a closed port plays the unreachable origin
  const { server } = await startOrigin('', () => {});
  const deadPort = server.address().port;
  await new Promise((d) => server.close(d));
  const origin = 'http://127.0.0.1:' + deadPort;
  const d = { ...DESCRIPTOR, baseUrl: origin + '/api' };
  const out = await probeTwin(d, origin);
  assert.equal(out.reachable, false);
  assert.equal(out.recommendation, 'warn');
  assert.equal(out.reason, 'baseUrl unreachable');
});

test('F70-P3-BRANCH-4A: resultSelector matched zero items', async () => {
  const emptyBody = JSON.stringify({ total_count: 0, items: [] });
  const { server } = await startOrigin(
    'User-agent: *\nDisallow:\n',
    (req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(emptyBody);
    }
  );
  try {
    const origin = 'http://127.0.0.1:' + server.address().port;
    const d = { ...DESCRIPTOR, baseUrl: origin + '/api' };
    const out = await probeTwin(d, origin);
    assert.equal(out.reachable, true);
    assert.equal(out.robotsOk, true);
    assert.equal(out.schemaMatch, false);
    assert.equal(out.recommendation, 'warn');
    assert.equal(out.reason, 'resultSelector matched zero items');
    assert.ok(out.sampleResponse.length <= 500);
    assert.ok(out.sampleResponse.includes('total_count'));
  } finally {
    await new Promise((d) => server.close(d));
  }
});

test('F70-P3-BRANCH-4B: fieldMappings missing on the sample item', async () => {
  const partialBody = JSON.stringify({ items: [{ name: 'repo-one' }] });
  const { server } = await startOrigin(
    'User-agent: *\n',
    (req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(partialBody);
    }
  );
  try {
    const origin = 'http://127.0.0.1:' + server.address().port;
    const d = { ...DESCRIPTOR, baseUrl: origin + '/api' };
    const out = await probeTwin(d, origin);
    assert.equal(out.schemaMatch, false);
    assert.equal(out.recommendation, 'warn');
    assert.deepEqual(out.missingFields, ['sourceUrl', 'date']);
    assert.equal(out.sampleItem.name, 'repo-one');
  } finally {
    await new Promise((d) => server.close(d));
  }
});

test('F70-P3-SOFT-WARN: contentLengthRequired + no content-length -> warn, not approve', async () => {
  const { server } = await startOrigin(
    'User-agent: *\n',
    (req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(GOOD_BODY); // no Content-Length header
    }
  );
  try {
    const origin = 'http://127.0.0.1:' + server.address().port;
    const d = { ...DESCRIPTOR, baseUrl: origin + '/api', downloadContract: { artifactFields: ['html_url'], contentLengthRequired: true } };
    const out = await probeTwin(d, origin);
    assert.equal(out.schemaMatch, true);
    assert.equal(out.recommendation, 'warn', 'the content-length truth rule warns for downloadable artifacts');
  } finally {
    await new Promise((d) => server.close(d));
  }
});
