<!-- Copy-ready body for issue #191. The integration could not update it: PATCH /repos/dekarita/supreme-lamp/issues/191 -> HTTP 403 "Resource not accessible by integration" (GraphQL and REST), 2026-10-09 ~08:52Z. Paste everything below this comment into the issue body. -->

Canonical planning issue for Mission Control diagnostics. **Planning only — no application code is changed by this issue or its docs PRs.**

## Current state (updated 2026-10-09 ~08:50Z, F-OBSERVATORY v20)
| Item | State |
|---|---|
| Verified revision | source researched at `823bcb6` (application code identical on `main` = `c3322f8`, which adds only `docs/status.json` commits from the live run) |
| Stage | **PLAN_PARTIAL** — research in progress; plan v2 published |
| Docs PRs | v1 #190 (`9aa6051`) · **v2 continuation #192** (contains #190's commits) |
| Complete | correction ledger (v1 claims A–I); R2 Collector/capture + diagnostic drawers read in depth; census v1 (**301** static DOM control sites); capability/reuse matrix; architecture; diagnostics spec (UX + event/probe/redaction); troubleshooting matrix (MC-P1…P24); acceptance plan; WP-00…WP-14 specs; #153/#156 reconciliation; 14 child issues |
| Researching now | WP-03A census handler classification (#196) · WP-05A server/runner endpoints (#199) · WP-09 e2e-ui timeout (#203) · WP-01 live M8 evidence (#195) |
| Unread (bounded) | most R1 page/domain components, HUD/Lab/replay, R5 PowerShell server handlers, R6 Explorer/mirror, R7 workflows — exact list: [source ledger §3](https://github.com/dekarita/supreme-lamp/blob/arena/b7f4c19a-supreme-lamp/docs/mission-control/SOURCE-RESEARCH-LEDGER.md#3-not-read-bounded-exclusions-with-next-step) |
| Live evidence | run [37903915039](https://github.com/dekarita/supreme-lamp/actions/runs/37903915039) (operator dispatch on `823bcb6`) in progress: initial + heartbeat snapshots carry `runAttempt: 1` (M8 writers executed live); finalizer step pending → not yet evidenced. Run untouched by agents. |
| Browser E2E | **0/100** recent `e2e-ui` successes (25-min job timeout; last success 2026-10-05) |
| First implementation-ready package | **WP-13 #193** Collector privacy defects (needs explicit implementation authorization) |

**Blockers and owners**
| Blocker | Owner | Blocks |
|---|---|---|
| Intended RDP application identity (option A/B/C, MC-P21) | operator (decision) | WP-02 follow-up only |
| Run 37903915039 completion (or runbook cancel) | operator | WP-01 terminal evidence only |
| `e2e-ui` step log (sandbox cannot download log archives) | operator (optional) / WP-09 | BROWSER_E2E acceptance, not specs |
| Server handler research | agent (WP-05A #199) | WP-05B |

**Operator actions (only these):** (1) reply **A**, **B** or **C** for the RDP identity — [options](https://github.com/dekarita/supreme-lamp/blob/arena/b7f4c19a-supreme-lamp/docs/mission-control/ISSUE-RECONCILIATION.md#4-genuine-operator-decision-identity); (2) optionally attach one `e2e-ui` step-8 log (run 37898544529). No secret re-creation, setup repeat or issue-number choice is requested (OPERATOR_CONFIRMED_CONFIGURATION).

**Plan documents (v2, PR #192 branch):** [master plan](https://github.com/dekarita/supreme-lamp/blob/arena/b7f4c19a-supreme-lamp/docs/MISSION-CONTROL-MASTER-PLAN.md) · [coverage matrix](https://github.com/dekarita/supreme-lamp/blob/arena/b7f4c19a-supreme-lamp/docs/MISSION-CONTROL-COVERAGE-MATRIX.md) · [correction ledger](https://github.com/dekarita/supreme-lamp/blob/arena/b7f4c19a-supreme-lamp/docs/mission-control/CORRECTION-LEDGER.md) · [source ledger](https://github.com/dekarita/supreme-lamp/blob/arena/b7f4c19a-supreme-lamp/docs/mission-control/SOURCE-RESEARCH-LEDGER.md) · [control census](https://github.com/dekarita/supreme-lamp/blob/arena/b7f4c19a-supreme-lamp/docs/mission-control/CONTROL-CENSUS.md) · [capability/reuse](https://github.com/dekarita/supreme-lamp/blob/arena/b7f4c19a-supreme-lamp/docs/mission-control/CAPABILITY-REUSE-MATRIX.md) · [architecture](https://github.com/dekarita/supreme-lamp/blob/arena/b7f4c19a-supreme-lamp/docs/mission-control/ARCHITECTURE.md) · [diagnostics spec](https://github.com/dekarita/supreme-lamp/blob/arena/b7f4c19a-supreme-lamp/docs/MISSION-CONTROL-DIAGNOSTICS-SPEC.md) · [troubleshooting](https://github.com/dekarita/supreme-lamp/blob/arena/b7f4c19a-supreme-lamp/docs/MISSION-CONTROL-TROUBLESHOOTING.md) · [acceptance plan](https://github.com/dekarita/supreme-lamp/blob/arena/b7f4c19a-supreme-lamp/docs/MISSION-CONTROL-ACCEPTANCE-PLAN.md) · [work packages](https://github.com/dekarita/supreme-lamp/blob/arena/b7f4c19a-supreme-lamp/docs/mission-control/WORK-PACKAGES.md) · [issue reconciliation](https://github.com/dekarita/supreme-lamp/blob/arena/b7f4c19a-supreme-lamp/docs/mission-control/ISSUE-RECONCILIATION.md) · [handoff](https://github.com/dekarita/supreme-lamp/blob/arena/b7f4c19a-supreme-lamp/docs/mission-control/HANDOFF.md)

## Roadmap
| WP | Purpose | Category | Planning state | Child | Next action |
|---|---|---|---|---|---|
| WP-00 | plan reconciliation + docs | planning | PR_OPEN | #190, #192 | review |
| WP-01 | M8 live evidence | verification | RESEARCH_IN_PROGRESS | #195 | collect after run ends |
| WP-02 | F99 reconciliation + identity | defect repair | SPECIFIED | #153 (recommended canonical) | operator A/B/C |
| WP-03A | control/evidence census | core | RESEARCH_IN_PROGRESS | #196 | read PrimaryActions/WebDesktopCard/MirrorCard |
| WP-03B | AST catalog + CI gate | verification | SPECIFIED | #197 | after 03A schema freeze |
| WP-04 | event contract + redaction core | core | SPECIFIED | #198 | after/with WP-13 |
| WP-05A | server/runner research | core | RESEARCH_PENDING | #199 | read server route table |
| WP-05B | health model + bounded probes | core | RESEARCH_PENDING | #200 | after 05A |
| WP-06 | causal attribution | core | SPECIFIED | #201 | after WP-04 + WP-13 |
| WP-07 | embedded diagnostics UX | core | SPECIFIED | #202 | after 05B + 06 |
| WP-08 | Live Patch emitter | optional | SPECIFIED, DEFERRED | #181 | operator key ceremony |
| WP-09 | e2e-ui systematic timeout | verification | RESEARCH_IN_PROGRESS | #203 | first failing run / log |
| WP-10 | sanitized export | core | SPECIFIED | #204 | after WP-04 + WP-13 |
| WP-11 | guided troubleshooting | core | SPECIFIED | #205 | after WP-07 |
| WP-12 | live acceptance + rollout | verification | BLOCKED | #206 | after WP-01/07/11 |
| WP-13 | Collector privacy defects | defect repair | **READY_FOR_IMPLEMENTATION** | #193 | first when authorized |
| WP-14 | truthfulness + safety defects | defect repair | READY_FOR_IMPLEMENTATION | #194 | independent |

Delivery states are tracked separately (PR_OPEN → MERGED → DEPLOYED → LIVE_VERIFIED); none of WP-01…WP-14 has delivery yet.

## Coverage (denominators defined)
- Routes: **16** `<Route>` = 1 layout + **14** navigable (12 literal + 2 parameterized) + 1 wildcard. Registry features: 11. Chrome surfaces: 10.
- Static DOM control call-sites: **301** (42 in dynamic families, 60 conditional); keyboard listeners 12; programmatic action sites 27.
- F104 capture: 235 self-eligible / 48 not / 18 ignored by design. Explicit Collector instrumentation: 3 sites. Click-now targets: 18 (9 mutating).
- Handler bodies researched: 24/301. Runtime diagnostic coverage: NOT MEASURED (0/11 features). Live verification: 0/11.

## Known problems (registry: [troubleshooting §3](https://github.com/dekarita/supreme-lamp/blob/arena/b7f4c19a-supreme-lamp/docs/MISSION-CONTROL-TROUBLESHOOTING.md#3-problem-registry-root-cause-investigation))
| ID | Problem | Class | WP |
|---|---|---|---|
| MC-P1 | no Live Patch producer on `/ws` | CONFIRMED (grep scope) | #181 |
| MC-P2 | #153/#156 same title, divergent bodies | CONFIRMED | WP-02 |
| MC-P3 | e2e-ui 0/100, 25-min timeout | CONFIRMED class | #203 |
| MC-P4 | stale snapshot (v1) | SUPERSEDED (live run) | #195 |
| MC-P5 | handoff names old main | CONFIRMED | WP-00 |
| MC-P6 | runtime diagnostic coverage | PARTIAL (census) | #196 |
| MC-P7 | Pages verify step non-asserting; stale remediation text | CONFIRMED | #199 |
| MC-P8 | controlled password value captured as `label` | CONFIRMED mechanism (probe) | #193 |
| MC-P9 | add-site row records follow-up GET; verdict ignores result | CONFIRMED | #201 |
| MC-P10 | global capture fan-out / status 0 = failure / constant duration | CONFIRMED | #201 |
| MC-P11 | raw hash route persisted | CONFIRMED | #193 |
| MC-P12 | token-bearing URLs + bodies persisted | CONFIRMED | #193 |
| MC-P13 | raw `button-actions.json`; token fingerprints | CONFIRMED | #193 |
| MC-P14 | `/diag` drawer misclassifies failures | CONFIRMED | #194 |
| MC-P15 | batch clicks run 9 mutating targets unconfirmed | CONFIRMED | #194 |
| MC-P16 | success without effect (`.rdp`, reconnect, watcher chip) | CONFIRMED | #194 |
| MC-P17 | F-TESTID apostrophe blind spot | CONFIRMED | #197 |
| MC-P18 | closed drawer focusable | LIKELY | #194 |
| MC-P19 | pre-probes delay instrumented handler | CONFIRMED (impact HYPOTHESIS) | #201 |
| MC-P20 | duplicate native-status pollers | CONFIRMED | #201 |
| MC-P21 | RDP identity split / password sync | decision pending | WP-02 |
| MC-P22 | dead fetch-wrapper layers | LIKELY | #201 |
| MC-P23 | registry `endpoints` incomplete | LIKELY | #197 |
| MC-P24 | public status.json publishes tailnet/egress addresses + Funnel URL (no token) | observation | #199 |

## Decisions and tradeoffs
| Decision | Rationale | Consequences | Revisit trigger |
|---|---|---|---|
| Single parent (#191); child issues created now | instruction authorizes planning issues; WPs specified | 14 children #193–#206 | operator feedback |
| Continuation PR #192 instead of pushing to #190's branch | session-bound branch | #192 carries #190's commits | reviewer preference |
| #153 recommended canonical; #156 unique requirements carried over | evidence richness; open PR #154 references #153 | closure is the operator's | operator |
| WP-13 first | later WPs widen the collector store, which can currently persist secrets | catalog generator later | none |
| Live Patch optional | no diagnostic view depends on it | WP-08 deferred | operator request |
| No new routes; retired endpoints stay retired | M8/#169 lessons | some diagnostics reuse existing reads | WP-05A evidence |
| Pointer in OBSERVATORY-STATE, not STATE.md | STATE.md locked at 60 lines (tests/f53) | — | ledger migration |

## Recent changes (append-only)
- 2026-10-09: Plan published (PR #190, docs-only). Application code unchanged.
- 2026-10-09: Plan v2 (PR #192): corrections A–I, census v1, specs, acceptance plan, troubleshooting matrix, WP-00…WP-14, child issues #193–#206, #153/#156 reconciliation; live M8 run observed (writers live, finalizer pending); e2e-ui timeout classified. Application code unchanged.

<details><summary>Previous body (v1, superseded 2026-10-09 — kept for history)</summary>

Canonical planning issue for Mission Control diagnostics. Planning only: no application code is changed by this issue.

## Current snapshot
- Last verified revision: `main` @ `823bcb6e94df8117a2f43d491a73e60265a968a1` (PR #189 merge), observed 2026-10-09.
- Existing capabilities: Mission Control SPA routes (13 concrete + fallback), feature registry (11 features), M8 status finalizer (PR #188, #189 merged).
- Verified checks (merge SHA): gates success, proof success, windows-native success. e2e-ui: cancelled (cause not classified).
- Local static gates: f53 + f111 + m4 = 17/17 pass.
- Runtime/live evidence still missing: M8 live run (NOT RUN); tracked `docs/status.json` is stale (2026-10-07, in_progress); runtime diagnostic coverage 0/11 features.
- Operator-confirmed configuration: secrets and most operator setup reported complete (OPERATOR_CONFIRMED_CONFIGURATION). Not independently re-verified.
- Active work package: WP-00 (plan PR #190, awaiting review).
- Next actionable work package: WP-03 control catalog + coverage gate (after plan review).
- Actual blockers: plan review; #153/#156 canonical decision; WP-01 live run requires operator dispatch.

## Roadmap
| Step | Purpose | State | Dependency | Acceptance | Evidence | Issue/PR | Next action |
|---|---|---|---|---|---|---|---|
| WP-00 | Reconciliation + plan docs | PR_OPEN | none | Plan reviewed | docs | PR #190 | Review |
| WP-01 | M8 live acceptance | BLOCKED | WP-00; no important run in flight | Runbook stages A–D | docs/M8-LIVE-VERIFICATION.md | #188, #189 | Operator |
| WP-02 | Reconcile #153/#156 | READY | decision | One canonical F99 issue | metadata | #153, #156, #181 | Operator picks canonical |
| WP-03 | Control catalog + coverage gate | READY (first) | WP-00 | Derived catalog; gate fails on undeclared route/feature | gate tests | TBD | Create child after review |
| WP-04 | Event contract + redaction core | PLANNED | WP-03 | Schema + redaction negative tests | unit | TBD | — |
| WP-05 | Read-only dependency health + bounded probes | PLANNED | WP-04 | Timeouts/budgets; stale/unknown distinct | unit/integration | TBD | — |
| WP-06 | Action trace capture (reuse collector) | PLANNED | WP-04 | No recursive capture | browser | TBD | — |
| WP-07 | Embedded diagnostics panel | PLANNED | WP-05, WP-06 | Real controls; EN/SI; keyboard; degraded backend | browser E2E | TBD | — |
| WP-08 | F110c patch emitter | BLOCKED (source re-read) | WP-03 | Verifiable patches on synthetic session | native/unit | #181 | Re-read emitter |
| WP-09 | e2e-ui cancellation classification | READY (read-only) | none | Cause classified with evidence | run log | none | Read log |
| WP-10 | Sanitized evidence export | PLANNED | WP-04 | Secret exclusion tests | unit | TBD | — |
| WP-11 | Troubleshooting guide | PLANNED | WP-07 | Each failure class has safe next step | doc gate | TBD | — |
| WP-12 | Live acceptance + rollout | BLOCKED | WP-01..WP-11 | Operator acceptance | runbook | TBD | Operator |

## Coverage
| Feature/control family | Diagnostic coverage | Test coverage | Live verification | Gap | Work item |
|---|---|---|---|---|---|
| 11 registry features (overview, search, sessions, connections, keys, files, mirror, telemetry, health, collector, settings) | NOT MEASURED (0/11) | NOT MEASURED | 0/11 | control inventory missing | WP-03, WP-05, WP-07 |
| Lab + search lab routes | NOT MEASURED | NOT MEASURED | 0 | internals NOT_READ | WP-03 |
| Live Patch emitter | broken per #181 | verifier has nothing to verify | — | emitter missing | WP-08 |
| Pages / status snapshot | stale tracked snapshot | gate tests only | M8 NOT RUN | live run | WP-01 |
| e2e-ui lane | — | cancelled on merge SHA | — | unclassified | WP-09 |

Controls (buttons/forms/menus/keyboard) are not yet counted: denominator is unknown until WP-03.

## Known problems
| ID | Severity | Evidence | Confidence | Current disposition | Proposed next action |
|---|---|---|---|---|---|
| MC-P1 | High | `/ws` has no patch broadcaster (#181) | High (issue text) | OPEN | WP-08 |
| MC-P2 | Medium | #153 and #156 identical titles | High | OPEN both | WP-02 |
| MC-P3 | Medium | e2e-ui cancelled on `823bcb6` | High (conclusion); cause unknown | not dismissed | WP-09 |
| MC-P4 | Medium | tracked status.json stale 2026-10-07 | High | expected until live run | WP-01 |
| MC-P5 | Low | SESSION_HANDOFF names an older main SHA | High | stale handoff | noted in plan |

## Operator actions
- Reply with the canonical F99 issue number to keep (#153 or #156). Decision only.
- When no important run is in flight, run the M8 runbook (`docs/M8-LIVE-VERIFICATION.md` §0–§2) once. Do not cancel other sessions' runs.
- No secret re-creation or setup repeat is requested.

## Decisions and tradeoffs
| Decision | Rationale | Consequences | Revisit trigger |
|---|---|---|---|
| Single parent; child issues after review | Avoid issue sprawl | child links later | operator approval |
| No new routes; reuse existing channels | retired endpoints stay retired | some diagnostics depend on existing reads | WP-05 insufficiency |
| Pointer in OBSERVATORY-STATE, not STATE.md | STATE.md locked at 60 lines (tests/f53) | pointer lives in history | ledger migration |
| #153/#156 not closed by agent | scope/authorization unclear | duplicate remains | operator reply |

## Recent changes
- 2026-10-09: Plan published (PR #190, docs-only). Application code unchanged.

## Deferred items
- Full read of src/components, src/lib (collector/HUD/DVR/livePatch), payloads/*.ps1, worker.js, workflows, tests/e2e: NOT_READ. Next: WP-03.
- Control-level inventory: Next: WP-03.
- Live runtime probing: Next: WP-01 and WP-05.

## Links
- Master plan: docs/MISSION-CONTROL-MASTER-PLAN.md (PR #190)
- Coverage matrix: docs/MISSION-CONTROL-COVERAGE-MATRIX.md (PR #190)
- M8 runbook: docs/M8-LIVE-VERIFICATION.md
- Observatory history: docs/OBSERVATORY-STATE.md
- Related: #163 (closed, background), #165 (closed, background), #181 (open), #153/#156 (open, reconcile)


</details>
