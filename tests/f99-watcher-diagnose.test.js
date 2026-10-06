// [F99 §2.2 / B2 + §2.3 / B3] WATCHER TASK + LOGON WINDOW.
//
// EVIDENCE this file fences (F96 bundle 2026-10-06T13:13:06Z):
//   * scheduledTaskLastResult 267011 / 0x00041303 = the ONLOGON trigger had
//     NEVER fired; startTask=7 calls could not make a task bound to a user who
//     never signs in run, and the logon verdict decayed to `none` because
//     Update-RdpLogonAuthLast read only the last 120 seconds of the Security
//     log while the bundle's own re-scan counted 8 accepted type-2 events in a
//     3600-second window.
// The F99 fix has three visible halves, all pinned below: the diagnose map
// (server), the registration/read-back + XML export (main.yml + docs), and the
// two-window logon verdict (server) plus the widest set of accepted
// interactive logon types everywhere - including payloads/ghrdp-watcher.ps1,
// whose strict `LogonType = 10` filter was the third scanner that disagreed.
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const SERVER = fs.readFileSync("payloads/ghrdp-server.ps1", "utf8");
const WATCHER = fs.readFileSync("payloads/ghrdp-watcher.ps1", "utf8");
const MAIN = fs.readFileSync(".github/workflows/main.yml", "utf8");
const DOC = fs.readFileSync("docs/f99-watcher-task.xml", "utf8");

test("F99-B2-1: every task result code the bundle showed has a reason + a fix", () => {
  assert.ok(SERVER.includes("$script:F99WatcherResultCodes = [ordered]@{"), "the reason-code map is missing");
  const i = SERVER.indexOf("$script:F99WatcherResultCodes = [ordered]@{");
  const map = SERVER.slice(i, SERVER.indexOf("\n}", i));
  for (const code of ["0x00041303", "0x80070844", "0x8007010b"]) {
    assert.ok(map.includes("'" + code + "'"), "the map does not explain " + code);
  }
  // 267011 = 0x41303; 2147944516 = 0x80070844; 2147942667 = 0x8007010b.
  assert.ok(/SCHED_S_TASK_HAS_NOT_RUN/.test(map), "267011 is not named");
  assert.ok(/reason = /.test(map) && /fix = /.test(map), "an entry lacks a reason or a fix");
  assert.ok(/PRINCIPAL MISMATCH/.test(SERVER), "the principal-vs-active-user check is missing");
  assert.ok(/TRIGGER USER MISMATCH/.test(SERVER), "the trigger-user-vs-active-user check is missing");
});

test("F99-B2-2: Invoke-F99WatcherDiagnose is read-only and complete", () => {
  assert.ok(SERVER.includes("function Invoke-F99WatcherDiagnose"), "the diagnose function is missing");
  const i = SERVER.indexOf("function Invoke-F99WatcherDiagnose");
  const body = SERVER.slice(i, i + 4000);
  assert.ok(body.includes("Read-only. Never starts, stops, registers or deletes anything."), "the read-only contract is not stated");
  for (const k of ["actionPathOk", "principalUser", "principalLogon", "triggerTypes", "triggerUsers", "activeSessionUser", "userMismatch", "xmlPath", "findings", "suggestedFix", "lastResultHex"]) {
    assert.ok(body.includes(k), "diagnose output is missing " + k);
  }
  // 0x80070002 is the missing-action-path class: the argument line must be
  // parsed out of the action and checked on disk, never assumed.
  assert.ok(SERVER.includes("the action path does not exist on disk"), "the action path is never verified");
  // Surfaced in both the /diag read-out and the F96 bundle.
  assert.ok(SERVER.includes("watcherDiagnose = $(try { Invoke-F99WatcherDiagnose -TaskName 'GhrdpWatcher' } catch { $null })"), "the plain diag route does not carry the diagnose block");
  assert.ok(SERVER.includes("$f96Watcher.watcherDiagnose = Invoke-F99WatcherDiagnose -TaskName 'GhrdpWatcher'"), "the comprehensive bundle does not carry the diagnose block");
  assert.ok(SERVER.includes("foreach ($f96Wd in @($f96Watcher.watcherDiagnose.findings)) { Add-F96Note"), "diagnose findings never reach the advisory list");
});

