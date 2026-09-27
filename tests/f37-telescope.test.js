// [F37] RDP TELESCOPE - SELF-EXPLAINING OBSERVABILITY (client + runner + lab).
// Run: node --test tests/f37-telescope.test.js
//
// Every assertion is on a SHIPPED surface, and the ones that CAN be executed are
// executed here: the dashboard's timeline function is run out of payloads/ui.html
// over synthetic native-status samples (and, when the Windows lab exports
// F37_TEL_FIXTURE, over the REAL /api/native-status sample the lab captured).
// The PowerShell module (payloads/rdp-telescope.ps1) is the SINGLE SOURCE OF
// TRUTH for the format, so this matrix cross-checks the other three surfaces
// (launcher .cs, server .ps1, lab/main workflows) against the module's tokens.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const mod = fs.readFileSync('payloads/rdp-telescope.ps1', 'utf8');
const srv = fs.readFileSync('payloads/ghrdp-server.ps1', 'utf8');
const ui = fs.readFileSync('payloads/ui.html', 'utf8');
const cs = fs.readFileSync('payloads/ghrdp-rdp-launcher.cs', 'utf8');
const lab = fs.readFileSync('.github/workflows/autologin-lab.yml', 'utf8');
const main = fs.readFileSync('.github/workflows/main.yml', 'utf8');
const gates = fs.readFileSync('.github/workflows/launch-gates.yml', 'utf8');

function psArray(name) {
  const m = mod.match(new RegExp('\\$' + name + ' = @\\(([\\s\\S]*?)\\n?\\s*\\)'));
  assert.ok(m, 'the module no longer declares $' + name + ' (the format token list is the contract)');
  return m[1].split(',').map(s => s.trim().replace(/^'|'$/g, '')).filter(Boolean);
}
const STAGES = psArray('stages');
const FAILURE_AT = psArray('failureAt');
const SLUGS = psArray('slugs');
const DEATHS = psArray('deathPoints');

// [F37 §1 beacon-stage] slug -> stage, the module's ONE table. The client
// declares the stage, the server DERIVES it from here - so the table must cover
// the whole slug vocabulary and name only stages the format defines.
function psSlugStage() {
  const m = mod.match(/\$slugStage = \[ordered\]@\{([\s\S]*?)\n\s*\}/);
  assert.ok(m, 'the module no longer declares $slugStage (slug -> stage is the contract)');
  return new Map([...m[1].matchAll(/'([a-z0-9-]+)' = '([a-z]+)'/g)].map(x => [x[1], x[2]]));
}
const SLUG_STAGE = psSlugStage();
// the stages a CLIENT beacon can belong to (the launcher is the client; the
// runner-only logon|schannel|listener stages are never beacons)
const CLIENT_STAGES = ['dns', 'tcp', 'tls', 'cred'];

// ---------------------------------------------------------------------------
// §1 the module IS the format
// ---------------------------------------------------------------------------
test('F37-1 the telescope module declares the stage/failure/slug vocabulary', () => {
  assert.ok(mod.includes('# [F37 §1 telescope-format]'), 'the format header marker is missing');
  for (const s of ['dns', 'tcp', 'tls', 'cred', 'logon', 'schannel', 'listener']) {
    assert.ok(STAGES.includes(s), 'stage missing from the module: ' + s);
  }
  for (const f of ['rst-before-cert', 'chain', 'name-mismatch', 'eku']) {
    assert.ok(FAILURE_AT.includes(f), 'failure point missing from the module: ' + f);
  }
  for (const s of ['telescope-dns-ok', 'telescope-tcp-ok', 'telescope-tls-ok',
    'telescope-rst-before-cert', 'telescope-chain', 'telescope-name-mismatch',
    'telescope-eku', 'telescope-cred-ok', 'telescope-cred-missing']) {
    assert.ok(SLUGS.includes(s), 'beacon slug missing from the module: ' + s);
  }
  // one JSON object per line, and a single allowlist function that drops
  // anything the format does not name.
  assert.ok(mod.includes('function New-RdpTelescopeLine'), 'the line emitter is missing');
  assert.ok(mod.includes('ConvertTo-Json -Compress'), 'lines must be single-line JSON');
  assert.ok(mod.includes('function Select-RdpTelescopeLine'), 'the allowlist filter is missing');
  assert.ok(mod.includes('$script:F37TelFields'), 'the field allowlist table is missing');
  // death-point vocabulary (the class the session maps to a fix)
  for (const d of ['dns', 'tcp', 'tls-cert', 'tls-chain', 'tls-eku', 'name-mismatch', 'credssp', 'logon', 'acl']) {
    assert.ok(mod.includes("'" + d + "'"), 'death point missing: ' + d);
  }
  assert.ok(mod.includes('function Get-RdpTelescopeDeathPoint'), 'the death-point resolver is missing');
  // [F37 §1 beacon-stage] slug -> stage is declared HERE and read back through
  // the module's own accessor: exactly the shared slugs, only client stages.
  assert.deepStrictEqual([...SLUG_STAGE.keys()].sort(), [...SLUGS].sort(),
    'the slug -> stage table and the slug vocabulary disagree');
  for (const [slug, stage] of SLUG_STAGE) {
    assert.ok(STAGES.includes(stage), 'the slug -> stage table names a non-stage: ' + slug + '=' + stage);
    assert.ok(CLIENT_STAGES.includes(stage), 'a beacon slug points at a runner-only stage: ' + slug + '=' + stage);
  }
  assert.ok(mod.includes('function Get-RdpTelescopeBeaconStage'), 'the slug -> stage accessor is missing');
  assert.ok(mod.includes("Get-RdpTelescopeFormatTokens -Kind 'slugStage'"),
    'the accessor must read the ONE token table, not a second mapping');
  assert.ok(mod.includes("'slugStage' { return $slugStage }"),
    'the slug -> stage table is not exported as a format token');
  assert.ok(mod.includes('function Get-RdpTelescopeFields'), 'the shared derivation helper is missing');
  assert.ok(mod.includes('function Format-RdpTelescopeDump'), 'the printed-field renderer is missing');
});

test('F37-2 the TLS probe reads the certificate even when the chain fails, and names the failure point', () => {
  const tls = mod.slice(mod.indexOf('function Get-RdpTelescopeTls'), mod.indexOf('function Get-RdpTelescopeCredReadback'));
  assert.ok(tls.length > 400, 'the TLS stage was not found');
  // permissive callback: READ, never trust, never install - and COMPILED,
  // because a scriptblock cannot run on the threadpool thread that completes
  // the handshake (that is what produced the false rst-before-cert).
  assert.match(tls, /\[GhrdpTelTls\]::Callback\(\)/, 'the TLS stage does not use the compiled callback');
  assert.match(mod, /return true;\s*\n\s*\}/, 'the compiled callback must be permissive so the certificate is READ');
  assert.match(mod, /public static byte\[\] ServedRaw/, 'the compiled callback does not capture the served certificate');
  assert.match(tls, /GetCertHashString\(\)|ServedThumb/, 'the served thumbprint is never read');
  assert.match(tls, /X509Chain/, 'the chain status is never evaluated locally');
  // the four named failure points, each reachable
  for (const f of ["'rst-before-cert'", "'name-mismatch'", "'eku'", "'chain='"]) {
    assert.ok(tls.includes(f), 'the TLS stage cannot name ' + f);
  }
  // the EKU check is shared with the runner probe (one implementation)
  assert.ok(mod.includes('function Test-RdpTelescopeCertServerAuth'), 'the shared EKU check is missing');
  assert.ok(mod.includes('2.5.29.37') && mod.includes('1.3.6.1.5.5.7.3.1'), 'the EKU check is missing');
  assert.ok(tls.includes('2.5.29.17'), 'the SAN check is missing');
  // no trust is ever installed by the telescope
  assert.ok(!/X509Store\('Root'/.test(mod), 'the telescope must never touch the Root store');
  assert.ok(!/AddAccessRule/.test(mod), 'the telescope must never modify an ACL (read-only observer)');
});

test('F37-3 the module is secret-free by construction', () => {
  for (const bad of ['Read-Host', '-AsPlainText', 'ConvertTo-SecureString', 'Invoke-Expression',
    'cmdkey.exe /add', '/pass:', 'GetNetworkCredential', 'SecureString']) {
    assert.ok(!mod.includes(bad), 'the telescope module must not contain: ' + bad);
  }
  // the credential stage may only read target existence/type/user metadata
  const cred = mod.slice(mod.indexOf('function Get-RdpTelescopeCredReadback'), mod.indexOf('function Get-RdpTelescopeLogon'));
  assert.ok(cred.includes('cmdkey.exe /list'), 'the credential read-back must use cmdkey /list (metadata only)');
  assert.ok(!/cmdkey\.exe \/(add|generic|delete)/.test(cred), 'the telescope must never write or delete a credential');
  // and the allowlist drops password-shaped FIELD NAMES even if a caller invents one
  const sel = mod.slice(mod.indexOf('function Select-RdpTelescopeLine'), mod.indexOf('function New-RdpTelescopeLine'));
  assert.match(sel, /pass\|pwd\|secret\|token\|ticket/, 'the field-name scrub is missing');
});

