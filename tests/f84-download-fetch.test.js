// [F84 §2.4] Download-to-RDP server pin: the /api/fetch?download=true branch
// writes to the RDP runner's Desktop\RDP-Downloads and returns {ok,path,bytes},
// and the UI carries the second button for file-ish URLs only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const SERVER = fs.readFileSync('payloads/ghrdp-server.ps1', 'utf8').replace(/\r\n?/g, '\n');
const CLIENT = fs.readFileSync('src/api/fetch/index.ts', 'utf8');
const GRID = fs.readFileSync('src/pages/search/ResultsGrid.tsx', 'utf8');
const LAB = fs.readFileSync('src/pages/search/Lab.tsx', 'utf8');
const INSPECTOR = fs.readFileSync('src/pages/search/LabInspector.tsx', 'utf8');
const PREVIEW = fs.readFileSync('src/pages/search/PreviewDialog.tsx', 'utf8');
const EN = JSON.parse(fs.readFileSync('src/i18n/en.json', 'utf8'));
const SI = JSON.parse(fs.readFileSync('src/i18n/si.json', 'utf8'));

test('F84-DL-SERVER: download=true streams to Desktop\\RDP-Downloads', () => {
  assert.ok(SERVER.includes("Join-Path $env:USERPROFILE 'Desktop\\RDP-Downloads'"), 'RDP-Downloads destination missing');
  assert.ok(SERVER.includes("$f84Download = ([string]$parts.query['download']) -eq 'true'"), 'download query flag missing');
  // [F88 §C.1] the transfer moved into the shared verified helper.
  assert.ok(SERVER.includes('$f88Written += $f88Read'), 'no streaming write loop');
  assert.ok(SERVER.includes('path = [string]$f88Dl.path; bytes = [int64]$f88Dl.bytes'), 'no {path,bytes} response envelope');
  assert.ok(SERVER.includes('verified = [bool]$f88Dl.verified; writeTime = [string]$f88Dl.writeTime'), 'no F88 verification fields');
  assert.ok(SERVER.includes("$f88Clean = ($f88Base -replace '[^A-Za-z0-9._-]', '_').Trim('.')"), 'filename is not sanitised');
  assert.ok(SERVER.includes('function Invoke-F88DownloadToRdp'), 'the shared download helper is missing');
  assert.ok(SERVER.includes('f84 download-to-rdp bytes='), 'no audit line');
});

test('F84-DL-SERVER: an off-host redirect still refuses to write', () => {
  assert.ok(SERVER.includes('if (-not (& $f88Same $f88Uri.Host $f88Got))'), 'final-host guard missing');
  assert.ok(SERVER.includes("code = 'HOSTNAME_MISMATCH'"), 'off-host refusal code missing');
});

test('F84-DL-CLIENT: the request carries download=true and accepts {ok,path}', () => {
  assert.ok(CLIENT.includes('"/api/fetch?download=true"'), 'client query flag missing');
  assert.ok(CLIENT.includes("typeof json.path === 'string'"), 'client does not accept the download envelope');
});

test('F84-DL-UI: file-ish results get "Download to RDP", landing pages do not', () => {
  assert.ok(GRID.includes('data-testid="card-download-rdp"'), 'download button missing');
  assert.ok(GRID.includes('data-testid="card-open-rdp"'), 'open-in-RDP button missing');
  assert.ok(GRID.includes('const fileish = fileUrlExtension(r.sourceUrl);'), 'file-ish detection missing');
  assert.ok(GRID.includes('{fileish ? ('), 'download button is not gated on file-ish URLs');
  assert.ok(GRID.includes('t("download.success", { path: p })'), 'success toast missing');
  assert.ok(GRID.includes('t("download.failed", { reason:'), 'failure toast missing');
  for (const cat of [EN, SI]) {
    assert.equal(typeof cat.download.toRdp, 'string');
    assert.equal(typeof cat.download.success, 'string');
    assert.equal(typeof cat.download.failed, 'string');
  }
});

test('F84-NOFALLBACK: no result/lab/preview surface renders <a target="_blank"> anymore', () => {
  assert.ok(!GRID.includes('target="_blank"'), 'ResultsGrid still has a target=_blank anchor');
  assert.ok(!LAB.includes('target="_blank"'), 'Lab still has a target=_blank anchor');
  assert.ok(!INSPECTOR.includes('target="_blank"'), 'LabInspector still has a target=_blank anchor');
  assert.ok(!PREVIEW.includes('window.open('), 'PreviewDialog still falls back to window.open');
});
