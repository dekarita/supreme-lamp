// [F79] Source-bound backend contract tests: no PowerShell runtime emulation.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const server = readFileSync('payloads/ghrdp-server.ps1', 'utf8');
const five = ['github-releases', 'internet-archive', 'arxiv-public', 'wikipedia-public', 'google-books-public'];
const defaults = server.match(/\$script:DefaultFanOutAdapterIds\s*=\s*@\(([^)]*)\)/);
const strings = (text) => [...text.matchAll(/'([^']+)'/g)].map((m) => m[1]);

test('F79 backend defines exactly one locked five-source default', () => {
  assert.ok(defaults);
  assert.deepEqual(strings(defaults[1]), five);
  assert.equal((server.match(/\$script:DefaultFanOutAdapterIds\s*=/g) || []).length, 1);
});
test('F79 POST /api/search empty or omitted adapterIds consumes only that default', () => {
  assert.match(server, /\$f70Adapters = @\(\$f70ReqAdapters \| Select-Object -Unique\)\s+if \(\$f70Adapters.Count -eq 0\) \{ \$f70Adapters = @\(\$script:DefaultFanOutAdapterIds\) \}/);
  assert.doesNotMatch(server, /\$f70Adapters\s*=\s*@\(\$searchAllowedAdapters\)/);
});
test('F79 backend queues statuses only for the resolved adapter set', () => {
  assert.match(server, /foreach \(\$a in \$f70Adapters\)\s*\{\s*\$f70Rec.adapterStatuses\[\$a\] = @\{ status = 'queued'/);
});
test('F79 keeps the real F72 fan-out branches for all five canonical adapters', () => {
  for (const id of five) assert.ok(server.includes(`if ($f70Adapters -contains '${id}')`), id);
  for (const helper of ['Invoke-F72GithubSearch', 'Invoke-F72InternetArchiveSearch', 'Invoke-F72ArxivSearch', 'Invoke-F72WikipediaSearch', 'Invoke-GhrdpGoogleBooksSearch']) assert.ok(server.includes(helper), helper);
});
test('F79 search and fetch allowlists accept every canonical default', () => {
  for (const variable of ['$searchAllowedAdapters', '$allowedAdapters']) {
    const literal = server.split('\n').find((line) => line.includes(variable + ' = @('));
    assert.ok(literal);
    for (const id of five) assert.ok(strings(literal).includes(id), variable + ': ' + id);
  }
});
test('F79 canonical result/status ids and legacy Advanced aliases agree', () => {
  for (const [legacy, canonical] of [['arxiv', 'arxiv-public'], ['wikisource', 'wikipedia-public']]) {
    assert.ok(server.includes(`if ($as -eq '${legacy}') { $as = '${canonical}' }`));
    assert.ok(server.includes(`adapterId = '${canonical}'`));
    assert.ok(server.includes(`$f70Rec.adapterStatuses['${canonical}'].resultCount`));
  }
});
test('F79 frontend debug mirror matches the backend source of truth', () => {
  const fanOut = readFileSync('src/lib/search/fanOut.ts', 'utf8');
  const literal = fanOut.match(/DEFAULT_FANOUT_ADAPTER_IDS: readonly string\[\] = \[([^\]]+)\]/);
  assert.ok(literal);
  assert.deepEqual([...literal[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]), strings(defaults[1]));
  const store = readFileSync('src/stores/searchStore.ts', 'utf8');
  // [F81 §2.3/Q7=B] The empty-selection default still delegates to the
  // backend (sends []). When the operator pre-selects, intent-aware
  // ranking may reorder the adapters; that is an ADDITIVE feature on
  // top of the F79 contract.
  assert.ok(store.includes('resolveFanOutAdapters(st.adapterIds)'), 'explicit resolveFanOutAdapters call missing');
  assert.ok(store.includes('resolvedAdapters = [];'), 'empty-selection default fan-out is missing');
});
test('F79 CI caches Chromium and launches an executable, never a fake browser directory', () => {
  const workflow = readFileSync('.github/workflows/e2e-ui.yml', 'utf8');
  const config = readFileSync('playwright.e2e-ui.config.ts', 'utf8');
  assert.match(workflow, /uses: actions\/cache@v4/);
  assert.match(workflow, /PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/);
  assert.doesNotMatch(workflow, /(?:npx|exec) playwright install/);
  assert.doesNotMatch(workflow, /PLAYWRIGHT_BROWSERS_PATH=/);
  assert.match(config, /executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH/);
  assert.match(config, /vite preview --host 0.0.0.0/);
  const gates = readFileSync('.github/workflows/launch-gates.yml', 'utf8');
  assert.ok(!gates.includes("grep -qF 'w-[60%]' src/pages/search/CommandBar.tsx"));
  assert.equal(gates.split("grep -qF 'max-w-[760px]' src/pages/search/CommandBar.tsx").length - 1, 2);
});
test('F79 screenshot artifact is SHA-named, mandatory, always uploaded, retained 14 days', () => {
  const workflow = readFileSync('.github/workflows/e2e-ui.yml', 'utf8');
  const upload = workflow.slice(workflow.indexOf('- name: Upload screenshots'), workflow.indexOf('- name: Publish screenshot'));
  for (const token of ['if: always()', 'uses: actions/upload-artifact@v4', 'name: screenshots-${{ github.sha }}', 'path: screenshots/', 'if-no-files-found: error', 'retention-days: 14']) assert.ok(upload.includes(token), token);
});