// ---------------------------------------------------------------------------
// §3 client telescope (launcher verb diag + preflight + trace id)
// ---------------------------------------------------------------------------
test('F37-4 the launcher mirrors the module vocabulary token-for-token', () => {
  assert.ok(cs.includes('[F37 §1 telescope-format: shared with payloads/rdp-telescope.ps1]'),
    'the launcher does not point at the single source of truth');
  for (const s of SLUGS) {
    assert.ok(cs.includes('"' + s + '"'), 'the launcher cannot emit the shared slug: ' + s);
  }
  for (const f of FAILURE_AT) {
    // the module writes the class as `failureAt`; the launcher mirrors it, and
    // for `chain` the class carries its status (`chain=<status>`) on both sides.
    assert.ok(cs.includes('"' + f + '"') || cs.includes('"' + f + '='),
      'the launcher cannot name the shared failure point: ' + f);
  }
  // every death point the launcher assigns must be one the module defines
  const assigned = [...cs.matchAll(/death = "([a-z-]+)"/g)].map(m => m[1]);
  assert.ok(assigned.length >= 4, 'the launcher no longer resolves a death point');
  for (const d of assigned) {
    assert.ok(DEATHS.includes(d), 'the launcher invented a death point the module does not define: ' + d);
  }
});

test('F37-5 the diag verb is read-only and beacons per stage to /api/rdp-telescope', () => {
  const diag = cs.slice(cs.indexOf('private static int DiagStep'), cs.indexOf('private static int Main(string[] args)'));
  assert.ok(diag.length > 200, 'the diag verb is missing');
  assert.ok(diag.includes('TelPreflight'), 'the diag verb does not run the stage probes');
  for (const forbidden of ['MstscStep', 'CmdkeyStep', 'WriteCredential', 'RedeemAndStore', 'PurgeStaleTermsvr']) {
    assert.ok(!diag.includes(forbidden), 'the diag verb must not reach ' + forbidden + ' (read-only)');
  }
  // per-stage beacons, one trace id per click
  const stage = cs.slice(cs.indexOf('private static void TelStage'), cs.indexOf('private static byte[] TelReadExact'));
  assert.ok(stage.includes('HelloBounded(host, port, "diag"'), 'the stage beacon is not a diag beacon');
  assert.ok(stage.includes('trace'), 'the stage beacon does not carry the trace id');
  // [F37 §3 beacon-stage] the diag beacon DECLARES the stage its slug belongs
  // to. The server derives the stage from the slug anyway, so a declaration can
  // only agree with the format or be neutralized - never become the authority.
  assert.ok(stage.includes('HelloBounded(host, port, "diag", ok, slug, trace, stage)'),
    'the stage beacon does not declare the stage its slug belongs to');
  const cliStage = cs.slice(cs.indexOf('private static bool IsTelClientStage'), cs.indexOf('// One slug per stage verdict'));
  assert.ok(cliStage.length > 40, 'the client stage allowlist is missing');
  for (const s of CLIENT_STAGES) {
    assert.ok(cliStage.includes('"' + s + '"'), 'the client stage allowlist lost ' + s);
  }
  for (const s of ['logon', 'schannel', 'listener']) {
    assert.ok(!cliStage.includes('"' + s + '"'), 'the client claims the runner-only stage ' + s);
  }
  const hello = cs.slice(cs.indexOf('private static void Hello(string host, int port, string verb, bool ok, string details, string trace, string stage)'),
    cs.indexOf('private static string JoinArgs'));
  assert.ok(hello.length > 200, 'the stage-carrying beacon writer is missing');
  assert.ok(hello.includes('IsTelClientStage(stage)'),
    'the declared stage is not gated on the client stage set');
  assert.ok(hello.includes('J(stage)'), 'the declared stage never reaches the beacon body');
  assert.ok(cs.includes('endpoint = (verb == "diag") ? "/api/rdp-telescope" : "/api/handler-hello"'),
    'diag beacons must go to /api/rdp-telescope, never into the handler-hello chain');
  // the REAL launch path only telescopes when the click minted a trace, so the
  // fail-visible lab beacon chain (invoked -> ... -> mstsc-started) is untouched.
  assert.ok(cs.includes('if (TraceParam(uri).Length > 0) { TelPreflight(uri, server, host, port); }'),
    'the preflight is not gated on the click trace');
  assert.match(cs, /TraceRe = new Regex\(@"\^\[A-Za-z0-9\\-\]\{4,64\}\$"/, 'the trace id is not validated');
  // TLS probe: permissive callback that READS the certificate
  const tls = cs.slice(cs.indexOf('private static bool TelTls'), cs.indexOf('private static string TelPreflight'));
  assert.ok(tls.includes('return true;   // PERMISSIVE: read only, never trust'), 'the client TLS probe must be read-only');
  assert.ok(tls.includes('X509Chain'), 'the client TLS probe must evaluate the chain locally');
  assert.ok(tls.includes('2.5.29.37'), 'the client TLS probe must name the EKU failure class');
});

test('F37-6 every click mints a trace id and the dashboard renders ONE timeline', () => {
  assert.ok(ui.includes('id="telescopeRow"') && ui.includes('id="telescopeSegments"'), 'the timeline row is missing');
  assert.ok(ui.includes('function telescopeTimeline(s, nowMs)'), 'the pure timeline function is missing');
  assert.ok(ui.includes('function mintTraceId(src)'), 'the client trace minter is missing');
  assert.ok(ui.includes('id="btnRunDiag"'), 'the [RUN DIAG] button is missing');
  assert.ok(ui.includes("launchProto(url+traceParam())"), '[RUN DIAG] must fire the diag verb with a trace id');
  // AUTO-LOGIN and the one-click recovery both carry the click's trace id
  assert.ok(ui.includes("+'&t='+encodeURIComponent(ticket)") &&
    /ghrdpRdpUrl\(fqdn,user,[\s\S]{0,200}?\)\+traceParam\(\)\+'&t='/.test(ui), 'the AUTO-LOGIN click does not mint a trace id');
  assert.ok(/ghrdpRecredUrl\(fqdn,user\)\+traceParam\(\)\+'&t='/.test(ui), 'the RECONNECT click does not mint a trace id');
});

// ---------------------------------------------------------------------------
// §4 runner telescope
// ---------------------------------------------------------------------------
test('F37-7 the runner tick is 60s, uses the module, and never invents a format', () => {
  assert.match(srv, /\$script:F37TelIntervalSec = 60/, 'the production tick is not 60s');
  assert.ok(srv.includes("$env:GHRDP_LAB_TEL_INTERVAL_SEC"), 'the lab-only tick shortening switch is missing');
  const blk = srv.slice(srv.indexOf('# [F37 §4 telescope-begin]'), srv.indexOf('# [F37 §4 telescope-end]'));
  assert.ok(blk.length > 1000, 'the runner telescope block is missing');
  assert.ok(blk.includes("rdp-telescope.ps1"), 'the runner does not load the single-source module');
  assert.ok(blk.includes('. $f37cand'), 'the runner must DOT-SOURCE the module (never re-implement the format)');
  assert.ok(blk.includes('Invoke-RdpTelescope'), 'the runner never runs the telescope');
  assert.ok(blk.includes('Get-RdpTelescopeFields'), 'the runner does not use the shared field derivation');
  assert.ok(blk.includes('Get-RdpTelescopeStageLine'), 'the runner does not SELECT stage lines through the module');
  // no second format implementation: the block must never build a telescope
  // line by hand (only the module may serialize stages)
  for (const dup of ['\"stage\":\"', 'chainStatus =', 'failureAt = ', "New-RdpTelescopeLine"]) {
    assert.ok(!blk.includes(dup), 'the runner block re-implements the format: ' + dup);
  }
  // the 60s tick is wired into the serve loop and runs once at startup
  assert.match(srv, /if \(\(\(Get-Date\) - \$lastTelScan\)\.TotalSeconds -ge \$script:F37TelIntervalSec\)/, 'the tick is not in the accept loop');
  assert.match(srv, /STARTUP SCAN: the telescope stamps BEFORE the first client can poll/, 'the startup scan is missing');
  // row surfaces
  assert.ok(srv.includes('telescope = $f37State.telescope'), 'native-status does not serve the runner telescope');
  assert.ok(srv.includes('telescopeCollector = $f37State.telescopeCollector'), 'native-status does not serve the tick liveness');
  assert.ok(srv.includes('telescopeClient = $f37Client'), 'native-status does not serve the client beacons');
  assert.ok(srv.includes("telescopeLive"), 'the row cannot prefer the live sample over the workflow stamp');
  assert.ok(ui.includes('boundThumb') && ui.includes('servedThumb') && ui.includes('DRIFT'),
    'the SERVER CONN LOG row does not render boundThumb vs servedThumb');
  assert.ok(ui.includes('aclSids') && ui.includes('schannelTail'), 'the row does not render aclSids + the schannel tail');
});

test('F37-8 the client beacon endpoint allowlists stage/slug/trace (a secret cannot ride a beacon)', () => {
  const ep = srv.slice(srv.indexOf("if ($path -eq '/api/rdp-telescope' -and $parts.method -eq 'POST')"));
  const body = ep.slice(0, ep.indexOf('Add-F37ClientBeacon'));
  assert.ok(body.length > 200, 'the telescope endpoint is missing');
  for (const field of ['$bjT.trace', '$bjT.stage', '$bjT.ok', '$bjT.details']) {
    assert.ok(body.includes(field), 'the endpoint does not read ' + field);
  }
  assert.match(body, /\^\[A-Za-z0-9\\-\]\{4,64\}\$/, 'the endpoint does not validate the trace id');
  assert.ok(body.includes("telescope-unparsed"), 'an unknown slug must be neutralized, not stored');
  // [F37 §3 beacon-stage] the stage is DERIVED from the shared slug through the
  // module - the declared stage can only agree or be neutralized, so a
  // mislabeled (or future) beacon can never become a timeline verdict.
  assert.ok(body.includes('Get-F37BeaconStageForSlug'), 'the server trusts the declared stage instead of deriving it');
  assert.ok(!/\$cb\.stage = \$stT\b/.test(body), 'the declared stage is stored verbatim (the client would be the authority)');
  assert.ok(body.includes("$cb.stage = 'other'") && body.includes("$cb.details = 'telescope-unparsed'"),
    'a slug/stage disagreement is not neutralized');
  const helper = srv.slice(srv.indexOf('function Get-F37BeaconStageForSlug'), srv.indexOf('function New-F37TelescopeFallback'));
  assert.ok(helper.length > 200, 'the server-side slug -> stage derivation is missing');
  assert.ok(helper.includes('Get-RdpTelescopeBeaconStage -Slug $Slug'),
    'the server keeps a second slug -> stage mapping instead of asking the module');
  assert.ok(helper.includes('$script:F37TelModule'),
    'the derivation does not say how it answers when the module is absent');
  // the SERVER's slug regex must accept exactly the module's slugs
  const m = srv.match(/\$script:F37TelSlugRe = '([^']+)'/);
  assert.ok(m, 'the server slug allowlist is missing');
  const re = new RegExp(m[1]);
  for (const s of SLUGS) { assert.ok(re.test(s), 'the server would reject a shared slug: ' + s); }
  for (const bad of ['telescope-tls-ok password=x', 'password=P@ss', 'telescope-secret-ok', 'telescope-dns-ok token=abc']) {
    assert.ok(!re.test(bad), 'the server allowlist accepts a non-slug: ' + bad);
  }
  // only the five allowlisted fields are ever stored
  const add = srv.slice(srv.indexOf('function Add-F37ClientBeacon'), srv.indexOf('function Get-F37ClientTelescope'));
  const obj = add.slice(add.indexOf('$obj = [ordered]@{'), add.indexOf('}', add.indexOf('$obj = [ordered]@{')));
  const keys = [...obj.matchAll(/^\s*(\w+)\s*=/gm)].map(m => m[1]);
  assert.deepStrictEqual(keys.sort(), ['details', 'ok', 'stage', 'trace', 'ts'],
    'the beacon store accepts a field outside the allowlist: ' + keys.join(','));
});

