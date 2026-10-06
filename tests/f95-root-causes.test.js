// [F95] ROOT CAUSE pins for the two fixes that live in PowerShell (R1 logon
// detection, R2 watcher auto-start). This sandbox has no PowerShell interpreter,
// so these are grep-level over the SHIPPED sources, matching the F84/F87/F91/F93
// house style; launch-gates.yml drives the real PowerShell in CI.
//
// R3/R4/R5 are EXECUTED in src/tests/smoke/f95-root-causes.test.tsx.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const SERVER = readFileSync("payloads/ghrdp-server.ps1", "utf8");
const WF = readFileSync(".github/workflows/main.yml", "utf8");
const GATES = readFileSync(".github/workflows/launch-gates.yml", "utf8");
const NATIVE = readFileSync("src/lib/domain/native.ts", "utf8");

// ===========================================================================
// R1 - logon detection accepted only LogonType 10
// ===========================================================================
test("F95-R1 FILTER: the accepted set is 2/10/11 and a bare type-10 filter cannot return", () => {
  // One shared definition, so the four call sites cannot drift apart.
  assert.ok(
    SERVER.includes("$script:GhrdpInteractiveLogonTypes = @('2', '10', '11')"),
    "the accepted logon-type set is not defined"
  );
  assert.ok(
    SERVER.includes("function Test-GhrdpInteractiveLogonType"),
    "the shared predicate is missing"
  );
  assert.ok(
    SERVER.includes("$script:GhrdpLogonSessionWql = 'LogonType=2 OR LogonType=10 OR LogonType=11'"),
    "the WQL form of the set is missing"
  );
  // Every Win32_LogonSession probe reads the shared WQL, never a literal 10.
  assert.ok(
    !/Win32_LogonSession -Filter 'LogonType=10'/.test(SERVER),
    "a type-10-only Win32_LogonSession filter is back - an autologon desktop would read as no session"
  );
  // [F96 §2.1] SUPERSEDED PIN (rewritten in place, not deleted - the F95
  // convention this repository uses for every pin a later feature outgrows).
  // Was `2` = the two CIM probes F95 itself introduced. F96's diagnostic bundle
  // adds a THIRD probe (runnerInfo.activeUsers) and it uses the SAME shared WQL,
  // so the invariant this assertion exists for - "no probe may filter on a
  // literal LogonType=10" - is intact and still asserted by the negative test
  // above. Keeping the old count would fail on a change that makes the F95 fix
  // MORE visible, which is the opposite of what the pin is for.
  // [F99 §2.3 / B3] SUPERSEDED PIN (rewritten in place, third time - the same
  // convention). Was `3` = F95's two CIM probes + F96's runnerInfo.activeUsers.
  // F99 adds a FOURTH probe: Update-RdpLogonAuthLast corroborates the persisted
  // logon verdict with a LIVE interactive session, because the F96 bundle proved
  // a live desktop could still read `logon.detected: false`. It uses the SAME
  // shared WQL, so the invariant this count exists for - "no probe may filter on
  // a literal LogonType=10" (asserted negatively above) - is intact; a literal
  // filter would still fail here no matter how many probes exist.
  const wqlProbes = (SERVER.match(/Win32_LogonSession -Filter \$script:GhrdpLogonSessionWql/g) || []).length;
  assert.ok(
    wqlProbes >= 4,
    "all Win32_LogonSession probes must use the shared WQL (F95: 2, F96: +runnerInfo.activeUsers, F99: +sessionActive corroboration); found " + wqlProbes
  );
  // The F28 collector's pre-filter no longer drops non-10 events.
  assert.ok(
    !SERVER.includes("if ([string]$it.logonType -ne '10' -and [string]$it.id -eq '4624') { continue }"),
    "the F28 pre-filter still drops every non-type-10 event before the window check"
  );
  assert.ok(
    SERVER.includes("if (-not (Test-GhrdpInteractiveLogonType -LogonType ([string]$it.logonType)) -and [string]$it.id -eq '4624') { continue }"),
    "the F28 pre-filter does not use the shared predicate"
  );
  // Non-interactive types must STAY excluded - 3 (network) / 5 (service) / 4
  // (batch) / 7 (unlock) / 9 (new-credentials) are not a desktop.
  for (const bad of ["'3'", "'4'", "'5'", "'7'", "'9'"]) {
    assert.ok(
      !SERVER.includes("$script:GhrdpInteractiveLogonTypes = @('2', '10', '11')".replace(")", ", " + bad + ")")),
      "a non-interactive logon type leaked into the accepted set"
    );
  }
});

