# GHRDP Mission Control — Integrated Diagnostics and Verification Master Plan

Status: **PLAN ONLY** (documentation artifact). Nothing in this document is a shipped feature.
Branch: `arena/2adce58c-supreme-lamp` (session-fixed). Base: `main` @ `823bcb6e94df8117a2f43d491a73e60265a968a1`.
Companion files: `docs/MISSION-CONTROL-COVERAGE-MATRIX.md` (feature/control coverage and denominators).
Parent tracking issue: see the Links section at the end of this file (filled after issue publication).

Privacy: this document contains no tokens, cookies, keys, private hostnames, personal filenames, conversation
identifiers or raw audit text. Tailnet addresses, repository-owned file paths and public run IDs are the only
concrete identifiers, and they are project metadata.

---

## 1. Present-state model

### 1.1 Checkpoint (refreshed 2026-10-09, verified with `gh`)

| Fact | Evidence (verified this session) |
|---|---|
| PR #188 MERGED (M8 cancellation-safe status.json finalizer, PROB-004) | `gh pr view 188` → `mergedAt 2026-10-09T04:08:11Z` |
| PR #189 MERGED (M8 follow-up: behavioral verification + finalization hardening, PROB-004/RC-02) | `gh pr view 189` → merge commit `823bcb6e94df8117a2f43d491a73e60265a968a1`, `mergedAt 2026-10-09T07:21:23Z` |
| Merge-SHA check runs on `823bcb6` | `gates` success · `proof` success · `windows-native` success · **`e2e-ui` cancelled** |
| Local branch HEAD before this change | `823bcb6` (clean working tree) |
| Issue #163 (Mission Control UI inventory) | CLOSED — historical, not reopened |
| Issue #165 (Observatory 10-step roadmap) | CLOSED — historical, not reopened |
| Issue #181 (F110c patch emitter — `/ws` has no patch broadcaster) | OPEN, real defect/work item |
| Issues #153 and #156 (both titled "F99: 5 confirmed root causes …") | OPEN, identical titles → **potential duplicates, reconciliation required, neither closed here** |
| Open PRs | 25 open PRs, most from the older F-series (2026-09 era); none is a Mission Control diagnostics PR |
| No active Mission Control parent roadmap issue exists | `gh search issues` on "Mission Control" returns only #163/#165 (closed) and #153/#156 (F99) |

### 1.2 Operator-confirmed configuration (OPERATOR_CONFIRMED_CONFIGURATION)

The operator states that required secrets have been created and saved and that most operator-side setup
is complete. This is recorded as **operator-confirmed**. It is **not** independently re-verified here:

- Presence of configuration *bindings* (names only) was not re-inspected in this session.
- Successful *use* of those bindings in a production run is **not demonstrated** by any tracked evidence.
- No independent configuration failure has been demonstrated.

The operator is **not** asked to re-create secrets. Operator action is requested only where a specific
observation below requires it (see §10).

### 1.3 Source reading status

