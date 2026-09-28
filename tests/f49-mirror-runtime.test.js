// [F49] Runtime (one-click) mirror opt-in - source-contract lock.
// The behaviour is proven by tests/f49-mirror-runtime.ps1 on the Windows lane
// (real server over loopback); this suite pins the contract statically: the
// three routes + preflight, the dash-token + CSRF gates, the query-credential
// refusal, the helper/beacon/ledger surface, the stage strings, the banner +
// modal in both UIs, and the F48 token bans over every new surface.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const lf = (s) => s.replace(/\r\n?/g, '\n');
const srv = lf(fs.readFileSync('payloads/ghrdp-server.ps1', 'utf8'));
const mod = lf(fs.readFileSync('payloads/ghrdp-mirror.ps1', 'utf8'));
const wat = lf(fs.readFileSync('payloads/ghrdp-watcher.ps1', 'utf8'));
const ui = lf(fs.readFileSync('payloads/ui.html', 'utf8'));
const wf = lf(fs.readFileSync('.github/workflows/main.yml', 'utf8'));
const card = lf(fs.readFileSync('src/components/domain/MirrorCard.tsx', 'utf8'));
const lib = lf(fs.readFileSync('src/lib/mirror.ts', 'utf8'));
const en = JSON.parse(fs.readFileSync('src/i18n/en.json', 'utf8'));
const si = JSON.parse(fs.readFileSync('src/i18n/si.json', 'utf8'));

test('F49-1 the three routes plus the CORS preflight exist on the PS dashboard', () => {
  for (const r of ['/api/mirror/status', '/api/mirror/enable', '/api/mirror/disable']) {
    assert.ok(srv.includes(`'${r}'`), 'route missing: ' + r);
  }
  assert.ok(srv.includes('X-Dash-Token, X-CSRF-Token'), 'the preflight does not allow the F49 headers');
  assert.ok(srv.includes('F49 runtime-opt-in-begin'), 'the F49 route block marker is missing');
});

test('F49-2 POSTs require the presented dash token (no tailnet fallback)', () => {
  assert.ok(srv.includes('dashboard authorization required (X-Dash-Token or Bearer)'), 'the POST 401 needle is missing');
  assert.ok(srv.includes("parts.headers['x-dash-token']"), 'X-Dash-Token is never read');
  assert.ok(srv.includes('Test-TicketBearer $mRecv $mExp'), 'the token compare is not constant-time');
});

test('F49-3 POSTs require the per-process CSRF token', () => {
  assert.ok(srv.includes('CSRF token missing or invalid'), 'the POST 403 needle is missing');
  assert.ok(srv.includes("parts.headers['x-csrf-token']"), 'X-CSRF-Token is never read');
  assert.ok(srv.includes('X-CSRF-Token: '), 'the status response does not deliver the CSRF token');
  assert.ok(srv.includes('ghrdp_mirror_csrf='), 'the status response does not set the CSRF cookie');
  assert.ok(srv.includes('SameSite=Strict'), 'the CSRF cookie is not SameSite=Strict');
});