test("F95-R1 EXPLAIN: the verdict carries WHICH logon type it came from", () => {
  // The operator's banner read "no type-10 4624" - true about the filter, false
  // about the machine. The row must now be able to name the logon.
  assert.ok(SERVER.includes("logonType   = $lastLogonType"), "authLast does not carry logonType");
  assert.ok(SERVER.includes("logonKind   = $lastLogonKind"), "authLast does not carry logonKind");
  assert.ok(
    SERVER.includes("function Get-GhrdpInteractiveLogonTypeLabel"),
    "the human label helper is missing"
  );
  for (const [n, label] of [["'2'", "'interactive'"], ["'10'", "'remote-interactive'"], ["'11'", "'cached-interactive'"]]) {
    assert.ok(SERVER.includes(n + "  { return " + label) || SERVER.includes(n + " { return " + label), "no label for LogonType " + n);
  }
  // The /api/logon-status rendered-message scan accepts the same set.
  assert.ok(
    SERVER.includes("'Logon Type:\\s+(2|10|11)\\b'"),
    "/api/logon-status still only matches 'Logon Type: 10'"
  );
  assert.ok(SERVER.includes("logonType  = $ltSeen"), "/api/logon-status does not report the type it saw");
});

test("F95-R1 UI: the banner names all three accepted types, never just type-10", () => {
  assert.ok(
    !NATIVE.includes('"none yet - " + scanned + " (no type-10 4624'),
    "the operator's verbatim 'no type-10 4624' banner text is still shipped"
  );
  assert.ok(
    NATIVE.includes("(no interactive 4624 [LogonType 2/10/11] and no 4625 since "),
    "the banner does not name the accepted set"
  );
  // A success now says WHICH logon, so type-2 autologon and type-10 RDP are
  // distinguishable on screen.
  assert.ok(NATIVE.includes('[LogonType " + lt'), "the success row does not name the logon type");
  assert.ok(NATIVE.includes("logonType?: string;"), "logonRowText does not expose logonType");
});

test("F95-R1 GATE: the launch-gates pin was rewritten in place, not deleted", () => {
  // The pin that kept the bug alive. Repo rule: superseded pins are rewritten
  // in place with the old assertion quoted, never removed.
  assert.ok(
    GATES.includes("# Was: grep -q 'LogonType=10' payloads/ghrdp-server.ps1"),
    "the superseded pin lost its provenance comment"
  );
  assert.ok(
    GATES.includes("grep -q \"GhrdpLogonSessionWql = 'LogonType=2 OR LogonType=10 OR LogonType=11'\" payloads/ghrdp-server.ps1"),
    "the gate does not assert the new accepted set"
  );
  assert.ok(
    GATES.includes("Win32_LogonSession -Filter 'LogonType=10'"),
    "the gate no longer FORBIDS the old filter from returning"
  );
  // The F28 scanner-block token pin still has to find 'LogonType 10' inside the
  // pinned block - the F95 comment quotes the old rule, so it does.
  const blk = SERVER.slice(
    SERVER.indexOf("# [F28 §1 scanner-begin]"),
    SERVER.indexOf("# [F28 §1 scanner-end]")
  );
  assert.ok(blk.length > 0, "the F28 scanner block markers are missing");
  assert.ok(blk.includes("LogonType 10"), "the F28 block lost the pinned 'LogonType 10' token");
  assert.ok(blk.includes("Test-GhrdpInteractiveLogonType"), "the shared predicate is outside the pinned F28 block");
});

// ===========================================================================
// R2 - the watcher was registered but never started
// ===========================================================================
test("F95-R2 START: the ONLOGON task is registered AND started at bootstrap", () => {
  const step = WF.slice(WF.indexOf("- name: Register watcher autostart (ONLOGON)"));
  const body = step.slice(0, step.indexOf("# [F91 §A.2]"));
  assert.ok(body.includes("Register-ScheduledTask -TaskName 'GhrdpWatcher'"), "the task is not registered");
  // THE ROOT CAUSE: registration with no start. An ONLOGON task waits for a
  // logon that R1 proves the detector was missing.
  assert.ok(
    body.includes("Start-ScheduledTask -TaskName 'GhrdpWatcher' -ErrorAction Stop"),
    "the bootstrap registers the watcher but never starts it"
  );
  assert.ok(body.includes("& schtasks.exe /Run /TN GhrdpWatcher"), "no schtasks /Run fallback");
  assert.ok(body.includes("::warning::[watcher]"), "a failed start is silent instead of loud");
  // The schtasks fallback path must also mark itself registered, or the start
  // below is skipped on exactly the machine that needed the fallback.
  // (Slice on the Write-Host line, not on "}": the /TR argument contains '{1}'.)
  const fallback = body.slice(
    body.indexOf("if (-not $registered) {"),
    body.indexOf("[watcher] schtasks ONLOGON fallback registered")
  );
  assert.ok(fallback.length > 0, "the schtasks fallback block was not found");
  assert.ok(
    fallback.includes("$registered = $true"),
    "the schtasks fallback does not set $registered, so the start is skipped"
  );
});