| Source group | Status | Notes |
|---|---|---|
| `STATE.md` (60-line contract, `tests/f53-content-length.test.js`) | PARTIALLY_READ | Head and queue read; long rows not fully read |
| `docs/OBSERVATORY-STATE.md` (2082 lines, append-only) | PARTIALLY_READ | Headers, §OPERATOR-ASSERTIONS, last rows read |
| `docs/M8-LIVE-VERIFICATION.md` | READ | Full runbook sections 0–4 read (sections 3–4 partially) |
| `SESSION_HANDOFF_PROMPT.md` | READ (partial) | Stale: names `main == c6de5447` (#188 merge) while main is `823bcb6` (#189) |
| `PROJECT-CONTEXT-v2-CANONICAL.md` | PARTIALLY_READ | Section 6 locked rules head read |
| `src/App.tsx` (159 lines) | READ | 14 `<Route>` entries (13 concrete + `*`) |
| `src/lib/feature-registry.json` | READ | 11 features, fields: id, order, route, routeKind, component, navKey, owns, dependsOn, navigatesTo, stores, endpoints |
| `tests/f111-ci-inventory.test.js` header | PARTIALLY_READ | Gate purpose + falsification notes |
| `.github/workflows/*.yml` (15 files) | MISSING from detailed read | Only names + `main.yml` status.json grep read |
| `worker.js` (Cloudflare Worker) | NOT_READ | CORS origin noted in OBSERVATORY-STATE only |
| `src/components/**` (dvr, explorer, lab, livePatch, primitives, search, domain, layout) | NOT_READ | Listed only |
| `src/components/primitives/FeatureBoundary.tsx`, `ChromeBoundary.tsx` | NOT_READ | Named in App.tsx call sites only |
| `src/components/DebugHUD.tsx`, `src/lib/debugHud*.js` | NOT_READ | Named only |
| `src/lib/collectorAgent.ts`, `globalClickCapture.ts`, `launchUrl.ts`, `dashToken.ts`, `api.ts` | NOT_READ | Named only |
| `src/lib/dvr/*`, `src/replay/*`, `src/lib/livePatch/*` | NOT_READ | Named only |
| `payloads/*.ps1`, `payloads/*.cs` (PowerShell server/watcher/launcher) | NOT_READ | Named only |
| `tests/**` (125 files) | PARTIALLY_READ | File list + the f111 and f53 gate tests executed |
| `src/tests/smoke/**` (81), `tests/e2e/**` | NOT_READ | Counted only |
| `docs/status.json` (tracked snapshot) | READ | `ts 2026-10-07T13:19:42Z`, `runId 37623514721`, `runStatus in_progress`, no `runAttempt`/`finalizeReason` → stale tracked snapshot |
| `docs/MIGRATION.md`, `docs/AUTOLOGIN.md`, `docs/F60-OPERATOR-SETUP.md`, others | NOT_READ | Listed only |

Local execution: `node --test tests/f53-content-length.test.js tests/f111-ci-inventory.test.js tests/m4-drift-fixed.test.js`
→ **17 pass / 0 fail** (static gate tests; not runtime evidence).

Every NOT_READ/PARTIALLY_READ group is a named continuation item in §12 (Deferred inputs).

### 1.4 Separate views (not collapsed into one status)

**A. Implementation state**

| Capability | State | Evidence |
|---|---|---|
| Mission Control SPA shell, 13 concrete routes + fallback | PRESENT | `src/App.tsx` |
| Feature registry (11 features) | PRESENT | `src/lib/feature-registry.json`, #165 history |
| FeatureBoundary / ChromeBoundary wrappers | PRESENT (static) | Used in `App.tsx`; internals NOT_READ |
| F111 CI inventory gate | PRESENT, static tests pass locally | `tests/f111-ci-inventory.test.js` 17/17 with siblings |
| M8 status finalizer (main.yml step + behavioral harness) | PRESENT in source | #188, #189 merged |
| Debug HUD, Collector, DVR, replay, Live Patch | PRESENT per OBSERVATORY-STATE history | Internals NOT_READ |
| Live Patch patch **emitter** (`/ws` broadcaster) | ABSENT / BROKEN | #181 open; F110b verifier has nothing to verify |
| Unified diagnostic event contract | ABSENT | No such schema found in the parts read |
| Dependency-health probe model for Mission Control | ABSENT | No such module found in the parts read |
| Embedded diagnostics UX (global health, per-feature entry) | ABSENT | Not found in App.tsx routes |
| Troubleshooting guide for operator | ABSENT | This plan proposes it (WP-11) |

**B. Verification state**

| Item | State |
|---|---|
| M8 finalizer | **Static + structural + native harness on PR head** (windows-native green on #189); **not live-verified** (`docs/M8-LIVE-VERIFICATION.md` status: NOT RUN) |
| Plan documents (this PR) | **Static only** (no test covers them beyond existing gates) |
| Feature registry | Static gate tests pass; runtime not exercised in this session |
| e2e-ui lane | **Not verified** on merge SHA (`cancelled`) |

**C. Runtime observation**

| Surface | Observation | Classification |
|---|---|---|
| Tracked `docs/status.json` | `in_progress` from 2026-10-07, run `37623514721` | **STALE** (no finalizer evidence; M8 live run not performed) |
| Live Mission Control / Pages served state | Not probed in this session (read-only probe not authorized as part of planning without need) | UNKNOWN |
| Pages deployment | Previously observed as not serving the site (OBSERVATORY-STATE §OPERATOR-ASSERTIONS, 2026-10-07 measurements); not re-measured today | UNKNOWN (historical) |

**D. Delivery state**

| Item | State |
|---|---|
| M8 finalizer and follow-up | MERGED (#188, #189) — live acceptance: BLOCKED on operator dispatch (runbook) |
| F110c patch emitter (#181) | OPEN — PLANNED (WP-08) |
| #153 / #156 reconciliation | OPEN — READY for reconciliation decision |
| Mission Control diagnostics roadmap (this plan) | PLANNED; documentation PR open on this branch |

### 1.5 Known problems (evidence-classified)

| ID | Severity | Evidence | Confidence | Current disposition | Proposed next action |
|---|---|---|---|---|---|
| MC-P1 | High | Gap: `/ws` has no patch broadcaster, so F110b verifier verifies nothing (#181) | High (issue text; source not re-read) | OPEN #181 | WP-08: re-read emitter path, then repair in a separate implementation session |
| MC-P2 | Medium | #153 and #156 have identical titles and overlap scope | High (metadata) | OPEN both | Operator decides which to keep; reconcile in WP-02 |
| MC-P3 | Medium | `e2e-ui` **cancelled** on merge SHA `823bcb6` | High (check-run conclusion); cause UNKNOWN | Not dismissed; not diagnosed | WP-09: read the run log, classify (manual cancel / timeout / concurrency / failure) |
| MC-P4 | Medium | Tracked `docs/status.json` stale (`in_progress`, 2026-10-07) | High | Expected until a live M8 run; not a finalizer defect | WP-01 (operator-controlled live run) |
| MC-P5 | Low | `SESSION_HANDOFF_PROMPT.md` names `main == c6de5447` (#188 merge) while main is `823bcb6` | High | Stale handoff | WP-00 documentation correction (in this PR, only as a pointer) |
| MC-P6 | Unknown | Actual runtime diagnostic coverage in the SPA | Not measured | — | WP-03 catalog + WP-05 probes |

---

## 2. Architecture and data flow

```
 Operator browser (Mission Control SPA, served via RDP-side origin)
 ┌────────────────────────────────────────────────────────────────────────┐
 │ App.tsx routes ─ FeatureBoundary / ChromeBoundary ─ feature-registry   │
 │   │ UI intent (click / submit / keyboard)                              │
 │   ▼                                                                    │
 │ globalClickCapture / collectorAgent (existing capture)  ──┐            │
 │ DebugHUD (existing)                                       │ sanitized  │
 │ stores (zustand) + IndexedDB ghrdp-dvr (existing DVR)     ▼ local ring │
 │   │ authenticated request (dash token, existing resolver)               │
 └───┼────────────────────────────────────────────────────────────────────┘
     ▼
 Worker (worker.js, Cloudflare)  ──  CORS origin allowlist (existing)
     ▼
 PowerShell server / watcher (payloads/*.ps1, existing status writers)
     │  ├─ Launcher queue (existing: C:\ProgramData\ghrdp\launcher-queue)
     │  ├─ Mirror/upload pipeline (existing)
     │  └─ docs/status.json writer (M8 finalizer, existing)
     ▼
 Windows operations (file ops, browser launch, RDP session, Tailscale)
     ▼
 GitHub: main.yml / pages / issues (tracking; NOT a runtime channel)
```

Proposed additions (planning only; each must justify itself in its work package):

- A **diagnostic event contract** (schema + pure core), reusing the existing collector/DVR for storage.
- A **dependency-health read model** that aggregates existing read-only status endpoints (no new routes until
  WP-05 proves an existing route is insufficient).
- A **diagnostics panel** that reads the above, rendered inside existing boundaries.

No new bus, collector, registry, status writer or database is proposed. Those already exist in some form.

---

## 3. Feature and control coverage (summary)

Full matrix: `docs/MISSION-CONTROL-COVERAGE-MATRIX.md`.

Denominator used (explicit, current, static):
- **11** feature-registry entries (`src/lib/feature-registry.json`).
- **13** concrete routes in `src/App.tsx` (plus `*` fallback), including `/lab/:featureId` and `/search/lab/:targetId`.
- **Not counted** (not inventoried in this session): individual buttons, forms, menus, keyboard commands,
  dynamic control families inside components (NOT_READ).

Result: 11/11 registry features are mapped to a plan row. **0/11** have measured runtime diagnostic coverage.
**Runtime control coverage: UNKNOWN** (the control-level inventory is not yet derived).
This is NOT a "100% coverage" claim.

---

## 4. Diagnostic UX (target behavior)

Design goals (from the operator requirements) — each is a testable requirement, not a promise to detect every bug:

1. Global health summary: derived from the dependency-health model; shows `healthy / degraded / failed / stale /
   unknown / unreachable`, never a single green checkbox.
2. Contextual diagnostics entry beside each feature (via existing FeatureBoundary header slot — to verify).
3. Action outcome panel: attempted action → receiving component → where it stopped → observed effect → evidence → hypotheses.
4. Chronological, correlated timeline (correlation ID per user action).
5. Guided investigation: a fixed checklist driven by the failure class, with safe next steps only.
6. Safe evidence export: redacted, bounded, local download only. **No automatic upload or AI submission.**
7. Links to the GitHub work item tracking an unresolved defect (from the known-problems registry).
8. Explicit missing/stale/unknown evidence labels on every card.
9. Recovery text appropriate to the operator (plain language; technical trace in an expandable view).
10. Graceful degradation: if the backend or network diagnostics are unavailable, the local panel still renders and
    says which evidence is unavailable.

Preserved constraints: existing styling and tokens, bilingual EN/SI parity (`src/i18n/*.json`, existing parity test),
keyboard navigation, accessibility, and all existing feature contracts.

---

## 5. Event, identity and redaction contract (planned, WP-04)

Fields are justified only where an existing architecture point needs them:

| Field | Justification | Source |
|---|---|---|
| `schemaVersion`, `buildSha` | Attribute evidence to the build (answers "verified on the current build?") | Build metadata |
| `correlationId` (per user action) | Join UI click → request → server receipt → effect | Generated client-side |
| `parentId` | Nested operations (e.g. queue → launcher job) | Caller |
| `featureId`, `controlId`, `actionId` | Map to registry and coverage matrix | Feature registry |
| `component`, `operation` | Where it stopped | Code constants |
| `startedAt` (wall), `durationMs` (monotonic) | Timeline and latency; monotonic for duration | Client/server |
| `expected`, `observed`, `outcome` | Separates intent from effect; HTTP 200 ≠ effect | Handler + effect probe |
| `errorCategory`, `errorCode` | Stable grouping | Enumerated constants |
| `evidenceRefs[]` | Bounded references (not raw bodies) | Probe results |
| `retryState`, `cancelState` | Monotonic terminal state | Caller |
| `redaction` | `none \| partial \| full`, enforced before storage | Redaction core |
| `issueRef` | Link to tracking issue when known | Known-problems registry |

Rules: no keystrokes, passwords, tokens, cookies, personal content or unbounded bodies. Duplicate suppression by a
safe technical fingerprint (category + component + normalized code), with first/last seen, count, affected build,
and recurrence kept. Failures are never silently removed to improve a health score.

Channels: the plan reuses existing supported channels only (in-app collector/DVR, existing read-only status
surfaces, existing launcher heartbeat/queue files where already produced). **No new routes are proposed**, and retired
diagnostic/control endpoints stay retired.

---

## 6. Probe classification

| Class | Meaning | Examples in this plan |
|---|---|---|
| READ_ONLY | No meaningful side effect | Read `docs/status.json`, read health endpoints, read registry |
| SYNTHETIC | Controlled fixture/lab, isolated | Noop launcher job in lab; fixture upload to test root |
| SIDE_EFFECTING | Changes app state; needs explicit user action | Queueing a real download/mirror |
| OPERATOR_CONTROLLED | Production dispatch/cancel, credential lifecycle, deploy | M8 live run; any `main.yml` dispatch/cancel |

Startup checks: bounded (≤ 2 s each, ≤ 5 probes at load, read-only only), no file upload, deletion or movement,
no workflow dispatch, no key rotation, no AI/external submission.

---

## 7. Root-cause investigation registry (summary)

| ID | Question | Status | Discriminating observation needed |
|---|---|---|---|
| RC-MC-01 | Why does F110b verify nothing? | Hypothesis: no emitter on `/ws` (#181) | Read emitter code path; observe zero broadcast messages in a synthetic session |
| RC-MC-02 | Why was e2e-ui cancelled on `823bcb6`? | UNKNOWN | Read run log: manual cancel vs timeout vs concurrency cancel |
| RC-MC-03 | Is the M8 finalizer correct in production? | UNKNOWN (not run) | Operator-controlled live run per runbook stages A–D |
| RC-MC-04 | Why is the tracked status snapshot stale? | Expected: no live finalizer run since 2026-10-07 | Compare with run history after the M8 live run |

Rule: correlation, an old error string, or missing data is **not** a confirmed root cause.

---

## 8. Phased roadmap

Coverage areas A–L from the requirement are collapsed where already satisfied.

| Step | Purpose | State | Dependency | Acceptance | Evidence | Issue/PR | Next action |
|---|---|---|---|---|---|---|---|
| WP-00 | Reconciliation + plan docs | IN_PROGRESS → PR_OPEN (this PR) | none | Plan + coverage matrix + ledger pointer merged by review | This file | Docs PR (see Links) | Operator review |
| WP-01 | M8 live acceptance | BLOCKED (operator dispatch) | WP-00 review; no important run in flight | Runbook stages A–D recorded independently | `docs/M8-LIVE-VERIFICATION.md` | #188, #189 | Operator runs runbook when ready |
| WP-02 | Reconcile #153/#156 duplicates; relate #181 | READY (decision needed) | none | One canonical F99 issue; other closed with reason | Issue metadata | #153, #156, #181 | Operator chooses canonical issue |
| WP-03 | Derived feature/control catalog + coverage gate | READY — **first implementation step** | WP-00 | Catalog derived from source; gate fails on undeclared route/feature; counts = denominator | Gate test results | TBD child issue | Create child issue after review |
| WP-04 | Event contract + redaction core (pure, tested) | PLANNED | WP-03 | Schema validated; redaction tests incl. secret fixtures; negative tests | Unit tests | TBD | After WP-03 |
| WP-05 | Read-only dependency-health model + bounded startup probes | PLANNED | WP-04 | Each probe has timeout/budget; stale/unknown rendered distinctly | Unit + integration with mock | TBD | After WP-04 |
| WP-06 | Action trace capture (reuse collector/globalClickCapture) | PLANNED | WP-04 | Duplicate suppression; no recursive capture; no keystrokes | Browser tests | TBD | After WP-04 |
| WP-07 | Embedded diagnostics panel (global summary + per-feature entry) | PLANNED | WP-05, WP-06 | Real controls tested; EN/SI parity; keyboard; degraded-backend mode | Browser E2E | TBD | After WP-05/06 |
| WP-08 | F110c patch emitter (#181) | BLOCKED on source re-read | WP-03 for scope | Emitter produces verifiable patches on synthetic session | Native + unit | #181 | Re-read emitter before estimating |
| WP-09 | e2e-ui lane investigation | READY (read-only) | none | Cancellation cause classified with evidence | Run log | none yet | Read run log |
| WP-10 | Sanitized evidence export | PLANNED | WP-04 | Export excludes secrets by test; bounded size | Unit + negative tests | TBD | After WP-04 |
| WP-11 | Troubleshooting guide + guided flow | PLANNED | WP-07 | Every failure class in registry has a documented safe next step | Doc gate | `docs/MISSION-CONTROL-TROUBLESHOOTING.md` (not yet created) | After WP-07 |
| WP-12 | Live acceptance + rollout | BLOCKED | WP-01…WP-11 | Operator acceptance on the current build | Runbook record | TBD | Operator |

Effort ranges are intentionally omitted until WP-03 measures the real control denominator.

### 8.1 First actionable package: WP-03

- **Problem**: no machine-derived control inventory exists for the SPA; coverage cannot be measured honestly.
- **Target behavior**: a read-only derivation of routes, registry features, and control families, diffed against a
  declared catalog, with a gate that fails when an undeclared route or feature appears (same pattern as F111).
- **In scope**: catalog JSON, pure derivation core, gate test. **Out of scope**: runtime probes, UI changes,
  workflow changes, new routes.
- **Reuse**: F111 inventory pattern (`src/lib/ci/inventoryCore.js` style), `feature-registry.json`.
- **Tests**: positive (current tree passes), negative (added undeclared route fails), mutation (deleting a declared
  feature fails).
- **Rollback**: remove the catalog and gate test.
- **Operator actions**: none.

### 8.2 Execution briefs (copy-ready, for a later implementation session — NOT executed in this task)

**WP-03 brief:** "On branch `arena/<session>`, add a read-only catalog generator and gate for the Mission Control SPA routes and feature-registry entries. Derive routes from `src/App.tsx` and features from `src/lib/feature-registry.json`; compare with `docs/mission-control-catalog.json`; fail `node --test` on undeclared or removed entries. Do not change runtime code, workflows, or dependencies. Report counts with denominator."

**WP-09 brief:** "Read-only: fetch the `e2e-ui` job log for merge SHA `823bcb6e94df8117a2f43d491a73e60265a968a1` and classify the cancellation cause. Do not re-run or cancel workflows. Record the sanitized classification in `docs/OBSERVATORY-STATE.md` as an append-only entry."

Briefs for WP-04 to WP-12 are written when each predecessor is accepted (avoids spending budget on briefs that
will change).

---

## 9. Test and acceptance strategy

- Static and unit: existing `node --test tests/*.test.js` (gates), plus new contract tests per WP.
- Negative and mutation tests: each new gate must be shown to fail on a deliberately broken variant, then reverted.
- Browser: real control clicks in Playwright (existing `playwright*.config.ts`). The e2e-ui lane must be understood
  (WP-09) before its result is used as evidence.
- Native: PowerShell behavioral harness (M8 pattern: execute, don't just grep structure).
- Live: operator-controlled only (WP-01, WP-12).
- Separate reporting: PR-head CI, merge-SHA CI, deployment checks, live acceptance. Never merge them into one status.
- Coverage is reported only against an explicit denominator (§3). "Not measured" is a valid result.

---

## 10. Operator actions (only where evidence requires them)

| Action | Why it is needed | Exact smallest step | Requested now? |
|---|---|---|---|
| Choose canonical F99 issue (#153 or #156) | Identical titles; duplicate tracking | Reply with the number to keep | Yes, decision |
| Run M8 live verification (WP-01) | Live acceptance is NOT RUN | Follow `docs/M8-LIVE-VERIFICATION.md` §0–§2 with one controlled run, only when no important run is in flight | Deferred until plan review |
| Confirm e2e-ui cancellation cause | Cancelled lane; cause unknown | Only if the agent's read-only log check (WP-09) cannot determine it | Not yet |

No secret re-creation or setup repeat is requested.

---

## 11. Security, privacy, performance, rollout and rollback

- **Security/privacy**: redaction before storage; no secret values read or printed; no raw bodies; no external
  submission; no AI submission of raw diagnostics. Existing auth (dash token resolver), NLA and CORS allowlist unchanged.
- **Performance**: diagnostic capture is a bounded ring (size and count caps defined in WP-04); probes are bounded
  per §6; no polling loop faster than existing dashboard polling.
- **Free-tier / $0**: no new paid service; no new dependency proposed in this plan.
- **Rollout**: each WP ships behind its own gate; no flag removes existing behavior.
- **Rollback**: each WP is revertible by reverting its own commits; existing ledgers keep their schema.

---

## 12. Deferred and missing inputs (explicit)

- Full read of `src/components/**`, `src/lib/**` (collector, HUD, DVR, live patch, launchUrl), `payloads/**`,
  `worker.js`, `.github/workflows/**` (except `main.yml` status.json lines), `tests/e2e/**`, `src/tests/**`.
  Next step: WP-03 derivation reads these as inputs; WP-03 records each as READ/PARTIAL/NOT_READ.
- Live runtime probing of Mission Control, Pages and the watcher: not performed (planning does not require it).
  Next step: WP-01 (operator-controlled) and WP-05 (read-only probes).
- Full issue/PR history beyond the open list and the named issues (#153, #156, #163, #165, #181). Next step: WP-02.
- The `e2e-ui` cancellation cause (RC-MC-02). Next step: WP-09.
- Full control-level inventory (buttons, forms, menus, keyboard commands): not derived. Next step: WP-03.

---

## 13. Decisions and tradeoffs

| Decision | Rationale | Consequences | Revisit trigger |
|---|---|---|---|
| Parent is a single planning issue, child issues created after review | Avoid issue proliferation before the operator approves scope | Child links appear later | Operator approval of WP order |
| No new routes; reuse existing channels | Retired endpoints must stay retired; M8 lessons | Some diagnostics depend on existing read paths | WP-05 proves insufficiency |
| Plan doc in `docs/`; ledger pointer in append-only `OBSERVATORY-STATE.md` | `STATE.md` is locked at 60 lines by `tests/f53-content-length.test.js` | Pointer lives in history, not the core ledger | Ledger schema migration |
| #153/#156 not closed here | Scope and authorization unclear | Duplicate remains until decision | Operator reply |
| e2e-ui not dismissed | Lane is part of Mission Control confidence | WP-09 added | RC-MC-02 classified |

---

## 14. Recent changes (append-only)

- 2026-10-09: Initial plan. Verified #188/#189 merged, merge SHA `823bcb6`, merge-SHA checks as §1.1, local
  static gates 17/17 pass. Created this plan and the coverage matrix. Application code unchanged.

## 15. Sanitized planning handoff

Next session starts at WP-03 (if approved) on the session branch. Read this file, the coverage matrix, and
`docs/M8-LIVE-VERIFICATION.md` first. Do not re-run the M8 live run unless the operator dispatches it. Do not close
#153/#156 without a decision. Do not treat OPERATOR_CONFIRMED_CONFIGURATION as independently verified.

---

## Links

- Coverage matrix: `docs/MISSION-CONTROL-COVERAGE-MATRIX.md`
- M8 runbook: `docs/M8-LIVE-VERIFICATION.md`
- Observatory history (append-only): `docs/OBSERVATORY-STATE.md`
- Ledger: `STATE.md` (pointer intentionally not added — locked to 60 lines; see §13)
- Parent tracking issue: https://github.com/dekarita/supreme-lamp/issues/191 (docs PR #190)
- Child issues: none created yet (WP-03 first, after review)
- Planned, not yet written: `docs/MISSION-CONTROL-DIAGNOSTICS-SPEC.md`, `docs/MISSION-CONTROL-ACCEPTANCE-PLAN.md`, `docs/MISSION-CONTROL-TROUBLESHOOTING.md` (WP-04/WP-11 deliverables; intentionally not created to avoid unverified duplication)

Final status: `mode=PLAN_ONLY; status=PLAN_PARTIAL; application_changes=NONE;`
