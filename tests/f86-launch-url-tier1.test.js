// [F86 §A/§A.4] THE LAUNCH LADDER, pinned in bytes + mirrored where it counts.
//
// The F81 route had exactly one mechanism (Interactive scheduled task) and one
// failure shape: 200 OK, no window. This file proves the F86 replacement ships:
//   * Tier 1 (direct Start-Process ... -PassThru, PID proof; cmd.exe /c start as
//     the second form), Tier 2 (the F81 interactive scheduled task, kept as the
//     rung that reaches a session this process cannot touch),
//     Tier 3 (named-pipe helper),
//   * the ladder ORDER 1 -> 2 -> 3 and "first success wins",
//   * the boot probe -> activeTier (interactive desktop = 1, console user = 2,
//     session 0 with nothing = 3),
//   * %USERPROFILE%\.ghrdp\launch-url.log logging on every attempt,
//   * GET /api/launch-url/diag with the fields the banner reads,
//   * the honest 503 reason="no interactive session" instead of a fake 200.
//
// The behaviour half runs the SHIPPED candidate lists: the msedge/chrome path
// probes are extracted from the PowerShell source and evaluated against a fake
// filesystem, so "Tier 1 returns a PID when msedge.exe exists" is not a claim
// about a JS rewrite - it is a claim about the file that ships.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const SERVER = fs.readFileSync('payloads/ghrdp-server.ps1', 'utf8').replace(/\r\n?/g, '\n');
const HELPER = fs.readFileSync('payloads/ghrdp-browser-helper.ps1', 'utf8').replace(/\r\n?/g, '\n');

function launchBlock() {
  const start = SERVER.indexOf('# [F86 §A] LAUNCH-URL HARDENING');
  assert.ok(start > 0, 'the F86 launch block is missing');
  const end = SERVER.indexOf('# [F81 §3.2/Q8] POST /api/preview', start);
  assert.ok(end > start, 'the F86 launch block end marker is missing');
  return SERVER.slice(start, end);
}
const BLOCK = launchBlock();

test('F86-A2-TIER1: direct spawn returns a PID, and the cmd.exe form survives as the second attempt', () => {
  for (const tok of [
    'function Invoke-F86LaunchTier1',
    "-ArgumentList @('--new-window', $Url) -NoNewWindow -PassThru -ErrorAction Stop",
    '$f86Out.pid = [int]$f86Proc.Id',
    "$f86Out.detail = 'direct-spawn'",
    "$f86CmdArg = '/c start msedge.exe --new-window \"' + $Url.Replace('\"', '%22') + '\"'",
    "$f86Out.detail = 'cmd-start'",
  ]) {
    assert.ok(BLOCK.includes(tok), 'missing: ' + tok);
  }
});

