## Summary

F96 diag bundle (attached to the F96 report, `bundle 2026-10-06T13:13:06Z`) proves **5 root causes** behind the persistent production symptoms. Not guesses — bundle data. Follows #145 (F95 root causes, merged via PR #146) and #148 (F96 diagnostic bundle endpoint, merged via PR #148).

Every B-item below names the **file:line** that produces the evidence, so this is checkable, not narrative.

---

## B1. WebSocket server missing `/ws` upgrade route (critical)

**Evidence**: `webSocket.serverUpgradeSupported: false`, `healthWsFlag: false`, 24 reconnect attempts closed 1006.
**Bundle note**: "This server build has NO RFC6455 upgrade path: /health hardcodes ws=false and no route answers /ws".

**Confirmed in code**: `payloads/ghrdp-server.ps1:416` `$script:F96WsUpgradeSupported = $false`; the `/health` handler at `:8413` hardcodes `ws = $false`; `/api/mirror/status`'s `serverUpgradeSupported` diagnostic at `:7456` reads that same hardcoded constant. The listener is a **raw `System.Net.Sockets.TcpListener`** (`:8677`) with a hand-rolled HTTP parser (`Read-ClientRequest`, `:1536`) — there is no route table entry for `/ws` anywhere, so the F95/R4 client lane (`src/hooks/useDashboardPolling.ts:146`, which correctly sends `?key=` **and** a `{type:'hello',key}` first frame) can never be accepted. Every attempt closes 1006 because the server never answers the upgrade.

**Fix**: implement the RFC 6455 upgrade in `payloads/ghrdp-server.ps1` (handshake + frame codec + a token-checked pump) **or** delete the client WS lane and switch to SSE / long-poll.
**Priority 1** — blocks real-time status.

---

## B2. Watcher task 267011 never fires (critical)

**Evidence**: `scheduledTaskLastResult: 267011` (`0x00041303` = `SCHED_S_TASK_HAS_NOT_RUN`), `supervisorAttempts.taskStart: 7`, `schtasksRun: 5`, `watcherProcessRunning: false`, `watcherHeartbeat: null`.

**Diagnosis**: 267011 = "The task has not yet run" (not an error — the task is registered and **its trigger has never fired**). Combined with `taskStart=7` (7 `Start-ScheduledTask` calls that evidently did nothing) the mechanism is visible: the task's principal/trigger is bound to a user that **never logs on**, so the ONLOGON trigger never fires and an on-demand start silently no-ops.

**Confirmed in code**: `.github/workflows/main.yml:4466-4470` registers `GhrdpWatcher` with `New-ScheduledTaskTrigger -AtLogOn -User $user` + `New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive`, where `$user = $env:RDP_USER` is the **per-run generated account** (`main.yml:1841`: `'rdp' + guid[0..6]`). The desktop that actually exists on the box belongs to `runneradmin` (F96: `runnerInfo.activeUsers[0].user`). Nothing ever filters the trigger's user, validates the action path, or reads the task XML back — the F95 supervisor escalates `task-start → schtasks-run → direct-invoke` against a task that cannot start.

**Fix**: inspect/export the registered XML (`Get-ScheduledTask GhrdpWatcher | Export-ScheduledTask`) and register from a **hardened, validated XML** (`Register-ScheduledTask -Xml`) bound to the user that really logs on; add `Invoke-F99WatcherDiagnose` mapping task result codes → reason + suggested fix.
**Priority 1** — blocks all RDP-side features.

---

## B3. Second logon scanner still filters too narrowly (high)

**Evidence**: `logon.rawEventCount: {type2: 8, type10: 0, type11: 0, excluded: 102}` — 8 valid type-2 events **seen in the 3600s window** — yet `logon.detected: false`. Advisory: "F28 scanner has no accepted interactive logon yet".

**Confirmed in code**: F95 R1 fixed the *filter* (`Test-GhrdpInteractiveLogonType`, `:746`) but left the **window** at 120 s:

- `Update-RdpLogonAuthLast` (`:841`, probe at `:846`) reads only `$ScanStartedUtc.AddSeconds(-120)` — **2 minutes** of Security log — and **overwrites** `rdp-logon.json` every 30 s (`:8664`, `:8853`).
- `Get-RdpLogonAuthLast` (`:766`, floor at `:770`) then evaluates that 2-minute slice.

So any logon older than 2 minutes is *unseen and unstamped*, the persisted verdict decays to `result='none'`, and `logon.detected` reads **false while a real desktop is live** — precisely the F95 symptom, still reproducible, and exactly why the advisory fires while the bundle's own wider re-scan counts 8 accepted type-2 events. A **third** strict filter also survives at `payloads/ghrdp-watcher.ps1:366` (`Win32_LogonSession -Filter "LogonType = 10"`), which makes the watcher's session-clock stamping disagree with the server.

