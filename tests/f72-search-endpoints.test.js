// F72 route contract tests. The PowerShell runtime is unavailable in this
// Linux lab, so the Windows-native HTTP harness remains the execution lane; this
// Node suite pins the route wiring, validation, exact-host guard, and map bridge.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const server = fs.readFileSync('payloads/ghrdp-server.ps1', 'utf8');
const start = server.indexOf("# [F71 §B#3/#4, §C#2.1/#2.3/#2.4/#2.6/#2.8 / F72.2-F72.3]");
const end = server.indexOf('# [remediation] C2 / agent-payload / .bat endpoints removed -> 404', start);
assert.ok(start >= 0 && end > start, 'F72 search routes are inserted after /api/fetch');
const routes = server.slice(start, end);

function adapterFunction(name) {
  const from = server.indexOf(`function ${name} {`);
  assert.ok(from >= 0, `${name} exists`);
  const next = server.indexOf('\nfunction ', from + 10);
  return server.slice(from, next < 0 ? server.length : next);
}

test('F72 POST /api/search accepts only compiled IDs and publishes accepted search state', () => {
  assert.match(routes, /if \(\$path -in @\('\/api\/search','\/api\/search\/status','\/api\/search\/cancel'\)\)/);
  assert.match(routes, /\$parts\.method -ne \$expectedMethod/);
  assert.match(routes, /Test-TicketBearer \$received \$expected/);
  assert.match(routes, /credentials are not accepted in the query string/);
  assert.match(routes, /query must contain 1-500 characters/);
  assert.match(routes, /limit must be between 1 and 50/);
  assert.match(routes, /\$script:F72AllowedAdapters -ccontains \$adapterId/);
  assert.match(routes, /\$validAdapters\.Count -gt 8/);
  assert.match(routes, /\$script:DefaultFanOutAdapterIds/);
  assert.match(routes, /\$script:F56dSearchMap\[\$searchId\] = \$state/);
  assert.match(routes, /Send-ClientResponse -Stream \$stream -Code 202/);
  assert.match(routes, /acceptedAdapterIds = @\(\$validAdapters\)/);
});

test('F72 status paging returns normalized result state and cancellation is idempotent', () => {
  for (const field of ['searchId', 'phase', 'queryGeneration', 'adapterStatuses', 'results', 'resultOrder', 'cursor', 'hasMore', 'serverTs']) {
    assert.match(routes, new RegExp(`${field}\\s*=`), `GET status contains ${field}`);
  }
  assert.match(routes, /\$state\.adapterStatuses\[\$adapterId\]\.status = 'cancelled'/);
  assert.match(routes, /cancellationState = 'cancelled'/);
  assert.match(routes, /idempotency = 'cancelled'/);
});

test('F72 result IDs bridge directly to the existing fail-closed /api/fetch lookup', () => {
  assert.match(routes, /\$script:F56dResultsMap\[\$resultId\] = \$sourceUri\.AbsoluteUri/);
  assert.match(server, /\$script:F56dResultsMap\.ContainsKey\(\$resultId\)/);
  assert.match(server, /resultId lookup unavailable; use urlImport\.url/);
});

test('F72 outgoing API and result URLs use exact HTTPS hosts and block redirects', () => {
  const exactGuard = adapterFunction('Get-F72ExactHttpsUri');
  const httpGet = adapterFunction('Invoke-F72HttpGet');
  assert.match(exactGuard, /\$hostName -ceq \[string\]\$allowed/);
  assert.match(exactGuard, /\$u\.Scheme -cne 'https'/);
  assert.match(exactGuard, /\$u\.Port -ne 443/);
  assert.match(exactGuard, /'api_key','apikey'/);
  assert.match(httpGet, /-MaximumRedirection 0/);
  assert.match(httpGet, /2097152/);
});

test('F72 wires five fixed adapters without provider keys or custom source parsers', () => {
  const expected = [
    ['Invoke-F72GithubReleases', 'api.github.com'],
    ['Invoke-F72InternetArchive', 'archive.org'],
    ['Invoke-F72ArxivPublic', 'export.arxiv.org'],
    ['Invoke-F72WikipediaPublic', 'en.wikipedia.org'],
    ['Invoke-F72GoogleBooksPublic', 'www.googleapis.com'],
  ];
  for (const [name, host] of expected) {
    const fn = adapterFunction(name);
    assert.ok(fn.includes(`-ExpectedHost '${host}'`), `${name} pins ${host}`);
    assert.match(fn, /New-F72SearchResult/);
  }
  assert.match(server, /\$script:DefaultFanOutAdapterIds = @\('github-releases','internet-archive','arxiv-public','wikipedia-public','google-books-public'\)/);
  assert.doesNotMatch(server, /GHRDP_GOOGLE_API_KEY|GHRDP_GOOGLE_CX/);
});
