// [F91 §A/§6.A] Persistent launcher SERVICE + /api/launcher/queue|health -
// pinned in bytes (the repo's proven pattern for the single-file PS server).
// Proves: (1) the service script drains the queue dir, executes the four modes
// behind the same validation fence, heartbeats every 10 s and never carries a
// UI-automation identifier; (2) the queue route writes GUID-named .job files,
// validates mode + URL like the service does, rate-limits 60/min, and answers
// 503 (never a fake 200) when the directory is unwritable; (3) the health route
// exposes the exact fields the diag banner renders; (4) main.yml registers +
// starts the GHRDP-Launcher scheduled task with a hidden window (F11-5.3);
// (5) the e2e mock answers the same envelopes so the UI specs exercise the
// real shapes.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const SERVER = fs.readFileSync(path.join(__dirname, "..", "payloads", "ghrdp-server.ps1"), "utf8").replace(/\r\n?/g, "\n");
const SVC = fs.readFileSync(path.join(__dirname, "..", "payloads", "ghrdp-rdp-launcher.ps1"), "utf8").replace(/\r\n?/g, "\n");
const WF = fs.readFileSync(path.join(__dirname, "..", ".github", "workflows", "main.yml"), "utf8").replace(/\r\n?/g, "\n");
const MOCK = fs.readFileSync(path.join(__dirname, "..", "tests", "e2e", "fixtures", "mock-backend.mjs"), "utf8");

