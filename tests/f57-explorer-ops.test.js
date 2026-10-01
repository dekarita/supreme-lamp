// [F57 §5] Node lab: the Explorer real-op wiring is measured against the
// SHIPPED sources, not a copy - the additive id lock (collision-free against the
// frozen 219 and every earlier additive array), the en/si catalog parity for the
// new files.ops.* keys, the destructive-op fence (trash/restore/move only), the
// no-new-dependency decision, and the CI wiring that runs the Vitest cells plus
// the Windows file-op lab.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const read = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n?/g, '\n');
const GATES = read('.github/workflows/launch-gates.yml');
const IDS_OPS = read('src/pages/file-explorer/ids.ops.ts');
const TRANSPORT = read('src/lib/explorer/transport.ts');
const OPS = read('src/lib/explorer/ops.ts');
const ROOTS = read('src/lib/explorer/roots.ts');
const TRASH = read('src/lib/explorer/trash.ts');
const PREVIEW = read('src/lib/explorer/preview.ts');
const QUEUE = read('src/lib/explorer/queue.ts');
const PAGE = read('src/pages/FileExplorer.tsx');
const LAB = read('tests/f57-explorer-ops.ps1');
const PKG = JSON.parse(read('package.json'));

function arrayFrom(source, name) {
  const m = new RegExp(name + '\\s*=\\s*\\[(.*?)\\]\\s*as const;', 's').exec(source);
  assert.ok(m, `${name} must exist as an ` + '`as const`' + ' array');
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
}

const FROZEN_219 = [...read('src/lib/regression-ids.ts').matchAll(/'([^']+)'/g)].map((m) => m[1]);
const ALL_ADDITIVE = [
  ...arrayFrom(read('src/pages/search/ids.ts'), 'F56_SEARCH_IDS'),
  ...arrayFrom(read('src/pages/file-explorer/ids.ts'), 'F57_EXPLORER_IDS'),
  ...arrayFrom(read('src/pages/search/v2/ids.ts'), 'F56C_V2_SEARCH_IDS'),
  ...arrayFrom(read('src/pages/search/v2/ids.ts'), 'F57_EXPLORER_V2_IDS'),
  ...arrayFrom(read('src/pages/search/v2/ids.ts'), 'F56C_V3_SEARCH_IDS'),
  ...arrayFrom(read('src/pages/search/v2/ids.ts'), 'F58_SEARCH_IDS'),
  ...arrayFrom(read('src/pages/search/v2/ids.ts'), 'F56D_SEARCH_IDS'),
];

