// [F43] DEFAULT-v2 cutover: flag resolution table, Classic-UI link, build-ui
// wiring in main.yml, and the 219-id lock under the default-flag config.
// Zero-dependency (node:test only): runs BEFORE `pnpm install` in launch-gates.
// Run: node --test tests/f43-default-v2.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const lf = (s) => s.replace(/\r\n?/g, '\n');
const srv = lf(fs.readFileSync('payloads/ghrdp-server.ps1', 'utf8'));
const wf = lf(fs.readFileSync('.github/workflows/main.yml', 'utf8'));
const gates = lf(fs.readFileSync('.github/workflows/launch-gates.yml', 'utf8'));
const shell = lf(fs.readFileSync('src/components/layout/AppShell.tsx', 'utf8'));
const en = lf(fs.readFileSync('src/i18n/en.json', 'utf8'));
const si = lf(fs.readFileSync('src/i18n/si.json', 'utf8'));
const ui = lf(fs.readFileSync('payloads/ui.html', 'utf8'));

// --- §1 build-ui wiring in main.yml -----------------------------------------
test('F43-1 main.yml has a parallel build-ui job that uploads dist-ui', () => {
  assert.match(wf, /^ {2}build-ui:/m, 'build-ui job missing');
  assert.ok(wf.includes('runs-on: ubuntu-latest'), 'build-ui must run on ubuntu-latest');
  assert.ok(wf.includes('pnpm install --frozen-lockfile'), 'frozen lockfile install missing');
  assert.ok(/pnpm run build|pnpm build/.test(wf), 'pnpm build missing');
  assert.ok(wf.includes('actions/upload-artifact@v4'), 'upload-artifact missing');
  assert.ok(wf.includes('name: dist-ui'), 'artifact name dist-ui missing');
  assert.ok(wf.includes('path: ui/dist/index.html'), 'upload path must be ui/dist/index.html');
  assert.ok(wf.includes('retention-days: 1'), 'retention-days: 1 missing');
  assert.ok(wf.includes('actions: write'), 'workflow permissions must grant actions: write');
});

test('F43-1 rdp job needs build-ui and downloads dist-ui BEFORE staging', () => {
  assert.ok(wf.includes('needs: [build-ui]'), 'rdp must needs: [build-ui]');
  assert.ok(wf.includes('actions/download-artifact@v4'), 'download-artifact missing');
  const dl = wf.indexOf('actions/download-artifact@v4');
  const stage = wf.indexOf('Stage files + write config.json');
  assert.ok(dl > 0 && stage > dl, 'download-artifact must precede Stage files');
  // F42 assert kept
  assert.ok(wf.includes("if (-not (Test-Path -LiteralPath $v2p)) { throw 'ui-v2.html staging failed - build artifact missing' }"));
  assert.ok(wf.includes('if ($v2len -le 51200) { throw'), 'size assert (>50KB) missing');
  assert.ok(wf.includes("Join-Path $root 'ui-v2.html'"), 'stage target C:\\ghrdp\\ui-v2.html missing');
  // no silent in-rdp vite build of the bundle
  const writeStart = wf.indexOf('Write deploy payloads');
  const kitStart = wf.indexOf('Build ghrdp-handler-kit');
  const writeBlock = wf.slice(writeStart, kitStart);
  assert.equal(/pnpm (run )?build/.test(writeBlock), false, 'Write-deploy must not pnpm-build the UI');
  assert.equal(/pnpm install/.test(writeBlock), false, 'Write-deploy must not pnpm-install');
});

// --- §2 default-flag resolution table ---------------------------------------
// Mirrors the shipped server: wantV2 = UiV2Default -or (uiSel -eq 'v2');
// if uiSel -eq 'v1' { wantV2 = $false }. Missing file => v1 + banner.
function resolveUi(uiSel, defaultOn, filePresent) {
  let wantV2 = defaultOn || uiSel === 'v2';
  if (uiSel === 'v1') wantV2 = false;
  if (!wantV2) return { file: 'v1', banner: false };
  if (filePresent) return { file: 'v2', banner: false };
  return { file: 'v1', banner: true };
}

test('F43-2 server default flag is $true (v2 is the default)', () => {
  assert.ok(srv.includes('$script:UiV2Default = $true'), 'UiV2Default must be $true');
  assert.equal(srv.includes('$script:UiV2Default = $false'), false, 'UiV2Default=$false must be gone');
  // resolution order still present
  assert.ok(srv.includes("$wantV2 = $script:UiV2Default -or ($uiSel -eq 'v2')"));
  assert.ok(srv.includes("if ($uiSel -eq 'v1') { $wantV2 = $false }"));
  assert.ok(srv.includes('uiV2MissingBanner'), 'fail-visible banner must stay');
  assert.ok(srv.includes('ui-v2.html not staged in this run - main.yml stage step failed; re-dispatch or check CI'));
});

