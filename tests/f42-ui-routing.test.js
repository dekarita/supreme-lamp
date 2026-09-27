// [F42] ?ui=v2 must ACTUALLY reach v2: query normalisation, fail-visible
// staging, and the v1 -> v2 link builder. Zero-dependency (node:test only):
// this file runs BEFORE `pnpm install` in launch-gates.
// Run: node --test tests/f42-ui-routing.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const lf = (s) => s.replace(/\r\n?/g, '\n');
const srv = lf(fs.readFileSync('payloads/ghrdp-server.ps1', 'utf8'));
const ui = lf(fs.readFileSync('payloads/ui.html', 'utf8'));
const wf = lf(fs.readFileSync('.github/workflows/main.yml', 'utf8'));
const gates = lf(fs.readFileSync('.github/workflows/launch-gates.yml', 'utf8'));
const psTest = lf(fs.readFileSync('tests/f27-windows.ps1', 'utf8'));

// --- §1 the shipped algorithm, mirrored line-for-line for the unit matrix ----
// PowerShell: $qNorm = ($target.Substring($qAt + 1)).Replace('?', '&')
//             foreach ($kv in ($qNorm -split '&')) { ... UnescapeDataString ... }
function parseQueryShipped(target) {
  const qAt = target.indexOf('?');
  const out = {};
  if (qAt < 0) return out;
  const qNorm = target.slice(qAt + 1).replace(/\?/g, '&');
  for (const kv of qNorm.split('&')) {
    const eq = kv.indexOf('=');
    if (eq > 0) {
      out[decodeURIComponent(kv.slice(0, eq)).toLowerCase()] = decodeURIComponent(kv.slice(eq + 1));
    }
  }
  return out;
}

test('F42-1 server normalises every literal "?" to "&" BEFORE splitting on "&"', () => {
  const norm = srv.split('\n').findIndex((l) => l.includes(".Replace('?', '&')"));
  const split = srv.split('\n').findIndex((l) => l.includes("($qNorm -split '&')"));
  assert.ok(norm > 0, 'server lacks the ?->& query normalisation');
  assert.ok(split > norm, 'normalisation must run BEFORE the & split');
  const block = srv.split('\n').slice(norm, split + 1).join('\n');
  assert.match(block, /Substring\(\$qAt \+ 1\)/, 'normalisation must start after the FIRST ?');
  // decode happens per PAIR, after the split (an encoded %3F stays a value)
  const decode = srv.split('\n').findIndex((l, i) => i > split && l.includes('UnescapeDataString'));
  assert.ok(decode > split, 'pairs must be url-decoded AFTER the split');
});

test('F42-1 unit: both URL forms and the encoded form parse ui=v2 with a clean key', () => {
  const amp = parseQueryShipped('/?key=K1&ui=v2');
  assert.equal(amp.key, 'K1');
  assert.equal(amp.ui, 'v2');
  assert.equal(amp.key.includes('?'), false);
  const glued = parseQueryShipped('/?key=K1?ui=v2');
  assert.equal(glued.key, 'K1', 'the key must not swallow the glued ui fragment');
  assert.equal(glued.ui, 'v2', 'the double-? form must reach v2');
  assert.equal(glued.key.includes('ui='), false);
  const enc = parseQueryShipped('/?key=K%201?ui=v2&x=a%26b');
  assert.equal(enc.key, 'K 1');
  assert.equal(enc.ui, 'v2');
  assert.equal(enc.x, 'a&b', 'an encoded & must not split a pair');
  assert.equal(parseQueryShipped('/').ui, undefined, 'no query -> no ui param');
  assert.equal(parseQueryShipped('/?ui=v2').ui, 'v2');
});

test('F42-1 unit: the shipped parser is exercised for real in the Windows lab', () => {
  for (const pin of [
    "Get-RequestParts \"GET /?key=K1&ui=v2 HTTP/1.1",
    "Get-RequestParts \"GET /?key=K1?ui=v2 HTTP/1.1",
    "Get-RequestParts \"GET /?key=K%201?ui=v2&x=a%26b HTTP/1.1",
  ]) assert.ok(psTest.includes(pin), 'Windows-native parser test missing: ' + pin);
});

// --- §2 fail-visible v2 ------------------------------------------------------
const BANNER_TEXT = 'ui-v2.html not staged in this run - main.yml stage step failed; re-dispatch or check CI';