test('F37-9 the live probe and the keep-alive tick stamp rdpListener.telescope (single derivation)', () => {
  assert.ok(main.includes('payloads/rdp-telescope.ps1'), 'main.yml never loads the module');
  assert.ok(main.includes('Invoke-RdpTelescope -Fqdn $dnsName'), 'the F17 probe does not run the telescope');
  assert.ok(main.includes('Get-RdpTelescopeFields -Telescope $f37Tel'), 'the probe does not use the shared derivation');
  assert.ok(main.includes('telescope = [ordered]@{'), 'rdpListener.telescope is never stamped');
  assert.ok(main.includes("Write-RdpTelescopeSummary"), 'the telescope is never printed to the step summary');
  assert.ok(main.includes('rdp-telescope.jsonl'), 'no JSONL artifact is written');
  assert.ok(main.includes('name: F37 telescope artifact (survives halts)'), 'the artifact step is missing');
  assert.ok(main.includes("rdp-telescope.ps1\" \"$RUNNER_TEMP/ghrdp-stage/rdp-telescope.ps1\""),
    'the module is not deployed next to the server');
  // the keep-alive 60s tick stamps the same object, from the same module
  const ka = main.slice(main.indexOf('# [F37 §4] TELESCOPE ON THE SAME 60s KEEP-ALIVE TICK'));
  assert.ok(ka.length > 500, 'the keep-alive telescope stamp is missing');
  assert.ok(ka.includes("Invoke-RdpTelescope -Fqdn $f37Fqdn -Src 'keepalive'"), 'the keep-alive tick does not run the telescope');
  assert.ok(ka.includes("$rlT | Add-Member -NotePropertyName telescope"), 'the keep-alive tick does not stamp rdpListener.telescope');
  assert.ok(main.includes("'telescope')) {"), 'the F24 carry-forward does not preserve the telescope across the probe rebuild');
  // no GHRDP_LAB_ switch may ever reach production
  assert.ok(!/GHRDP_LAB_[A-Z_]+/.test(main), 'main.yml carries a GHRDP_LAB_ switch (lab-only by contract)');
});

// ---------------------------------------------------------------------------
// §2 lab self-explanation
// ---------------------------------------------------------------------------
test('F37-10 the lab cert is Schannel-acceptable and the cell prints the telescope before AND after the bind', () => {
  assert.ok(lab.includes('2.5.29.37={text}1.3.6.1.5.5.7.3.1'), 'the lab cert has no ServerAuth EKU');
  assert.ok(lab.includes('2.5.29.17={text}DNS='), 'the lab cert has no SAN');
  assert.ok(lab.includes('$labSan'), 'the SAN text-extension is not passed to New-SelfSignedCertificate');
  assert.ok(/New-SelfSignedCertificate -DnsName \$fqdn, 'localhost', \$env:COMPUTERNAME/.test(lab),
    'the lab cert SAN does not cover localhost + machinename');
  const before = lab.indexOf('F37 lab telescope BEFORE bind');
  const bindIdx = lab.indexOf("New-ItemProperty -Path 'HKLM:\\System\\CurrentControlSet\\Control\\Terminal Server\\WinStations\\RDP-Tcp' -Name 'SSLCertificateSHA1Hash'");
  const after = lab.indexOf('F37 lab telescope AFTER bind+restart');
  assert.ok(before > 0 && bindIdx > 0 && after > 0, 'a telescope/bind anchor is missing from the lab cell');
  assert.ok(before < bindIdx, 'the BEFORE telescope must run before the cert bind');
  assert.ok(bindIdx < after, 'the AFTER telescope must run after the cert bind');
  assert.ok(lab.includes('Write-RdpTelescopeSummary -Telescope $telBeforeR') &&
    lab.includes('Write-RdpTelescopeSummary -Telescope $telAfterR'),
    'the lab must PRINT every telescope field (both runs) into the step summary');
  // the cell passes only if servedThumb == boundThumb AND the handshake succeeds
  assert.ok(lab.includes("if ($servedR -ne $boundR) { R-Fail 'bind-effectiveness'"), 'served==bound is not gated');
  assert.ok(lab.includes("if ($telAfterR.deathPoint -ne 'none') { R-Fail 'bind-effectiveness'"), 'the death point is not gated');
  assert.ok(lab.includes('Test-RdpListenerHandshake.ps1') && lab.includes("if (-not $effective) { R-Fail 'bind-effectiveness'"),
    'the strict F31 handshake is no longer gated');
  // a cert cell can never exit red WITHOUT the telescope fields
  const cell = lab.slice(bindIdx, lab.indexOf("Write-Host ('[R] baseline OK"));
  const fails = cell.split(/\r?\n/).map(l => l.trim()).filter(l => l.includes("R-Fail '"));
  assert.ok(fails.length >= 4, 'the bind-effectiveness failures were not found (found ' + fails.length + ')');
  for (const f of fails) {
    assert.ok(/\$dump(Before|After)R/.test(f), 'a bind-effectiveness failure can exit red without the telescope fields: ' + f);
  }
});

test('F37-11 the lab drives the real diag verb, the beacon ring, the allowlist and the real-sample timeline', () => {
  const z = lab.slice(lab.indexOf('Z: F37 telescope - module fields'), lab.indexOf('# [F19 §5] LAB PROOF'));
  assert.ok(z.length > 2000, 'lab cell Z is missing');
  assert.ok(z.includes('Get-RdpTelescopeFormatTokens'), 'cell Z does not check the module token set');
  assert.ok(z.includes('ghrdp://diag?server='), 'cell Z never fires the real diag verb');
  assert.ok(z.includes('telescopeClient'), 'cell Z never reads the client beacon ring');
  assert.ok(z.includes('P@ssw0rd-lab-SECRET-9876'), 'cell Z has no secret-shaped beacon negative');
  assert.ok(z.includes("'telescope-unparsed'"), 'cell Z does not assert the allowlist neutralization');
  assert.ok(z.includes('node --test tests/f37-telescope.test.js'), 'cell Z does not run this matrix');
  assert.ok(z.includes('F37_TEL_FIXTURE'), 'cell Z does not feed the REAL sample to the renderer');
  assert.ok(z.includes('aclSids'), 'cell Z does not assert the live ACL SIDs');
});