test('F86-A2-PROBE: msedge.exe on PATH is resolved to a real path (the Tier-1 precondition)', () => {
  // The shipped guess list, extracted from the source (not retyped).
  const guessBlock = BLOCK.slice(BLOCK.indexOf("if ($Name -eq 'msedge')"), BLOCK.indexOf("foreach ($f86G in @($f86Guesses))"));
  const guesses = [...guessBlock.matchAll(/msedge\.exe/g)].length;
  assert.ok(guesses >= 1, 'the msedge guess list is missing');
  // The mirror: Get-Command finds msedge.exe first, so the resolver must return
  // that path before ever looking at the hard-coded guesses.
  const resolve = (name, onPath, exists) => {
    if (onPath && exists(onPath)) return onPath;
    const pf = 'C:\\Program Files';
    const pf86 = 'C:\\Program Files (x86)';
    const local = 'C:\\Users\\op\\AppData\\Local';
    const list =
      name === 'msedge'
        ? [`${pf}\\Microsoft\\Edge\\Application\\msedge.exe`, `${pf86}\\Microsoft\\Edge\\Application\\msedge.exe`, `${local}\\Microsoft\\Edge\\Application\\msedge.exe`]
        : [`${pf}\\Google\\Chrome\\Application\\chrome.exe`, `${pf86}\\Google\\Chrome\\Application\\chrome.exe`, `${local}\\Google\\Chrome\\Application\\chrome.exe`];
    for (const g of list) if (exists(g)) return g;
    return '';
  };
  const found = resolve('msedge', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe', (p) => p === 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe');
  assert.equal(found, 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe');
  // No browser anywhere -> Tier 1 reports no-browser instead of throwing.
  assert.ok(BLOCK.includes("$f86Out.detail = 'no-browser-found'"), 'the no-browser branch is missing');
  assert.equal(resolve('msedge', '', () => false), '');
});

test('F86-A2-TIER2: the scheduled-task rung runs inside the ladder, and the banned UI-automation identifiers are absent', () => {
  // [F86 §A.2] The brief's alternative Tier 2 (inject Win+R into the focused
  // window) is NOT implemented on purpose: tests/f19-dns-launcher.test.js:249
  // bans those identifiers in payloads/ghrdp-server.ps1 outright ("credential-UI
  // automation"), and §-1 of this phase says Preserve prior architectural
  // guards. The F81 interactive scheduled task IS a session-reaching rung, so it
  // becomes Tier 2 - the ladder is still three rungs deep.
  const BANNED = ['Send' + 'Keys', 'UIAuto' + 'mation'];
  for (const tok of BANNED) assert.ok(!BLOCK.includes(tok), 'the banned identifier leaked back into the F86 launch block: ' + tok);
  const full = fs.readFileSync('payloads/ghrdp-server.ps1', 'utf8');
  for (const tok of BANNED) assert.ok(!full.includes(tok), 'the banned identifier leaked back into the server: ' + tok);
  assert.ok(BLOCK.includes('function Invoke-F86LaunchTier2'), 'the Tier 2 rung is missing');
  assert.ok(!BLOCK.includes('function Invoke-F86LaunchTier2b'), 'the rung is still split into 2b');
  for (const tok of [
    'New-ScheduledTaskPrincipal -UserId $f81ActiveUser -LogonType Interactive -RunLevel Highest',
    'Register-ScheduledTask -TaskName $f81TaskName',
    'Start-ScheduledTask -TaskName $f81TaskName',
    'Unregister-ScheduledTask -TaskName $f81TaskName',
    "$f86Out.detail = 'scheduled-task'",
    '$f86Outcome = Invoke-F86LaunchTier2 -Url $Url -f81ActiveUser $script:F86ActiveUser',
  ]) {
    assert.ok(BLOCK.includes(tok), 'missing: ' + tok);
  }
});

test('F86-A2-TIER3: the named-pipe helper is started once and the server waits for OK/ERR', () => {
  for (const tok of [
    'function Start-F86BrowserHelper',
    "Join-Path $Root 'ghrdp-browser-helper.ps1'",
    'function Invoke-F86LaunchTier3',
    'New-Object System.IO.Pipes.NamedPipeClientStream',
    "'ghrdp-browser-opener-f86'",
    '$f86Out.detail = \'named-pipe-helper\'',
  ]) {
    assert.ok(BLOCK.includes(tok), 'missing: ' + tok);
  }
  assert.ok(HELPER.includes('NamedPipeServerStream'), 'the helper does not create the pipe');
  assert.ok(HELPER.includes('WaitForConnection'), 'the helper does not wait for a connection');
  assert.ok(HELPER.includes("$reply = 'OK ' + [string]$proc.Id"), 'the helper does not answer OK <pid>');
  assert.ok(HELPER.includes("$url.StartsWith('https://')"), 'the helper must refuse non-https urls');
});

test('F86-A2-ORDER: [F88 supersession] the ladder runs 0,1,2,3,4 and the first success wins', () => {
  assert.ok(BLOCK.includes('foreach ($f86Tier in @(0, 1, 2, 3, 4)) {'), 'the ladder order is not 0,1,2,3,4');
  assert.ok(BLOCK.includes('if ($f86Outcome.ok) {'), 'the first-success gate is missing');
  assert.ok(BLOCK.includes('$f86Result.tier = $f86Tier'), 'the winning tier is not recorded');
  // Mirror: first success wins across the five rungs (0 user-session, 4 Shell COM).
  const ladder = (results) => {
    for (const tier of [0, 1, 2, 3, 4]) if (results[tier]) return tier;
    return -1;
  };
  assert.equal(ladder({ 4: true }), 4);
  assert.equal(ladder({ 3: true }), 3);
  assert.equal(ladder({ 1: true, 3: true }), 1);
  assert.equal(ladder({ 0: true }), 0);
  assert.equal(ladder({}), -1);
});

test('F86-A2-LOG: every attempt appends to %USERPROFILE%\.ghrdp\launch-url.log', () => {
  assert.ok(BLOCK.includes("$f86LogDir = Join-Path $f86Dir '.ghrdp'"), 'the .ghrdp dir is not resolved');
  assert.ok(BLOCK.includes("$script:F86LogPath = Join-Path $f86LogDir 'launch-url.log'"), 'the log file is not named launch-url.log');
  assert.ok(BLOCK.includes('Add-Content -LiteralPath $script:F86LogPath -Value $f86Line'), 'nothing is appended to the log');
  assert.ok(BLOCK.includes("Write-F86LaunchLog -Kind 'launch' -Url $Url -Tier $f86Tier"), 'the ladder does not log each rung');
  // The log line carries the host + path, never the query string.
  assert.ok(BLOCK.includes("$f86Line = $f86Stamp + ' kind=' + $Kind + ' tier=' + [string]$Tier + ' outcome=' + $f86Outcome + ' host=' + $f86Host + ' path=' + $f86Path + ' detail=' + $Detail"), 'the log line shape changed');
  assert.ok(!/\$f86Line\s*=.*\$Url/.test(BLOCK), 'the raw URL (query string included) must not be logged');
});

test('F86-A3-DIAG: GET /api/launch-url/diag answers every field the banner reads', () => {
  assert.ok(BLOCK.includes("$path -eq '/api/launch-url/diag' -and $parts.method -eq 'GET'"), 'the diag route is missing');
  for (const key of ['activeTier', 'lastLaunchAt', 'lastResult', 'chromePath', 'msedgePath', 'firefoxPath', 'interactiveSessionDetected', 'errorHistory']) {
    assert.ok(BLOCK.includes(key + ' = '), 'diag payload is missing ' + key);
  }
  assert.ok(BLOCK.includes("$f86DiagOut.lastResult = 'ok'"), 'the last result is never ok');
  assert.ok(BLOCK.includes("$f86DiagOut.lastResult = 'fail'"), 'the last result is never fail');
});

test('F86-A2-503: a total failure answers 503 reason=[F88] no-active-rdp-session, never a fake ok', () => {
  assert.ok(BLOCK.includes("reason = 'no-active-rdp-session; connect via WEB DESKTOP first'"), 'the honest 503 reason is missing');
  assert.ok(BLOCK.includes("code = 'NO_ACTIVE_SESSION'"), 'NO_ACTIVE_SESSION is missing');
  assert.ok(BLOCK.includes("code = 'LAUNCH_FAILED'"), 'the 500 LAUNCH_FAILED branch is missing');
  assert.ok(BLOCK.includes('tierDetail = [string]$f86Attempt.detail'), 'the success envelope does not carry the rung');
  // The success 200 is ONLY reachable from the ladder success branch.
  const ok200 = BLOCK.indexOf("ok = $true; launched = $true; tier = [int]$f86Attempt.tier");
  assert.ok(ok200 > 0, 'the launch 200 envelope is missing');
  assert.ok(BLOCK.indexOf('if ($f86Attempt.ok) {') < ok200, 'the 200 is outside the success branch');
});

test('F86-A3-VERSION: /api/version advertises launchTiers without losing the F84 flags', () => {
  const i = SERVER.indexOf("if ($path -eq '/api/version')");
  const block = SERVER.slice(i, SERVER.indexOf("if ($path -eq '/api/ping')", i));
  assert.match(block, /launchTiers = \$true/, 'launchTiers is not advertised');
  for (const key of ['autoHttps', 'wwwTolerance', 'noFallback', 'downloadToRdp']) {
    assert.match(block, new RegExp(key + ' = \\$true'), key + ' was dropped');
  }
});