test('F42-2 a ui=v2 request with no staged v2 file serves v1 PLUS a red banner (never silent)', () => {
  assert.ok(srv.includes('$v2Missing = $true'), 'server has no missing-v2 branch flag');
  assert.ok(srv.includes('uiV2MissingBanner'), 'the banner div id is missing');
  assert.ok(srv.includes(BANNER_TEXT), 'the banner/log text is missing');
  assert.ok(/background:#7f1d1d/.test(srv), 'the banner is not red');
  assert.ok(srv.includes("(?i)(<body[^>]*>)"), 'the banner is not injected at the top of the document');
  assert.ok(srv.includes("Write-Host ('[F42] V2-MISSING: ' + $v2BannerText"), 'no server log line carries the banner text');
  // the missing-v2 branch must stay HTTP 200 (a page the operator can read)
  const i = srv.indexOf('$v2Missing = $false');
  const region = srv.slice(i, srv.indexOf('if ($path -eq', i));
  assert.ok(region.includes('Send-ClientResponse -Stream $stream -Code 200'), 'the fallback must answer 200');
  // fail-closed is replaced by fail-VISIBLE: no silent `if wantV2 -> v1` any more
  assert.equal(/if \(\$wantV2 -and \(Test-Path -LiteralPath \$script:UiV2Path\)\) \{ \$uiFile = \$script:UiV2Path \}/.test(srv), false,
    'the silent v1-on-missing branch is back');
});

test('F42-2 the banner never carries key/token material', () => {
  const text = srv.slice(srv.indexOf('$v2BannerText ='), srv.indexOf('Send-ClientResponse -Stream $stream -Code 200', srv.indexOf('$v2BannerText =')));
  assert.equal(/\$key|\$tok|query\[/.test(text), false, 'banner construction must not interpolate the key/token');
});

// --- §4 staging assert -------------------------------------------------------
test('F42-4 main.yml stage step halts loudly when ui-v2.html is missing/truncated', () => {
  assert.ok(wf.includes("Join-Path $root 'ui-v2.html'"), 'stage step does not point at C:\\ghrdp\\ui-v2.html');
  assert.ok(wf.includes("if (-not (Test-Path -LiteralPath $v2p)) { throw 'ui-v2.html staging failed - build artifact missing' }"),
    'existence assert (Test-Path + throw) missing');
  assert.ok(wf.includes('if ($v2len -le 51200) { throw'), 'a size assert (> 50KB) is missing');
  // [F43] the assert must sit AFTER the dist-ui artifact is copied to ui-v2.html
  const copyAt = wf.indexOf("Copy-Item -LiteralPath $f43src -Destination (Join-Path $root 'ui-v2.html') -Force");
  const assertAt = wf.indexOf('$v2len = (Get-Item -LiteralPath $v2p).Length');
  assert.ok(copyAt > 0 && assertAt > copyAt, 'the assert must run after the dist-ui artifact is copied to ui-v2.html');
});

// --- §3 v1 link builder ------------------------------------------------------
test('F42-3 v1 top bar preview link builds its href via URLSearchParams (never hand-concatenated)', () => {
  assert.ok(ui.includes('id="v2PreviewLink"'), 'the v1 top-bar "Preview v2 UI" link is missing');
  assert.ok(ui.includes('Preview v2 UI'), 'the link label is missing');
  assert.ok(ui.includes('function v2PreviewHref(base)'), 'the link builder is missing');
  assert.ok(ui.includes("u.searchParams.set('ui','v2')"), 'the builder must use URLSearchParams.set');
  assert.ok(ui.includes("a.setAttribute('href',v2PreviewHref())"), 'the link does not use the builder');
  assert.equal(/['"`]\?ui=v2['"`]\s*\+\s*(location|window)/.test(ui), false, 'a hand-concatenated ?ui=v2 href is present');
  assert.equal(/href\s*=\s*["']\?ui=v2["']/.test(ui), false, 'a literal ?ui=v2 href is present');
});

// --- §5 gate + e2e wiring ----------------------------------------------------
test('F42-5 launch-gates pins the F42 contract and the e2e spec covers all three cases', () => {
  assert.ok(gates.includes('F42'), 'launch-gates carries no F42 gate');
  assert.ok(gates.includes(BANNER_TEXT), 'launch-gates does not pin the banner text');
  assert.ok(gates.includes('ui-v2.html staging failed - build artifact missing'), 'launch-gates does not pin the staging assert');
  const spec = lf(fs.readFileSync('src/tests/e2e/f42-ui-routing.spec.ts', 'utf8'));
  for (const pin of ['key=k&ui=v2', 'key=k?ui=v2', 'uiV2MissingBanner', 'bb-elapsed']) {
    assert.ok(spec.includes(pin), 'e2e spec missing case: ' + pin);
  }
  // the fixture mirrors the shipped server contract (normalise + fail-visible)
  const fx = lf(fs.readFileSync('src/tests/e2e/f42-fixture.ts', 'utf8'));
  assert.ok(fx.includes('replace(/\\?/g, "&")'), 'the fixture does not normalise ?->&');
  assert.ok(fx.includes('F42_BANNER_TEXT'), 'the fixture owns no banner text');
  assert.ok(fx.includes('missingV2'), 'the fixture owns no missing-v2 branch');
});