test("F99-B2-3: main.yml resolves the SESSION user, reads the task back and exports the XML", () => {
  const i = MAIN.indexOf("Register watcher autostart (ONLOGON)");
  assert.ok(i > 0, "the watcher step is missing");
  const step = MAIN.slice(i, i + 40000);
  assert.ok(/Win32_ComputerSystem/.test(step) && /quser\.exe/.test(step), "the active session user is never resolved (both readers missing)");
  assert.ok(/\$taskUser = \$sessionUser/.test(step), "the task principal does not prefer the session user");
  assert.ok(/Register-ScheduledTask -TaskName 'GhrdpWatcher'/.test(step), "the watcher task is not registered");
  assert.ok(/-WorkingDirectory 'C:\\ghrdp'/.test(step), "the working directory is not set (0x8007010b class)");
  assert.ok(/Get-ScheduledTask -TaskName 'GhrdpWatcher'/.test(step), "the task is never read back");
  assert.ok(/Export-ScheduledTask -TaskName 'GhrdpWatcher'/.test(step), "the XML is never exported");
  assert.ok(/watcher-task\.xml/.test(step), "the dump path is missing");
  assert.ok(/GhrdpWatcherSystem/.test(step), "the SYSTEM/AtStartup fallback is missing");
  assert.ok(/lastTaskResult=/.test(step), "the read-back does not print the last task result");
});

test("F99-B2-4: the reference XML documents the exact registered shape", () => {
  assert.ok(/<URI>\\GhrdpWatcher<\/URI>/.test(DOC), "the task URI is missing");
  assert.ok(/RUNNER_SESSION_USER/.test(DOC), "the principal placeholder is missing");
  assert.ok(/<LogonType>InteractiveToken<\/LogonType>/.test(DOC), "the interactive logon type is missing");
  assert.ok(/<RunLevel>HighestAvailable<\/RunLevel>/.test(DOC), "the run level is missing");
  assert.ok(/PT6H/.test(DOC), "the execution time limit is missing");
  assert.ok(/-File "C:\\ghrdp\\ghrdp-watcher\.ps1"/.test(DOC), "the action does not match the registered action");
  assert.ok(/0x00041303|267011/.test(DOC), "the reference does not explain the 267011 evidence");
});

test("F99-B3-1: the logon verdict has two windows (fresh 120s + session 3600s)", () => {
  const i = SERVER.indexOf("function Get-RdpLogonAuthLast");
  const body = SERVER.slice(i, SERVER.indexOf("function Update-RdpLogonAuthLast", i));
  assert.ok(/\$windowStart = \$ScanStartedUtc\.AddSeconds\(-120\)/.test(body), "the fresh 120s window is gone");
  assert.ok(/\$sessionStart = \$windowStart/.test(body), "the session window is not derived");
  assert.ok(/\$floor = \$nowUtc\.AddSeconds\(-1 \* \$script:F28WindowSec\)/.test(body), "the F28WindowSec floor is gone");
  assert.ok(/\[F99 §2\.3 \/ B3\]/.test(body), "the B3 rationale is not stated in the scanner");
  // The per-item floor: 4624 judged on the session window, everything else fresh.
  assert.ok(/\$itemFloor = \$windowStart/.test(body), "the per-item floor is missing");
  assert.ok(/if \(\[string\]\$it\.id -eq '4624'\) \{ \$itemFloor = \$sessionStart \}/.test(body), "4624 is not judged on the session window");
  assert.ok(body.includes("sessionWindowSec = $script:F28WindowSec"), "sessionWindowSec is not published");
  assert.ok(body.includes("freshWindowSec   = 120"), "freshWindowSec is not published");
  assert.ok(body.includes("sessionAgeSec") && body.includes("sessionEventTs"), "the session age/eventTs are not published");
});