**Fix**: one shared accepted set (`2/10/11`) **and** one shared window; make the verdict sticky for an established session; replace the remaining `LogonType = 10` filter with the shared WQL set.
**Priority 2** — blocks logon detection.

---

## B4. Autologon user mismatch (high)

**Evidence**: `mainYmlBootstrap.autologonUser: "rdpb2e2fa"` vs `runnerInfo.activeUsers[0].user: "runneradmin"`.

**Confirmed in code**: `main.yml:1841` creates a **random per-run account** (`rdp` + 6 hex) and `main.yml:4741-4744` writes it into `Winlogon\DefaultUserName` + `DefaultPassword` + `AutoAdminLogon=1`, while the interactive desktop on a hosted runner belongs to `runneradmin` (the image's own autologon). The result is two users with two different roles: every user-scoped artifact (watcher/launcher/first-login ONLOGON tasks at `:4466`, `:4657`, `:4816`; Startup shortcuts; `dashboard-url.txt` consumers) is bound to the generated account that is **not** the one signing in.

**Fix**: resolve the **actual interactive session user** at bootstrap and (a) arm AutoAdminLogon for *that* user when a session exists — never clobber the image's working autologon pair with a generated account — (b) bind the user-scoped tasks/shortcuts to the same user, (c) publish `autologonUser` vs `activeUser` + `userMatches` as machine-readable state for the dashboard and the collector.
**Priority 2** — blocks first-boot autologon success.

---

## B5. Dash token 401 on `GET /api/mirror/status` (medium)

**Evidence**: 3× `401` on `/api/mirror/status` in `recentErrors`, while `clientInfo.dashTokenPresent: true`.

**Confirmed in code**: the expected token is read **once** at process start into a memory snapshot (`payloads/ghrdp-server.ps1:432-435`, `dash-token.txt`) and every route re-implements its own comparison against that snapshot — `:2147` (mirror), `:2424` (f58), `:3784` (f70), `:4916` (f78), `:5652` (f81), `:5779` (f91). None re-reads the file, none records what was compared. `GET /api/mirror/status` is the only route that both **permits a token-less loopback/tailnet request** (`:2188-2191`) **and** returns `401 (dash token invalid)` the moment a token is *presented* but does not match the snapshot (`:2186`). That asymmetry is exactly the reported signature: a client that presents a token is rejected, while the same client without one would be allowed. Any rotation of `dash-token.txt` (written fresh on every dispatch, `main.yml:2510`) under a still-running server process makes every presented-token check fail with no telemetry to prove it.

**Fix**: one shared, **rotation-aware** validator (`Test-GhrdpDashToken`: snapshot + current file token, constant-time, normalised) used by every route, plus bounded verification telemetry (hashes only, never the value) served at `/api/diag`.
**Priority 3** — causes retry noise.

---

## Operator requirement — Diagnosis Collector

A `/#/collector` page + one button that exercises **every** RDP Mission Control feature end-to-end (15+ features), takes as long as it needs, and reports per-feature pass/fail with diagnostics: `POST /api/collector/run` (1 call / 5 min) + `GET /api/collector/status` (progress) + `GET /api/collector/report`, and a downloadable JSON report + Markdown summary.

## Operator requirement — clean RDP first login

PowerShell/conhost windows must not be visible on first noVNC login, and the dashboard must open automatically (F98 §4 partially landed; F99 hardens it).

---

## Acceptance

- [ ] `/ws` answers a real RFC 6455 upgrade, validates the dash token, pushes a status frame every 2 s; `/health` reports the true `ws` value.
- [ ] `GhrdpWatcher` XML validated + re-registered for the user that logs on; `Invoke-F99WatcherDiagnose` explains 267011/2147944516/2147942667.
- [ ] No `LogonType 10`-only filter or 120 s-only window remains in any scanner; `logon.detected` is true while a live interactive session exists.
- [ ] `autologonUser == activeUser` (or the mismatch is reported as a machine-readable warning with a suggested fix).
- [ ] Zero `401 (dash token invalid)` on a valid token; every verify recorded with hashes at `/api/diag`.
- [ ] `/#/collector` runs all features and reports per-feature pass/fail with download.
- [ ] No PowerShell window visible on first RDP login; dashboard auto-opens.

Refs: #145 (F95 root causes), #148 (F96 bundle endpoint). Fix PR: F99 (this session).