test('F43-2 resolution table: ui=v1 -> v1; ui=v2 -> v2; no param -> v2; missing file -> v1+banner', () => {
  assert.deepEqual(resolveUi('v1', true, true), { file: 'v1', banner: false });
  assert.deepEqual(resolveUi('v2', true, true), { file: 'v2', banner: false });
  assert.deepEqual(resolveUi('', true, true), { file: 'v2', banner: false });
  assert.deepEqual(resolveUi(undefined, true, true), { file: 'v2', banner: false });
  assert.deepEqual(resolveUi('v2', true, false), { file: 'v1', banner: true });
  assert.deepEqual(resolveUi('', true, false), { file: 'v1', banner: true });
  // explicit v1 never banners even when file missing
  assert.deepEqual(resolveUi('v1', true, false), { file: 'v1', banner: false });
  // default-off (legacy) still opts in via ui=v2
  assert.deepEqual(resolveUi('v2', false, true), { file: 'v2', banner: false });
  assert.deepEqual(resolveUi('', false, true), { file: 'v1', banner: false });
});

// --- §2 Classic UI link -----------------------------------------------------
test('F43-2 v2 TopBar has a Classic UI link href=?ui=v1 (i18n en+si)', () => {
  assert.ok(shell.includes('id="classicUiLink"'), 'classicUiLink id missing');
  assert.ok(shell.includes('data-testid="classic-ui-link"'), 'classic-ui-link testid missing');
  assert.ok(shell.includes('classicUiHref'), 'classicUiHref builder missing');
  assert.ok(shell.includes('toggle.classicUi'), 'i18n key wiring missing');
  // builder must set ui=v1 via URLSearchParams or produce ?ui=v1
  assert.ok(/searchParams\.set\(\s*[\"']ui[\"']\s*,\s*[\"']v1[\"']\s*\)/.test(shell) || shell.includes('"?ui=v1"'),
    'Classic UI href must resolve to ui=v1');
  // no credentials in the link path
  assert.equal(/classicUiHref[\s\S]{0,400}(password|token|key=)/i.test(shell), false,
    'Classic UI builder must not interpolate secrets');
  const enJ = JSON.parse(en);
  const siJ = JSON.parse(si);
  assert.ok(enJ.toggle && enJ.toggle.classicUi && enJ.toggle.classicUi.short, 'en classicUi missing');
  assert.ok(siJ.toggle && siJ.toggle.classicUi && siJ.toggle.classicUi.short, 'si classicUi missing');
  assert.match(enJ.toggle.classicUi.short, /Classic UI/i);
  // v1 keeps Preview-v2
  assert.ok(ui.includes('id="v2PreviewLink"'), 'v1 Preview v2 link must stay');
  assert.ok(ui.includes("u.searchParams.set('ui','v2')"), 'v1 preview builder must stay');
});

// --- §3 gate + e2e wiring ---------------------------------------------------
test('F43-3 launch-gates pins the F43 contract and e2e covers default/v1/banner', () => {
  assert.ok(gates.includes('F43'), 'launch-gates carries no F43 gate');
  assert.ok(gates.includes('$script:UiV2Default = $true'), 'gates must pin default=true');
  assert.ok(gates.includes('needs: [build-ui]'), 'gates must pin needs: [build-ui]');
  assert.ok(gates.includes('actions/download-artifact'), 'gates must pin download-artifact');
  const spec = lf(fs.readFileSync('src/tests/e2e/f43-default-v2.spec.ts', 'utf8'));
  for (const pin of ['classic-ui-link', 'ui=v1', 'bb-elapsed', 'uiV2MissingBanner', "goto(url + \"/\")"]) {
    assert.ok(spec.includes(pin), 'e2e spec missing case: ' + pin);
  }
  const fx = lf(fs.readFileSync('src/tests/e2e/f42-fixture.ts', 'utf8'));
  assert.ok(fx.includes('UiV2Default') || fx.includes('defaultV2') || fx.includes('DEFAULT'),
    'fixture must honour the default-v2 flag');
});

test('F43-3 219-id lock file still present (jsdom smoke asserts under default)', () => {
  const lock = lf(fs.readFileSync('src/lib/regression-ids.ts', 'utf8'));
  const ids = [...lock.matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.equal(ids.length, 219, 'regression lock must stay at 219 ids, got ' + ids.length);
  assert.ok(fs.existsSync('src/tests/smoke/ids-regression.test.tsx'), 'jsdom 219-id smoke missing');
});