test('F37-12 the F37 gate exists, is fail-closed and executes this matrix', () => {
  const g = gates.slice(gates.indexOf('name: F37 telescope'), gates.indexOf('name: Native UI and VPS contracts'));
  assert.ok(g.length > 500, 'the F37 gate step is missing from launch-gates');
  assert.ok(g.includes('node --test tests/f37-telescope.test.js'), 'the gate does not execute the matrix');
  assert.ok(g.includes('rdp-telescope.ps1'), 'the gate does not pin the single source of truth');
  assert.ok(g.includes('exit 1'), 'the gate is not fail-closed');
});

// ---------------------------------------------------------------------------
// §3/§4 the timeline - EXECUTED out of the shipped page
// ---------------------------------------------------------------------------
function timelineContext() {
  const begin = ui.indexOf('// [F37 §3 timeline-begin]');
  const end = ui.indexOf('// [F37 §3 timeline-end]');
  assert.ok(begin > 0 && end > begin, 'the timeline markers are missing from ui.html');
  const ctx = {
    document: { getElementById: id => (ctx.els[id] || (ctx.els[id] = { id, style: {}, textContent: '' })) },
    els: {}, String, Number, RegExp, JSON, Date, Math, Uint8Array,
    encodeURIComponent, console,
    liveDispatchAsList: v => Array.isArray(v) ? v : (v == null ? [] : [v]),
    FQDN_RE: /^[a-z0-9][a-z0-9-]*(\.[a-z0-9-]+)+\.ts\.net$/i,
    $: () => null, launchProto: () => { }
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(ui.slice(begin, end), ctx);
  return ctx;
}
const line = o => JSON.stringify(o);
function clientBeacons(stages, trace) {
  return stages.map((s, i) => ({
    ts: '2026-09-27T07:00:0' + i + 'Z', trace, stage: s.stage, ok: s.ok, details: s.slug
  }));
}
const GREEN_STAGES = [
  { stage: 'dns', ok: true, slug: 'telescope-dns-ok' },
  { stage: 'tcp', ok: true, slug: 'telescope-tcp-ok' },
  { stage: 'tls', ok: true, slug: 'telescope-tls-ok' },
  { stage: 'cred', ok: true, slug: 'telescope-cred-ok' }
];
function runnerLines(bound, served, extra) {
  return [
    line({ ts: 'x', trace: 'r1', src: 'live', stage: 'dns', ok: true, fqdn: 'h.ts.net', ip: '127.0.0.1', why: 'runner-local observation (listener face; DNS is not on this path)' }),
    line({ ts: 'x', trace: 'r1', src: 'live', stage: 'tcp', ok: true, ip: '127.0.0.1', port: 3389, rttMs: 2 }),
    line(Object.assign({ ts: 'x', trace: 'r1', src: 'live', stage: 'tls', ok: true, servedThumb: served, chainOk: true, nameMatch: true, serverAuth: true }, extra.tls || {})),
    line(Object.assign({ ts: 'x', trace: 'r1', src: 'live', stage: 'listener', ok: true, boundThumb: bound, servedThumb: served, serving: true, inStore: true, hasKey: true, container: 'c1', aclSids: ['S-1-5-18:FullControl:Allow', 'S-1-5-20:Read:Allow'], aclRead: true, aclOk: true }, extra.listener || {})),
    line(Object.assign({ ts: 'x', trace: 'r1', src: 'live', stage: 'schannel', ok: true, schannelIds: [], lastSchannelId: '', lastSchannelTs: '', schannelWhy: '', sinceSec: 3600 }, extra.schannel || {})),
    line(Object.assign({ ts: 'x', trace: 'r1', src: 'live', stage: 'logon', ok: true, eventId: '4624', logonType: '10', sub: '', eventTs: '2026-09-27T06:59:00Z', count4624: 1, count4625: 0 }, extra.logon || {}))
  ];
}
function sample(opts) {
  return {
    fqdn: 'lab-host.dekarita.tailnet-lab.ts.net',
    runnerResolvedIP: '100.118.42.7', pingMs: 12,
    telescopeClient: { count: 4, newestTrace: 't1', items: clientBeacons(opts.client || GREEN_STAGES, 't1') },
    rdpListener: {
      listenerHandshakeOk: true,
      telescope: { ts: 'x', src: 'live', deathPoint: opts.runnerDeath || 'none', lines: opts.runnerLines || runnerLines('AA11', 'AA11', {}) }
    },
    telescopeCollector: { alive: true, intervalSec: 60 }
  };
}

test('F37-13 the all-green sample renders ONE timeline with deathPoint=none', () => {
  const ctx = timelineContext();
  const tl = ctx.telescopeTimeline(sample({}), Date.now());
  assert.strictEqual(tl.deathPoint, 'none');
  assert.strictEqual(tl.ok, true);
  for (const s of ['dns', 'tcp', 'tls', 'cred', 'listener', 'logon']) {
    assert.ok(tl.segments.some(x => x.stage === s), 'the timeline lost the ' + s + ' segment');
  }
  ctx.paintTelescopeTimeline(sample({}));
  assert.match(ctx.els.telescopeSummary.textContent, /^ALL GREEN/);
  assert.match(ctx.els.telescopeSegments.textContent, /\[client\] tls ok/);
  assert.match(ctx.els.telescopeSegments.textContent, /\[runner\] listener ok/);
  assert.ok(!/undefined/.test(ctx.els.telescopeSegments.textContent), 'the timeline rendered an undefined field');
});

test('F37-14 the FIRST red segment is the death point, and it is CLASSED (rst-before-cert => tls-cert)', () => {
  const ctx = timelineContext();
  const red = sample({
    client: [
      { stage: 'dns', ok: true, slug: 'telescope-dns-ok' },
      { stage: 'tcp', ok: true, slug: 'telescope-tcp-ok' },
      { stage: 'tls', ok: false, slug: 'telescope-rst-before-cert' },
      { stage: 'cred', ok: true, slug: 'telescope-cred-ok' }
    ],
    runnerLines: runnerLines('AA11', '', {
      tls: { ok: false, failureAt: 'rst-before-cert', servedThumb: '', chainOk: false, nameMatch: false, why: 'server reset before presenting a certificate' },
      listener: { ok: false, servedThumb: '', serving: false, why: 'NETWORK SERVICE (S-1-5-20) Read ACE absent or unverified' },
      schannel: { ok: false, schannelIds: ['36870'], schannelWhy: 'A fatal alert was generated' },
      logon: { ok: false, eventId: '', count4624: 0 }
    })
  });
  const tl = ctx.telescopeTimeline(red, Date.now());
  assert.strictEqual(tl.deathPoint, 'tls-cert', 'rst-before-cert must map to tls-cert');
  assert.ok(tl.segments.length > 0 && tl.segments[0].ok === true, 'the timeline must start green before the death point');
  const dead = tl.segments.find(s => s.ok === false);
  assert.strictEqual(dead.stage, 'tls', 'the first red segment must be the TLS stage');
  assert.ok(tl.fix.length > 20, 'a death point must carry a targeted fix');
  ctx.paintTelescopeTimeline(red);
  assert.match(ctx.els.telescopeSummary.textContent, /^DEATH POINT: tls-cert/);
  assert.match(ctx.els.telescopeDeath.textContent, /first red segment: tls-cert/);
});

test('F37-15 every death point class is reachable and named (dns|tcp|tls-chain|tls-eku|name-mismatch|credssp|acl|logon)', () => {
  const ctx = timelineContext();
  const cases = [
    ['dns', sample({ client: [{ stage: 'dns', ok: false, slug: 'telescope-dns-fail' }], runnerLines: runnerLines('AA11', 'AA11', {}) })],
    ['tcp', sample({ client: [{ stage: 'dns', ok: true, slug: 'telescope-dns-ok' }, { stage: 'tcp', ok: false, slug: 'telescope-tcp-fail' }] })],
    ['tls-chain', sample({ client: [{ stage: 'tls', ok: false, slug: 'telescope-chain' }] })],
    ['tls-eku', sample({ client: [{ stage: 'tls', ok: false, slug: 'telescope-eku' }] })],
    ['name-mismatch', sample({ client: [{ stage: 'tls', ok: false, slug: 'telescope-name-mismatch' }] })],
    ['credssp', sample({ client: [{ stage: 'cred', ok: false, slug: 'telescope-cred-missing' }], runnerLines: runnerLines('AA11', 'AA11', {}) })],
    ['acl', sample({ client: GREEN_STAGES, runnerLines: runnerLines('AA11', 'AA11', { listener: { ok: false, aclRead: false, aclSids: [], why: 'NETWORK SERVICE (S-1-5-20) Read ACE absent or unverified' } }) })],
    ['logon', sample({ client: GREEN_STAGES, runnerLines: runnerLines('AA11', 'AA11', { logon: { ok: false, eventId: '', count4624: 0, count4625: 1, sub: '0xC000006A' } }) })]
  ];
  for (const [want, s] of cases) {
    const tl = ctx.telescopeTimeline(s, Date.now());
    assert.strictEqual(tl.deathPoint, want, 'the timeline misclassifies ' + want);
    assert.strictEqual(tl.ok, false);
    assert.ok(tl.fix.length > 20, want + ' has no fix text');
  }
});

test('F37-16 a missing client telescope is NOT a red path, and a missing runner sample says so', () => {
  const ctx = timelineContext();
  const tl = ctx.telescopeTimeline({ rdpListener: {}, telescopeCollector: null }, Date.now());
  assert.strictEqual(tl.deathPoint, 'none', 'absent telemetry must never be reported as a path failure');
  assert.ok(tl.segments.some(s => s.ok === null && /RUN DIAG/.test(s.detail)), 'the placeholder must tell the user what to click');
  const sampled = ctx.telescopeTimeline({ telescope: null, rdpListener: { telescope: { src: 'keepalive', deathPoint: 'none', lines: [] } } }, Date.now());
  assert.strictEqual(sampled.deathPoint, 'none');
});

test('F37-18 the listener stage names the CERTIFICATE itself (ServerAuth EKU + SAN), and a missing EKU is a death point', () => {
  const mod = fs.readFileSync('payloads/rdp-telescope.ps1', 'utf8');
  const allow = /listener = @\(([^)]*)\)/.exec(mod);
  assert.ok(allow, 'the listener allowlist is missing');
  for (const f of ['hasServerAuth', 'eku', 'san']) {
    assert.ok(allow[1].includes("'" + f + "'"), 'the listener allowlist drops ' + f + ' (the cause would be invisible)');
  }
  // the EKU/SAN are read from the SHIPPED functions, and the verdict requires them
  assert.ok(mod.includes("$_.Oid.Value -eq '2.5.29.37'"), 'the ServerAuth EKU is not read from the bound certificate');
  assert.ok(mod.includes("$_.Oid.Value -eq '2.5.29.17'"), 'the SAN is not read from the bound certificate');
  assert.ok(mod.includes('bound cert has NO ServerAuth EKU'), 'a missing ServerAuth EKU is not named');
  assert.match(mod, /\$ok = \(\$fields\.inStore -and \$fields\.hasKey -and \$fields\.hasServerAuth -and \$fields\.aclOk -and \$fields\.serving\)/,
    'a cert without ServerAuth must not be able to pass the listener verdict');
  // the death point prefers the CAUSE over the symptom of an RST
  assert.match(mod, /hasServerAuth'\] -and -not \[bool\]\$listenerObj\.hasServerAuth\) \{ return 'tls-eku' \}/,
    'a missing ServerAuth EKU does not name the tls-eku death point');
  // and the derived fields travel to the config stamp / conn log row
  for (const f of ['hasServerAuth', 'eku', 'san']) {
    assert.ok(new RegExp('\\$out\\.' + f + ' =').test(mod), 'Get-RdpTelescopeFields does not derive ' + f);
  }
  assert.ok(fs.readFileSync('payloads/ui.html', 'utf8').includes('NO-ServerAuth'),
    'the SERVER CONN LOG row cannot render a missing ServerAuth EKU');
});

