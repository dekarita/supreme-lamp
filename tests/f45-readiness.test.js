// [F45-R] Readiness contract lock: the listener bind and the LISTENING marker
// are decoupled from the synchronous Get-WinEvent startup scans, /health tells
// a harness which application instance is actually answering, and every
// readiness consumer requires marker + HTTP 200 + MATCHING pid.
//
// WHY this file exists (root cause, verified on main @179a25a):
//   * Update-RdpLogonAuthLast / Update-RdpConnLog / Update-RdpListenerTelescope
//     are synchronous Get-WinEvent walks of the Security/System logs.
//   * They ran BEFORE $listener.Start(), so a slow event-log walk delayed the
//     bind, the marker, and every harness waiting on it.
//   * Readiness (listener bound + right instance responding) and scanner
//     FRESHNESS are different facts and must be reported separately.
//
// WHAT THIS FILE PROVES vs what it cannot: these are static pins (the sandbox
// has no Windows runtime). The Windows-native lanes (tests/f45-fx-server.ps1,
// tests/f49-mirror-runtime.ps1, autologin-lab.yml) execute the same contract
// against the real server; this file keeps the source from regressing between
// those runs. The remaining known limitation - a scan running on the accept
// thread still pauses request draining while it runs - is documented in the
// server (F45-R §1) and tracked as the isolated-scan-worker package (F45-B);
// a cooperative delay cannot yield inside Get-WinEvent, so no static pin here
// claims that latency is bounded.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");

const read = (p) => fs.readFileSync(p, "utf8").replace(/\r\n?/g, "\n");

const srv = read("payloads/ghrdp-server.ps1");
const f45 = read("tests/f45-fx-server.ps1");
const f49 = read("tests/f49-mirror-runtime.ps1");
const lab = read(".github/workflows/autologin-lab.yml");

const lineOf = (haystack, needle, what) => {
  const i = haystack.indexOf(needle);
  assert.ok(i >= 0, what + " is missing: " + needle);
  return haystack.slice(0, i).split("\n").length;
};

test("F45-R1 the listener binds and the marker writes BEFORE the first startup scan", () => {
  const startLine = lineOf(srv, "try { $listener.Start() } catch {", "$listener.Start()");
  const markerLine = lineOf(
    srv,
    "'LISTENING pid={0} bind={1} port={2} at={3}'",
    "the LISTENING marker write",
  );
  const logonScanLine = lineOf(
    srv,
    "try { Update-RdpLogonAuthLast -StatePath $script:LogonStatePath -ScanStartedUtc $script:ServerStartedUtc | Out-Null } catch { }",
    "the F28 startup scan",
  );
  const connScanLine = lineOf(
    srv,
    "try { Update-RdpConnLog -StatePath $script:ConnLogStatePath -ScanStartedUtc $script:ServerStartedUtc | Out-Null } catch { }",
    "the F30 startup scan",
  );
  const telScanLine = lineOf(
    srv,
    "try { Update-RdpListenerTelescope -StatePath $script:F37TelStatePath -ScanStartedUtc $script:ServerStartedUtc | Out-Null } catch { }",
    "the F37 startup scan",
  );
  assert.ok(markerLine > startLine, "the marker must be written after the bind succeeds");
  assert.ok(logonScanLine > markerLine, "the F28 startup scan must run after the marker (readiness first)");
  assert.ok(connScanLine > markerLine, "the F30 startup scan must run after the marker (readiness first)");
  assert.ok(telScanLine > markerLine, "the F37 startup scan must run after the marker (readiness first)");
  // the reorder rationale is recorded next to the code, not only in this test
  assert.match(srv, /READINESS BEFORE SCANS/, "the reorder rationale must be recorded in the server");
});

test("F45-R2 the startup scans still exist (reorder must not delete the collectors)", () => {
  // These exact call shapes are also pinned by f28/f30/f37 + launch-gates;
  // repeated here so a change that satisfies ONE gate still fails visibly here.
  assert.ok(srv.includes("Update-RdpLogonAuthLast -StatePath $script:LogonStatePath"), "logon scan missing");
  assert.ok(srv.includes("Update-RdpConnLog -StatePath $script:ConnLogStatePath"), "conn-log scan missing");
  assert.ok(srv.includes("Update-RdpListenerTelescope -StatePath $script:F37TelStatePath"), "telescope scan missing");
  assert.match(srv, /STARTUP SCAN: the telescope stamps promptly after the listener starts/, "telescope startup-scan marker text missing");
});