test("F95-R2 SHORTCUT: the Startup-folder link is written by the workflow, not by the watcher", () => {
  const step = WF.slice(WF.indexOf("- name: Register watcher autostart (ONLOGON)"));
  const body = step.slice(0, step.indexOf("# [F91 §A.2]"));
  // The old coverage log claimed "(a) startup-folder shortcut - created by the
  // watcher itself at first logon", which is circular: the shortcut only exists
  // once the watcher has already run.
  assert.ok(
    body.includes("Start Menu\\Programs\\Startup"),
    "the workflow does not write the Startup-folder shortcut"
  );
  assert.ok(body.includes("'GHRDP Watcher.lnk'"), "the Startup shortcut name drifted from the watcher's");
  assert.ok(
    !body.includes("(a) startup-folder shortcut - created by the watcher itself at first logon"),
    "the coverage log still claims the circular mechanism"
  );
  assert.ok(
    body.includes("written HERE by the workflow (F95"),
    "the coverage log does not describe what is actually true"
  );
});

test("F95-R2 SUPERVISOR: the server heals a DEAD watcher and reports what it did", () => {
  assert.ok(SERVER.includes("function Invoke-F95WatcherSupervise"), "the supervisor is missing");
  // Liveness is MEASURED from the watcher's own heartbeat, not assumed.
  assert.ok(SERVER.includes("$script:F95SupStaleSec = 180"), "no staleness bound on the heartbeat");
  assert.ok(SERVER.includes("Read-JsonFile -Path $script:ProgPath"), "the supervisor does not read the heartbeat");
  // Three escalating routes, ending in a direct invoke.
  assert.ok(SERVER.includes("Start-ScheduledTask -TaskName 'GhrdpWatcher' -ErrorAction Stop"), "no task route");
  assert.ok(SERVER.includes("& schtasks.exe /Run /TN GhrdpWatcher"), "no schtasks route");
  assert.ok(SERVER.includes("'-WindowStyle','Hidden','-File',$watcherSrc"), "no direct-invoke last resort");
  // The F11-5.3 launch-gates pin greps THIS FILE per-line for a launcher call
  // lacking `-WindowStyle Hidden` (with no comment filter, unlike the main.yml
  // half of the gate). A backtick continuation - or a comment merely naming the
  // call - trips it. Pin the invariant so the supervisor cannot silently
  // re-break that gate.
  const badLaunch = SERVER.split("\n")
    .filter((l) => l.includes("Start-Process"))
    .filter((l) => !l.includes("NoNewWindow"))
    .filter((l) => !l.includes("WindowStyle Hidden"));
  assert.deepEqual(
    badLaunch,
    [],
    "F11-5.3 would fail: an unhidden server-launched helper (or a comment naming one):\n" + badLaunch.join("\n")
  );
  // It writes a verdict the dashboard can read - an unverifiable supervisor is
  // indistinguishable from none.
  assert.ok(SERVER.includes("$script:F95SupStatePath = Join-Path $Root 'watcher-supervisor.json'"), "no supervisor state file");
  assert.ok(SERVER.includes("watcherSupervisor = "), "/diag does not expose the supervisor verdict");
  for (const a of ["'task-start'", "'schtasks-run'", "'direct-invoke'", "'failed'"]) {
    assert.ok(SERVER.includes("$state.action = " + a), "supervisor action " + a + " is not reported");
  }
  // The blind 60s heal is gone.
  assert.ok(
    !SERVER.includes("try { Start-ScheduledTask -TaskName 'GhrdpWatcher' -ErrorAction SilentlyContinue } catch { }\n    }"),
    "the blind 60s heal is still in the accept loop"
  );
  assert.ok(SERVER.includes("Invoke-F95WatcherSupervise | Out-Null"), "the accept loop does not call the supervisor");
});