test('F57-ID-LOCK: the ops ids are additive, namespaced and collision-free', () => {
  const ids = arrayFrom(IDS_OPS, 'F57_OPS_IDS');
  assert.ok(ids.length >= 30, `expected the real-op surface to be substantial, got ${ids.length}`);
  assert.equal(new Set(ids).size, ids.length, 'duplicate F57 ops id');
  const frozen = new Set(ALL_ADDITIVE);
  const parent = new Set(FROZEN_219.map((p) => p.replace(/^[#.]/, '')));
  for (const id of ids) {
    assert.match(id, /^f57\.explorer\.ops\.[A-Za-z0-9]+(\.[A-Za-z0-9]+)*$/, `bad id shape: ${id}`);
    assert.ok(!frozen.has(id), `collides with an earlier additive array: ${id}`);
    assert.ok(!parent.has(id), `collides with the frozen 219: ${id}`);
    assert.ok(!parent.has(id.replace(/\./g, '-')), `dashed collision with the frozen 219: ${id}`);
  }
  // the frozen F56-c locks themselves are untouched
  assert.equal(arrayFrom(read('src/pages/file-explorer/ids.ts'), 'F57_EXPLORER_IDS').length, 21);
  assert.equal(arrayFrom(read('src/pages/search/v2/ids.ts'), 'F57_EXPLORER_V2_IDS').length, 4);
  assert.equal(FROZEN_219.filter((p) => p.startsWith('f56.') || p.startsWith('f57.')).length, 0);
});

test('F57-I18N: every new ops key exists in both catalogs with Sinhala parity', () => {
  const flatten = (d, p = '') =>
    Object.entries(d).reduce((acc, [k, v]) => {
      if (v && typeof v === 'object') Object.assign(acc, flatten(v, p + k + '.'));
      else acc[p + k] = String(v);
      return acc;
    }, {});
  const en = flatten(JSON.parse(read('src/i18n/en.json')));
  const si = flatten(JSON.parse(read('src/i18n/si.json')));
  const enOps = Object.keys(en).filter((k) => k.startsWith('files.ops.')).sort();
  const siOps = Object.keys(si).filter((k) => k.startsWith('files.ops.')).sort();
  assert.deepEqual(siOps, enOps, 'files.ops.* key sets drifted');
  assert.equal(enOps.length, 78, `expected 78 files.ops keys, got ${enOps.length}`);
  for (const k of siOps) {
    assert.ok(si[k].trim().length > 0, `empty si value: ${k}`);
    const ph = (s) => (s.match(/\{\{\s*\w+\s*\}\}/g) || []).sort();
    assert.deepEqual(ph(si[k]), ph(en[k]), `placeholder drift: ${k}`);
  }
  const sinhala = siOps.some((k) => /[\u0D80-\u0DFF]/.test(si[k]));
  assert.ok(sinhala, 'the new si keys must carry real Sinhala codepoints');
});

test('F57-OP-FENCE: the client can only express trash/restore/move', () => {
  assert.ok(TRANSPORT.includes('SERVER_OPS: readonly ServerOpName[] = ["trash", "restore", "move"]'));
  assert.ok(!/hard\s*[:=]\s*true/i.test(TRANSPORT), 'no hard-delete flag may exist in the transport');
  assert.ok(!TRANSPORT.includes('api/fx/list'), 'the F56-d S3 file-API literal must stay out of the UI');
  assert.ok(!TRANSPORT.includes('X-Idempotency-Key'), 'the F45 S3 bundle needle must stay out');
  assert.ok(TRANSPORT.includes('ghrdp_fx_csrf'), 'POSTs must read the fx CSRF cookie');
  assert.ok(TRANSPORT.includes('X-CSRF-Token') && TRANSPORT.includes('X-Dash-Token'));
  assert.ok(TRANSPORT.includes('/api/fx/preview') && TRANSPORT.includes('/api/fx/op'));
  assert.ok(!/\?key=/.test(TRANSPORT), 'the dash token must never travel in a URL');
});

test('F57-INVARIANTS: undo=20, retention=30d, roots=6, durable queue', () => {
  assert.match(OPS, /export const UNDO_LIMIT = 20;/);
  assert.match(OPS, /if \(this\.items\.length > UNDO_LIMIT\) this\.items\.splice\(0, this\.items\.length - UNDO_LIMIT\);/);
  assert.match(TRASH, /export const TRASH_RETENTION_DAYS = 30;/);
  assert.match(TRASH, /export const TRASH_ROOT = "D:\\\\RDP-Storage\\\\\.trash";/);
  assert.match(ROOTS, /export const ROOT_COUNT = 6;/);
  assert.equal((ROOTS.match(/"(C:\\\\Users\\\\RDP\\\\[A-Za-z]+|%TEMP%|D:\\\\RDP-Storage|D:\\\\RDP-Storage\\\\Fetched)"/g) || []).length, 6, 'six watched roots');
  assert.ok(QUEUE.includes('QUEUE_STORAGE_KEY') && QUEUE.includes('rehydrateJobs'), 'the queue is durable + rehydratable');
  assert.ok(QUEUE.includes('QUEUE_MAX_ATTEMPTS'));
  // preview registry covers the plan §7 table
  for (const kind of ['image', 'video', 'audio', 'pdf', 'markdown', 'code', 'unsupported']) {
    assert.ok(PREVIEW.includes('"' + kind + '"'), `renderer missing: ${kind}`);
  }
  assert.ok(PREVIEW.includes('PREVIEW_RESTRICTED_KEY = "files.ops.preview.restricted"'), 'the restricted note is a localized key');
  assert.ok(PAGE.includes('tinykeys') && PAGE.includes('F2') && PAGE.includes('Shift+Delete') && PAGE.includes('mod+z'));
});

test('F57-NO-NEW-DEP: the single-file bundle keeps its frozen dependency set', () => {
  assert.deepEqual(Object.keys(PKG.dependencies).sort(), [
    'i18next',
    'lucide-react',
    'react',
    'react-dom',
    'react-i18next',
    'react-router-dom',
    'react-window',
    'zustand',
  ]);
  assert.ok(!JSON.stringify(PKG).includes('tinykeys'), 'keyboard shortcuts stay in-repo (src/pages/file-explorer/keymap.ts)');
  assert.ok(!JSON.stringify(PKG).includes('marked'), 'markdown rendering stays in-repo (src/lib/explorer/preview.ts)');
});

test('F57-GATE-WIRING: one additive bash gate + one windows lab step', () => {
  const step = /- name: F57 Explorer real-ops gates[\s\S]*?          echo 'F57 gates PASS[^\n]*'/;
  const m = step.exec(GATES);
  assert.ok(m, 'the F57 gate step is missing from launch-gates.yml');
  const body = m[0];
  assert.ok(body.includes('shell: bash'), 'the F57 gate must be a bash-counted step');
  for (const file of [
    'src/tests/smoke/f57-command-actions.test.tsx',
    'src/tests/smoke/f57-context-menu.test.tsx',
    'src/tests/smoke/f57-keyboard.test.tsx',
    'src/tests/smoke/f57-selection-undo.test.ts',
    'src/tests/smoke/f57-preview-wire.test.tsx',
    'src/tests/smoke/f57-dragdrop-trash.test.tsx',
    'src/tests/smoke/f57-op-queue.test.tsx',
  ]) {
    assert.ok(body.includes(file), `the gate must run ${file}`);
  }
  assert.ok(body.includes('node --test tests/f57-explorer-ops.test.js'), 'the gate must run this node lab');
  assert.ok(body.includes('tests/f57-explorer-ops.ps1'), 'the PS lab must be named by the gate');
  // the Windows lane executes the live file-op lab
  const win = /- name: F57 explorer real-ops lab[\s\S]*?Write-Host 'F57 explorer ops lab PASS'/;
  const w = win.exec(GATES);
  assert.ok(w, 'the windows-native F57 lab step is missing');
  assert.ok(w[0].includes('shell: pwsh'));
  assert.ok(w[0].includes('f57-explorer-ops.ps1'));

  // the lab itself: six roots, four op cells, labeled skips, fail-visible
  assert.ok(LAB.includes('roots 5->6') && LAB.includes('D:\\RDP-Storage\\Fetched'));
  for (const tag of ['NEW:', 'RENAMED:', 'MOVED:', 'DELETED:']) assert.ok(LAB.includes(tag), `lab cell missing: ${tag}`);
  assert.ok(LAB.includes('Get-ChildItem -LiteralPath $root -File -Recurse'), 'the lab re-walks with the watcher scan enumeration');
  assert.ok(LAB.includes('ROOT-SKIP:'), 'an absent root must be a labeled skip');
  assert.ok(LAB.includes('exit 1'), 'the lab must fail visibly');
  assert.ok(LAB.includes('$SkipLiveCells') || LAB.includes('SkipLiveCells'));
});