test("F45-R3 /health separates instance readiness from scanner freshness", () => {
  const i = srv.indexOf("if ($path -eq '/health')");
  assert.ok(i >= 0, "/health route is missing");
  const block = srv.slice(i, i + 3000);
  assert.match(block, /ok\s+=\s+\$true/, "/health must report ok=true");
  assert.match(block, /app\s+=\s+'ghrdp'/, "/health must name the application instance");
  assert.match(block, /pid\s+=\s+\$PID/, "/health must carry the responding pid");
  assert.match(block, /listenerBound\s+=\s+\$true/, "/health must report the bind state");
  assert.match(block, /scans\s+=\s+\$hScans/, "/health must carry scanner freshness");
  assert.match(block, /scanTs/, "scanner freshness reads scanTs from the state files");
  assert.match(block, /probeError/, "scanner freshness surfaces probeError honestly");
  // freshness is OPTIONAL: a null scanTs (slow first scan) must not flip ok
  assert.ok(!/ok\s+=\s+\$false/.test(block), "/health must not fail on a missing scan stamp");
  // no credential/config material in the probe body
  for (const leak of ["Token", "windowsPass", "vncPass", "creds"]) {
    assert.ok(!block.includes(leak), "/health leaks " + leak);
  }
});

test("F45-R4 the accept loop drains pending requests before the periodic scans tick", () => {
  const loopIdx = srv.indexOf("while ($listener.Pending())");
  assert.ok(loopIdx >= 0, "the pending-drain loop is missing");
  const tickIdx = srv.indexOf("$script:F28IntervalSec", loopIdx);
  assert.ok(tickIdx > loopIdx, "the periodic logon tick must sit after the pending drain in the loop");
  // the drain is a WHILE (all pending clients), not an IF (one client per pass)
  assert.match(srv, /while \(\$listener\.Pending\(\)\)/, "the drain must exhaust the backlog each pass");
});

test("F45-R5 the loop yield is bounded and overridable via GHRDP_SCAN_DELAY_MS", () => {
  assert.match(srv, /\$env:GHRDP_SCAN_DELAY_MS/, "the delay override is missing");
  assert.match(srv, /\[Math\]::Max\(5, \[Math\]::Min\(1000/, "the override must be clamped to 5..1000ms");
  assert.match(srv, /Start-Sleep -Milliseconds \$script:ScanDelayMs/, "the accept loop must sleep the configured delay");
  assert.match(srv, /\$script:ScanDelayMs = 50/, "the default yield stays 50ms");
});

test("F45-R6 the F45 harness requires marker + HTTP 200 + matching pid", () => {
  assert.match(f45, /'LISTENING'/, "the harness still waits on the LISTENING marker");
  assert.match(f45, /pid=\(\\d\+\)/, "the harness reads the pid out of the marker");
  assert.match(f45, /Send-FxRaw -Port \$port -Method 'GET' -Target '\/health'/, "the harness must GET /health");
  assert.match(f45, /"app":"ghrdp"/, "the harness must verify the app identity");
  assert.match(f45, /\/health pid matches the LISTENING marker/, "the harness must compare marker pid to /health pid");
  assert.match(f45, /\/health pid matches the started process/, "the harness must compare /health pid to the process it started");
});

test("F45-R7 the F49 harness requires marker + HTTP 200 + matching pid", () => {
  assert.match(f49, /'LISTENING'/, "the harness still waits on the LISTENING marker");
  assert.match(f49, /pid=\(\\d\+\)/, "the harness reads the pid out of the marker");
  assert.match(f49, /Send-F49Raw -Port \$port -Method 'GET' -Target '\/health'/, "the harness must GET /health");
  assert.match(f49, /"app":"ghrdp"/, "the harness must verify the app identity");
  assert.match(f49, /\/health pid matches the LISTENING marker/, "the harness must compare marker pid to /health pid");
});

test("F45-R8 the autologin lab requires /health 200 + app + pid identity", () => {
  assert.match(lab, /Invoke-LabJson \(\$base \+ '\/health'\)/, "the lab must GET /health");
  assert.match(lab, /health-ok/, "the lab must fail visibly when ok is false");
  assert.match(lab, /health-app/, "the lab must fail visibly when app is not ghrdp");
  assert.match(lab, /health-pid/, "the lab must fail visibly when the pid does not match");
  assert.match(lab, /\$health\.pid -ne \[string\]\$srv\.Id/, "the lab compares /health pid to the server process id");
});

test("F45-R9 the scans never leak into the workflow keep-alive step (F24 rule preserved)", () => {
  const main = read(".github/workflows/main.yml");
  assert.ok(!main.includes("Update-RdpLogonAuthLast"), "the logon scan leaked into main.yml");
  assert.ok(!main.includes("Update-RdpConnLog"), "the conn-log scan leaked into main.yml");
  assert.ok(!main.includes("Update-RdpListenerTelescope"), "the telescope scan leaked into main.yml");
});
