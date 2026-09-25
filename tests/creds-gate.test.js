// [F10 s3] Credentials gate: the Windows/VNC passwords may only ever leave
// the server through the dash-token-gated /api/config creds block. Any other
// route that reads or serializes rdpPass/vncPass fails this test.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'payloads/ghrdp-server.ps1'), 'utf8');
const rust = fs.readFileSync(path.join(root, 'payloads/main.rs'), 'utf8');
const ui = fs.readFileSync(path.join(root, 'payloads/ui.html'), 'utf8');
const workflow = fs.readFileSync(path.join(root, '.github/workflows/main.yml'), 'utf8');

// Strip the Remove-CredKeys helper (its key-name references are STRIPS, not
// disclosures) and the single gated /api/config handler region.
function stripAllowed(text) {
  const fnStart = text.indexOf('function Remove-CredKeys');
  assert.ok(fnStart >= 0, 'Remove-CredKeys helper missing');
  const fnEnd = text.indexOf('function Invoke-ClientRequest', fnStart);
  assert.ok(fnEnd > fnStart, 'cannot bound Remove-CredKeys region');
  let out = text.slice(0, fnStart) + text.slice(fnEnd);
  const gatedStart = out.indexOf("if ($path -eq '/api/config')");
  assert.ok(gatedStart >= 0, '/api/config route missing');
  // Route region ends at the next `if ($path -eq` after the gated start.
  const nextRoute = out.indexOf('if ($path -eq', gatedStart + 10);
  const gatedEnd = nextRoute > gatedStart ? nextRoute : out.length;
  out = out.slice(0, gatedStart) + out.slice(gatedEnd);
  return out;
}

test('F10 s3: no non-gated server route touches rdpPass/vncPass', () => {
  let rest = stripAllowed(server);
  // PowerShell comments never serialize; drop them. Exclude the allowlisted
  // sibling field vncPassAdminUrl (an admin LINK, not a credential).
  rest = rest.split('\n').filter(l => !/^\s*#/.test(l)).join('\n');
  const leaks = rest.match(/.{0,60}(rdpPass|vncPass)(?!AdminUrl).{0,60}/g) || [];
  assert.deepStrictEqual(
    leaks, [],
    `secret field references outside Remove-CredKeys + /api/config:\n${leaks.join('\n')}`);
});

test('F10 s3: /api/config gate is token-gated before attaching secrets', () => {
  const gatedStart = server.indexOf("if ($path -eq '/api/config')");
  const nextRoute = server.indexOf('if ($path -eq', gatedStart + 10);
  const region = server.slice(gatedStart, nextRoute > gatedStart ? nextRoute : server.length);
  assert.ok(region.includes('$gatedF10'), 'gated flag missing from /api/config');
  assert.ok(region.includes('FixedTimeEquals'), 'constant-time token compare missing');
  assert.ok(!/Send-ClientResponse[\s\S]{0,200}rdpPass/.test(region),
    'config response must be built via $cfgOut (stripped unless gated)');
  // The secret attach must happen only inside the `if ($gatedF10 ...)` arm.
  const attachIdx = region.indexOf("Add-Member -MemberType NoteProperty -Name 'pass'");
  const gateIdx = region.indexOf('if ($gatedF10 -and $cfgOut)');
  const stripIdx = region.indexOf('$cfgOut = Remove-CredKeys');
  assert.ok(stripIdx >= 0 && gateIdx > stripIdx && attachIdx > gateIdx,
    'creds attach must follow Remove-CredKeys and sit inside the gated arm');
});

test('F10 s3: Remove-CredKeys strips both passwords everywhere else', () => {
  const fn = server.slice(server.indexOf('function Remove-CredKeys'),
    server.indexOf('function Invoke-ClientRequest'));
  assert.ok(fn.includes("'rdpPass'"), 'rdpPass missing from strip list');
  assert.ok(fn.includes("'vncPass'"), 'vncPass missing from strip list');
});

test('F10 s3: rust /api/config strips vncPass too', () => {
  assert.ok(/\["rdpPass",\s*"vncPass"/.test(rust),
    'main.rs api_config strip list must include vncPass');
});

test('F10 s3: config.json gains vncPass at dispatch; UI masks, never embeds', () => {
  assert.ok(workflow.includes('vncPass = [string]$env:VNC_PASS'),
    'stage step must write vncPass into config.json');
  assert.ok(workflow.includes('VNC_PASS: ${{ secrets.VNC_PASS }}'),
    'stage step must receive VNC_PASS from secrets');
  assert.ok(ui.includes('mask4'), 'UI must mask credentials (last 4)');
  assert.ok(ui.includes('copyGhrdpCred'), 'UI copy buttons missing');
  // The page must never carry a seeded password value of its own.
  assert.ok(!/pass\s*[:=]\s*['"][^'"]{6,}['"]/.test(ui.replace(/passWord|Password/g, '')),
    'ui.html appears to embed a literal password');
  // No credential material may be placed into a URI by the page.
  assert.ok(!/ghrdp:\/\/[^'"\s]*((pass|pwd|hash|secret)=)/i.test(ui),
    'ghrdp:// URI construction carries credential parameters');
});
