# Mission Control — Work-Package Specifications and Execution Briefs

Parent: [#191](https://github.com/dekarita/supreme-lamp/issues/191). IDs WP-00…WP-12 are preserved from plan v1.
Mapping of refinements: **WP-03 → WP-03A (research census) + WP-03B (generator/CI)**; **WP-05 → WP-05A (server and
runner research) + WP-05B (health model)**; **new WP-13** (Collector privacy defects) and **new WP-14** (diagnostic
truthfulness and safety defects) — both split out of v1 "known problems" because they are source-verified defects.

Planning states: `RESEARCH_PENDING` · `RESEARCH_IN_PROGRESS` · `SPECIFIED` · `READY_FOR_IMPLEMENTATION` · `BLOCKED` ·
`DEFERRED`. Delivery states (separate): `PR_OPEN` · `MERGED` · `DEPLOYED` · `LIVE_VERIFIED`.
Categories: `CORE_DIAGNOSTICS` · `VERIFIED_DEFECT_REPAIR` · `VERIFICATION_INFRASTRUCTURE` · `OPTIONAL_IMPROVEMENT`.
Effort ranges are engineering-session estimates with stated uncertainty, not commitments.

## Summary

| WP | Title | Category | Planning state | Delivery | Child issue |
|---|---|---|---|---|---|
| WP-00 | Plan reconciliation + docs | planning | SPECIFIED | PR_OPEN (#190 + continuation PR) | #191 |
| WP-01 | M8 live acceptance evidence | VERIFICATION_INFRASTRUCTURE | RESEARCH_IN_PROGRESS (run in flight) | — | ISSUE_WP01 |
| WP-02 | F99 issue reconciliation + RDP identity decision | VERIFIED_DEFECT_REPAIR | SPECIFIED (operator decision pending) | — | #153 (canonical, recommended) |
| WP-03A | Control and evidence census | CORE_DIAGNOSTICS | RESEARCH_IN_PROGRESS | — | ISSUE_WP03A |
| WP-03B | Catalog generator + CI gate | VERIFICATION_INFRASTRUCTURE | SPECIFIED | — | ISSUE_WP03B |
| WP-04 | Event contract + redaction core | CORE_DIAGNOSTICS | SPECIFIED | — | ISSUE_WP04 |
| WP-05A | Server/runner endpoint research (R5–R7) | CORE_DIAGNOSTICS | RESEARCH_PENDING | — | ISSUE_WP05A |
| WP-05B | Read-only dependency health model + bounded probes | CORE_DIAGNOSTICS | RESEARCH_PENDING (needs WP-05A) | — | ISSUE_WP05B |
| WP-06 | Causal action attribution | CORE_DIAGNOSTICS | SPECIFIED | — | ISSUE_WP06 |
| WP-07 | Embedded diagnostics experience | CORE_DIAGNOSTICS | SPECIFIED | — | ISSUE_WP07 |
| WP-08 | F110c patch emitter | OPTIONAL_IMPROVEMENT | SPECIFIED (in #181); DEFERRED from the diagnostics path | — | #181 |
| WP-09 | e2e-ui systematic timeout | VERIFICATION_INFRASTRUCTURE | RESEARCH_IN_PROGRESS | — | ISSUE_WP09 |
| WP-10 | Sanitized evidence export | CORE_DIAGNOSTICS | SPECIFIED | — | ISSUE_WP10 |
| WP-11 | Guided troubleshooting in product | CORE_DIAGNOSTICS | SPECIFIED | — | ISSUE_WP11 |
| WP-12 | Live acceptance + rollout | VERIFICATION_INFRASTRUCTURE | BLOCKED | — | ISSUE_WP12 |
| WP-13 | Collector privacy defects | VERIFIED_DEFECT_REPAIR | **READY_FOR_IMPLEMENTATION** (first) | — | ISSUE_WP13 |
| WP-14 | Diagnostic truthfulness and safety defects | VERIFIED_DEFECT_REPAIR | READY_FOR_IMPLEMENTATION | — | ISSUE_WP14 |

## Dependency graph

```
WP-13 ─┐                    WP-05A ──► WP-05B ─┐
WP-04 ─┼─► WP-06 ──────────────────────────────┼─► WP-07 ──► WP-11 ──┐
       ├─► WP-10                               │                     ├─► WP-12
WP-03A ──► WP-03B                              │       WP-01 ────────┤
WP-14 (independent)    WP-09 (independent; gates BROWSER_E2E acceptance of WP-07/13/14, not their specs)
WP-02 (independent)    WP-08 (optional, independent)
```

| Edge | Rationale (why blocking) |
|---|---|
| WP-04 → WP-06 | attribution needs `correlationId`/`attribution` fields to store results compatibly |
| WP-13 → WP-06 | widening capture before redaction would multiply the leak (MC-P8/P11/P12) |
| WP-04 → WP-10, WP-13 → WP-10 | export must use the shared redaction rules and must not ship raw rows |
| WP-05A → WP-05B | probe semantics depend on server handlers not yet read |
| WP-05B, WP-06 → WP-07 | the drawer's Overview/Timeline need a health model and attributed actions to be truthful |
| WP-07 → WP-11 | guided flows render inside the drawer |
| WP-03A → WP-03B | the generator's schema is the census schema frozen |
| WP-01, WP-07, WP-11 → WP-12 | live acceptance needs the features and the M8 evidence |
| Removed (v1) | WP-03 → WP-04, WP-03 → WP-08, WP-00 → WP-03 review gate, M8 → research, duplicate closure → census |

---

<a id="wp-00"></a>
## WP-00 — Plan reconciliation + documentation (planning)
- **Problem / evidence**: plan v1 had false absence claims, wrong route counts, serial topology (see
  [correction ledger](CORRECTION-LEDGER.md)). **Current**: #190 + continuation PR. **Scope**: docs only.
- **Acceptance**: correction ledger complete; #191 top section current; child issues linked. **Rollback**: revert docs.

<a id="wp-01"></a>
## WP-01 — M8 live acceptance evidence (VERIFICATION_INFRASTRUCTURE)
- **Problem / evidence**: the cancellation-safe finalizer (#188/#189) has no live evidence. Run
  [37903915039](https://github.com/dekarita/supreme-lamp/actions/runs/37903915039) (operator dispatch, `823bcb6`,
  attempt 1) committed `580f231` "initial status.json" with `runAttempt: 1` — the M8 initial-snapshot change executed
  live. Step 67 "Finalize status.json (M8 …)" pending at 08:27Z.
- **Reusable**: `docs/M8-LIVE-VERIFICATION.md` runbook; `tests/m8-*`; contents-API commit history of `docs/status.json`.
- **Required behaviour**: after the run ends (normal end or operator cancel), record: final `runStatus`,
  `runAttempt`, `finalizeReason` (if present), finalizer step conclusion, commit sha/time of the terminal snapshot,
  heartbeat commits count, and whether the terminal write is monotonic (no later `in_progress`).
- **Scope**: read-only evidence collection; **exclusions**: no dispatch, no cancel, no re-run by an agent.
- **Dependencies**: none blocking other WPs (rationale: evidence only).
- **Privacy**: status.json sensitive-named fields (`mirrorKey`, `legacyKey`, URLs, IPs) were empty in the initial
  snapshot; record only emptiness/shape, never values.
- **Tests**: compare terminal snapshot against runbook stages B–D. **Acceptance**: terminal snapshot observed with
  `runStatus ∈ {success, failure, cancelled}` matching the run conclusion, attempt matching, written after the last
  heartbeat; or a precise LIVE_ACCEPTANCE_NOT_EVIDENCED reason. **Rollback**: n/a.
- **Operator actions**: only the runbook's own stages (operator decides whether to cancel to test the cancel path).
- **Effort**: 0.5 session; uncertainty: run duration up to 6 h.
- **Brief**: "Read-only. For run 37903915039 (and any later main.yml run on a SHA containing #189), list
  `docs/status.json` commits on main after 2026-10-09T08:16Z, read only `ts,runId,runAttempt,runStatus,finalizeReason`,
  fetch the run's job steps, and record runbook stages B–D results in #191 and docs/OBSERVATORY-STATE.md (append-only).
  Do not dispatch, cancel or re-run workflows. Never print other status fields' values."

<a id="wp-02"></a>
## WP-02 — F99 issue reconciliation + RDP identity decision (VERIFIED_DEFECT_REPAIR)
- **Evidence**: [ISSUE-RECONCILIATION.md](ISSUE-RECONCILIATION.md): #153/#156 share B1–B5 and Collector/first-login
  requirements but contradict on B2 (XML capture), B3 (keep deliberate type-10 probes), B4 (which account). PR #155
  (merged) implemented #153's direction with a password sync for the active user; PR #154 (open, "Closes #153")
  proposes preserving the image's Winlogon pair.
- **Required**: one canonical tracking issue (recommended #153) carrying #156's unique requirements; an explicit
  operator decision on the intended RDP application identity; then a verified-defect WP if the deployed behaviour
  differs from the decision.
- **Scope**: tracking + decision; **exclusions**: closing issues (operator), changing main.yml (later WP).
- **Dependencies**: none. **Privacy/security**: decision affects which account's password is changed on the runner.
- **Acceptance**: cross-links posted; decision recorded; P-07 probe result recorded on the next live run.
- **Operator action**: choose identity option (ISSUE-RECONCILIATION §4). **Effort**: decision only.

<a id="wp-03a"></a>
## WP-03A — Control and evidence census (CORE_DIAGNOSTICS, research)
- **Problem / evidence**: v1 had no control inventory; census v1 now measures 301 static DOM control sites, 42
  dynamic-family sites, 12 global keyboard listeners, 27 programmatic sites ([CONTROL-CENSUS.md](CONTROL-CENSUS.md)).
- **Remaining research**: classify risk class, request dependencies and expected effect for the 277 `SITE_ONLY` rows
  by reading handler bodies; trace journeys J1–J8; measure rendered instances in a mock-backend browser session.
- **Next exact reads**: `PrimaryActions.tsx`, `WebDesktopCard.tsx`, `MirrorCard.tsx`, `src/pages/file-explorer/*`,
  `src/pages/search/{ResultsGrid,CommandBar,LabInspector}.tsx`.
- **Acceptance**: every census row has a risk class or an explicit NOT_CLASSIFIED reason; journeys traced to hop 5 at
  least. **Effort**: 2–3 sessions (uncertainty: Explorer/Search size). **Brief**: "Docs-only. Continue CONTROL-CENSUS.md
  from the SOURCE_RESEARCH_LEDGER next reads; re-run the census indexer method (CONTROL-CENSUS §A) at the current
  revision, diff against v1, and fill risk/request/effect columns. No application changes."

<a id="wp-03b"></a>
## WP-03B — Catalog generator + CI gate (VERIFICATION_INFRASTRUCTURE)
- **Problem**: F-TESTID is tag/char-based and has a blind spot (MC-P17); no gate links controls to semantics.
- **Required**: an AST-based derivation (TypeScript compiler API, already a devDependency) producing
  `docs/mission-control/catalog.json` (schema = census columns) and a `node --test` gate: fails on an undeclared
  route/feature/control, a control without testid **or** explicit `data-diag-exempt` reason, or a catalog row whose
  source site disappeared. Keeps F-TESTID rule ids (a–f) green; adds rule g "AST population ≥ char population".
- **Files**: `scripts/derive-mc-catalog.mjs`, `tests/mc-catalog.test.js`, `docs/mission-control/catalog.json`.
- **Dependencies**: WP-03A schema freeze. **Tests**: add an un-named button after an apostrophe → gate reddens; delete a
  catalog row → reddens; dynamic family counted once. **Rollback**: delete the three files. **Effort**: 1–2 sessions.

<a id="wp-04"></a>
## WP-04 — Event contract + redaction core (CORE_DIAGNOSTICS)
- **Evidence**: [spec Part B §B.1](../MISSION-CONTROL-DIAGNOSTICS-SPEC.md#b1-existing--required--delta).
- **Required**: pure core `src/lib/diag/eventCore.js` (+`.d.ts`, repo convention) providing `redactUrl`,
  `redactRoute` (re-exporting `sanitizeBoundaryRoute` semantics), `redactHeaders` (no fingerprints), `describeSafe`
  (no `value` reads), `classifyError` (layered over `classifyFailure`), `makeCorrelationId` (reusing `mintTraceId`),
  and `upgradeRecord(v1) → v2` (additive).
- **Exclusions**: no UI, no network, no storage writes. **Dependencies**: none (rationale: pure functions).
- **Compatibility**: v1 rows render unchanged; `schemaVersion` absent ⇒ 1.
- **Tests**: node tests executing the shipped core with synthetic secrets (F-13 unit half), mutation falsifiers per
  rule. **Rollback**: delete core. **Effort**: 1 session.

<a id="wp-05a"></a>
## WP-05A — Server and runner endpoint research (CORE_DIAGNOSTICS, research)
- **Missing reads**: `payloads/ghrdp-server.ps1` route table and the handlers of `/diag`, `/health`,
  `/api/health`, `/api/launcher/health`, `/api/native-status`, `/api/mirror/status`, `/api/diag/comprehensive`,
  `/api/collector/{run,status,report}`, `/api/f92-selftest`, `/ws`; validator use of `Test-GhrdpDashToken` per route;
  watcher/launcher payloads; `main.yml` status heartbeat writer and M8 step; Pages deploy workflow; Rust WS dashboard
  port/role; Explorer/mirror server ops (R6).
- **Acceptance**: each endpoint documented with fields (names only), auth shape, side effects, timeouts; architecture
  §3 uncertain edges resolved or re-justified. **Effort**: 2 sessions. **Brief**: "Docs-only research; record ranges in
  SOURCE-RESEARCH-LEDGER; no runtime probes against production."

<a id="wp-05b"></a>
## WP-05B — Read-only dependency health model + bounded probes (CORE_DIAGNOSTICS)
- **Reuse**: `captureServiceStates()` probes, `diagAtGlance`, F92 self-test, telemetry WS state.
- **Required**: a standing read model (store) with per-dependency `{state, lastCheckAt, freshnessBudget, evidenceRef}`
  and the state vocabulary of spec §A.3; startup set PR-01/02/06/07/08 (targets, measured in this WP).
- **Dependencies**: WP-05A (endpoint semantics). **Tests**: F-04, F-05, F-14. **Rollback**: remove store; chips fall back.

<a id="wp-06"></a>
## WP-06 — Causal action attribution (CORE_DIAGNOSTICS)
- **Evidence**: MC-P9, P10, P12 (attribution half), P16 (reconnect outcome), P19, P20, P22.
- **Required**: (1) `instrumentButton` stores **all** app exchanges of the window with `attribution`, selects the
  primary exchange by method/expected route, and folds the handler's own `{ok:false}` result into the verdict;
  (2) global capture tags exchanges with origin (background list derived from the polling hook + DNS probe), stops
  fan-out (EXPLICIT vs TEMPORAL), records real `durationMs`, treats opaque `status 0` from `no-cors` as "opaque", not
  failure; (3) pre-probes run in parallel with the action (not before it); (4) optional `X-GHRDP-Correlation` header in
  API clients (server echo = WP-05A finding).
- **Dependencies**: WP-04, WP-13. **Tests**: F-06, F-07, F-09, F-10; P-02, P-03. **Rollback**: revert per module.
- **Effort**: 2 sessions; uncertainty: correlation header acceptance on the PowerShell parser.

<a id="wp-07"></a>
## WP-07 — Embedded diagnostics experience (CORE_DIAGNOSTICS)
- **Spec**: [Part A](../MISSION-CONTROL-DIAGNOSTICS-SPEC.md#part-a--operator-experience). Hosts: top-bar Summary chip,
  "Diagnose this page" (Alt+D), `DiagSideDrawer` upgraded in place (ids kept), inner static fallback.
- **Dependencies**: WP-05B, WP-06 (truthful content); WP-14 fixes first. **Tests**: F-12, F-16, EN/SI parity,
  degraded-backend mode, keyboard. **Acceptance**: journey steps 1–12 demonstrable on mock backend; BROWSER_E2E once
  WP-09 restores the lane. **Rollback**: feature flag `VITE_MC_DIAG=false` restores today's drawer. **Effort**: 3 sessions.

<a id="wp-08"></a>
## WP-08 — F110c patch emitter (OPTIONAL_IMPROVEMENT)
- Specified in [#181](https://github.com/dekarita/supreme-lamp/issues/181) (re-measured 2026-10-09: 0 emitter hits,
  6 `Send-F99WsText`, empty pin). Not on the diagnostics critical path. Operator ordering constraint: pin + emitter
  land together.

<a id="wp-09"></a>
## WP-09 — e2e-ui systematic timeout (VERIFICATION_INFRASTRUCTURE)
- **Evidence**: run 37898544529 annotation "exceeded the maximum execution time of 25m0s", step 8 "Run F78 + F79 E2E
  specs" 24.5 min; latest 100 runs: 92 cancelled + 8 failure; last success 37285114245 on `2b66c11` (2026-10-05,
  1 m 44 s).
- **Next probe**: identify the first non-success run after `2b66c11` and its commit range; obtain one step log
  (sandbox egress blocks log archives — operator download or a local `playwright` run with the mock backend).
- **Acceptance**: hanging spec identified with evidence; lane green or quarantined with an explicit tracked reason.
  **Effort**: 1–2 sessions.

<a id="wp-10"></a>
## WP-10 — Sanitized evidence export (CORE_DIAGNOSTICS)
- **Reuse**: F96 bundle, `.mcrec` v1/v2, Collector downloads. **Required**: one export pipeline: preview → redact
  (WP-04 rules) → download; screenshots opt-in; tailnet identifiers replaced; manifest lists what was excluded.
- **Dependencies**: WP-04, WP-13. **Tests**: F-13 (export half). **Rollback**: keep existing downloads.

<a id="wp-11"></a>
## WP-11 — Guided troubleshooting in product (CORE_DIAGNOSTICS)
- **Source**: [troubleshooting matrix](../MISSION-CONTROL-TROUBLESHOOTING.md). **Required**: Causes tab entries map
  problem ids to the smallest safe next step and the tracking issue (static map). **Dependencies**: WP-07.

<a id="wp-12"></a>
## WP-12 — Live acceptance + rollout (VERIFICATION_INFRASTRUCTURE)
- **Blocked by** WP-01, WP-07, WP-11 (+ WP-09 for browser evidence). Operator-run acceptance of journey steps 1–12 on
  the current build; delivery states recorded separately (PR_OPEN → MERGED → DEPLOYED → LIVE_VERIFIED).

<a id="wp-13"></a>
## WP-13 — Collector privacy defects (VERIFIED_DEFECT_REPAIR) — first implementation-ready package
- **Problem / evidence**:
  - MC-P8: `describeClick` label falls back to the `value` attribute; React 18 reflects controlled values; probe P-01
    confirmed on the shipped function ([globalClickCapture.ts L126-L148](https://github.com/dekarita/supreme-lamp/blob/823bcb6e94df8117a2f43d491a73e60265a968a1/src/lib/globalClickCapture.ts#L126-L148)).
  - MC-P11: raw `location.hash` in `params.route` (L100-L107, L342), Click-now `result.route`/verdict
    ([collectorAgent.ts L1433-L1449](https://github.com/dekarita/supreme-lamp/blob/823bcb6e94df8117a2f43d491a73e60265a968a1/src/lib/collectorAgent.ts#L1433-L1449)), `describeEffects` "route →" (L1215).
  - MC-P12: raw `request.url` (incl. `?key=`) and 2000-char bodies stored (L541-L561); `instrumentButton` may persist a
    background poll (only `probe` filtered, L805).
  - MC-P13: `button-actions.json` exports raw rows ([Collector.tsx L269-L283](https://github.com/dekarita/supreme-lamp/blob/823bcb6e94df8117a2f43d491a73e60265a968a1/src/pages/Collector.tsx#L269-L283)); `maskHeaders` stores `sha=<FNV-1a>` of token values (L459-L475).
- **Reusable**: `sanitizeBoundaryRoute`, `safeRoute`, `stripUrl` (existing, tested sanitizers).
- **Required behaviour**: never read `value` in `describeClick`; sanitize every route string before it enters a row;
  store URLs path-only; drop header fingerprints; bodies only as allow-listed fields; redaction pass on hydration of
  existing rows (one-time, idempotent) and before `button-actions.json`.
- **Scope**: `src/lib/globalClickCapture.ts`, `src/lib/collectorAgent.ts`, `src/pages/Collector.tsx` (export only).
  **Exclusions**: attribution changes (WP-06), UI redesign (WP-07), server.
- **Dependencies**: none (rationale: uses existing sanitizers; WP-04 later generalizes them).
- **Schema / migration**: no new fields required; hydration pass rewrites `params.route`, `request.url`,
  `request.headers`, bodies in place; old rows remain renderable.
- **Privacy/security impact**: removes credential exposure paths; no new data collected.
- **Tests**: F-13 unit + jsdom (synthetic token in `?key=`, `#/x?key=`, `Authorization`, controlled password input);
  falsifiers: restore each removed path → its test reddens; F104/F-DVR/F102 gates updated in place (rewrite pins,
  never delete), e.g. F104-h extended to `currentRoute`.
- **Acceptance**: no synthetic secret in localStorage, DVR ring, `.mcrec` v1/v2, `button-actions.json`; existing gates
  green; row counts unchanged. **Rollback**: revert commit (hydration pass is lossy by design — document that
  reverted builds keep redacted rows).
- **Operator actions**: none. **Effort**: 1 session (uncertainty: number of pins to rewrite in f104/f102/f-dvr).
- **Execution brief**: "Implement WP-13 on the session branch. Read docs/mission-control/WORK-PACKAGES.md#wp-13 and
  CONTROL-CENSUS §B. Change only globalClickCapture.ts, collectorAgent.ts and Collector.tsx's actions export. Reuse
  sanitizeBoundaryRoute/safeRoute/stripUrl. Add tests that execute the shipped code with synthetic secrets and prove
  each falsifier reddens. Do not change capture scope, attribution, server code, workflows or dependencies. Report
  static, controlled-behaviour and (if the lane works) browser results separately."

<a id="wp-14"></a>
## WP-14 — Diagnostic truthfulness and safety defects (VERIFIED_DEFECT_REPAIR)
- **Problem / evidence**: MC-P14 (`runDiag` relative `/diag`, HTTP errors shown as "not reachable",
  [sessionStore.ts L155-L178](https://github.com/dekarita/supreme-lamp/blob/823bcb6e94df8117a2f43d491a73e60265a968a1/src/stores/sessionStore.ts#L155-L178)); MC-P15 (batch real clicks include 9 mutating targets
  without confirmation); MC-P16 (`.rdp` `ok:true` regardless of popup result; reconnect logs only `requested`;
  Watcher chip `!!mirror` ignores heartbeat age, [AppShell.tsx L81](https://github.com/dekarita/supreme-lamp/blob/823bcb6e94df8117a2f43d491a73e60265a968a1/src/components/layout/AppShell.tsx#L81)); MC-P18 (closed drawer focusable).
- **Required**: `runDiag` via `apiBase()` with status-classified messages; batch/replay skip `mutating` (and
  `collector-run`) unless the operator confirms each effect class; `.rdp` result reflects `window.open` return value;
  reconnect row updated with the observed WS outcome within the ladder window; watcher chip from heartbeat age with
  `stale`; drawer `inert` when closed.
- **Scope**: `sessionStore.ts`, `collectorAgent.ts` (batch filter), `Collector.tsx` (confirmation), `Connections.tsx`,
  `AppShell.tsx`, `DiagSideDrawer.tsx`. **Dependencies**: none. **Tests**: P-05, P-06, F-15, F-16.
- **Acceptance**: each defect has a reddening falsifier; F102 e2e expectations updated in place for the new
  confirmation step. **Rollback**: per-file revert. **Effort**: 1–1.5 sessions.
- **Execution brief**: "Implement WP-14 per WORK-PACKAGES.md#wp-14; one commit per defect; keep test ids; update pins in
  place; no server/workflow/dependency changes."
