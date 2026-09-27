// [F43] v2 is the default UI. Resolution table, Classic UI escape, 219-id lock.
// Zero-dependency (node:test only): runs before pnpm install in launch-gates.
// Run: node --test tests/f43-default-v2.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const lf = (s) => s.replace(/\r\n?/g, '\n');
const srv = lf(fs.readFileSync('payloads/ghrdp-server.ps1', 'utf8'));
const wf = lf(fs.readFileSync('.github/workflows/main.yml', 'utf8'));
const shell = lf(fs.readFileSync('src/components/layout/AppShell.tsx', 'utf8'));
const en = JSON.parse(fs.readFileSync('src/i18n/en.json', 'utf8'));
const si = JSON.parse(fs.readFileSync('src/i18n/si.json', 'utf8'));

// Mirror of the shipped decision (flag is pinned $true below):
//   $wantV2 = $script:UiV2Default -or ($uiSel -eq 'v2')
//   if ($uiSel -eq 'v1') { $wantV2 = $false }
function resolveUi(ui, fileExists, uiV2Default) {
  let wantV2 = uiV2Default || ui === 'v2';
  if (ui === 'v1') wantV2 = false;
  if (wantV2 && fileExists) return { served: 'v2', banner: false };
  return { served: 'v1', banner: wantV2 };
}

test('F43-1 default flag is v2 and the resolution lines are the shipped ones', () => {
  assert.ok(srv.includes('$script:UiV2Default = $true'), 'UiV2Default must be $true');
  assert.equal(srv.includes('$script:UiV2Default = $false'), false, 'the opt-in-only flag came back');
  assert.ok(srv.includes("$wantV2 = $script:UiV2Default -or ($uiSel -eq 'v2')"));
  assert.ok(srv.includes("if ($uiSel -eq 'v1') { $wantV2 = $false }"));
  assert.ok(srv.includes('uiV2MissingBanner'));
  assert.ok(srv.includes('[F42] V2-MISSING: '));
  assert.ok(srv.includes('ui-v2.html not staged in this run - main.yml stage step failed; re-dispatch or check CI'));
});

test('F43-1 resolution table: v1 / v2 / default / missing-file banner', () => {
  const rows = [
    ['v1', true, 'v1', false],
    ['v1', false, 'v1', false],
    ['v2', true, 'v2', false],
    ['v2', false, 'v1', true],
    ['', true, 'v2', false],
    ['', false, 'v1', true],
    ['other', true, 'v2', false],
    ['other', false, 'v1', true],
  ];
  for (const [ui, exists, served, banner] of rows) {
    const got = resolveUi(ui, exists, true);
    assert.equal(got.served, served, 'ui=' + (ui || '(none)') + ' exists=' + exists);
    assert.equal(got.banner, banner, 'banner ui=' + (ui || '(none)') + ' exists=' + exists);
  }
  // a false flag must NOT be what production ships, but the table still
  // names it so a rollback cannot silently drop the missing-file banner.
  assert.equal(resolveUi('', true, false).served, 'v1');
  assert.equal(resolveUi('v2', false, false).banner, true);
});

test('F43-2 Classic UI link is ?ui=v1, i18n-keyed en+si, and carries no credential', () => {
  const i = shell.indexOf('id="classicUiLink"');
  assert.ok(i > 0, 'classicUiLink missing from TopBar');
  const tag = shell.slice(i, shell.indexOf('</a>', i));
  assert.ok(tag.includes('href="?ui=v1"'), 'Classic UI href must be ?ui=v1');
  assert.ok(tag.includes('t("nav.classicUi")'), 'Classic UI label must be i18n-keyed');
  assert.equal(/key=|token=|password=|passwd=|secret=/.test(tag), false, 'link carries credential text');
  assert.equal(en.nav.classicUi, 'Classic UI');
  assert.equal(typeof si.nav.classicUi, 'string');
  assert.ok(si.nav.classicUi.length > 0, 'Sinhala classicUi string is empty');
  assert.notEqual(si.nav.classicUi, en.nav.classicUi, 'Sinhala classicUi must not be a copy of English');
});

test('F43-3 regression ids stay 219 and the default route is the v2 bundle that renders them', () => {
  const lock = lf(fs.readFileSync('src/lib/regression-ids.ts', 'utf8'));
  const m = lock.match(/export const REGRESSION_IDS: readonly string\[\] = \[([\s\S]*?)\]/);
  assert.ok(m, 'REGRESSION_IDS missing');
  const ids = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
  assert.equal(ids.length, 219);
  assert.equal(ids.includes('classicUiLink'), false, 'the escape link must not be stuffed into the frozen 219');
  // default route serves v2, so the existing jsdom lock (ids-regression) is the
  // default-route lock. A missing file still banners instead of silent v1.
  assert.equal(resolveUi('', true, true).served, 'v2');
  assert.equal(resolveUi('', false, true).banner, true);
  assert.ok(wf.includes('node scripts/check-regression-ids.mjs'), 'build-ui must keep the 219-id check');
});

test('F43-4 main.yml publishes dist-ui and the stage step copies it before the size assert', () => {
  assert.ok(/^ {2}build-ui:/m.test(wf), 'build-ui job missing');
  assert.ok(wf.includes('needs: [build-ui]'));
  assert.ok(wf.includes('actions/upload-artifact@v4'));
  assert.ok(wf.includes('actions/download-artifact@v4'));
  assert.ok(wf.includes('name: dist-ui'));
  assert.ok(wf.includes('path: ui/dist/index.html'));
  assert.ok(wf.includes('retention-days: 1'));
  assert.ok(wf.includes('contents: read'));
  assert.ok(wf.includes('actions: write'));
  const dl = wf.indexOf('actions/download-artifact@v4');
  const stage = wf.indexOf('name: Stage files + write config.json');
  const copy = wf.indexOf("Copy-Item -LiteralPath $f43src -Destination (Join-Path $root 'ui-v2.html') -Force");
  const assertAt = wf.indexOf('if ($v2len -le 51200) { throw');
  assert.ok(dl > 0 && stage > dl, 'download-artifact must run before staging');
  assert.ok(copy > stage && assertAt > copy, 'size assert must follow the artifact copy');
  const fx = lf(fs.readFileSync('src/tests/e2e/f42-fixture.ts', 'utf8'));
  assert.ok(fx.includes('const uiV2Default = true'), 'e2e fixture must default to v2');
  assert.ok(fx.includes('query.ui === "v1"'), 'e2e fixture must honour the v1 escape');
});