test('F49-4 a credential in the query string is refused, not ignored', () => {
  assert.ok(srv.includes('credentials are not accepted in the query string; send X-Dash-Token'), 'the query-refusal needle is missing');
  assert.ok(lib.includes('X-Dash-Token'), 'the v2 client does not send the dash token by header');
  assert.ok(!/[?&](key|token|password)=["'`+]/.test(lib), 'the v2 client builds a credential URL');
  assert.ok(!/fetch\([^)]*\?key=/.test(ui), 'the v1 client sends the key in a URL on an F49 call');
});

test('F49-5 the module converges config objects; scope is this-run; default stays off', () => {
  for (const fn of ['function Set-F49CfgProp', 'function Get-F49RuntimeOptIn', 'function Test-F49MirrorEnabled', 'function Get-F49OptInStatus', 'function Set-F49RuntimeOptIn', 'function Clear-F49RuntimeOptIn', 'function Format-F49OptInLedger', 'function Format-F49OptOutLedger', 'function Write-F49OptInBeacon', 'function Remove-F49OptInBeacon']) {
    assert.ok(mod.includes(fn), 'helper missing: ' + fn);
  }
  assert.ok(mod.includes("$script:F49OptInScope = 'this-run'"), 'the scope constant drifted');
  assert.ok(mod.includes('[mirror] RUNTIME OPT-IN: enabled=true scope=this-run source=runtime host='), 'the ledger format drifted');
  assert.ok(mod.includes('mirror-optin-beacon.json'), 'the beacon filename drifted');
  // F11-5.2 at code level: the shipped host default is still disabled.
  assert.match(mod, /function Get-F46DefaultHost[\s\S]*?enabled = \$false/, 'the shipped default host is no longer disabled');
});

test('F49-6 the watcher consumes the flags and ledgers the opt-in', () => {
  assert.ok(wat.includes("Join-Path $Root 'mirror-enable.flag'"), 'the enable flag is never consumed');
  assert.ok(wat.includes("Join-Path $Root 'mirror-disable.flag'"), 'the disable flag is never consumed');
  assert.ok(wat.includes('Format-F49OptInLedger'), 'the opt-in ledger call is missing');
  assert.ok(wat.includes('Format-F49OptOutLedger'), 'the opt-out ledger call is missing');
  assert.ok(wat.includes('optIn = $f49OptInDiag'), 'mirrorDiag does not carry the opt-in marker');
  assert.ok(wat.includes('F49LastOptInAt'), 'the per-marker ledger guard is missing');
});

test('F49-7 the stage summary carries the F49 strings; the dispatch path is unchanged', () => {
  assert.ok(wf.includes('[F49] runtime opt-in ready: POST /api/mirror/enable|/disable + GET /api/mirror/status'), 'the F49 log needle is missing');
  assert.ok(wf.includes('- [F49] runtime opt-in: POST /api/mirror/enable (dash-token + CSRF, this-run scope)'), 'the F49 summary needle is missing');
  assert.ok(wf.includes('[F48] mirror opt-in for THIS run: host=gofile enabled=true token-less guest mode'), 'the F48 dispatch block regressed');
  assert.ok(wf.includes("mirror_enable:\n"), 'the mirror_enable dispatch input is gone');
});

test('F49-8 the banner + ConfirmModal exist in v1, v2 and both locales', () => {
  // v1 (payloads/ui.html, also served as the 7332 static copy)
  assert.ok(ui.includes('id="mirrorOptInBanner"'), 'v1 banner missing');
  assert.ok(ui.includes('id="mirrorOptInModal"'), 'v1 modal missing');
  assert.ok(ui.includes('role="dialog" aria-modal="true"'), 'v1 modal a11y roles missing');
  assert.ok(ui.includes('aria-labelledby="mirrorOptInTitle"'), 'v1 modal label missing');
  assert.ok(ui.includes('Enable &amp; Upload'), 'v1 [Enable & Upload] missing');
  assert.ok(ui.includes('openMirrorOptIn(btn)'), 'v1 gated flush missing');
  // v2 (React default UI)
  assert.ok(card.includes('mirror-disabled-banner'), 'v2 banner testid missing');
  assert.ok(card.includes('onUploadNow'), 'v2 gated upload handler missing');
  assert.ok(card.includes('mirror.optInTitle'), 'v2 modal title key missing');
  assert.ok(card.includes('mirror.enableUpload'), 'v2 [Enable & Upload] key missing');
  assert.ok(card.includes('mirror-disable'), 'v2 disable affordance missing');
  assert.ok(card.includes('<Modal'), 'v2 does not reuse the Modal primitive');
  // locales
  for (const k of ['optInBanner', 'optInTitle', 'optInBody', 'enableUpload', 'optInCancel', 'optOut']) {
    assert.ok(en.mirror[k] && en.mirror[k].length > 0, 'en.mirror.' + k + ' missing');
    assert.ok(si.mirror[k] && si.mirror[k].length > 0, 'si.mirror.' + k + ' missing');
  }
  assert.equal(en.mirror.enableUpload, 'Enable & Upload', 'the primary label drifted');
});

test('F49-9 the F48 token bans hold over every new surface', () => {
  // No gofile credential plumbing may enter through the F49 code: the only
  // token named anywhere near it is the dashboard's own (X-Dash-Token).
  for (const [name, src] of [['src/lib/mirror.ts', lib], ['MirrorCard.tsx', card]]) {
    assert.ok(!src.includes('X-Gofile-Token'), name + ' names a host token header');
    assert.ok(!src.includes('accountToken'), name + ' names a host account token');
    assert.ok(!/GOFILE[_]?TOKEN/.test(src), name + ' names the banished secret');
    assert.ok(!src.includes('Authorization'), name + ' sends an Authorization header');
  }
  for (const frag of ['X-Gofile-Token', 'accountToken']) {
    const hits = ui.split('\n').filter((l) => l.includes(frag) && l.includes('mirrorOpt'));
    assert.equal(hits.length, 0, 'v1 F49 code touches a host token: ' + hits.join(' | '));
  }
  // The server route file may Bearer-gate the DASHBOARD (purge precedent) but
  // must never mint a host-bound token header for the mirror API.
  assert.ok(!srv.includes('X-Gofile-Token'), 'the server mints a host token header');
  // No F49 surface offers evasion or a credential parameter.
  for (const [name, src] of [['mirror.ts', lib], ['MirrorCard', card]]) {
    assert.ok(!/Mozilla|WebProxy|proxy\s*=|rotat|spoof/i.test(src), name + ' carries an evasion pattern');
    assert.ok(!/[?&](token|key|password)=["'`+]/.test(src), name + ' builds a credential URL');
  }
});