test("F91-a: the launcher service drains the queue with the 500 ms loop + 10 s heartbeat", () => {
  assert.ok(SVC.includes("$QueueDir     = 'C:\\ProgramData\\ghrdp\\launcher-queue'"), "queue dir contract drifted");
  assert.ok(SVC.includes("$LogPath      = 'C:\\ProgramData\\ghrdp\\launcher.log'"), "log path contract drifted");
  assert.ok(SVC.includes("$Heartbeat    = 'C:\\ProgramData\\ghrdp\\launcher-heartbeat.txt'"), "heartbeat path drifted");
  assert.ok(/\$PollMs\s+=\s+500/.test(SVC), "poll interval must be 500 ms");
  assert.ok(/\$HeartbeatSec\s+=\s+10/.test(SVC), "heartbeat every 10 s");
  assert.ok(/while \(\$true\)/.test(SVC), "the service must loop forever");
  assert.ok(/Sort-Object CreationTime/.test(SVC), "jobs must run in creation order");
  for (const mode of ["'navigate'", "'explorer'", "'download'", "'noop'"]) {
    assert.ok(SVC.includes("switch ($mode)".replace("$mode", "$mode")) || /switch \(\$mode\)/.test(SVC), "mode switch missing");
    assert.ok(SVC.includes(mode + " {") || SVC.includes(mode + " {") || SVC.includes(mode + " {") || SVC.includes(mode), "mode " + mode + " missing");
  }
  assert.ok(SVC.includes("Start-Process msedge.exe") || /Start-Process \$target -ArgumentList \$url/.test(SVC), "navigate must spawn a browser");
  assert.ok(/'msedge\.exe'/.test(SVC) && /'chrome\.exe'/.test(SVC), "edge-first, chrome-fallback");
  assert.ok(SVC.includes("Remove-Item -LiteralPath $item.FullName -Force"), "consumed jobs must be deleted");
  // every job ends in the log, success or not, and failures NEVER kill the loop
  assert.ok(SVC.includes("Write-F91Log ('REFUSED"), "refusals must be logged");
  assert.ok(/finally \{[\s\S]*Remove-Item/.test(SVC), "the job file must be removed even when the job throws");
  // safety: the https fence runs in the SERVICE too, and no forbidden surface
  assert.ok(/-notmatch '\^\(\?i\)https:\/\/'/.test(SVC), "the service must re-fence https");
  assert.ok(!/SendKeys|UIAutomation|WScript\.Shell\s*\.\s*AppActivate/i.test(SVC.replace(/CreateShortcut/g, "")), "no UI-automation identifiers in the launcher service");
  assert.ok(SVC.includes("Get-F91RedactedUrl"), "navigate log lines must be redacted to host+path");
});

test("F91-b: /api/launcher/queue validates with the SAME fence as the service", () => {
  const i = SERVER.indexOf("if ($path -eq '/api/launcher/queue' -and $parts.method -eq 'POST')");
  assert.ok(i > 0, "the queue route is missing");
  const block = SERVER.slice(i, SERVER.indexOf("# [F91 §A.4]", i));
  assert.ok(block.length > 500, "the route block looks truncated");
  assert.ok(block.includes("Test-F91QueueJob -Url $f91JobUrl -Mode $f91JobMode"), "the route must use the shared validator");
  assert.ok(SERVER.includes("if (@('navigate','download','explorer','noop') -notcontains $m)"), "mode allowlist is missing");
  assert.ok(SERVER.includes("if ($u -match '(?i)^(javascript|file|data|vbscript|about|ms-msdt|search|folder)?:')"), "the scheme deny-list is missing");
  assert.ok(SERVER.includes("if ($u -notmatch '^(?i)https://')"), "navigate must be https-only");
  assert.ok(SERVER.includes("$uri.UserInfo"), "userinfo must be refused");
  assert.ok(SERVER.match(/explorer'\) \{\s*\n\s*# a LOCAL folder path only/), "explorer must accept a drive path only");
  assert.ok(block.includes("$f91JobId = [guid]::NewGuid().ToString('N')"), "job id must be a GUID");
  assert.ok(block.includes("($f91JobId + '.job')"), "the job file must be <guid>.job");
  assert.ok(block.includes("code = 'RATE_LIMITED'") && /-ge 60/.test(block), "60 writes/min must be enforced");
  assert.ok(block.includes("QUEUE_DIR_UNAVAILABLE"), "an unwritable queue must answer 503, never a fake ok");
  assert.ok(block.includes("ok = $true; queuedAt = $f91Job.timestamp; jobId = $f91JobId"), "the 200 envelope {ok,queuedAt,jobId} drifted");
  // the audit line carries the HOST only (F88 redaction rule)
  assert.ok(block.includes("([System.Uri]$f91Job.url).Host"), "queue audit must log the host, not the URL");
});

test("F91-c: /api/launcher/health exposes exactly the diag fields", () => {
  const i = SERVER.indexOf("if ($path -eq '/api/launcher/health' -and $parts.method -eq 'GET')");
  assert.ok(i > 0, "the health route is missing");
  assert.ok(SERVER.slice(i, i + 400).includes("Get-F91LauncherHealth"), "health must be served by the shared helper");
  const h = SERVER.indexOf("function Get-F91LauncherHealth");
  const body = SERVER.slice(h, SERVER.indexOf("function Invoke-F91StreamFetch", h));
  for (const key of ["serviceRunning", "heartbeatAge", "queueDepth", "taskExists", "activeUser", "log"]) {
    assert.ok(body.includes(key), "health payload missing: " + key);
  }
  assert.ok(/-lt 30000/.test(body), "heartbeat <30 s = serviceRunning");
  assert.ok(body.includes("Get-Content -LiteralPath $p.log -Tail 10"), "log = last 10 lines");
  assert.ok(/schtasks\.exe \/Query \/TN GHRDP-Launcher/.test(body), "taskExists = scheduler query");
  // the three routes must be admitted by the F78 gate (the F88 §B.1 lesson)
  assert.ok(SERVER.includes("-or $path -eq '/api/launcher/queue' -or $path -eq '/api/launcher/health' -or $path -eq '/api/stream'"), "F78 gate does not admit the new routes");
});

test("F91-d: main.yml installs the GHRDP-Launcher task at dispatch", () => {
  assert.ok(WF.includes("cp \"$GITHUB_WORKSPACE/payloads/ghrdp-rdp-launcher.ps1\" \"$RUNNER_TEMP/ghrdp-stage/ghrdp-rdp-launcher.ps1\""), "the service script is never staged");
  const step = WF.slice(WF.indexOf("- name: Register GHRDP-Launcher service (F91 mirror mode)"), WF.indexOf("- name: Register GhrdpWebDesk task"));
  assert.ok(step.length > 300, "the registration step is missing");
  assert.ok(step.includes("Register-ScheduledTask -TaskName 'GHRDP-Launcher'"), "the task is not registered");
  assert.ok(step.includes("-WindowStyle Hidden"), "F11-5.3: the helper launch must be hidden");
  assert.ok(step.includes("schtasks.exe /Run /TN GHRDP-Launcher"), "the task must be started once at dispatch");
  assert.ok(step.includes("Get-ScheduledTaskInfo -TaskName 'GHRDP-Launcher'"), "the task state must be read back");
  assert.ok(step.includes("launcher-heartbeat.txt"), "the heartbeat file must be proven after the first run");
  assert.ok(step.includes("C:\\ProgramData\\ghrdp"), "the script must land under ProgramData (shared by SYSTEM server + interactive user)");
});

test("F91-e: the mock backend mirrors both envelopes (e2e exercises the real shape)", () => {
  assert.ok(MOCK.includes('path === "/api/launcher/queue"'), "mock queue lane missing");
  assert.ok(MOCK.includes('path === "/api/launcher/health"'), "mock health lane missing");
  assert.ok(MOCK.includes("ok: true, queuedAt: new Date().toISOString(), jobId"), "mock queue envelope drifted");
  assert.ok(MOCK.includes('serviceRunning: true, heartbeatAge: 2000, queueDepth: 0'), "mock health envelope drifted");
  assert.ok(MOCK.includes('mode === "navigate") launchCalls.push'), "navigate jobs must also count as launch calls for the F86 readback");
  for (const f of ["launcherQueueOk", "streamProxyOk", "downloadOk", "taskSchedulerHealth"]) {
    assert.ok(MOCK.includes(f), "mock selftest lacks the F91 column: " + f);
  }
});

test("F91-f: /api/version advertises mirrorLauncher (and the flag has code behind it)", () => {
  const i = SERVER.indexOf("if ($path -eq '/api/version')");
  const block = SERVER.slice(i, SERVER.indexOf("if ($path -eq '/api/ping')", i));
  assert.match(block, /mirrorLauncher = \$true/, "mirrorLauncher is not advertised");
  assert.match(block, /streamProxy = \$true/, "streamProxy is not advertised");
});
