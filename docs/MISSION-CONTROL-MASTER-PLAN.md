# GHRDP Mission Control — Integrated Diagnostics and Verification Master Plan

Status: **PLAN ONLY — PLAN_PARTIAL** (documentation artifact; nothing here is a shipped feature).
Version: **v2** (2026-10-09, F-OBSERVATORY v20 research session) on top of v1 (PR #190 @ `9aa6051`).
Branches: v1 `arena/2adce58c-supreme-lamp` (PR #190); v2 continuation `arena/b7f4c19a-supreme-lamp` (contains v1's commits).
Source researched: `823bcb6e94df8117a2f43d491a73e60265a968a1`; `main` is now `580f231` (adds only `docs/status.json`).
Parent issue: [#191](https://github.com/dekarita/supreme-lamp/issues/191).

Privacy: no tokens, cookies, keys, private hostnames, personal filenames, conversation identifiers or raw audit text.
The attached audit file named in the session prompt was not present in the workspace; nothing from it is used.

## Document map

| Artifact | Purpose |
|---|---|
| this file | hub: state, roadmap summary, problems, decisions |
| [MISSION-CONTROL-COVERAGE-MATRIX.md](MISSION-CONTROL-COVERAGE-MATRIX.md) | denominators and coverage by verification class |
| [mission-control/CORRECTION-LEDGER.md](mission-control/CORRECTION-LEDGER.md) | v1 claim → evidence → corrected classification |
| [mission-control/SOURCE-RESEARCH-LEDGER.md](mission-control/SOURCE-RESEARCH-LEDGER.md) | exact read ranges, findings, next reads |
| [mission-control/CONTROL-CENSUS.md](mission-control/CONTROL-CENSUS.md) | control/action census v1 (301 static DOM control sites) |
| [mission-control/CAPABILITY-REUSE-MATRIX.md](mission-control/CAPABILITY-REUSE-MATRIX.md) | existing primitives and reuse decisions |
| [mission-control/ARCHITECTURE.md](mission-control/ARCHITECTURE.md) | actual channels and data flow |
| [MISSION-CONTROL-DIAGNOSTICS-SPEC.md](MISSION-CONTROL-DIAGNOSTICS-SPEC.md) | UX (Part A) + event/probe/redaction (Part B) |
| [MISSION-CONTROL-TROUBLESHOOTING.md](MISSION-CONTROL-TROUBLESHOOTING.md) | symptoms, domains, problem registry MC-P1…P23 |
| [MISSION-CONTROL-ACCEPTANCE-PLAN.md](MISSION-CONTROL-ACCEPTANCE-PLAN.md) | verification classes, fault-injection cases, probes |
| [mission-control/WORK-PACKAGES.md](mission-control/WORK-PACKAGES.md) | WP-00…WP-14 specs, dependency graph, briefs |
| [mission-control/ISSUE-RECONCILIATION.md](mission-control/ISSUE-RECONCILIATION.md) | #153/#156/#154/#155, #181, #191 |
| [mission-control/HANDOFF.md](mission-control/HANDOFF.md) | sanitized continuation |

---

## 1. Present-state model

### 1.1 Checkpoint (refreshed 2026-10-09 ~08:30Z with `gh`, read-only)

| Fact | Evidence |
|---|---|
| PR #188, #189 MERGED; #189 merge commit `823bcb6` | v1 checkpoint, unchanged |
| PR #190 OPEN at `9aa6051` | `gh pr view 190` |
| `main` = `580f231` "chore: initial status.json [skip ci]" (08:17:26Z) | `git ls-remote`, commits API |
| `main.yml` run [37903915039](https://github.com/dekarita/supreme-lamp/actions/runs/37903915039): `workflow_dispatch` by the operator on `823bcb6`, attempt 1, **in progress** (step 59 keep-alive; step 67 M8 finalizer pending) | runs/jobs API |
| `docs/status.json` on main: `runId 37903915039`, `runAttempt 1`, `runStatus in_progress`; sensitive-named fields present but empty | contents API (identity fields only) |
| `e2e-ui`: 0 successes in the latest 100 runs (92 cancelled at the 25-min job cap, 8 failure); last success 2026-10-05 | workflow runs API, job annotations |
| #153, #156, #181 OPEN, 0 comments each; PR #155 merged (F99), PR #154 open ("Closes #153") | issues/PR API |

### 1.2 Operator-confirmed configuration (OPERATOR_CONFIRMED_CONFIGURATION)

| Layer | State |
|---|---|
| Configuration reported complete | yes (operator statement) |
| Binding names/presence observed | indirectly: run 37903915039 passed "Validate required secret (RENTRY_EDIT_PASSWORD) - fail fast", "Tailscale up (TS_AUTHKEY fail-closed …)", "Optional Funnel ACL via TS_API_KEY" (step conclusions only) |
| Successful use observed | Tailscale connected, RDP listener self-probe, initial status commit (step conclusions / commit) |
| Concrete configuration failure demonstrated | **none** |

### 1.3 Source reading status

Moved to the revision-aware [SOURCE_RESEARCH_LEDGER](mission-control/SOURCE-RESEARCH-LEDGER.md). Summary: R2
(Collector/capture) and the diagnostic drawers **READ in depth**; R3 boundaries/DVR-lite READ, DVR-full/HUD/Lab
partial or unread; R4 API/token/session store READ, polling partial; R5–R7 grep-level plus targeted workflow ranges;
R6 unread. **No full-repository review is claimed.**

### 1.4 Separate views

**A. Implementation state** (classification per [CAPABILITY-REUSE-MATRIX](mission-control/CAPABILITY-REUSE-MATRIX.md))

| Capability | v1 said | v2 (evidence) |
|---|---|---|
| SPA shell / routes | "13 concrete + fallback" | **EXISTS**: 16 `Route` = 1 layout + 14 navigable (12 literal + 2 parameterized) + 1 wildcard |
| Feature/chrome fences | PRESENT (static) | **EXISTS**: 11 feature fences (13 `fence()` calls) + 10 chrome surfaces |
| Action record schema | "event contract ABSENT" | **PARTIAL**: `ButtonAction` family exists, unevenly populated |
| Dependency probes | ABSENT | **PARTIAL**: `captureServiceStates()` (4 endpoints + WS), F96 glance, F92 self-test |
| Embedded diagnostics UX | ABSENT | **PARTIAL**: drawers, F96 card, top-bar chips, Health, Collector, HUD, DVR, boundary cards |
| Control inventory | none | **PARTIAL**: F-TESTID (addressability, 204 sites) + `KNOWN_BUTTONS` (18); census v1 measured 301 sites |
| Troubleshooting guide | ABSENT | **PARTIAL**: in-product copy-only guidance + this plan's matrix |
| Live Patch emitter | ABSENT/BROKEN | producer **VERIFIED_ABSENT** (grep scope), transport/verifier EXIST; optional |

**B. Verification state** — see [ACCEPTANCE-PLAN §1](MISSION-CONTROL-ACCEPTANCE-PLAN.md#1-current-verification-state-denominators-defined).
Static gates for this cluster: 106/106 pass (structural). Browser E2E: no passing evidence since 2026-10-05.

**C. Runtime observation** — M8: initial writer executed live (`runAttempt: 1`); finalizer LIVE_ACCEPTANCE_NOT_EVIDENCED
(run in progress). Pages served state: UNKNOWN (sandbox cannot reach github.io; CI step non-asserting, MC-P7).

**D. Delivery state** — see [WORK-PACKAGES summary](mission-control/WORK-PACKAGES.md#summary).

### 1.5 Known problems

Full registry with classes and next probes: [TROUBLESHOOTING §3](MISSION-CONTROL-TROUBLESHOOTING.md#3-problem-registry-root-cause-investigation).

| ID | Severity | Problem (short) | Class | WP |
|---|---|---|---|---|
| MC-P1 | Medium (optional feature) | no Live Patch producer on `/ws` | CONFIRMED | WP-08 / #181 |
| MC-P2 | Low | #153/#156 divergent bodies, same title | CONFIRMED | WP-02 |
| MC-P3 | High (verification) | e2e-ui 0/100, 25-min timeout | CONFIRMED class | WP-09 |
| MC-P4 | — | stale snapshot (v1) | SUPERSEDED by run 37903915039 | WP-01 |
| MC-P5 | Low | handoff names old main | CONFIRMED | WP-00 |
| MC-P6 | Medium | runtime diagnostic coverage | PARTIAL (census v1) | WP-03A |
| MC-P7 | Low | Pages verify non-asserting; stale remediation text | CONFIRMED | WP-05A |
| MC-P8 | **High (privacy)** | controlled password value captured as `label` | CONFIRMED mechanism | WP-13 |
| MC-P9 | High (truthfulness) | add-site row records follow-up GET; verdict ignores result | CONFIRMED | WP-06 |
| MC-P10 | Medium | global capture fan-out; status 0 = failure; constant duration | CONFIRMED | WP-06 |
| MC-P11 | High (privacy) | raw hash route persisted | CONFIRMED | WP-13 |
| MC-P12 | High (privacy) | raw URLs with `?key=` and bodies persisted; background polls as button request | CONFIRMED | WP-13 |
| MC-P13 | Medium (privacy) | raw `button-actions.json`; token fingerprints | CONFIRMED | WP-13 |
| MC-P14 | Medium | `/diag` drawer misclassifies failures | CONFIRMED | WP-14 |
| MC-P15 | High (safety) | batch clicks run 9 mutating targets unconfirmed | CONFIRMED | WP-14 |
| MC-P16 | Medium | success without effect (`.rdp`, reconnect, watcher chip) | CONFIRMED | WP-14 |
| MC-P17 | Low | F-TESTID apostrophe blind spot | CONFIRMED | WP-03B |
| MC-P18 | Low | closed drawer focusable | LIKELY | WP-14 |
| MC-P19 | Medium | pre-probes delay instrumented handler | CONFIRMED (impact HYPOTHESIS) | WP-06 |
| MC-P20 | Low | duplicate native-status pollers | CONFIRMED (intent unknown) | WP-06 |
| MC-P21 | High (security/product) | RDP identity split / password sync | decision pending | WP-02 |
| MC-P22 | Low | dead fetch-wrapper layers on overlap | LIKELY | WP-06 |
| MC-P23 | Low | registry `endpoints` incomplete | LIKELY | WP-03B |

---

## 2. Architecture and data flow

Replaced by [ARCHITECTURE.md](mission-control/ARCHITECTURE.md): the SPA talks to the runner's PowerShell server
directly (`apiBase()`); the Worker is a separate Pages-origin dispatch/cancel plane; status publication goes runner →
contents API → `main` → Pages workflow. v1's serial diagram is withdrawn (correction E1).

## 3. Feature and control coverage (summary)

Denominators (static, `823bcb6`): 11 registry features · 14 navigable route patterns · 10 chrome surfaces ·
**301 static DOM control call-sites** (42 in dynamic families, 60 conditional) · 12 global keyboard listeners ·
27 programmatic action sites. F104 capture eligibility: 235 self-eligible, 48 not, 18 ignored by design. Explicit
Collector instrumentation at the call-site: 3. Runtime diagnostic coverage per feature: NOT_MEASURED (0/11 measured).
Details: [coverage matrix](MISSION-CONTROL-COVERAGE-MATRIX.md), [census](mission-control/CONTROL-CENSUS.md).

## 4. Diagnostic UX (target behaviour)

Specified in [DIAGNOSTICS-SPEC Part A](MISSION-CONTROL-DIAGNOSTICS-SPEC.md#part-a--operator-experience): Summary chip
in `#topbarChips`, route-aware "Diagnose this page", `DiagSideDrawer` upgraded in place, 8-hop outcome ladder,
EN/SI state labels, inner static fallback so a failing backend or panel never blanks the explanation. v1's
"FeatureBoundary header slot" is withdrawn (no such slot; correction D1).

## 5. Event, identity and redaction contract

Specified in [DIAGNOSTICS-SPEC Part B](MISSION-CONTROL-DIAGNOSTICS-SPEC.md#part-b--event-probe-and-redaction-contract)
as an additive extension of `ButtonAction` (EXISTING → REQUIRED → DELTA), reusing `mintTraceId`,
`sanitizeBoundaryRoute`, `safeRoute`, `stripUrl`.

## 6. Probe classification

`READ_ONLY` / `SYNTHETIC` / `SIDE_EFFECTING` / `OPERATOR_CONTROLLED` with a catalog PR-01…PR-11 (spec §B.4).
Numeric budgets are **targets** justified by existing code timeouts (2.5 s, 3 s), not measurements (correction I5).

## 7. Root-cause investigation registry

Moved to [TROUBLESHOOTING §3](MISSION-CONTROL-TROUBLESHOOTING.md#3-problem-registry-root-cause-investigation).
v1 RC-MC-01 → MC-P1 (confirmed); RC-MC-02 → MC-P3 (timeout class confirmed); RC-MC-03 → WP-01 (in progress);
RC-MC-04 → MC-P4 (superseded).

## 8. Phased roadmap

| Step | Purpose | State | Category | Next action |
|---|---|---|---|---|
| WP-00 | plan reconciliation | PR_OPEN | planning | review #190 + continuation PR |
| WP-01 | M8 live evidence | RESEARCH_IN_PROGRESS | verification | read-only collection after run 37903915039 ends |
| WP-02 | F99 reconciliation + identity | SPECIFIED | defect repair | operator identity decision |
| WP-03A | census | RESEARCH_IN_PROGRESS | core | read PrimaryActions/WebDesktopCard/MirrorCard |
| WP-03B | catalog generator + gate | SPECIFIED | verification | after 03A schema freeze |
| WP-04 | event + redaction core | SPECIFIED | core | implementation-ready after WP-13 |
| WP-05A | server/runner research | RESEARCH_PENDING | core | read server route table |
| WP-05B | health model | RESEARCH_PENDING | core | after 05A |
| WP-06 | causal attribution | SPECIFIED | core | after WP-04 + WP-13 |
| WP-07 | embedded diagnostics UX | SPECIFIED | core | after 05B + 06 |
| WP-08 | patch emitter | SPECIFIED (#181), DEFERRED | optional | operator key ceremony |
| WP-09 | e2e-ui timeout | RESEARCH_IN_PROGRESS | verification | find first failing run / log |
| WP-10 | sanitized export | SPECIFIED | core | after WP-04 + WP-13 |
| WP-11 | guided troubleshooting | SPECIFIED | core | after WP-07 |
| WP-12 | live acceptance | BLOCKED | verification | after WP-01/07/11 |
| WP-13 | Collector privacy defects | **READY_FOR_IMPLEMENTATION** | defect repair | first package when implementation is authorized |
| WP-14 | truthfulness + safety defects | READY_FOR_IMPLEMENTATION | defect repair | independent |

Child issues and full briefs: [WORK-PACKAGES.md](mission-control/WORK-PACKAGES.md).

### 8.1 First actionable package: WP-13 (replaces v1's WP-03 choice)

Rationale: every later package (attribution, UX, export) widens or surfaces the collector store; the store currently
can persist a controlled password value, the raw hash route and token-bearing URLs (MC-P8, P11, P12, P13). Fixing
these first prevents the diagnostics expansion from multiplying an existing exposure. It needs no other package
(reuses existing, tested sanitizers) and has a ready execution brief.

### 8.2 Execution briefs

In [WORK-PACKAGES.md](mission-control/WORK-PACKAGES.md) for every package (v1 deferred WP-04…WP-12 briefs; v2 writes them).

## 9. Test and acceptance strategy

[ACCEPTANCE-PLAN.md](MISSION-CONTROL-ACCEPTANCE-PLAN.md): seven verification classes with denominators, 16
fault-injection cases with falsifiers, probes P-01 (executed) … P-07.

## 10. Operator actions (only where evidence requires them)

| Action | Why | Smallest step | Requested now? |
|---|---|---|---|
| Decide the intended RDP application identity (option A/B/C) | MC-P21: deployed code changes the active user's password; #153/#156/#154 disagree | reply A, B or C on #191 or #153 | **yes (decision only)** |
| Let run 37903915039 finish or cancel it per the M8 runbook | WP-01 evidence | operator's choice; agents do not touch the run | no new action |
| Optionally download one `e2e-ui` step log | WP-09; sandbox cannot download log archives | attach the step-8 log of run 37898544529 to #191 | optional |

No secret re-creation, setup repeat or issue-number choice is requested.

## 11. Security, privacy, performance, rollout and rollback

Privacy defects found in existing diagnostics are tracked as WP-13 (first). New diagnostics follow spec Part B §B.3
(redaction before storage/export, no derived token identifiers, screenshots opt-in). Performance observations:
8 extra requests per instrumented click, duplicate native-status pollers (MC-P19/P20). No new paid service or
dependency is proposed. Rollout per WP behind its own flag; rollback per WP (briefs).

## 12. Deferred and missing inputs (explicit)

See [SOURCE-RESEARCH-LEDGER §3](mission-control/SOURCE-RESEARCH-LEDGER.md#3-not-read-bounded-exclusions-with-next-step)
and [HANDOFF](mission-control/HANDOFF.md#exact-next-steps).

## 13. Decisions and tradeoffs

| Decision | Rationale | Consequences | Revisit trigger |
|---|---|---|---|
| Continuation PR instead of pushing to #190's branch | session is fixed to its own branch; continuation carries #190's commits | #190 can merge first (continuation diff shrinks) or be superseded | reviewer preference |
| Child issues created now | instruction authorizes planning issues; WPs are specified | 13 child issues | operator feedback |
| #153 recommended canonical; #156 carried over | evidence richness + open PR reference | closure by operator | operator decision |
| WP-13 first (not WP-03) | privacy defects in the store every later WP builds on | catalog generator later | none |
| Live Patch optional | no diagnostic view depends on it | WP-08 deferred | operator asks for it |
| No `STATE.md` edit | 60-line contract (`tests/f53-content-length.test.js`) | pointer lives in `OBSERVATORY-STATE.md` | ledger migration |

## 14. Recent changes (append-only)

- 2026-10-09: Initial plan. Verified #188/#189 merged, merge SHA `823bcb6`, merge-SHA checks as §1.1, local
  static gates 17/17 pass. Created this plan and the coverage matrix. Application code unchanged.
- 2026-10-09 (v2, F-OBSERVATORY v20): corrected v1 claims A–I (correction ledger); researched R2 in depth (Collector,
  global capture, drawers, boundaries, DVR-lite) with R3/R4 support; measured census v1 (301 static DOM control
  sites); executed isolated probe P-01 (password-value capture mechanism confirmed); classified e2e-ui cancellation
  (systematic 25-min timeout) and M8 live state (run 37903915039 in progress, initial writer live); reconciled
  #153/#156 technically; added specs, troubleshooting matrix, acceptance plan, work packages WP-00…WP-14 and child
  issues. Application code unchanged.

## 15. Sanitized planning handoff

[mission-control/HANDOFF.md](mission-control/HANDOFF.md).

---

## Links

- Parent issue: [#191](https://github.com/dekarita/supreme-lamp/issues/191) · plan v1 PR: [#190](https://github.com/dekarita/supreme-lamp/pull/190)
- M8 runbook: [docs/M8-LIVE-VERIFICATION.md](M8-LIVE-VERIFICATION.md) · history: [docs/OBSERVATORY-STATE.md](OBSERVATORY-STATE.md)
- Child issues: see [WORK-PACKAGES summary](mission-control/WORK-PACKAGES.md#summary)

Final status: `mode=RESEARCH_AND_PLAN_ONLY; status=PLAN_PARTIAL; application_changes=NONE;`