test("F99-B3-2: the scanner READS the session window and corroborates with a LIVE session", () => {
  const i = SERVER.indexOf("function Update-RdpLogonAuthLast");
  const body = SERVER.slice(i, SERVER.indexOf("function Get-RdpLogonCollectorState", i));
  assert.ok(/\$since = \$ScanStartedUtc\.AddSeconds\(-1 \* \$script:F28WindowSec\)/.test(body), "the Security-log read still stops at 120s");
  assert.ok(!/AddSeconds\(-120\)/.test(body), "the 120s read window is back");
  assert.ok(body.includes("$script:GhrdpLogonSessionWql"), "the live session corroboration does not use the shared 2/10/11 WQL");
  assert.ok(body.includes("sessionActive"), "sessionActive is never computed");
  assert.ok(body.includes("interactiveSessions"), "interactiveSessions is never recorded");
  assert.ok(body.includes("sessionProbe"), "the corroboration source is not named");
  // A stale (age > 300s) success with NO live session must not claim a desktop.
  assert.ok(/\$sum\.sessionAgeSec -gt 300/.test(body), "the stale-session guard is missing");
});

test("F99-B3-3: the bundle's logon block carries the B3 fields and promotes a live session", () => {
  assert.ok(SERVER.includes("sessionActive  = $null"), "the bundle logon block lacks sessionActive");
  assert.ok(SERVER.includes("interactiveSessions = $null"), "the bundle logon block lacks interactiveSessions");
  assert.ok(SERVER.includes("freshWindowSec = 120"), "the bundle logon block lacks freshWindowSec");
  assert.ok(/a live interactive logon session exists/.test(SERVER), "the live-session advisory is missing");
  assert.ok(/\$f96Logon\.sessionActive -eq \$true\) \{ \$f96Logon\.detected = \$true/.test(SERVER), "sessionActive does not promote `detected`");
});

test("F99-B3-4: no strict LogonType-10-only filter survives anywhere", () => {
  // Comments legitimately QUOTE the old filter while explaining the fix, so
  // only executable lines count.
  const codeOf = (text) => text.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");
  for (const [file, text] of [
    ["payloads/ghrdp-watcher.ps1", WATCHER],
    ["payloads/ghrdp-server.ps1", SERVER],
  ]) {
    assert.ok(!/LogonType = 10"/.test(codeOf(text)), file + " still has a strict RemoteInteractive-only CIM filter");
    assert.ok(!/-ne '10'/.test(codeOf(text)), file + " still compares a type against the literal 10 only");
  }
  assert.ok(WATCHER.includes("$script:GhrdpLogonSessionWql = 'LogonType=2 OR LogonType=10 OR LogonType=11'"), "the watcher does not declare the shared WQL");
  assert.ok(WATCHER.includes("-Filter $script:GhrdpLogonSessionWql"), "the watcher's session probe does not use the shared WQL");
  assert.ok(SERVER.includes("$script:GhrdpLogonSessionWql = 'LogonType=2 OR LogonType=10 OR LogonType=11'"), "the server's shared WQL is gone");
  assert.ok(SERVER.includes("$script:GhrdpInteractiveLogonTypes = @('2', '10', '11')"), "the server's shared type set is gone");
});

test("F99-B3-5: the collector reads the B3 fields (its logon row cannot lie)", () => {
  const COLLECTOR = fs.readFileSync("payloads/ghrdp-collector.ps1", "utf8");
  for (const k of ["logonType", "logonKind", "sessionAgeSec", "sessionWindowSec", "allScannersAgree", "liveInteractiveSessions"]) {
    assert.ok(COLLECTOR.includes(k), "the collector's logon probe does not report " + k);
  }
  assert.ok(/LogonType=2 OR LogonType=10 OR LogonType=11/.test(COLLECTOR), "the collector's live probe is not the shared set");
});
