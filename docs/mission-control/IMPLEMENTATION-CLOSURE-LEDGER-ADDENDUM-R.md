# Implementation Coverage Ledger — Addendum R (researched upgrades)

**Parent ledger of record**: `docs/mission-control/IMPLEMENTATION-CLOSURE-LEDGER.md`
(lives on `arena/19dded16-supreme-lamp`, PR **#208**). This file is an **ADDENDUM to that ledger**, not a
competing roadmap: it adds the researched-upgrade rows (#210–#218) and this session's repairs using the
same column set and the same stable IDs, and it leaves every existing MC-P/WP row untouched.

**Why a separate file**: rows MC-P1…P24 / WP-01…WP-14 belong to PR #208's branch. Adding a second copy of
that file to a different branch would fork the ledger and guarantee a merge conflict. This addendum is
merged into the parent file when #208 lands (next action, §5).

**Session**: 2026-10-10 · mode `IMPLEMENTATION_AND_VERIFICATION` · branch `arena/a50d3050-supreme-lamp`
· base `main` @ `017f719c3d1f504732e2a994e5f3d0dcb33ffa4a`.

## Status vocabulary (as directed)

`OPEN` · `IN_PROGRESS` · `IMPLEMENTED_UNVERIFIED` · `VERIFIED_IN_TEST` · `PR_OPEN` · `MERGED` ·
`DEPLOYED` · `LIVE_VERIFIED` · `ALREADY_SATISFIED_WITH_EVIDENCE` · `BLOCKED_WITH_EXACT_DEPENDENCY` ·
`OPTIONAL_NOT_ENABLED`

---

## 1. Batch 0 — PR #208's repair loop (the first thing to finish)

| Requirement / issue | Current behavior | Required behavior | Source revision | Affected files | Dependency | Implementation commit / PR | Acceptance test | Verification class / result | Delivery state | Remaining blocker | Next action |
|---|---|---|---|---|---|---|---|---|---|---|---|
| #208 gates (`launch-gates.yml`) | head `e5d7c91` fails `gates`: two F101 smoke fixtures POST `/api/fetch` directly, which the F56-c fence reserves for the F56-d lane | the fixtures drive the button through the real lane client; the gate is not weakened | `e5d7c91` → `3f6566b` | `src/tests/smoke/f101-collector-depth.test.tsx` (fixtures only) | none | **PR #219** (`arena/8dcb6f43-supreme-lamp` → base `arena/19dded16-supreme-lamp`), head `3f6566b` | CI on that head: `gates` **pass**, `windows-native` **pass**, labs pass | CI (STATIC_CHECK + NATIVE_INTEGRATION) — **green on `3f6566b`** | **PR_OPEN** (delivered by the previous session; independently re-verified this session via `gh pr checks 219`) | none for `gates` | operator merges #219 into #208's branch, then #208 |
| #203 / WP-09 — e2e-ui 25-minute timeout | 92 cancelled + 8 failed of the last 100 runs; the step log was EMPTY because `pnpm run e2e > e2e-run.log` only tailed the file after the command returned, and a cancelled job never returns | a hang must FAIL with visible evidence, and the hanging mechanism must be removed | first non-success run `37289316623` @ `1827d3f0` (the F91 commit that added `tests/e2e/f91-mirror-mode.spec.ts`); last success `37285114245` @ `2b66c11` | `.github/workflows/e2e-ui.yml`, `tests/e2e/f91-mirror-mode.spec.ts`, `tests/f203-e2e-lane.test.js` (new) | a real browser run to prove green | this branch, commit "fix(e2e): bound the e2e-ui step, stream its log, and close the mirror spec's popups (#203)" | `tests/f203-e2e-lane.test.js` (5 static pins) | **STATIC_CHECK** — 5/5 pass locally. Mechanism attribution is **SOURCE_REVIEW + lane-history correlation (high confidence, not a reproduced browser hang: no Chromium is downloadable in this sandbox — cdn.playwright.dev and objects.githubusercontent.com are unreachable, and the bundled binary needs `libnss3` which cannot be apt-installed)** | **IMPLEMENTED_UNVERIFIED** (the lane has never run green here) | a Chromium-capable runner | push, let CI run `e2e-ui`, read the now-streamed log; if it is still red the log names the spec |

**Mechanism removed (documented beside the code).** `f91-mirror-mode.spec.ts` opened a popup at a real
third-party operator site (pluto.tv, tubitv.com, archive.org, …) and left it open. Playwright closes the
whole context at test teardown and a context close waits for every page in it — with `workers: 1` a single
wedged teardown stalls the entire run, which is exactly the "0 successes, every run cancelled at ~25m"
signature. Two narrowings, neither of which drops an assertion:
1. every external navigation is **fulfilled with a stub** (the spec's own comment already said *"its LOAD
   may fail in a sandbox; creation + correct target is the proof"* — the popup URL is the assertion, the
   page body never was);
2. every popup is **closed in a `finally`**.

No per-test timeout was lowered and no spec was deleted (`f203-b` pins ≥11 specs incl. F78/F79/F91).

---

## 2. Batch 2 — truthful metrics and clocks (#211 / #212)

| Requirement / issue | Current behavior | Required behavior | Source revision | Affected files | Dependency | Implementation commit / PR | Acceptance test | Verification class / result | Delivery state | Remaining blocker | Next action |
|---|---|---|---|---|---|---|---|---|---|---|---|
| #211 — jitter rendered as `0 ms` | `jitMedian()` returned `0` for fewer than 2 samples → "jit 0 ms" read as *measured and perfectly stable* | `null` until 2 usable samples exist; the DOM exposes `data-samples` / `data-measured` | `017f719` | `src/lib/domain/metrics.ts` (new), `src/lib/domain/connProbe.ts`, `src/components/domain/ConnectionCard.tsx` | none | this branch | `r-metrics-truthfulness.test.tsx` R-METRICS-1 + `r-metrics-connection-card.test.tsx` | CONTROLLED_BEHAVIOR — 29 + 6 tests pass | **VERIFIED_IN_TEST** | — | — |
| #211 — one RTT label for two producers | `connRtt` showed the Tailscale wire RTT when present and the browser HTTP round trip otherwise | separate, labelled measurements; the DOM names the producer (`data-source`) | `017f719` | same | none | this branch | R-METRICS-2 (5 tests) + card test "names the producer of the RTT it displays" | CONTROLLED_BEHAVIOR | **VERIFIED_IN_TEST** | — | — |
| #211 — FPS placeholder | `-- fps` / `fps --` (a number-shaped placeholder for a quantity neither transport publishes) | explicit *not exposed*, with `data-exposed="0"` | `017f719` | `ConnectionCard.tsx` | none | this branch | card test "never renders an FPS number" | CONTROLLED_BEHAVIOR | **VERIFIED_IN_TEST** | — | — |
| #212 — `progress.wire` provenance | `/ping`'s `wire` object (Tailscale-derived) was silently preferred over the browser's own HTTP timing under one label | labelled producers; freshness (`rttAtMs`) recorded so a stale number is marked stale | `017f719` | `src/stores/telemetryStore.ts`, `ConnectionCard.tsx` | none | this branch | R-METRICS-2 stale test; `setWire` records `rttAtMs` and rejects non-finite RTT | CONTROLLED_BEHAVIOR | **VERIFIED_IN_TEST** | — | — |
| #212 — remaining clock showed `05:30:00` with no evidence | `remainingSeconds()` returned the 5h30 **policy** constant whenever the run start was unknown | prefer the server-published `sessionEnd` (`/api/progress`, min of github/keep-alive/watcher deadlines); label the policy fallback; `null` → unknown state | server publishes it at `payloads/ghrdp-server.ps1` L8811-L8828; the SPA never read it | `src/lib/domain/metrics.ts`, `src/stores/telemetryStore.ts`, `src/components/layout/AppShell.tsx`, `src/components/domain/PrimaryActions.tsx` | none | this branch | R-METRICS-3 (6) + R-METRICS-4 (7, incl. run-identity change, invalid deadline, absent-vs-empty key) + R-METRICS-6 DOM (`data-basis` = `unknown`/`policy-window`/`server-session-end`, `data-expired`) | CONTROLLED_BEHAVIOR | **VERIFIED_IN_TEST** | — | — |
| #212 — run identity changes | `runStartedAtMs` was latched once, so a new GitHub run kept the previous run's start (and its deadline) | a >1s change re-seats the start **and** invalidates the cached deadline | `017f719` | `telemetryStore.ts` | none | this branch | R-METRICS-4 "a CHANGED run re-seats the start and invalidates the old deadline" | CONTROLLED_BEHAVIOR | **VERIFIED_IN_TEST** | — | — |
| #212 — speed-history caption | one fixed caption ("last 90 samples (7.5 min @ 5s)") for arrays from two different producers | the caption follows the array's **origin**; the model reports it | `src/lib/domain/progress.ts` L75 (server array) vs the client fallback at the 3s poll cadence | `src/lib/domain/progress.ts`, `src/components/domain/MirrorCard.tsx`, `src/lib/domain/metrics.ts` | none | this branch | R-METRICS-5 (5 tests: server=5s/450s, client=3s/270s at identical length, empty) | CONTROLLED_BEHAVIOR | **VERIFIED_IN_TEST** | — | — |
| Pin rewrite (old pin enforced the wrong contract) | `f-i18n-render.test.tsx` pinned that the surface renders the literal `mirror.speedHistory` caption | pin the caption the surface actually renders | `017f719` | `src/tests/smoke/f-i18n-render.test.tsx` | — | this branch | replaced with `mirror.speedHistoryEmpty`, with a comment; provenance covered behaviourally by R-METRICS-5 | STATIC_CHECK + CONTROLLED_BEHAVIOR | **VERIFIED_IN_TEST** | — | — |

---

## 3. Batch 3 — search failure explanation (#216) and Explorer scale (#217)

| Requirement / issue | Current behavior | Required behavior | Source revision | Affected files | Dependency | Implementation commit / PR | Acceptance test | Verification class / result | Delivery state | Remaining blocker | Next action |
|---|---|---|---|---|---|---|---|---|---|---|---|
| #216 — zero results with source failures looked identical to a clean zero | only "No results for X — try broader terms" | a concise counted summary, tied to the current query generation, linking to the existing adapter-status surface | `017f719` | `src/lib/search/zeroResultSummary.ts` (new), `src/pages/search/SearchFailureSummary.tsx` (new), `src/pages/Search.tsx` | none | this branch | `r-search-zero-summary.test.tsx` — 17 tests (clean zero, counted summary, non-overlapping rate-limit/failure buckets, in-progress, cancelling, stale generation, no raw error/URL leak, navigation to `f56.search.adapterStatusList`, 2 page-integration tests) | CONTROLLED_BEHAVIOR | **VERIFIED_IN_TEST** | — | — |
| #217 — Explorer rendered every row | `ExplorerResults` mapped all rows into one `<ul>`; a 5000-entry directory = 5000 nodes | windowed rendering with the **bundled react-window 1.8.10** (same v1 API / same pattern as `ResultsGrid.tsx`) | `react-window@1.8.10` (unchanged in `package.json`; latest 2.3.3 deliberately **not** adopted, and no second virtualization library added) | `src/pages/file-explorer/ExplorerResults.tsx` | none | this branch | `r-files-explorer-scale.test.tsx` — 13 tests: ≤100 nodes for 5000 rows, all rows for small lists, ARIA list semantics, external selection survives unmounting, no row-identity bleed across windows, rename/create editors, keyboard nav + Home/End, grid column math | CONTROLLED_BEHAVIOR (jsdom; `scrollTop`/`clientHeight` shimmed because jsdom performs no layout — documented in the test file) | **VERIFIED_IN_TEST** | real-device/Chromium perf measurement (see §4) | run the §4 measurement workload in a browser |
| #217 — frozen F57 contract | — | stable row identity, item keys = row ids, external selection, long-press/context-menu/drag-drop, inline rename + focus, list semantics, offscreen navigation scrolls into view | `017f719` | same | none | this branch | same file, R-FILES-2 (7 tests) + the pre-existing `f57-*` suites (all still green: `f57-keyboard`, `f57-command-actions`, `f57-context-menu`, `f57-dragdrop-trash`, `f57-selection-undo`, `f56c-v2-explorer`, `file-explorer-shell`) | CONTROLLED_BEHAVIOR | **VERIFIED_IN_TEST** | — | — |
| #217 — Explorer data source | the routed `FileExplorer` reads `src/pages/file-explorer/fixture.json` (6 rows) | **Not changed in this session** — this is Lab fixture data, not a production listing | `017f719` | `src/pages/FileExplorer.tsx` | the existing supported listing contract, to be reconciled with the F45 program | — | — | SOURCE_REVIEW | **OPEN** | a decision on which listing contract the routed Explorer must use | reconcile with F45; do not call the fixture-only preview a production upgrade |
| #217 — server paging | not implemented | conditional: implement only if a measured payload/listing workload demonstrates the need | `017f719` | — | a demonstrated workload | — | — | SOURCE_REVIEW | **OPTIONAL_NOT_ENABLED** | activation criterion: measured >N ms to first paint / >M MB payload on a real listing | measure first |

---

## 4. Batch 4 — download-manager stages (#210)

| Requirement / issue | Current behavior | Required behavior | Source revision | Affected files | Dependency | Implementation commit / PR | Acceptance test | Verification class / result | Delivery state | Remaining blocker | Next action |
|---|---|---|---|---|---|---|---|---|---|---|---|
| #210 stage 1 — reserved rail cells | the rail's speed/ETA/bytes cells were **absent**, and the header said "coming in F56-d" | explicit `unavailable` cells with their own testids; no number is implied | `017f719` | `src/pages/search/BottomProgressRail.tsx` | none | this branch | `r-dl-rail-honesty.test.tsx` — 13 tests (unavailable cells contain no digit, per-row identity, 7 lifecycle labels distinct, cancel only on live jobs, retry only on ended-badly jobs, retry success/failure paths) | CONTROLLED_BEHAVIOR | **VERIFIED_IN_TEST** | — | — |
| #210 stage 1 — retry action | `retryFetch()` existed in the client but no UI exposed it | retry offered only for a job that ended badly | `017f719` | `BottomProgressRail.tsx` | none | this branch | same file, R-DL-3 | CONTROLLED_BEHAVIOR | **VERIFIED_IN_TEST** | — | — |
| #210 stage 1 — live bytes/speed/ETA | not wired: `Get-Aria2Status` (aria2 `tellStatus`) exists in `payloads/ghrdp-aria2.ps1` L84-L87 and `progressRef` is assigned in `payloads/ghrdp-server.ps1` L3280, but nothing publishes a status read to the SPA | a status poll over an existing channel feeding the cells now shipped | `017f719` | `payloads/ghrdp-server.ps1`, plus the SPA poller | **a server-side read** (the SPA cannot ask aria2 directly — the RPC is loopback-only on the runner by design) | — | — | SOURCE_REVIEW | **BLOCKED_WITH_EXACT_DEPENDENCY** | exactly one: a sanitized per-`gid` status read on an existing route (`/api/progress` is the natural channel — it is already dash-token gated and polled at 3s) + a `windows-native` test | smallest next step: add the read to the `/api/progress` payload as `fetches[{fetchId,gid,status,bytes,total,speed,eta}]`, then a `tests/*.test.js` pin on the sanitized shape; then wire `data-available="1"` |
| #210 stage 2/3 — queue UX, cross-device retrieval | not started | cancel/retry/open row states; authenticated streaming retrieval | `017f719` | — | stage 1 + a server retrieval path | — | — | SOURCE_REVIEW | **OPEN** | depends on the row above | after the status feed |
| #210 lane C — yt-dlp adapter | not present | isolated adapter, disabled until its host/configuration policy is valid | yt-dlp pin `51bab8a` (Unlicense) — **not installed this session** | — | operator host-allowlist decision | — | — | SOURCE_REVIEW | **OPTIONAL_NOT_ENABLED** | activation criteria: (a) operator-authorized host allowlist, (b) pinned engine + processing dependencies, (c) argv-array invocation (never shell interpolation), (d) path/redirect/authorization fences, (e) a named unsupported-extractor error. No DRM/access-control bypass and no "every site works" claim | operator decision, then implement behind a default-off flag |
| Seal / aria2 / Mornye | — | **not adopted** | Seal `7677f61` (GPL-3.0, patterns only — no name/assets/Kotlin); aria2 `release-1.37.0` (GPL-2.0, RETAIN_EXISTING loopback RPC); Mornye/SpotiFLAC-Mobile reference-only | — | — | — | — | SOURCE_REVIEW | **OPTIONAL_NOT_ENABLED** | — | do not adopt without a demonstrated gap |
| OpenTelemetry | — | **not added** — the metric work was wiring/labelling, not a tracing requirement | — | — | — | — | — | SOURCE_REVIEW | **OPTIONAL_NOT_ENABLED** | a distinct, evidenced tracing requirement | revisit only with evidence |

---

## 5. Batches 5–7 — not started this session (recorded, not silently dropped)

| Requirement / issue | State | Activation criteria / blocker | Next action |
|---|---|---|---|
| #214 — safe-area, 44px targets, keyboard/focus, accessible names, EN/SI terminology | **OPEN** (not started) | no new i18n strings required for the safe-area + touch-target slice; the label/glossary slice needs a catalog addition and must move all five count-lock pins | implement the safe-area + touch-target slice first (no catalog change), then the glossary |
| #213 — glass design tokens, `GlassContainer`, Tinted/Clear, nested/shared backdrop, quality preference + opaque fallback | **OPEN** (not started) | must be benchmarked before the default is changed; opaque/reduced-effects stays the safe baseline | deliver tokens + `GlassContainer` behind the existing quality setting, then run the §6 workload in a browser; do not claim pixel-parity with Flutter or iPhone validation from Playwright WebKit |
| #215 / #218 | **ALREADY_SATISFIED_WITH_EVIDENCE** (research history, preserved) | — | keep both open as research history; this addendum is the implementation evidence linked from them |
| Remaining mandatory repair program (WP-14/#194, WP-04/#198, WP-06/#201, WP-03A/B, WP-05A/B, WP-07, WP-10, WP-11, WP-08/#181) | **OPEN** — inherited from the parent ledger, untouched | per the parent ledger's §9 priority order | parent ledger §9 is the plan of record |
| M8 / WP-01 | preserved | `docs/status.json` now records run `37903915039` attempt 1 with `runStatus=cancelled`, `finalizeReason=job.status=cancelled` (a real terminal artifact, so the obsolete "still in_progress" assumption is retired). **Not hand-edited; not cancelled by this session.** | the remaining M8 stages (finalizer execution, committed snapshot, deployment consumed, served response) still need run-log evidence — operator-owned; do not manufacture it |

---

## 6. Upstream sources actually used (integration boundary)

| Source | Inspected revision | Reused mechanism | Attribution / boundary | License note |
|---|---|---|---|---|
| `react-window` | **1.8.10** (already in `package.json`, unchanged) | `FixedSizeList`, `itemKey`, `itemData`, `outerElementType`/`innerElementType`, `scrollToItem` | application code only; the v1→v2 bump is explicitly **not** taken | MIT |
| Lucide | `^0.446.0` (already a dependency) | existing icon system retained | no second icon set added | ISC (notice obligation retained by the repo) |
| yt-dlp / aria2 / Seal / Mornye(SpotiFLAC) | as recorded in #210/#213/#218 | **none used this session** | reference/pattern only; nothing copied, no binary installed | yt-dlp Unlicense · aria2 GPL-2.0 (invoked, not vendored) · Seal GPL-3.0 (patterns only) |
| OpenTelemetry / Radix / TanStack | — | **none used** | no new dependency of any kind this session | — |

**Dependency delta: zero.** `package.json` is byte-identical to `main` (8 runtime, 21 dev).
`check:no-neon-green`, `check:regression-ids` (219===219), `check:fx-ids`, `check:bottom-bar` all pass.

---

## 7. Evidence summary (this session, local)

| Evidence class | Result |
|---|---|
| CONTROLLED_BEHAVIOR (`vitest run`) | **95 files / 1234 tests pass, 0 fail** (13 + 29 + 6 + 17 + 13 = 78 new tests across 5 new files) |
| STATIC_CHECK (`node --test tests/*.test.js`) | **817 tests: 791 pass / 0 fail / 26 pre-existing skips** (+5 from `tests/f203-e2e-lane.test.js`) |
| STATIC_CHECK (repo scripts) | `check:regression-ids` OK · `check:fx-ids` OK · `check:bottom-bar` OK · `check:no-neon-green` OK (1,121,702 bytes) |
| BUILD | `tsc -p tsconfig.build.json` clean + `vite build` clean → `ui/dist/index.html` **1,159,746 B (1,132.56 kB)**, single-file bundle, no chunking change. (`ui/dist` is git-ignored, so this is a local build artifact, not a shipped asset; the previous local build this session was 1,121,702 B — the +38 kB is the Explorer windowing + download-rail + 20 i18n keys. No new dependency, so no vendor-size change.) |
| i18n | en/si both **1050** keys; all five count-lock pin sites re-measured and updated with dated notes; `i18n-f56-parity` 528 → 537 |
| BROWSER_E2E | **0** — no Chromium obtainable in this sandbox (CDN and GitHub release hosts unreachable; the bundled binary needs `libnss3`, apt unreachable). The lane repair is therefore `IMPLEMENTED_UNVERIFIED` and is proven or disproven by the next CI run, which now streams its log |
| NATIVE_INTEGRATION / DEPLOYMENT / LIVE_ACCEPTANCE | **0** — no runner, server, deploy or production endpoint exercised (standing operator policy). M8 preserved merged (#188/#189) |

## 8. Rollout / rollback

- Rollout: each batch is an independent, revertible commit on one branch; the UI ships as a single file
  behind the existing dash-token gate.
- Rollback: `git revert <commit>` per batch. No schema migration, no stored-state migration, no new
  dependency, no new route, no build flag changed. The i18n catalog grew by 20 keys — reverting a batch
  must move the five count-lock pins back with it (the pins are the guard, not an obstacle).
- The Explorer change alters the row element from `<li>` to `<div role="listitem">` (react-window renders
  divs). Every frozen F57 id/testid is preserved; the `f57-*` suites prove it.

## 9. New defects found during this implementation

| ID | Finding | Disposition |
|---|---|---|
| ND-8 | `remainingSeconds()` returned the 5h30 **policy** window whenever `runStartedAtMs` was unknown, so the bottom bar rendered a confident `05:30:00` with nothing behind it | CLOSED (server `sessionEnd` preferred, policy labelled, unknown → `--:--:--` + `data-basis="unknown"`) |
| ND-9 | `runStartedAtMs` was latched once, so a new GitHub run kept the previous run's start **and** its cached deadline | CLOSED (>1s change re-seats the start and clears the deadline; test named for it) |
| ND-10 | `finiteOrNull()` via `Number(x)` turned `null`/`""`/`[]` into a real, displayed `0` | CLOSED (guarded before `Number()`; regression test in R-METRICS-2) |
| ND-11 | react-window v1's `List` is a `PureComponent`: a deliberately stable `itemData` froze the rows at their first snapshot (selection/editor stopped updating) — caught by the pre-existing `f57-*` suites, not by new tests | CLOSED (identity changes with the inputs; the row renderer stays stable so rows update in place). The constraint is documented in the source so it is not "optimised" back |
| ND-12 | `setFetchStatus` indexes `fetches` by **result** id, while the rail built its key as `resultId \|\| fetchId` — a compat row stored under `fetchId` would silently no-op | DOCUMENTED, not changed (changing the store key convention is out of scope for this batch); the new tests mirror the store's convention so the hazard is visible |
| ND-13 | the e2e-ui step's log was unreadable on cancellation, which is why the hang stayed unidentified for ~100 runs | CLOSED (`tee` + `timeout 18m` + `cancelled()` artifact upload + 5 static pins) |
