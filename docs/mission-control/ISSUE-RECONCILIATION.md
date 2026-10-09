# Canonical Issue Reconciliation (#153 / #156 / #154 / #155, #181, #191)

Read in full this session: [#153](https://github.com/dekarita/supreme-lamp/issues/153) (8.9 KB, 0 comments),
[#156](https://github.com/dekarita/supreme-lamp/issues/156) (4.4 KB, 0 comments), [#181](https://github.com/dekarita/supreme-lamp/issues/181)
(4.6 KB, 0 comments); PR bodies searched: [#155](https://github.com/dekarita/supreme-lamp/pull/155) (merged
2026-10-06T15:21:29Z, "F99: fix 5 root causes + Diagnosis Collector + RDP UX", no closing keyword for either issue),
[#154](https://github.com/dekarita/supreme-lamp/pull/154) (open, "Closes #153"). The two issue titles are identical;
the bodies are not.

## 1. #153 vs #156 item by item

| Item | Shared | #153 only | #156 only | Contradiction | Current code (`823bcb6`) | Status |
|---|---|---|---|---|---|---|
| B1 WebSocket | no RFC 6455 path in F96 bundle | file:line evidence; "or delete WS lane, switch to SSE"; acceptance "status frame every 2 s" | "authenticate before upgrade", contract tests | none material | `F96WsUpgradeSupported = $true` (server L415), `Invoke-F99WebSocketUpgrade` (L430), `Send-F99WsText` ×6 | **RESOLVED_IN_CODE** (historical claim); live behaviour RUNTIME_UNVERIFIED |
| B2 Watcher 267011 | diagnose task result codes | export/inspect XML, register from hardened XML for the user that logs on, `Invoke-F99WatcherDiagnose` | "do not invent a live Task Scheduler XML capture when the runner cannot provide one" | XML strategy | main.yml step "Register watcher autostart (ONLOGON) [F99 B2 hardened]" registers from an inline XML template bound to the resolved active user (fallback `runneradmin`), reads principal back; `Invoke-F99WatcherDiagnose` at server L9385 | **IMPLEMENTED per #153**; whether the task fires in the operator's session depends on B4 |
| B3 Logon scanner | accepted set `{2,10,11}` | 120 s window bug; sticky verdict; replace watcher `LogonType = 10` | keep RDP-specific probes that **deliberately** require type 10 | whether every type-10 filter goes | `AddSeconds(-120)` absent in server; `LogonType = 10` absent in watcher/server; auto-logon step accepts 2/10/11 | **RESOLVED_IN_CODE** for the cited lines; #156's "deliberate type-10" caveat not yet audited |
| B4 Autologon user | mismatch generated `rdp…` vs `runneradmin` | arm for the actual interactive user; "never clobber the image's working pair with a generated account" | arm for "the actual RDP account created/configured by the workflow"; "do not hard-code a username" | **direct**: which identity | main.yml L4795-L4835: resolve active user via `quser` → CIM → fallback **hard-coded `runneradmin`**; **set that user's password to the generated secret**; write Winlogon pair for it | **ACTIVE DECISION** (MC-P21). Deployed code follows neither text exactly (it overwrites the image's pair's password); PR #154 proposes a third option |
| B5 dash token 401 | shared validator | rotation-aware (snapshot ∪ current file), constant-time, "hashes only" telemetry | "redacted/hashed token telemetry" | none between them; both propose token hashes in telemetry, which conflicts with this plan's no-derived-identifier rule | `Test-GhrdpDashToken` exists (L861), 6 references | **LIKELY RESOLVED**; per-route adoption NOT_READ (WP-05A) |
| Collector | `/#/collector`, rate-limited run, JSON + Markdown | 15+ features; `POST /api/collector/run` 1/5 min + status + report | ≥10 features incl. 11 search sites, viewing mode, AutoLogon, token rotation, sidebar routes; **EN + SI strings**; link failed checks to evidence | none | page + endpoints exist (registry); Collector page uses `defaultValue` English literals for many labels | **IMPLEMENTED (server half NOT_READ)**; EN/SI completeness of Collector UI **PARTIAL** (literals observed) |
| First-login UX | hide PowerShell windows; dashboard opens automatically | — | hide (not minimize); keep Tailscale connected; Edge app/kiosk with validated URL; idempotent; no credential-bearing URLs/logs | none | not read | NOT_READ |
| Process guards | — | — | no session dispatches `main.yml` or merges its PR; full check list | — | — | adopted by this plan |

## 2. Classification

- **Shared requirements**: B1–B5 evidence, Collector page/endpoints, first-login UX.
- **Unique to #153**: file:line evidence per item; 120 s window; sticky verdict; SSE alternative; 2 s WS frame cadence.
- **Unique to #156**: EN/SI strings for Collector; Tailscale-preserving first login; kiosk mode; credential-free
  URLs/logs; deliberate type-10 probes; "do not invent XML capture"; process guards.
- **Contradictions**: B2 (XML strategy), B3 (scope of type-10 removal), **B4 (identity)**.
- **Already resolved (code)**: B1, B3 (cited lines), B2 registration hardening, B5 validator existence, Collector.
- **Still active**: B4 identity decision; Collector EN/SI completeness; first-login UX verification; per-route B5
  adoption verification.
- **Unverified claims**: all "resolved" items lack live evidence on the current build (WP-01/WP-12).

## 3. Recommended canonical structure (technical, no number choice requested)

Keep **#153 canonical**: older, evidence-rich (file:line), already referenced by the open PR #154 ("Closes #153").
Record #156's unique requirements on #153 by a cross-link comment (done in this session) and mark #156 "superseded by
#153 — unique requirements carried over" in a comment. Closing #156 and deciding the fate of the stale competing PR
#154 (conflicts with merged #155 on B4) remain operator actions; neither blocks any other work package.

## 4. Genuine operator decision (identity)

Technical evidence is exhausted for the code question; the remaining question is product/security intent:

| Option | What it means | Security consequence | Evidence trail |
|---|---|---|---|
| A — generated per-run account is the RDP identity (#156) | autologon, watcher and launcher tasks bound to the generated `rdp…` account | platform `runneradmin` untouched | #156 B4 |
| B — active desktop user (usually `runneradmin`) is the RDP identity with password sync (**deployed**, PR #155) | operator signs in as `runneradmin` with the generated secret | platform account's password changed every run | main.yml L4795-L4835 |
| C — preserve the image's pair; generated account only when it owns the desktop (PR #154) | publish `autologon-status.json` with `userMatches` | no password change to platform account | PR #154 body |

Until decided, diagnostics must display all four observed names (autologon user, active session user, RDP login
user, task principal) — probe P-07 — rather than infer which one is "right".

## 5. #181 refresh (producer / signer / verifier / consumer)

| Part | State @ `9aa6051` | Evidence |
|---|---|---|
| Transport (`/ws`) | EXISTS | `Invoke-F99WebSocketUpgrade` L430; `Send-F99WsText` 6 occurrences (1 definition + 5 sends) |
| Producer (patch broadcaster) | VERIFIED_ABSENT in `payloads/ghrdp-server.ps1` | grep `"type":"patch"|patchFrame|SendPatch|livePatch|Send-F99WsPatch` → 0 |
| Signer | EXISTS (offline script) | `scripts/f110b-sign-patch.mjs` |
| Pin | empty | `PATCH_PUBLIC_KEY_B64 = ""` (`src/lib/livePatch/keys.ts` L23); build-time `VITE_PATCH_PUBLIC_KEY` path exists |
| Verifier / consumer | EXISTS, fail-closed | `signatureCore.js`, `channel.ts` ingest (grep) |

The #181 description remains accurate. The plan reclassifies Live Patch as OPTIONAL_IMPROVEMENT: no diagnostics
view depends on it.

## 6. #191 drift reconciled

| Drift | Fix |
|---|---|
| route counts "13 concrete + fallback" | 16 / 14 / 12 + 2 / 1 / 1 (correction B1) |
| problems MC-P1…P5 in issue vs P6 in doc | MC-P1…P23 in both |
| "Operator picks canonical #153/#156" | replaced by §3 recommendation |
| "M8 live run NOT RUN" | LIVE_EXECUTION_IN_PROGRESS (run 37903915039) |
| bare file paths | navigable PR-branch / permalink links |
| false dependencies (WP-04←WP-03, WP-08←WP-03) | removed (WORK-PACKAGES dependency graph) |