test('F37-19 the lab cannot go red without a readable annotation (trap + collapsed ::error:: + forensics step)', () => {
  const lab = fs.readFileSync('.github/workflows/autologin-lab.yml', 'utf8');
  // the two F37 cells catch unhandled exceptions and say so on ONE line
  assert.ok((lab.match(/stage=unhandled/g) || []).length >= 2, 'the F37 cells have no unhandled-error trap');
  assert.ok((lab.match(/\$f37one = \(\$Detail -replace/g) || []).length >= 2,
    'the fail helpers do not collapse their detail (a multi-line workflow command is dropped by GitHub)');
  // the lab cert carries BOTH extensions, with the documented fallback
  assert.ok(lab.includes("$labEku = '2.5.29.37={text}1.3.6.1.5.5.7.3.1'"), 'the lab cert lost the ServerAuth EKU');
  assert.ok(lab.includes("$labSan = '2.5.29.17={text}DNS='"), 'the lab cert lost the SAN');
  assert.ok(lab.includes('New-SelfSignedCertificate -Subject'), 'the lab cert is not built from an explicit subject');
  assert.ok(lab.includes('$labCertForm'), 'the lab does not report which cert form it used');
  // the forensics step re-emits evidence whenever a cell failed
  const q = lab.slice(lab.indexOf('Q: failure forensics'), lab.indexOf('G: setup-time'));
  assert.ok(q.length > 100, 'the failure-forensics step is missing');
  assert.ok(q.includes('if: ${{ failure() }}'), 'the forensics step does not run on failure');
  assert.ok(q.includes('::error::[forensics]'), 'the forensics step emits no annotation');
  assert.ok(q.includes('Format-RdpTelescopeDump'), 'the forensics step does not re-print the telescope');
  assert.ok(q.includes('de-diag'), 'the forensics step does not re-emit the cell classification files');
});

test('F37-20 the persisted key file is RESOLVED, not assumed (single source, with evidence)', () => {
  const mod = fs.readFileSync('payloads/rdp-telescope.ps1', 'utf8');
  const acl = fs.readFileSync('payloads/Grant-RdpKeyAccess.ps1', 'utf8');
  // the module owns the resolver
  assert.ok(mod.includes('function Resolve-RdpTelescopeKeyFile'), 'the module does not own the key-file resolver');
  // it searches BOTH stores + the per-user variants and reports what it found
  for (const token of ["Microsoft\\Crypto\\Keys", "Microsoft\\Crypto\\RSA\\MachineKeys", '$env:APPDATA', 'dirSample', 'hits']) {
    assert.ok(mod.includes(token), 'the resolver does not cover ' + token);
  }
  // the listener carries the hunt into every dump / config stamp / row
  for (const f of ['keyFileFound', 'keyFileCandidates', 'keyDirHits', 'keyDirSample', 'containerKind']) {
    assert.ok(new RegExp("'" + f + "'").test(mod), 'the listener allowlist drops ' + f);
  }
  assert.ok(mod.includes('persisted key file NOT FOUND'), 'a missing key file is not named with its search evidence');
  // a provider name is a claim; a UNIQUE stem match is accepted and reported
  assert.ok(mod.includes("$out.pathSource = 'stem-hit'"), 'a unique naming-variant match is not accepted');
  assert.ok(mod.includes("$out.pathSource = 'ambiguous-stem-hit'"), 'an ambiguous match must not be accepted silently');
  assert.ok(mod.includes("'keyFilePathSource'"), 'the chosen path source does not travel to the row');
  // the BEFORE-bind telescope resolves the EXPECTED certificate (nothing is bound yet)
  assert.ok(mod.includes('$lookupThumb = $(if ($want) { $want } else { $boundHex })'),
    'the listener only looks at the BOUND thumb, so the before-bind evidence is empty');
  // the F31 ACL helper uses the SAME resolver (never an assumed path) and keeps
  // its own fallback + the search evidence in the thrown message
  assert.ok(acl.includes("Resolve-RdpTelescopeKeyFile"), 'the ACL helper does not share the resolver');
  assert.ok(acl.includes("Join-Path $PSScriptRoot 'rdp-telescope.ps1'"), 'the ACL helper does not load the module next to it');
  for (const token of ['GetRSAPrivateKey', "Crypto\\Keys", "RSA\\MachineKeys", 'S-1-5-20', 'S-1-5-18', 'Set-Acl', 'GetAccessRules', 'Required ACE absent', 'Persisted machine key file missing']) {
    assert.ok(acl.includes(token), 'the ACL helper lost a shipped token: ' + token);
  }
  assert.ok(acl.includes('stores=['), 'the ACL failure carries no store evidence');
  assert.ok(fs.readFileSync('payloads/ui.html', 'utf8').includes('keyFile=NOT-FOUND'),
    'the live row cannot render a missing key file');
});

test('F37-21 the lab forces key persistence and names the ACL stage (no red without evidence)', () => {
  const lab = fs.readFileSync('.github/workflows/autologin-lab.yml', 'utf8');
  assert.ok(lab.includes('certutil.exe -repairstore My'), 'the lab never forces the key association');
  assert.ok(lab.includes("R-Fail 'key-acl-grant'"), 'the ACL grant can still fail as an unhandled exit');
  assert.ok(new RegExp("Invoke-RdpTelescope -Fqdn \\$fqdn -Src 'lab' -Local -Ip '127.0.0.1' -ExpectedThumb \\$lc.Thumbprint").test(lab),
    'the before-bind telescope does not carry the expected thumbprint');
  assert.ok(lab.includes("telescope BEFORE bind: deathPoint="), 'the lab does not print the before-bind verdict');
  assert.ok(lab.includes("keyFileFound="), 'the lab does not print the key-file verdict');
  // the forensics channel keeps reading the telescope and the classification files
  const q = lab.slice(lab.indexOf('Q: failure forensics'), lab.indexOf('G: setup-time'));
  assert.ok(q.includes('telescope-now'), 'forensics no longer re-prints the telescope');
  assert.ok(q.includes("'*.jsonl'"), 'forensics no longer re-emits the telescope artifacts');
});

test('F37-22 the certificate callback is COMPILED (a scriptblock callback cannot run on the handshake thread)', () => {
  const mod = fs.readFileSync('payloads/rdp-telescope.ps1', 'utf8');
  const probe = fs.readFileSync('payloads/Test-RdpListenerHandshake.ps1', 'utf8');
  // one compiled delegate, installed once, shared with the F31 probe
  assert.ok(mod.includes('function Add-RdpTelescopeTlsShim'), 'the module does not install the compiled callback shim');
  assert.ok(mod.includes('public static class GhrdpTelTls'), 'the compiled callback class is missing');
  assert.ok(mod.includes('public static RemoteCertificateValidationCallback Callback()'), 'the shim exposes no delegate factory');
  assert.ok(mod.includes('Add-RdpTelescopeTlsShim'), 'the TLS stage never installs the shim');
  assert.ok(probe.includes("Add-RdpTelescopeTlsShim"), 'the F31 probe does not use the shared shim');
  assert.ok(probe.includes("Join-Path $PSScriptRoot 'rdp-telescope.ps1'"), 'the F31 probe does not load the module next to it');
  // and NO surface may hand a PowerShell scriptblock to the TLS stack
  for (const [name, text] of [['module', mod], ['probe', probe]]) {
    assert.ok(!/RemoteCertificateValidationCallback\]\s*\{/.test(text),
      name + ' still passes a scriptblock to RemoteCertificateValidationCallback (threadpool => no runspace => false rst-before-cert)');
  }
  // the permissive/read-only rule survives in both places
  assert.ok(mod.includes('never trust'), 'the read-only promise is gone from the module');
  assert.ok(probe.includes('GhrdpTelTls'), 'the probe does not read the shim result');
});

test('F37-23 the X.224 confirm / RDP_NEG_RSP layout is EXECUTED and single-sourced (no off-by-one)', () => {
  const mod = fs.readFileSync('payloads/rdp-telescope.ps1', 'utf8');
  const probe = fs.readFileSync('payloads/Test-RdpListenerHandshake.ps1', 'utf8');
  // the canonical MS-RDPBCGR bytes: TPKT(4) trimmed off ->
  //   06 d0 | dst-ref | src-ref | class | 02 | 00 | 08 00 | selectedProtocol(HYBRID=2)
  const response = Buffer.from([0x06, 0xd0, 0x00, 0x00, 0x12, 0x34, 0x00, 0x02, 0x00, 0x08, 0x00, 0x02, 0x00, 0x00, 0x00]);
  // the SHIPPED indices, executed here
  assert.equal(response.length, 15, 'the canonical response must be 15 bytes after TPKT');
  assert.equal(response[1], 0xd0, 'X.224 confirm class byte');
  assert.equal(response[7], 0x02, 'RDP_NEG_RSP type at offset 7');
  assert.equal(response[8], 0x00, 'RDP_NEG_RSP flags at offset 8');
  assert.equal(response[9], 0x08, 'RDP_NEG_RSP length low byte at offset 9 (little-endian 8)');
  assert.equal(response[10], 0x00, 'RDP_NEG_RSP length high byte at offset 10');
  assert.equal(response.readUInt32LE(11), 2, 'selectedProtocol at offset 11');
  // the module writes EXACTLY those indices...
  for (const token of ['$Response[1] -ne 0xd0', '$Response[7] -ne 2', '$Response[9] -ne 8', '$Response[10] -ne 0', '[BitConverter]::ToUInt32($Response, 11)']) {
    assert.ok(mod.includes(token), 'the shared X.224 validator lost: ' + token);
  }
  assert.ok(mod.includes('function Test-RdpTelescopeX224Confirm'), 'the shared X.224 validator is missing');
  // ...and NO surface may hand-roll the layout again (the off-by-one that made
  // a healthy listener read as "RDP negotiation did not select TLS")
  for (const [name, text] of [['module', mod], ['probe', probe]]) {
    for (const bad of ['[6] -ne 2', '[8] -ne 8', '[9] -ne 0', 'ToUInt32($response, 10)', 'ToUInt32($Response, 10)']) {
      assert.ok(!text.includes(bad), name + ' re-implements the X.224 offsets (off-by-one): ' + bad);
    }
  }
  assert.ok(probe.includes('Test-RdpTelescopeX224Confirm -Response $response'),
    'the F31 probe does not use the shared X.224 validator');
});

test('F37-24 every runtime the SERVER loads stays Windows PowerShell 5.1 safe', () => {
  // The live server is started with powershell.exe (in-box 5.1 / .NET Framework),
  // and a .NET Core-only API silently degraded the whole runner telescope into a
  // fallback line. Only APIs that exist on BOTH runtimes may be used.
  const surfaces = ['payloads/rdp-telescope.ps1', 'payloads/ghrdp-server.ps1', 'payloads/ghrdp-lib.ps1', 'payloads/Grant-RdpKeyAccess.ps1', 'payloads/Test-RdpListenerHandshake.ps1'];
  const coreOnly = [
    /RandomNumberGenerator\]::(GetBytes|Fill)\(/,
    /\[Convert\]::ToHexString\(/,
    /SHA(256|384|512)\]::HashData\(/,
    /Encoding\]::Latin1/,
    /\[System\.IO\.Path\]::Join\(/,
  ];
  for (const f of surfaces) {
    const text = fs.readFileSync(f, 'utf8');
    for (const re of coreOnly) {
      assert.ok(!re.test(text), f + ' uses a .NET Core-only API (' + re + ') that does not exist on Windows PowerShell 5.1');
    }
  }
  // the trace id is minted with the instance API (both runtimes) and is
  // random + timestamp only - never derived from a credential
  const mod = fs.readFileSync('payloads/rdp-telescope.ps1', 'utf8');
  const fn = mod.slice(mod.indexOf('function New-RdpTelescopeTraceId'), mod.indexOf('function Select-RdpTelescopeLine'));
  assert.ok(fn.includes('RandomNumberGenerator]::Create()'), 'the trace id does not use the instance RNG');
  assert.ok(fn.includes('.GetBytes($r)'), 'the trace id does not fill the buffer with the instance RNG');
  assert.ok(!/(pass|pwd|secret|ticket|token)/i.test(fn), 'the trace id must never be derived from a credential');
});

// ---------------------------------------------------------------------------
// §4 SCOPE: the runner face must never be red for a client-owned fact
// ---------------------------------------------------------------------------
test('F37-25 the runner face skips the client-owned cred stage and SAYS why', () => {
  const blk = srv.slice(srv.indexOf('# [F37 §4 telescope-begin]'), srv.indexOf('# [F37 §4 telescope-end]'));
  assert.match(blk, /Invoke-RdpTelescope -Fqdn \$Fqdn -ExpectedThumb \$ExpectedThumb -Src \$Src -Local -Ip '127\.0\.0\.1' -SkipCred/,
    'the live runner still evaluates the CLIENT-owned cred stage (a healthy host reads as credssp)');
  assert.ok(blk.includes("credScope   = 'client-only'"), 'the runner sample does not state why it carries no cred line');
  // the module makes the runner face informational even if a caller forgets
  assert.ok(mod.includes('[switch]$Informational'), 'the cred stage has no runner-face (informational) mode');
  assert.ok(mod.includes('runner face: no stored TERMSRV target'), 'an absent client credential on the runner is not named as a scope fact');
  assert.ok(mod.includes('-Informational:$Local'), 'Invoke-RdpTelescope does not mark the runner face informational');
  // EVERY runner-side caller is runner-scoped
  assert.ok(main.includes("-ExpectedThumb $certThumb -SkipLogon -SkipCred"), 'the live F17 probe still evaluates the cred stage on the runner');
  assert.ok(main.includes("-Src 'keepalive' -Local -Ip '127.0.0.1' -SkipLogon -SkipCred"), 'the keep-alive tick lost its runner scope');
  // the lab proves the scope on the real runner, and keeps the client verdict real
  const z = lab.slice(lab.indexOf('Z: F37 telescope - module fields'), lab.indexOf('# [F19 §5] LAB PROOF'));
  assert.ok(z.includes("'module-scope'"), 'the lab never proves the runner/client cred scope split');
  assert.ok(z.includes("credScope -ne 'client-only'"), 'the lab does not require the runner sample to name its scope');
  assert.ok(z.includes('runner-scope'), 'the lab does not fail when a cred line reaches the runner sample');
});

test('F37-26 an absent RDP logon is INFORMATIONAL; only a rejection or an unreadable log is red', () => {
  const lg = mod.slice(mod.indexOf('function Get-RdpTelescopeLogon'), mod.indexOf('function Get-RdpTelescopeSchannel'));
  assert.ok(lg.includes('$newestReject'), 'the logon stage does not identify the newest event (a rejection is the only fault it owns)');
  assert.ok(lg.includes('informational: nobody has logged on yet'), 'an empty logon window is not named as informational');
  assert.ok(lg.includes('RDP logon rejected: newest event is a 4625'), 'a 4625 rejection is not named');
  assert.ok(!lg.includes("-Ok ([bool]($id -eq '4624'))"), 'the logon stage still paints an empty window red (false deathPoint=logon on every healthy runner)');
  assert.ok(lg.includes('Security log unreadable: '), 'an unreadable Security log must stay a named fault');
  // the death-point vocabulary keeps logon reachable for a REAL rejection
  assert.ok(DEATHS.includes('logon'), 'the logon death point disappeared');
});

test('F37-27 probeError is the LISTENER FACE; evidence travels as probeWarn (and neither hand-rolls the format)', () => {
  const blk = srv.slice(srv.indexOf('# [F37 §4 telescope-begin]'), srv.indexOf('# [F37 §4 telescope-end]'));
  assert.ok(blk.includes("'telescope red: '") && blk.includes("'telescope evidence: '"),
    'the runner tick does not separate a fatal stage from evidence');
  assert.match(blk, /@\('tcp', 'tls', 'listener'\) -contains \[string\]\$f37o\.stage/,
    'the fatal-stage set is not the listener face');
  assert.ok(blk.includes('ConvertFrom-Json'), 'the classification must read lines through JSON, never a hand-rolled match');
  assert.ok(!blk.includes('"ok":false'), 'the runner block matches on the wire format by hand');
  assert.ok(blk.includes('probeWarn   = [string]$script:F37TelLastWarn'), 'probeWarn never reaches the persisted sample');
  const col = blk.slice(blk.indexOf('function Get-RdpListenerTelescopeState'));
  assert.ok(col.includes('probeWarn'), 'native-status does not serve the evidence line');
  assert.ok(ui.includes('tc.probeWarn'), 'the row cannot show the runner evidence line');
});

test('F37-28 a derivation fault NAMES itself and the cause fields reach every surface', () => {
  assert.ok(mod.includes("$out.deriveError = ('field derivation failed: '"), 'the shared derivation swallows its own fault');
  assert.ok(mod.includes('redStages = @(); fatalStages = @(); deriveError ='), 'the derivation does not report which stages are red');
  const blk = srv.slice(srv.indexOf('# [F37 §4 telescope-begin]'), srv.indexOf('# [F37 §4 telescope-end]'));
  for (const f of ['deriveError', 'redStages', 'fatalStages', 'keyFileFound', 'containerKind', 'keyFilePathSource', 'keyTypedError', 'typesLoader', 'hasServerAuth', 'inStore', 'hasKey', 'aclOk', 'listenerWhy']) {
    assert.ok(blk.includes(f), 'the runner sample drops ' + f + ' (the row/annotation could not name the cause)');
  }
  assert.ok(blk.includes("$deriveThrown = ('derivation threw: '"), 'a thrown derivation is still silent');
  for (const f of ['keyFileFound', 'containerKind', 'keyFilePathSource', 'hasServerAuth', 'deriveError', 'fatalStages', 'redStages', 'keyTypedError', 'typesLoader']) {
    assert.ok(main.includes(f), 'the workflow telescope stamp drops ' + f);
  }
  for (const f of ['deriveError', 'keyTypedError', 'fatalStages', 'typesLoader']) {
    assert.ok(ui.includes(f), 'the SERVER CONN LOG row cannot render ' + f);
  }
});

test('F37-29 the key resolver survives Windows PowerShell 5.1 (assembly load + certutil fallback)', () => {
  const res = mod.slice(mod.indexOf('function Resolve-RdpTelescopeKeyFile'), mod.indexOf('function Get-RdpTelescopeListener'));
  assert.ok(mod.includes('function Initialize-RdpTelescopeCryptoTypes'), 'the 5.1 crypto-type loader is missing');
  assert.ok(mod.includes("'System.Security.Cryptography.X509Certificates'") && mod.includes("'System.Security.Cryptography.Cng'"),
    'the loader does not load the X509/Cng assemblies 5.1 leaves unloaded');
  assert.ok(mod.includes('LoadWithPartialName'), 'the loader has no .NET Framework path');
  assert.ok(res.includes('Initialize-RdpTelescopeCryptoTypes'), 'the resolver never calls the loader');
  assert.ok(res.indexOf('Initialize-RdpTelescopeCryptoTypes') < res.indexOf('RSACertificateExtensions'),
    'the loader runs AFTER the typed call it exists to make possible');
  assert.ok(res.includes('certutil.exe -store -v My $Certificate.Thumbprint'), 'the resolver has no provider-independent container source');
  assert.ok(res.includes("Key Container\\s*=") || res.includes('Key Container'), 'the certutil container name is not parsed');
  assert.ok(res.includes("'certutil-candidate'"), 'a certutil-resolved path is not reported as such');
  assert.ok(res.includes('$out.typedError'), 'a typed-resolution fault is not carried into the evidence');
  assert.ok(mod.includes("'keyTypedError'") && mod.includes("'typesLoader'"), 'the listener allowlist drops the resolver evidence');
  assert.ok(mod.includes('typedError='), 'the NOT FOUND message does not carry the resolver evidence');
});

test('F37-30 the death point cannot blame the EKU when nothing is bound', () => {
  const dp = mod.slice(mod.indexOf('function Get-RdpTelescopeDeathPoint'), mod.indexOf('function Invoke-RdpTelescope'));
  assert.match(dp, /\[bool\]\$listenerObj\.inStore -and \$listenerObj\.PSObject\.Properties\['hasServerAuth'\]/,
    'a listener with NO certificate still resolves tls-eku (the cause is "nothing bound")');
  assert.ok(dp.includes("if ($listenerObj -and $listenerObj.PSObject.Properties['boundThumb'] -and -not [string]$listenerObj.boundThumb) { return 'tls-cert' }"),
    'an unbound listener does not name tls-cert');
  assert.ok(dp.indexOf("return 'tls-eku'") < dp.indexOf("$listenerObj.boundThumb) { return 'tls-cert' }"),
    'a served-certificate EKU fault must outrank the unbound-listener case');
  assert.ok(dp.indexOf("return 'tls-cert' }") < dp.indexOf("return 'credssp'"), 'the listener verdict must outrank the client cred stage');
  for (const d of ['dns', 'tcp', 'tls-cert', 'tls-chain', 'tls-eku', 'name-mismatch', 'credssp', 'logon', 'acl', 'none']) {
    assert.ok(DEATHS.includes(d), 'the death-point vocabulary lost ' + d);
  }
});

test('F37-31 a NEUTRALIZED client beacon is not a stage verdict (executed)', () => {
  const ctx = timelineContext();
  const s = sample({
    client: [
      { stage: 'dns', ok: true, slug: 'telescope-dns-ok' },
      { stage: 'tcp', ok: true, slug: 'telescope-tcp-ok' },
      { stage: 'tls', ok: false, slug: 'telescope-unparsed' },
      { stage: 'cred', ok: true, slug: 'telescope-cred-ok' }
    ]
  });
  const tl = ctx.telescopeTimeline(s, Date.now());
  assert.strictEqual(tl.deathPoint, 'none', 'a beacon the allowlist neutralized became a death point');
  const seg = tl.segments.find(x => x.src === 'client' && x.stage === 'tls');
  assert.strictEqual(seg.ok, null, 'a neutralized beacon must render as unknown, not red');
  assert.match(seg.detail, /neutralized by the server allowlist/);
  ctx.paintTelescopeTimeline(s);
  assert.match(ctx.els.telescopeSummary.textContent, /^ALL GREEN/);
});

test('F37-32 the lab gives the client diag a stored target and fixtures the CLEAN sample', () => {
  const z = lab.slice(lab.indexOf('Z: F37 telescope - module fields'), lab.indexOf('# [F19 §5] LAB PROOF'));
  assert.ok(z.includes('cmdkey.exe /generic:TERMSRV/$fqdn /user:labuser /pass:LABDUMMY-win-9876'),
    'the client cred stage would be red on a healthy path (no stored target planted for the diag)');
  assert.ok(z.includes('cmdkey.exe /delete:TERMSRV/$fqdn'), 'the lab leaves its dummy credential behind');
  assert.ok(z.includes("'telescope-cred-ok'"), 'the lab does not require the client cred stage to be green');
  assert.ok(z.includes('$nsClean'), 'the timeline fixture is not captured from a clean sample');
  const cleanIdx = z.indexOf('f37-native-status.json');
  const secretIdx = z.indexOf('P@ssw0rd-lab-SECRET-9876');
  assert.ok(cleanIdx > 0 && secretIdx > 0 && cleanIdx < secretIdx,
    'the fixture must be captured BEFORE the allowlist negative posts a neutralized beacon under the same trace');
});

test('F37-33 the forensics budget is spent on the DECISIVE evidence first (10-annotation cap)', () => {
  const q = lab.slice(lab.indexOf('Q: failure forensics'), lab.indexOf('G: setup-time'));
  assert.ok(q.includes('10-annotation cap') || q.includes('FIRST 10 ::error::'), 'the annotation cap is not documented where it is handled');
  assert.ok(q.includes('Flush 9'), 'the forensics step can still exceed the cap and lose the decisive line');
  const cls = q.indexOf('CLASSIFICATION:');
  const sum = q.indexOf('RUNNER-SUMMARY:');
  const now = q.indexOf("'telescope-now'");
  assert.ok(cls > 0 && sum > 0 && now > 0, 'a forensics anchor is missing');
  assert.ok(cls < sum && sum < now, 'the failing cell verdict must be emitted before the runner state, and both before the re-run');
  for (const f of ['fatalStages', 'deriveError', 'keyTypedError', 'credScope', 'aclSids']) {
    assert.ok(q.includes(f), 'the runner summary drops ' + f + ' (the decisive field would be invisible)');
  }
  assert.ok(q.includes('Format-RdpTelescopeDump'), 'forensics no longer re-prints every telescope field');
});

test('F37-34 every PowerShell surface the runner loads is PARSED in CI and audited locally', () => {
  // The agent environment has no PowerShell interpreter, so a syntax error in
  // the module used to cost a whole Windows lab run before it was visible. Two
  // lanes now cover it: the windows-native parser list (real Parser::ParseFile)
  // and a structural audit the ubuntu gate runs (braces/here-strings/dangling
  // catch over the .ps1 files AND every workflow PowerShell block).
  const parse = gates.slice(gates.indexOf('Parse native PowerShell scripts'));
  const list = parse.slice(0, parse.indexOf('foreach ($file in') + 400);
  for (const f of ['payloads/rdp-telescope.ps1', 'payloads/Grant-RdpKeyAccess.ps1', 'payloads/Test-RdpListenerHandshake.ps1', 'payloads/ghrdp-server.ps1']) {
    assert.ok(list.includes("'" + f + "'"), 'the windows-native parse list dropped ' + f);
  }
  assert.ok(gates.includes('python3 tests/ps-balance-audit.py'), 'the F37 gate does not run the structural audit');
  assert.ok(fs.existsSync('tests/ps-balance-audit.py'), 'the structural audit script is missing');
  const audit = fs.readFileSync('tests/ps-balance-audit.py', 'utf8');
  for (const tok of ['unterminated-here-string', 'dangling-', 'imbalance', 'workflow_blocks']) {
    assert.ok(audit.includes(tok), 'the structural audit no longer checks ' + tok);
  }
  for (const f of ['payloads/rdp-telescope.ps1', 'payloads/ghrdp-server.ps1', 'payloads/Grant-RdpKeyAccess.ps1', 'payloads/Test-RdpListenerHandshake.ps1']) {
    assert.ok(audit.includes("'" + f + "'"), 'the audit does not cover ' + f);
  }
});

test('F37-35 the key ACL is read by a LADDER, never by one cmdlet (the runner lost Get-Acl)', () => {
  // GROUND TRUTH (run 36307844517, cell Z): the live runner is powershell.exe
  // 5.1 started by a pwsh step, so it inherits the CORE PSModulePath and cannot
  // load Microsoft.PowerShell.Security on demand -> Get-Acl failed inside the
  // server while the very same ACE read green in the pwsh step, and the row
  // reported deathPoint=acl on a healthy key. A single-method read is that bug.
  const reader = mod.slice(mod.indexOf('function Get-RdpTelescopeKeyAcl'), mod.indexOf('function Resolve-RdpTelescopeKeyFile'));
  assert.ok(reader.length > 1500, 'the independent ACL reader is missing from the module');
  for (const m of ["'get-acl'", "'dotnet-fileinfo'", "'acl-extensions'", "'icacls'"]) {
    assert.ok(reader.includes(m), 'the ACL ladder lost the reader ' + m);
  }
  assert.ok(reader.includes('.GetAccessControl()'), 'no managed ACL API is reachable without a cmdlet');
  // the ladder must be ORDERED: the cmdlet first, the module-free .NET path next
  assert.ok(reader.indexOf("'get-acl'") < reader.indexOf("'dotnet-fileinfo'"), 'the ladder is not ordered cmdlet -> .NET -> Core -> icacls');
  assert.ok(reader.indexOf("'dotnet-fileinfo'") < reader.indexOf("'icacls'"), 'the last-resort reader is not last');
  // the module path itself is repaired (every other on-demand module on that host)
  const repair = mod.slice(mod.indexOf('function Initialize-RdpTelescopeModulePath'), mod.indexOf('function Get-RdpTelescopeKeyAcl'));
  assert.ok(repair.includes('Join-Path $psHome'), 'the repair does not restore the host module directory');
  assert.ok(repair.includes('Import-Module Microsoft.PowerShell.Security'), 'the repair never loads the module it exists for');
  assert.ok(reader.includes('Initialize-RdpTelescopeModulePath'), 'the reader never repairs the module path');
  // the listener stage goes THROUGH the ladder - never a bare Get-Acl again
  const listener = mod.slice(mod.indexOf('function Get-RdpTelescopeListener'), mod.indexOf('function Get-RdpTelescopeFields'));
  assert.ok(listener.includes('Get-RdpTelescopeKeyAcl -Path $kf'), 'the listener stage does not use the ladder');
  assert.ok(!/^\s*\$acl = Get-Acl -LiteralPath/m.test(listener), 'the listener stage calls Get-Acl directly again (one method, no ladder)');
  // the method is PART OF THE FORMAT (allowlist) and of the verdict
  assert.ok(mod.includes("'aclReadMethod'") && mod.includes("'aclModule'"), 'the listener allowlist drops the reader evidence');
  assert.ok(listener.includes("$fields.aclReadMethod = [string]$aclInfo.method"), 'the method that answered is not stamped');
  assert.ok(listener.includes("key ACL unreadable by every method"), 'a total reader failure is not named');
  // and the derived picture carries it, so every consumer can see it
  const deriv = mod.slice(mod.indexOf('function Get-RdpTelescopeFields'), mod.indexOf('function Get-RdpTelescopeStageLine'));
  assert.ok(deriv.includes("if ($o.PSObject.Properties['aclReadMethod']) { $out.aclReadMethod = [string]$o.aclReadMethod }"),
    'the shared derivation drops aclReadMethod');
  assert.ok(deriv.includes("if ($o.PSObject.Properties['aclModule']) { $out.aclModule = [string]$o.aclModule }"),
    'the shared derivation drops aclModule');
});

test('F37-36 an unreadable ACL is a NAMED fault on every surface (module -> runner -> row -> lab)', () => {
  // a host that could not READ the ACL must never render the same as a host whose
  // NETWORK SERVICE ACE is genuinely missing: those are two different fixes.
  for (const f of ['aclReadMethod', 'aclModule']) {
    assert.ok(mod.includes(f), 'the module lost ' + f);
    assert.ok(srv.includes(f), 'the runner state does not carry ' + f);
    assert.ok(lab.includes(f), 'the lab never asserts ' + f);
    assert.ok(ui.includes(f), 'the dashboard row never renders ' + f);
  }
  // the runner persists it (read-back), and a derivation fault keeps every key
  assert.ok(srv.includes('aclReadMethod = [string]$derived.aclReadMethod'), 'the runner does not stamp the method');
  assert.ok(srv.includes("aclSids = @(); aclReadMethod = ''; aclModule = ''"),
    'the fallback state object is missing the new keys (a consumer could read a fault as absence)');
  // the lab fails CLOSED on 'none' for BOTH faces (module self-run + live runner)
  const z = lab.slice(lab.indexOf('Z: F37 telescope - module fields'), lab.indexOf('# [F19 §5] LAB PROOF'));
  assert.ok(z.includes("'module-acl-method'"), 'the module self-run can pass with no ACL reader');
  assert.ok(z.includes("'runner-acl-method'"), 'a runner whose ACL reader failed can still pass the cell');
  assert.ok(z.includes("aclReadMethod=' + [string]$ns.telescope.aclReadMethod"), 'the decisive annotation omits the method');
  // the row distinguishes UNREADABLE (blind) from NO (ACE missing)
  assert.ok(ui.includes("'UNREADABLE(no-reader)'"), 'the row cannot say the ACL was unreadable');
  assert.ok(ui.includes("('NO('+aclMethod+')')"), 'the row does not say which reader produced the NO');
  assert.ok(ui.includes('aclBlind'), 'a blind ACL verdict is not painted red');
});

test('F37-17 (lab fixture) the REAL native-status sample renders green through the shipped renderer', () => {
  const fx = process.env.F37_TEL_FIXTURE;
  if (!fx) { console.log('[F37] no F37_TEL_FIXTURE set - the lab-only live-sample cell is skipped'); return; }
  const live = JSON.parse(fs.readFileSync(fx, 'utf8'));
  const ctx = timelineContext();
  const tl = ctx.telescopeTimeline(live, Date.now());
  assert.strictEqual(tl.deathPoint, 'none',
    'the REAL sample has a red segment: ' + JSON.stringify(tl.segments.filter(s => s.ok === false)));
  const liveTel = (live.rdpListener && live.rdpListener.telescopeLive) || live.telescope;
  assert.ok(liveTel && liveTel.boundThumb && liveTel.boundThumb === liveTel.servedThumb,
    'the live runner sample does not prove served==bound');
  assert.ok(Array.isArray(liveTel.aclSids) && liveTel.aclSids.length > 0, 'the live sample read no ACL SIDs');
  const stages = (live.telescopeClient && live.telescopeClient.items || []).map(i => i.stage);
  for (const s of ['dns', 'tcp', 'tls', 'cred']) {
    assert.ok(stages.includes(s), 'the client beacon ring lacks the ' + s + ' stage');
  }
});
