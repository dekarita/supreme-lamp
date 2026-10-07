# Mission Control Observatory — orchestrator state (mirror of #165)

> **Why this file exists.** For an Arena session token on this repo `POST /repos/.../issues` (create)
> and `POST /repos/.../pulls/<n>/comments` (PR comment) succeed, while `PATCH /repos/.../issues/165`,
> `POST /repos/.../issues/165/labels` **and `POST /repos/.../issues/165/comments` all return**
> `403 Resource not accessible by integration` — a session can therefore create #165 but neither tick
> its box nor append its session log there. So the checklist cannot live only in an issue body: this
> file is the authoritative, mergeable mirror. A session MUST update it in its own PR and post its
> session log as a comment on **that PR** (which is what #166 carries). Next session's §1 step
> determination = first unchecked box below; fall back to #165's body only if this file is missing,
> then cross-check the newest "§3 tracking-issue handoff" comment on the PR this step shipped in.

**Roadmap owner**: #165 · **Inventory prerequisite**: #163 · **Updated**: 2026-10-07 16:20Z by arena/fa27adb3-supreme-lamp
**Roadmap owner**: #165 · **Inventory prerequisite**: #163 · **Updated**: 2026-10-07 by arena/66a13a8c-supreme-lamp

## §OPERATOR-ASSERTIONS (v7 migration; verify independently)
- GH_PAT: operator previously reported Worker environment variable; **not used** by F107. No secret value was read or stored.
- Pages: `GET /repos/dekarita/supreme-lamp/pages` returned 404 for this integration on 2026-10-07. Availability **unverified**, operator must confirm before F108.
- Labels: previous sessions recorded PR/new issue writes succeed but #163/#164/#165 return 403. #169 is closed on GitHub; operator made that decision.

## Phase 1 — Immediate value
- [x] **Step 1 — F-TESTID** · landed on `arena/ad1df050-supreme-lamp`, PR **#166**, head `5cf005a`
  · CI: `gates` ✅ 1m44s · `windows-native` ✅ · `e2e-ui` ⚠️ pre-existing 25-min self-cancel (see below)
  · measured gap was **76 missing of 174 button sites**, not 63 of 150 (see #163 §4 correction in the PR body)
- [x] **Step 2 — F-I18N-SI-72** · landed on `arena/0648e4eb-supreme-lamp`, PR **#167**, head `2955bb9`
  · closed **88** keys, not 72: the 72 en-only keys of #163 §3.6 (re-derived exactly: 933/861) **plus 16 `collector.*` keys in NEITHER catalog**,
    surviving only as `t("k",{defaultValue})` — invisible to any key-set diff and unreachable by a translator
  · gates: `tests/f-i18n-parity.test.js` (6 rules, auto-run by launch-gates `node --test tests/*.test.js`) +
    `src/tests/smoke/f-i18n-render.test.tsx` (9 surfaces × both languages, 70/88 strings DOM-proven, 4 falsifications)
  · Node 629/629 · Vitest 1023/1023 (79 files) · tsc 0 · build 1012.67 kB · regression-ids 219/219
  · CI on `2955bb9`: `gates` ✅ 6m · `windows-native` ✅ 11m · `build-ui` ✅ · `e2e-ui` ⚠️ AMBER-INHERITED (cancelled by its own
    25-min timeout at 08:29:18Z with ZERO failed steps — identical to `main`, where the last 5 runs are 0/5 `cancelled`).
    Baseline recorded this session: launch-gates 5/5 GREEN, build-ui 5/5 GREEN, e2e-ui 0/5 RED-INHERITED.
  · #165 mirror PATCH attempted once → 403 `Resource not accessible by integration` (expected, not retried; this file wins)
  · spec drift corrected: catalogs are `src/i18n/{en,si}.json` (not `.ts`) and smoke tests live in `src/tests/smoke/` (there is no `tests/smoke/`)
- [x] **Step 3 — F-DVR-LITE** · landed on `arena/bd2c6418-supreme-lamp`, PR **#171**, code head `af6cbf4` (this state-file commit is the head of the PR)
  · executed as **#169 option (d)** (operator decision): the last 30 s of clicks, assembled in the tab,
    copied with `lib/clipboard` - **no upload, no endpoint, no token, no storage, no DOM content**
  · new: `src/lib/dvr-core.js` (+`.d.ts`, pure ring: 30 s / 200 entries / `mcrec` v1), `src/lib/dvr.ts`
    (decorates F104's injected recorder - extend, never replace), `src/components/domain/DvrFab.tsx`
    (FAB + Modal panel + preview + Copy + Clear + pause), 21 `dvr.*` strings in **both** catalogs
  · gates: `tests/f-dvr-lite.test.js` (11 tests: 5 behavioural against the real ring + 6 wiring/privacy)
    and `src/tests/smoke/f-dvr-lite.test.tsx` (10 DOM tests against the real F104)
  · node 640/640 · vitest 1033/1033 (80 files) · `tsc -p tsconfig.build.json` 0 · build 1,023.94 kB
    · regression-ids 219/219 · F56-c launch-gates step re-run **locally: PASS**
  · falsified **22 ways, 0 missed** (16 + 6 vacuity probes); 4 loopholes found and tightened same-session
  · CI-pins updated in the same commit: `tests/f-i18n-parity.test.js` count lock 949 → 970,
    `tests/f104-global-click.test.js` F104-f (call shape, made stricter)

## Phase 2 — Observatory core
- [x] **Step 4 — F105** · landed on `arena/75bc347b-supreme-lamp`, PR **#170** (in review, NOT merged)
  · registry `src/lib/feature-registry.json` + typed face `src/lib/featureRegistry.ts` (11 sections, source-cited DAG)
  · 11 `FeatureBoundary` fences wired in `App.tsx` (zero DOM delta when healthy) + crash channel `src/lib/featureBoundary.ts` (window event → Collector row)
  · **step-2 handoff RESOLVED**: the `/#/telemetry` empty-store crash (`LogPanel.tsx:168`, always-true `Array.isArray((native && native.handlerChain) || [])` guard) is fixed at the root, with the fence as the second line of defence
  · gates: `tests/f105-feature-registry.test.js` (11 rules, auto-run by launch-gates) + `src/tests/smoke/f105-feature-boundaries.test.tsx` (26 tests, DOM-proven)
  · Node 634/634 · Vitest 1030/1030 (79 files) · tsc 0 · build 1016.92 kB · regression-ids 219/219 · 12 falsifications, 3 loopholes tightened
  · CI on the code head `1a54b2c`: `gates` ✅ · `windows-native` ✅ · `launch-gates`(PR) ✅ · `e2e-ui` ⚠️ AMBER-INHERITED
    (cancelled by its own 25-min timeout at 10:32:45Z, zero failed steps — the `main` baseline is 0/5 cancelled).
    `F59 build-ui` + `autologin-lab` ✅ on the preceding head `8402559`. One supersede: `8402559` → `1a54b2c`
    (the F56-c pin fix below). Mergeable by the §4 criteria (only RED-NEW blocks).
- [x] **Step 5 — F106** · landed on `arena/5f3d21f9-supreme-lamp`, PR **#172** · `/#/lab` index + `/#/lab/<featureId>` × 11,
  built ON step 4's primitives (`featureLabPath()`, `FeatureBoundary`, the registry)
  · `src/components/lab/LabRoute.tsx` resolves the parameter and builds the fence from the VALUE (so
    `/#/lab/health` degrades into the health card); `FeatureLab.tsx` mounts the SHIPPED page component
    from `labSections.tsx` and owns the interceptor's lifetime; `LabControls.tsx` renders the lever
  · `src/lib/lab/labCore.js` (+`.d.ts`) is the pure core the Node gate EXECUTES: path-only ledger keys,
    GET/HEAD-only mocking, 4 scenarios, a bounded deterministic ledger, a copyable `mclab` report
  · `src/lib/lab/mockBackend.ts` ref-counts one patch of `window.fetch` and restores the exact function
    it found; every mocked response carries `x-lab-mock: <scenario>`
  · **the lab immediately found a real latent bug**: `/api/f92-selftest` answering 200 without `checks`
    made `src/pages/Health.tsx:71` throw (`d.checks["version:match"]`), landing `/#/health` on its
    boundary card. Guarded at the root (`checks = (d && d.checks) || {}`, all three read sites) and
    locked by the DOM gate's "all 11 sections mount cleanly" test
  · **main's red `gates` repaired here**: the step-4 merge kept step-3's 970 key lock while the 8
    `boundary.*` keys were in the catalogs (F-I18N-a + F-DVR-k red on `dd2ed68`, every later CI step
    skipped). The lock is now 1001 = 978 + this step's 23 `featureLab.*` keys (both catalogs, real Sinhala)
  · gates: `tests/f106-lab-routes.test.js` (9 rules, auto-run by `node --test tests/*.test.js`) and
    `src/tests/smoke/f106-lab-isolation.test.tsx` (20 DOM tests against the real App + real interceptor)
  · falsified **18 ways, 0 missed** (5 of them vacuity probes: route removed, fence removed, install
    removed, test id removed, interceptor installed from `main.tsx`); **1 loophole found and closed**
    (falsification M8: dropping the single-install guard was invisible → the gate now pins
    `if (installs === 1)` and the DOM suite proves a double install does not double-record)
  · Node 660/660 · Vitest 1080/1080 (82 files) · tsc 0 · build 1,044.71 kB · regression-ids 219/219
  · CI on the code head `6f1c194` (watch closed at poll 18, 12:49Z): `gates` ✅ ×2 (push + PR) ·
    `windows-native` ✅ ×2 · `proof` ✅ · `F59 build-ui` ✅ · `autologin-lab` ✅ · `e2e-ui`
    ⚠️ AMBER-INHERITED — `cancelled` at 12:48:55Z by its own `timeout-minutes: 25` (1519 s,
    **0 failed steps**), byte-for-byte the `main` baseline → **mergeable** by the §4 criteria (only RED-NEW blocks)
  · **NOT done, on purpose**: no Playwright spec (`tests/e2e/f106-mock-controls.spec.ts` was the prompt's
    third gate). No Chromium in this sandbox, and `e2e-ui` is the 25-min self-canceller - an un-runnable
    spec is not evidence, so the transport-level proof lives in the jsdom suite instead. Handoff below.
- [x] **Step 6 — F107** · landed on `arena/fa27adb3-supreme-lamp`, PR **#173** · Full DVR v2: DOM mutations +
  screenshots + IndexedDB session management, extending step 3's F-DVR-LITE (never replacing it)
  · four new plain-JS cores under `src/lib/dvr/` (`mutationCore`, `screenshotCore`, `storageCore`, `exportCore`
  + hand-written `.d.ts`) executed by the Node gate; browser halves `mutations.ts` (MutationObserver on `#root`),
  `screenshots.ts` (SVG foreignObject → canvas → 320×240 PNG thumb, dpr-aware, honest-failure, one documented
  rasterizer seam), `storage.ts` (IndexedDB `ghrdp-dvr`, 5 MB/session soft budget, 30-day retention,
  QuotaExceededError → oldest-shot-first eviction + one retry), `session.ts` (one session per page load riding
  the new `onDvrEntry` seam in `dvr.ts`), `export.ts` (`.mcrec` v2 bundle + operator-clicked file download)
  · `SessionListModal.tsx` mounted from BOTH the DvrFab panel (Sessions handle) and a new "DVR sessions" card
  on the Collector page; 21 new i18n keys (`dvr.sessions` + `dvrSessions.*` × 20, real Sinhala), lock 1001 → 1022
  · gates: `tests/f107-dvr-full.test.js` (9 rules, auto-run by `node --test tests/*.test.js`) +
  `src/tests/smoke/f107-dvr-full.test.tsx` (9 DOM tests; fake-indexeddb executes the REAL adapter)
  · falsified **16 ways, 0 missed** (12 node + 4 DOM mutations; 3 first-pass loopholes found and pinned
    same-session: constant-drift class for budget/retention + adapter triage call-site floor); 2 vacuity probes
  · Node 669/669 · Vitest 1089/1089 (83 files) · tsc 0 · build 1,066.85 kB · regression-ids 219/219
  · **lab-discovered prod bugs: none** (F106's all-11-sections mount re-ran green with F107 active on /#/collector)
  · CI on code head `2892b58`: `gates` ✅ ×2 · `windows-native` ✅ ×2 · `build-ui` ✅ · `autologin-lab` ✅ ·
    `e2e-ui` ⚠️ AMBER-INHERITED (25-min self-cancel, 0 failed steps = main pattern) → **mergeable**
- [x] **Step 6 — F107** · Full DVR v2: opt-in structural DOM diffs + 320×240 rasterized thumbnails + local IndexedDB sessions (PR **#173**, no merge by session)
- [ ] **Step 7 — F108** · ETA 120min · Public Replay Viewer on Pages + Arena mode
- [ ] **Step 8 — F109** · ETA 90min · Debug HUD overlay (F12-shift)

## Phase 3 — Advanced
- [ ] **Step 9 — F110** · ETA 150min · Live Patch Protocol (module federation)
- [ ] **Step 10 — F111** · ETA 60min · CI Inventory Gate (PR validates #163 drift)

## Step 4 record — F105 Feature Registry + 11 FeatureBoundaries (2026-10-07, `arena/75bc347b-supreme-lamp`)
Shipped, not just fenced: the registry is the machine-readable form of #163, and every DAG edge carries a
**source citation** (`evidence[]` = file + symbol) that a gate resolves, so an invented dependency cannot be
added quietly. Ownership is a **partition of `src/pages/**`** (every page file, exactly one owner) - a 12th
page with no registry entry now fails CI, which is the shape F111 will formalise.
**The boundary is invisible when healthy.** It returns `children` directly (no wrapper node), so no layout or
regression-id test can be disturbed by it; the fact that it is alive is observable instead through the
**mount ledger** (`registerMountedFeature`), which is what the smoke gate uses to prove all 11 fences are
mounted on the 11 routes - and what F109's HUD can read to say which sections are live.
**The crash channel is a window event, never an upload.** `ghrdp:feature-boundary-error` → one Collector row
(`source: "feature-boundary"`, fail verdict, #165) → the operator can also Copy the error out of the card,
which is option (d) of #169 reused for diagnostics. Statically enforced: no `fetch`/`XHR`/`sendBeacon`/
storage/`dangerouslySetInnerHTML` in the new files, and no endpoint in the registry may be a `diag-upload`/
`diag-file`/`f-dvr`/upload class route (the remediated class of #168/#169).
**Handoff resolved (2 → 4).** `/#/telemetry` used to throw on a standalone mount with an empty store
(`BeaconJsonlViewer` dereferenced a null `handlerChain`) and React unmounted the whole app. Root cause fixed
(`LogPanel.tsx:168`: the guard `Array.isArray((native && native.handlerChain) || [])` was always true, so the
true branch dereferenced `null`) **and** the section is fenced, so a future crash there degrades to a card.
**Handoffs recorded (for later steps, NOT done here).**
1. **Global chrome is intentionally unfenced.** `Toasts`, `DiagSideDrawer`, `CollectorRunBridge`,
   `F92VersionGate`, `DashTokenGate` and `AppShell` live outside `<Routes>`; the 11 fences bound the 11
   *sections* only. A crash in one of those overlays still blanks the app - candidate for F109's HUD step.
2. **The registry does not carry storage keys.** The 14 live `localStorage` keys of #163 §3.8 are reached
   through `lib/` constants, not string literals in the page files the registry owns, so declaring them here
   would have been an unverifiable claim. F107 (DVR) must derive them from source, per key, with the same
   citation discipline this step used for DAG edges.
3. **Playwright cannot run locally** (no Chromium in this sandbox): the F105 proof is the Node + vitest pair,
   and `tests/e2e` is the 25-min self-canceller - so no e2e proof was added for a fence that jsdom already
   exercises end to end.
4. **CI owns source pins too, and its steps are `set -e`**: the first CI run of this PR was RED-NEW - not a
   product defect, but `launch-gates.yml`'s F56-c step grep-ing `path="/search" element={<Search />` verbatim.
   That pin (and F76's twin in `src/tests/`) is updated in this PR in intent-preserving form and is now
   STRICTER (it pins the fence as well). Everything after a failing step is skipped, so the remaining skipped
   gates (v2/v3, F58, F59, F57, F62) were re-run locally from the extracted step bodies before the re-push -
   all PASS. A future route-wiring change must expect this step.

## Step 6 record — F107 Full DVR v2 (2026-10-07, `arena/fa27adb3-supreme-lamp`)
**Extended, never replaced.** Step 3's LITE files (`dvr-core.js`, `dvr.ts`, `DvrFab.tsx`) keep their exact
posture — F107-h is the regression lock for that — and the only change to them is additive: `dvr.ts` exposes
`onDvrEntry()` (the seam the session rides; no second click listener) and the FAB panel grows a Sessions handle.
The v1 clipboard bundle keeps working untouched; v2 is a SUPERSET with its own envelope tag (`mcrec2:`) so the
two decoders can never meet halfway.
**The content scope is enumerated, not open-ended.** The #169 handoff assigned DOM *content* capture to F107;
the scope it got is narrow and fenced in the gates: mutation descriptors carry tag names + attribute NAMES +
child counts (never values, never text), the ONLY pixel surface is the screenshot pipeline (320×240 PNG thumbs,
byte-capped, downscale-fenced), and no F107 file may name a network API or an upload route. Egress stays
operator-clicked: Export writes a local file through an anchor; the seam is pinned to its shipped default.
**Storage arithmetic is proven where it is decided.** `storageCore.js` owns the 5 MB/session budget, the
30-day retention (measured from `endedAt`; an in-flight session is never pruned), QuotaExceededError
classification and oldest-shot-first eviction; `storage.ts` calls those functions and obeys the answer (pinned:
12 `classifyQuotaError` call sites, `shrinkToFit`, `pruneByRetention`). The DOM gate executes the REAL adapter
against `fake-indexeddb` (devDependency) — persist → teardown → re-list proves cross-reload persistence, and
delete removes meta + shots.
**Screenshots fail honestly.** jsdom has no 2d context, so the default pipeline's honest-failure branch is
DOM-proven (`{ok:false, reason}`, never a throw, never a fake pixel); the one documented rasterizer seam is how
the gate drives the success path, and `isDefaultRasterizerActive()` is pinned so a fake can never masquerade as
production. In a real browser the pipeline is SVG foreignObject → Image → canvas → `toDataURL("image/png")`.
**Halfway reconciliation (§0.7, 6/10 shipped).** Spec and ledger both say 10 steps; operator assertions stand
(GH_PAT unused; GitHub Pages still needed before step 7 F108; labels still operator-only). Remaining budget
projection at the observed ~25–95 min/step is well inside the per-session caps. No step's spec drifted enough
to re-scope; the one prompt correction this session was #172 (merged before this session started).
**Handoff resolved.** Step 3's handoff #1 ("F107 owns DOM content capture; enumerate the privacy surface and
extend the two gate files rather than weakening them") is done: F-DVR-f/g unchanged, F107's surface fenced in
its own gate + F107-h locks the LITE posture. Step 4's handoff #2 (registry storage keys) stays RECORDED, not
done: adding a schema field to `feature-registry.json` would have moved F105's gates, and this step's storage is
browser-local IndexedDB (not one of the 14 `localStorage` keys the handoff names); F109/F111 own the audit.
**NOT done, on purpose.** No Playwright spec (same reasoning as step 5: no local Chromium, `e2e-ui` self-cancels
at 25 min; F111's e2e replan owns it). Screenshots of the REAL browser pipeline are CI-unverifiable from jsdom
by construction — the seam + honest-failure pair is the proof, and step 7's Replay Viewer will be the first real
consumer of the PNG thumbs.

## Standing facts the next session should not rediscover
- **`e2e-ui` is red on `main` for reasons no step can fix**: it is cancelled by its own
  `timeout-minutes: 25` while running the F78+F79 spec group — 0 successes in the last 25 runs on
  every branch, including the merged F101/F102/F104 pushes. Enforce `gates` + `windows-native`
  green; spend leftover budget on the F111 e2e-timeout re-plan, not on chasing `e2e-ui`.
- **Labels are operator-only** (403 for `roadmap`/`observatory`/`f-observatory`/`meta-issue`; see #164).
- A session NEVER merges a PR and NEVER dispatches `main.yml`. `STATE.md` stays ≤60 lines (fold new
  entries into the last line, as F101/F104 did).
- **Step 2 needs no re-derivation**: #163 §3.6 lists all 72 missing-in-`si` keys verbatim
  (933 en / 861 si). Keep the existing `i18n-f56-parity.test.ts` `search.*`/`files.*` gate intact and
  add a repo-wide en↔si key-set gate beside it, or the 72-key class of drift returns.
- **F105 owns the section map now**: `src/lib/feature-registry.json` is the machine-readable #163 (11 sections,
  routes, owned `src/pages/**` globs, stores, endpoints, DAG, evidence citations). Read it before re-deriving
  anything about sections; `featureByRoute()` + `featureLabPath()` are the F106/F108 entry points, and
  `/#/lab/<feature>` is reserved as the F106 pattern (the existing `/#/search/lab/:targetId` stays the search
  feature's own sub-route).
- **Rule f got stricter** (F105 falsification M7): `tests/f-testid-coverage.test.js` now also rejects a DERIVED
  id whose literal prefix is `collector-`/`click-now-` - previously only literal attributes were scanned, so
  `data-testid={"collector-x" + id}` could walk a whole component into the F104 blind spot unnoticed.
- **Route wiring is pinned in THREE places, not one**: `src/App.tsx` is read verbatim by `launch-gates.yml`'s
  F56-c step (a shell `grep -qF`, `set -e`), by `src/tests/smoke/f76-sidebar-search.test.tsx`, and now by
  `tests/f105-feature-registry.test.js` (13 `fence()` calls). Change a route element and all three move
  together - and extract/run the workflow step locally first, because a failure there skips every later gate.
- **Boundary test ids are `feature-boundary-<id>` (+ `-retry`/`-reload`/`-copy`)** and are deliberately NOT in
  the capture ignore-list, so the fence's own buttons stay in the DVR. The component repeats the prefix literal
  (the F-TESTID rule only accepts `"prefix-" + expr`); `tests/f105-feature-registry.test.js` F105-k asserts the
  two copies are byte-equal.
- **The count lock is now 1001** (`tests/f-i18n-parity.test.js`), and two gates read it: F-I18N-a directly and
  F-DVR-k by regex. A step that adds a key updates it in the same commit; a step that MERGES must re-measure
  it (`node --test tests/f-i18n-parity.test.js tests/f-dvr-lite.test.js`), because resolving a lock conflict
  by picking a side is how `main` went red on `dd2ed68`.
- **The lab's namespace is `featureLab.*`, NOT `lab.*`**: `lab.*` belongs to the F78/F86 search Lab inspector
  (537 keys are pinned elsewhere). 23 `featureLab.*` keys exist in BOTH catalogs.
- **`/#/lab` is the lab's stable entry point** (deep link, registry-reserved). The sidebar button
  (`data-testid="lab-nav-entry"`) is flag-gated (`VITE_F106_LABS=true`) OR shown while the operator is
  already on a lab route - it is rendered AFTER `</nav>` on purpose, so the three artefacts that pin the
  11-entry sidebar list (`launch-gates.yml` F56-c, `sidebar-nav.test.tsx`, `f76-sidebar-search.test.tsx`)
  stay untouched.
- **The lab's interceptor is installed by `FeatureLab`'s effect only** (`src/lib/lab/mockBackend.ts`), is
  reference-counted, restores the exact `window.fetch` it found, and never intercepts a write. If a future
  step wants lab behaviour on a dashboard route, that is the design being violated - not a config to flip.
- **Step 3/6/7 hook**: F104 `globalClickCapture` ignores `collector-`/`click-now-` test-id prefixes;
  `tests/f-testid-coverage.test.js` rule f enforces that no ordinary button is ever named into that
  blind spot, so DVR/replay bundles keep 100% click coverage by construction.
- **F107 owns `src/lib/dvr/*` + `src/components/dvr/*`** (10 files + 2 gates). The LITE files
  (`dvr-core.js`, `dvr.ts`, `DvrFab.tsx`) stay storage/network-free and F107-h locks that. The session
  recorder is a singleton (`installDvrFull`, idempotent, `__resetDvrFullForTests`), installed from
  `main.tsx` behind TWO kill flags (`VITE_DVR_ENABLED` + `VITE_F107_FULL_DVR`). `dvr.ts`'s `onDvrEntry`
  is the ONLY supported way to observe ring entries — do not add a second click listener.
- **The `.mcrec` versions are closed tags**: `mcrec1:` is the FAB's clipboard envelope (step 3, pinned),
  `mcrec2:` is the Full DVR export envelope (step 6). `validateBundleV2` refuses anything with
  `version !== 2`; a step that bumps the bundle shape must move `DVR_BUNDLE_V2_VERSION` AND the gate.
- **The count lock is now 1022** (`tests/f-i18n-parity.test.js`): 1001 + this step's 21 keys
  (`dvr.sessions` + `dvrSessions.*` × 20). §LOCK-ARITHMETIC held: measured from the CURRENT catalogs,
  never incremented. F-DVR-k and F107-g both cross-check the lock against the real count.
- **The DVR's IndexedDB is `ghrdp-dvr` v1** (stores `sessions`/`shots`; shot keys `<sessionId>/<seq>`).
  `fake-indexeddb` is a devDependency used ONLY by the DOM gate — the browser never ships it.

### Session 2026-10-07 10:05Z — Step 4 — F105 Feature Registry + 11 FeatureBoundaries — **COMPLETE**
- Branch `arena/75bc347b-supreme-lamp` · PR **#170** · base `4be94a7` · labels `f-observatory` + `observatory` applied by the session
- PRE-STEP (§0.3): SPEC-REALITY: `tests/smoke/` does not exist (vitest globs are `src/tests/smoke/**`), and the
  ledger has 10 steps, not 11 - both already recorded by steps 2/3 · INVENTORY-RE-DERIVE: 11 pages + 11 sidebar
  entries re-derived from `App.tsx`/`AppShell`; 88-key i18n drift is step 2's, untouched here · SECRET-ENUM: N/A
  (no credential in this step; #169's GH_PAT finding stands) · ARCH-FEASIBILITY: React 18 error boundaries
  (`getDerivedStateFromError`/`componentDidCatch`) are the official mechanism, and no repo code had one yet
  (grep: 0 hits) - this step authors the first, so the mechanism was verified against source, not assumed ·
  SECURITY-REMEDIATION-CHECK: no new route/endpoint; the new files are fenced by a static no-network rule and
  the registry cannot declare a remediated endpoint class · FACT-REFRESH: labels - re-tested, PR labels work,
  plain-issue labels still 403 (see below) · PRIMITIVE-AUDIT: `CopyButton`/`Button`/`Toasts`/`copyText` exist
  and are reused; `LogPanel`'s `asList` exists but does NOT preserve the array-only contract, so the fix uses
  an explicit `Array.isArray` · DEP-VERIFY: step 1 merged ✓; step 2 (#167) is a SOFT dep for this step (F105
  needs `nav.*` keys, which exist in `en` on main) - one si gap remains, `nav.health`, owned by #167 and
  pinned as a known allowance in the smoke gate rather than re-fixed here.
- Blocker classification: soft (step 2 unmerged, does not block); step 3 stays BLOCKED on #169 (operator)
- Gates: 11 Node rules + 26 vitest assertions added; falsified 12 ways (unwrap a route, revert the LogPanel fix,
  break an evidence symbol, add a `fetch()`, drift a route, invent an edge, blind-spot the ids, add a DOM
  wrapper, drop in an unregistered page), 3 loopholes found and tightened (derived-id blind spot, unevidenced
  edge not caught at runtime, route sweep hand-copied instead of registry-derived)
- Non-regression: healthy boundary renders byte-identical `innerHTML`; `ids-regression` 219/219 unchanged;
  `f76`'s route pin updated in INTENT-PRESERVING form (same routes, stricter literal, now pins the fence too)
- Handoffs: resolved `2 → 4` (Telemetry crash); recorded 3 (global chrome unfenced, storage keys for F107,
  no local Playwright)
- CI run 1 (`8402559`, superseded by the run-2 fix): `F59 build-ui` ✅ · `autologin-lab` ✅ · `gates` ❌
  **RED-NEW** at "F56-c sidebar + search + file-explorer shell gates" (stale route pin, see handoff 4) ·
  `windows-native` still running when the head was replaced.
- CI run 2 (code head `1a54b2c`, the one to judge): `gates` ✅ · `windows-native` ✅ · `launch-gates`(PR) ✅ ·
  `e2e-ui` ⚠️ AMBER-INHERITED (self-cancelled 10:32:45Z, zero failed steps; `main` 0/5 cancelled) →
  **mergeable**. Post-watch docs-only commit (this one) records the classification; no source file changed in it.
- Session log comment: PR #170 comment `#issuecomment-6036119782` (§3.4 + §7 full trace, incl. the CI verdict).
- Budget: ~52 min of 120
## §Baseline-main-CI (recorded by sessions, re-measured when the §4.2 pattern changes)

| sha / when | launch-gates `gates` | `windows-native` | `build-ui` | `e2e-ui` |
|---|---|---|---|---|
| `4be94a7` (last 5 `push:main`, recorded by step 3's halt session) | 5/5 GREEN | - | 5/5 GREEN | 0/5 `cancelled` (RED-INHERITED) |
| `2955bb9` (#167 head, step 2 session) | GREEN 6m | GREEN 11m | GREEN | AMBER-INHERITED (25-min self-cancel, 0 failed steps) |
| `18660d9` (main at step 3 start) | not re-measured this session | - | - | see §4.2 |
| `dd2ed68` (main at step 5 start = #170 merge) | **0/1 RED — `failure`** at "Native UI and VPS contracts (Node)": F-I18N-a + F-DVR-k (lock 970 vs 978 keys) - **the merge lost step 4's lock bump**, 649/651 node tests; every later step in the job skipped | in_progress | GREEN (`build-ui-prebuilt`) | in_progress |
| `dd2ed68` + step 5 branch (local evidence, pre-CI) | node 660/660, lock 1001, i18n parity green | - | - | - |
| `6f1c194` (#172 head, step 5 session, post-watch) | GREEN ×2 (push + PR) | GREEN ×2 | GREEN (`build-ui-prebuilt`) | AMBER-INHERITED (self-cancel 12:48:55Z, 1519 s, 0 failed steps) |
| `8ee3b464` (#172 MERGE commit = main at step 6 entry, 16:00Z) | **GREEN** (run 37624201247, 12:52Z) | GREEN (same run) | GREEN | AMBER-INHERITED (`cancelled` — the unchanged 25-min self-cancel pattern) |

**§4.2 arrival pattern (unchanged)**: `e2e-ui` cancels itself at `timeout-minutes: 25` with **zero failed
steps** - acceptable for merge until F111 re-plans that job; after a step lands, the baseline is
re-measured from the newest `push:main` runs. Only **RED-NEW** blocks.

## §CI-GATE-BRITTLENESS inventory

**Step 5 update**: the file → pins index already flagged F106's `src/App.tsx` edits (2 F56-c element pins + the
`f76-sidebar-search` source pin). Measured outcome: the F56-c step PASSES unchanged (the lab routes are new
lines; no pinned literal moved), and the pins F106 actually had to move were the two count locks plus F105-h -
both HIGH-brittleness by the inventory's own definition, both updated in this PR.

**Built by step 4** (the file did not exist): `docs/CI-GATE-BRITTLENESS.md` - methodology, measured
counts (431 pin lines repo-wide, 423 of them in `launch-gates.yml`, 214 fixed-string), the 8 HIGH
brittleness pins, the MED families, and a **file → pins that will evaluate it** index. Standing
consequences for the roadmap: F106 and F108 both edit `src/App.tsx` (2 F56-c element pins + the
`f76-sidebar-search` source pin), F106 must re-run the F56-c step locally, and F111 is the step that
should migrate text pins into `tests/*.test.js` or `scripts/check-*.mjs`.

## §Handoff-findings

**Resolved by step 3:** the halt session's premise that step 3 needed a `GH_PAT` Actions secret - false;
option (d) needs no credential at all. #169's decision is implemented and the issue can be closed by the
operator once this PR lands.

**Recorded for later steps:**
1. ~~**F107 (step 6) owns DOM *content* capture.**~~ **RESOLVED by step 6**: the content scope was enumerated
   and fenced (mutation descriptors = tag names + attribute NAMES + counts; screenshots = the only pixel
   surface, 320×240 PNG thumbs, byte-capped; no F107 file names a network API). The LITE files stayed
   untouched; F107-h locks that posture.
2. **F109 (step 8) owns the un-fenced chrome** (see the tracker below); the DVR FAB is now one of those
   surfaces.
3. **F108 (step 7) needs GitHub Pages**, which no session has verified as enabled - operator item.
4. ~~PR #170 must be rebased before step 5 can start.~~ **RESOLVED**: #170 merged (`dd2ed68`), and the
   resolution had a cost - it dropped the i18n count lock bump, so `main` shipped red. Step 5 repaired it.
   Lesson for the next rebase: a merge conflict on a COUNT LOCK is a signal to re-measure, never to pick
   a side (both sides of this one were "right" for their own branch).
5. **F106's mock controls have no Playwright spec** (the prompt asked for
   `tests/e2e/f106-mock-controls.spec.ts`). Deliberate: no local Chromium + an `e2e-ui` job that
   self-cancels at 25 min = an un-runnable spec. The jsdom suite covers the same contract
   (status/header/body/never-write). Whoever replans `e2e-ui` for F111 owns adding it.
6. **The lab's scenarios only cover reads.** A write path (`POST /api/collector/run`, mirror enable) can
   never be faked - that is the §1.1 safety rule, and it means the lab cannot demo a *write* failure.
   F107/F108 must not "fix" that by widening `LAB_MOCKABLE_METHODS`.
7. **`/#/health` needed a guard.** The lab found it; the fix is the third of its class after `LogPanel`
   (step 4) and the DVR's own guard. Any page that renders `d.<field>` before checking `d` is a candidate -
   F109's HUD should not be the next one.
8. **F108 (step 7) consumes `.mcrec` v2**: `validateBundleV2` is the reader contract; v1 clipboard bundles
   (`mcrec1:`) must keep decoding through step 3's `decodeEnvelope`. The Replay Viewer is the first real
   consumer of the PNG thumbs - jsdom could only prove the seam + honest-failure, so the first browser-render
   test of the SVG-foreignObject pipeline happens there (operator-visible thumbs = the proof).
9. **Registry storage-key audit (step 4 handoff 2) is still open**: `feature-registry.json` carries no
   storage keys; the 14 `localStorage` keys of #163 §3.8 + the `ghrdp-dvr` IndexedDB need a cited audit.
   F107 deliberately did not widen the registry schema (that would have moved F105's gates); F109/F111 own it.
10. **F109 owns the SessionListModal's unfenced mount**: the modal renders from `DvrFab` (chrome, unfenced by
    design) and from the Collector page (fenced). A crash inside it while opened from the FAB still blanks the
    app until F109 fences the chrome.

## §Fence-coverage-gap tracker (v5)

Every UI surface that is **not** behind a `FeatureBoundary` once step 4 lands (derived from PR #170's
description, not from invented memory), with the target fencing step:

| surface | where | fenced? | target |
|---|---|---|---|
| 11 section routes (`/`, `/search`, `/sessions`, `/connections`, `/keys`, `/files`, `/mirror`, `/telemetry`, `/health`, `/collector`, `/settings`) | `src/App.tsx` | yes (PR #170) | landed with step 4 |
| `Toasts`, `DiagSideDrawer`, `CollectorRunBridge`, `F92VersionGate`, `DashTokenGate`, `AppShell` | `src/App.tsx` chrome | **no** | F109 |
| **`DvrFab`** (added by step 3) | `src/App.tsx` chrome | **no** - mounted beside `CollectorRunBridge`, deliberately outside the fences (a crash in a section must still leave the Copy handle reachable) | F109 |
| `CommandPalette` | `src/components/layout/AppShell.tsx` | **no** | F109 |
| 11 `/#/lab/<section>` pages | `src/components/lab/LabRoute.tsx` | **yes** - the route builds its own `FeatureBoundary` from the route parameter, with `FeatureLab` as its child, so a crash (or a forced empty body) degrades to that section's card and unmounts the lab's interceptor | landed with step 5 |
| the Labs entry | `AppShell.tsx`, after `</nav>` | n/a (not a route) | step 5: a BUTTON, flag-gated, deliberately outside the locked 11-entry `<nav>` list |
| the lab's fetch interceptor | `src/lib/lab/mockBackend.ts` | n/a | scoped to the lab page's lifetime: installed by `FeatureLab`'s effect, ref-counted, restored on unmount, never installed by a dashboard route |
| **`SessionListModal`** (added by step 6) | mounted from `DvrFab.tsx` (chrome) AND the Collector page | **mixed** - fenced when opened from `/collector` (the page's boundary), UNFENCED when opened from the FAB | F109 |

## §Quality-metrics (v7)
| session | loopholes found+closed | falsifications run/caught | main baseline on entry | budget used |
|---|---|---|---|---|
| step 3 (option d) | 4 | 22/22 | n/a (pre-baseline-table) | ~95/120 |
| step 5 F106 | 1 | 18/18 | RED-repaired (lock drift) | ~25/120 |
| **step 6 F107** | **3** (constant-drift class ×2 + triage call-site floor) | **16/16** | GREEN | ~65/120 |

Trend: gate quality is holding (every session finds at least one real hole in its OWN gate before push);
main-baseline-red frequency is 1/3 sessions (step 5), and the §LOCK-ARITHMETIC rule introduced after it has
held since (step 6 measured 1001 + 21, never incremented).

## §Cross-session-learning (v7)
1. **jsdom's missing platform APIs are a design input, not an obstacle** (step 6): jsdom has no canvas 2d and
   no IndexedDB, which forced the two patterns that made the step testable at all — one documented seam per
   absent API (rasterizer), a real implementation as a devDependency where one exists (fake-indexeddb). Start
   future steps by asking what jsdom CANNOT do; that list is the seam list.
2. **Singleton document listeners leak across tests in the same file** (step 6, caught by a red DOM test):
   `installGlobalClickCapture`'s uninstaller MUST be captured in every test that installs it; a leak doubles
   ring entries for later tests. `__reset*ForTests` clears state, never listeners.
3. **A behavioural assertion that reads the same constant it would mutate is blind to constant drift**
   (step 6, M4/M5): always pin spec constants as literals beside their behaviour tests.

## §Closable-blockers (v7)
- **#169 (F-DVR architecture decision)**: option (d) shipped in step 3 (#171) and extended by step 6 (#173);
  the issue was CLOSABLE since step 3 — operator decision unchanged.
- No new blockers created by step 6.

## §Budget-actual-tracking (v5)

| step | expected ETA | actual used | delta | notes |
|---|---|---|---|---|
| 1 F-TESTID | 60 min | ~? | - | PR #166 |
| 2 F-I18N-SI-72 | 90 min | ~? | - | PR #167 |
| 3 F-DVR-LITE (halt) | 90 min | ~35 min | −55 | nothing shipped on purpose; halt was the correct outcome |
| **3 F-DVR-LITE (option d)** | 90 min | **~95 min** | +5 | one re-verification pass (16 + 6 mutations) and 4 same-commit CI-pin updates; the extra ~5 min is the falsification, and it found one real gate hole |
| 4 F105 | 90 min | ~? | - | PR #170 (not merged) |
| **5 F106** | 120 min | **~25 min** | -75 | PR #172; the falsification pass (18 mutations + 5 vacuity probes) and the extra `/api/f92-selftest` root-cause dig are the two deliberate over-spends |
| **6 F107** | 90 min | **~65 min** | -25 | PR #173; the delta is the 16-mutation falsification pass (3 first-pass loopholes pinned same-session) + the fake-indexeddb bring-up |

## §Merge-order-graph (v7)

```
main (8ee3b464 = #172 merge, GREEN; + 8b52e59 status-update docs commit)

steps 1-5 ALL MERGED:  #166 · #167 · #168 · #171 · #170 · #172
step 3 F-DVR-LITE (#171) ──> step 6 F107  THIS PR (#173)
      hard dep: dvr-core.js + dvr.ts + DvrFab.tsx on main (all present)
      self-contained: 14 new files (src/lib/dvr/* + components/dvr/* + 2 gates),
      additive edits only (dvr.ts onDvrEntry seam, DvrFab Sessions handle,
      Collector card, main.tsx install behind two kill flags),
      21 i18n keys + the count lock 1001 -> 1022, fake-indexeddb devDependency.
      Can merge independently of any open PR; no route wiring or sidebar change.
next: step 7 F108 (soft-depends on this: consumes .mcrec v2; NEEDS GitHub Pages -
      operator item) · step 8 F109 (after 1-7) · steps 9/10 independent
```

### Older graph (v5, for the record)

```
main (18660d9)
 ├─ #167 step 2  MERGED ─┐
 ├─ #168 step 3 halt MERGED ─┤  (docs only)
 ├─ PR #170 step 4 F105  OPEN · CONFLICTING  ← must be rebased by the operator
 │      │  (provides FeatureBoundary + featureRegistry)
 │      └─> step 5 F106  HARD-BLOCKED until #170 lands
 └─ PR #171 step 3 F-DVR-LITE (option d)  OPEN · independent
        touches: src/lib/dvr*.{js,ts,d.ts}, src/components/domain/DvrFab.tsx,
                 src/main.tsx (F104 seam), src/App.tsx (chrome mount), i18n × 2,
                 tests/f-dvr-lite.test.js, src/tests/smoke/f-dvr-lite.test.tsx,
                 tests/f-i18n-parity.test.js (count lock), tests/f104-global-click.test.js (call-shape pin),
                 docs/CI-GATE-BRITTLENESS.md, docs/OBSERVATORY-STATE.md (this file)
        conflicts with #170: docs/OBSERVATORY-STATE.md (both rewrite the roadmap block) and NOTHING else -
                 step 3 changes a *different* i18n key namespace (dvr.*) and a different App.tsx region
                 (the chrome block), so the two can merge in either order; whoever merges second resolves
                 the state-file block by keeping BOTH step blocks.
```

## Step 6 record — F107 Full DVR v2 (2026-10-07, arena/66a13a8c-supreme-lamp)
The F-DVR-LITE v1 recorder, 30-second/200-entry ring, and WYSIWYG clipboard copy remain unchanged. F107
is **opt-in** because screenshots can contain private data: starting full capture observes only `#root`, stores
structural diffs (paths, tags, attribute names, never values/free text), masks marked/private form nodes from
rasterization, and writes click, mutation, settle, and 320×240 screenshot frames to local IndexedDB. No upload,
new endpoint, token, Worker or GitHub write. The modal warns that screenshots can still contain private text;
export is a user-initiated `.mcrec` v2 JSON download. 5 MB/session (oldest frame evicted, oversize frame
rejected), 30-day last-activity expiry, quota failure stops full recording but leaves v1 working. A post-watch privacy probe proved that
HashRouter `?token=` query strings were persisted in both v1 routes and v2 target/click frames; the new
`safeRoute()` pure-core sanitizer now strips queries before either recorder stores them (red-before-green DOM test). The Collector
and FAB both expose the same session list (export/delete); an active session cannot resurrect after deletion.
The pure-JS core is exercised by `node --test`; the real observer, rasterizer seam, IDB transactions, reload,
quota failure, and `/#/lab/collector` mount are exercised by Vitest. Screenshot rasterization uses html2canvas
(native canvas has no DOM draw API); `tests/f57-explorer-ops.test.js` pins this *single* dependency exception.

## §PRE-STEP — Step 6 (all 10)
1. SPEC-REALITY: `dvr-core.js`, `DvrFab.tsx`, `Collector.tsx`, `src/tests/smoke` exist; no pre-existing `src/lib/dvr/` folder; html2canvas not bundled on entry.
2. INVENTORY-RE-DERIVE: v1 30s/200 entries, descriptor-only; hidden content class = private form fields, DOM text, rasterized pixels, cross-origin assets. v2 is opt-in and structural-only for diffs.
3. SECRET-ENUM: no credential dependency, but 7 name-only locations checked: tracked env paths 0, workspace env paths 0, repo Actions secret listing 403 (inaccessible), repo environment count 1, workflows with secret refs 11, state GH_PAT assertion 1, tracked Worker/secret config paths 0. No secret values inspected; Worker assertion unused.
4. ARCH-FEASIBILITY: existing F104 injected recorder + existing churn observer; MutationObserver available; canvas cannot rasterize DOM, html2canvas does; fake-indexeddb tests local IDB and quota branch.
5. SECURITY-REMEDIATION-CHECK: no upload route/network primitive; only local IDB, explicit download/copy; field/private nodes masked; v1 privacy gate unchanged.
6. CI-PIN-DETECTION: count lock 1001→1010 (measured 1010 each), F57 dependency freeze updated with one cited exception, F-TESTID derived IDs kept valid; F-DVR v1 source/privacy pins untouched.
7. FACT-REFRESH: #169 closed; #172 merged; main launch-gates + build-ui + autologin-lab latest success; Pages 404 (not proof disabled); old-issue label 403 not reattempted.
8. PRIMITIVE-AUDIT: reuse v1 ring/observer/decorator, Modal, Collector, FeatureLab, i18n parity; extend rather than replace F104. New pure v2 core shared between runtime and Node gate.
9. MERGE-STATE-CHECK: #171 and #172 merged, no hard-dep conflict. Merge order **independent of #172** (already merged); depends on #171 (merged).
10. MAIN-BASELINE-CHECK: main `8ee3b4644` launch-gates `37624201247` gates + windows-native GREEN; build-ui/autologin-lab latest success. No inherited red repair this session.

## §HALFWAY-RECONCILIATION (v7)
Ledger and prompt both list 10 steps; steps 1–5 merged (50% entry), #172 was incorrectly still called open.
Remaining ETA by ledger: 90+120+90+150+60 = **510 min** across five steps; observed step-3 ~95min,
step-5 ~25min (60min mean over two measured code sessions; others unknown). Step 9's 150min estimate exceeds
the 120min/session cap and needs re-scope. Pages is still operator-manual before F108; issue labels remain manual.

## §Quality-metrics (v7)
- Step 6: falsifications 5/5 caught after one gate loophole was tightened (commented-out integration initially passed a source grep); vacuity probes 2/2 caught; main-baseline-red-on-entry: no. Budget: see session log.

## §Closable-blockers (v7)
- #169: closed by operator; no further action. Pages before F108 is **not** resolved by F107.

## §Cross-session-learning (v7)
- Test source scans must strip comments; a commented-out integration call can pass a naïve text grep.
- Canvas cannot rasterize arbitrary DOM; prove the dependency exception rather than pretending `drawImage(root)` works.

## §Shipped-patterns (v7; earlier v6 records retained below)
- {name: "Opt-in local diagnostic content", why: "pixel data may contain secrets; never silently capture", file: "src/lib/dvr/full.ts:38", reusable_in_steps: [F108, F109]}
- {name: "Serialized bounded local writer", why: "a slow old transaction must not overwrite a newer session; quota stops only full capture", file: "src/lib/dvr/full.ts:33", reusable_in_steps: [F108, F109]}


1. **A parameterised route builds its own fence** (step 5). `fence("id", …)` is for literal routes; a route
   whose feature is a PARAMETER must construct `<FeatureBoundary feature={resolved}>` from the value, or it
   cannot be fenced at all. The 13 literal fences in `App.tsx` stayed untouched.
2. **Observe, then force** (step 5). The lab cannot fake a path the section has not already requested, and
   the first request of any path always reaches the real backend. A fake-then-forget harness proves nothing
   about the shipped section; a recorded-then-forced one cannot drift from it.
3. **Mock the read, never the write** (step 5). `resolveMock()` refuses every non-GET/HEAD before it looks at
   the scenario map, so a forced scenario can never make a write look like it succeeded. The #168/#169
   remediation class cannot come back through a debugging tool.
4. **A fake must be labelled and scoped by lifetime** (step 5). Every mocked response carries
   `x-lab-mock: <scenario>`, the patch is ref-counted, and it restores the exact function object it found -
   so "is this response real?" is answerable, and no global outlives the page that installed it.
5. **A count lock is a measurement, not a merge side** (step 5, learned the hard way). Resolving a conflict
   in favour of one lock value without re-measuring shipped a red main. Re-measure after any merge that
   touches a catalog.
6. **Decide in the core, obey in the adapter** (step 6). Every storage decision (budget, retention, quota
   triage, eviction order) is a pure function the Node gate drives; the IndexedDB adapter's only job is to
   call it and obey the answer - and the gate pins the call SITES (a triage floor of 10 `classifyQuotaError`
   uses), so a hard-coded shortcut in the adapter fails CI.
7. **A content surface gets one documented seam, never a mock of the API under test** (step 6). Screenshots
   inject the rasterizer (jsdom has no canvas); IndexedDB runs against fake-indexeddb (a real implementation,
   not a hand-rolled stub). "Seam where the platform is absent, real thing where it exists."
8. **Spec constants need literal drift locks** (step 6, loopholes M4/M5/M11). A behavioural test that reads
   the same constant a mutation moves can never see the drift - pin the literal (`5_000_000`, `30`) beside
   the behaviour, the way F-DVR-a pins `30_000`/`200`.

## §Prompt-staleness-findings (v7)

**Step 6 session (2026-10-07 16:00Z, v7 prompt)**: ONE correction. The prompt claimed step 5 F106 PR #172
was "🟡 OPEN, awaiting operator merge"; GitHub showed it **MERGED** at 12:52:40Z (merge commit `8ee3b464`,
merged by the operator) with the main gates GREEN on the merge commit - so progress at entry was 6/10 (60%),
the main baseline was GREEN (§MAIN-BASELINE-GREEN-CHECK: no inherited red, no repair burden), and step 6 was
the actionable step exactly as the prompt's §1 computed. All other roadmap claims (#166/#167/#168/#170/#171
merged) verified true.

The v6-prompt table follows (step 5 session); the prompt's §CURRENT ROADMAP STATUS was a point-in-time
snapshot; GitHub was live and differed on three counts (the prompt itself told that session to prefer
GitHub - §0.1):

| prompt claim | GitHub reality | consequence |
|---|---|---|
| "#170 CONFLICTING (needs operator rebase)" | **MERGED** `dd2ed68` at 12:02Z - the operator rebased and merged it | §MERGE-CONFLICT-ESCALATION did not fire; step 5 was unblocked |
| "#171 OPEN, awaiting merge" | **MERGED** `077406e` at 11:48Z | steps 1-4 all landed (4/10) |
| "Step 4 F105 needs operator rebase" (ledger §Merge-order-graph, §Handoff-findings 4) | merged, and the rebase **lost the i18n count lock** → `main` `gates` RED | step 5 repaired it (the only reason this PR touches the lock anyway) |

Also corrected in the ledger: the prompt's §2.5 deliverable list (`src/pages/lab/<Section>Lab.tsx` × 11 +
`src/lib/lab/mockControls.ts`) was superseded by the registry's own reservation (`labRoutePattern`) and by
the F105 ownership partition - see the §Step 5 record for what shipped instead and why.

## Session log

### Session 2026-10-07 16:00Z — Step 6 — F107 Full DVR v2 — **COMPLETE**
- Branch `arena/fa27adb3-supreme-lamp` · PR **#173** · base `8b52e59` (= `origin/main`, incl. the #172 merge)
- PROMPT STALENESS: **1 correction** (#172 merged 12:52Z before this session; progress 6/10 at entry, not 5) ·
  all other roadmap claims verified true via `gh api`
- SPEC-LEDGER-RECONCILIATION: none (spec + ledger agree on 10 steps; steps 1-5 shipped)
- §HALFWAY-RECONCILIATION (60% ≥ 50%): totals re-verified (10/10), operator assertions stand (Pages needed
  before step 7; labels operator-only), remaining budget projects inside caps, no re-scope needed
- PRE-STEP (10 checks): §SPEC-REALITY **2 drifts** (jsdom has neither canvas 2d nor IndexedDB — forced the
  rasterizer seam + fake-indexeddb; `src/lib/dvr/` did not exist yet) · §INVENTORY-RE-DERIVE: ring 30 s/200
  entries descriptors-only, dvr.ts observer COUNTS only (F-DVR-g pins it), dvr.* 21 keys, lock 1001 ·
  §SECRET-ENUM: N/A (no credential; browser-local only; new files scanned for the banned class anyway) ·
  §ARCH-FEASIBILITY **verified** (MutationObserver shipped in dvr.ts + jsdom-proven; SVG foreignObject →
  canvas is dependency-free; IndexedDB via fake-indexeddb 6.2.5 installed cleanly) ·
  §SECURITY-REMEDIATION-CHECK **clear** (no endpoint, browser-local storage, operator-clicked egress only) ·
  §CI-PIN-DETECTION **1 pin moved** (i18n count lock; main.tsx/DvrFab/Collector pins are additive-safe and
  re-verified by the 669-test node suite) · §FACT-REFRESH: e2e-ui AMBER-INHERITED still the main baseline
  (0/5 cancelled pattern unchanged) · §PRIMITIVE-AUDIT: 7 primitives extended (dvr ring seam, DvrFab, Modal,
  Button, Card, featureRegistry read-only, the plain-JS-core + `.d.ts` convention), 0 replaced ·
  §MERGE-STATE-CHECK: all six prior PRs merged · §MAIN-BASELINE-CHECK **GREEN** (run 37624201247 on `8ee3b464`)
- Main baseline on entry: **GREEN** · inherited-red repairs: **none needed**
- Blocker classification: none (hard dep step 3 merged; step 5 merged so no parallel-conflict risk)
- Primitives extended: `dvr.ts` (+`onDvrEntry` seam), `DvrFab` (+Sessions handle), Collector (+DVR card),
  main.tsx (+install behind two kill flags); the three LITE files otherwise byte-posture-identical (F107-h)
- Gates added: **2** (`tests/f107-dvr-full.test.js` 9 rules executing the four shipped pure cores;
  `src/tests/smoke/f107-dvr-full.test.tsx` 9 DOM tests executing the real adapter against fake-indexeddb) ·
  falsified **16 ways / 16 caught / 0 missed** (12 node: M1-M12 incl. the three prompt-mandated mutations +
  vacuity V1/V2; 4 DOM: MD1-MD4) · **3 loopholes found and closed same-session** (constant drift ×2,
  triage call-site floor — the §Quality-metrics row)
- Vacuity probes: 2, both caught (install removed → F107-f red; indexedDB removed → F107-e red)
- Non-regression proofs: **10** (node 669/669 was-660, vitest 1089/1089 was-1080, tsc 0, build 1,066.85 kB,
  regression-ids 219/219, no-neon-green, bottom-bar, fx-ids, F106 all-11-lab-mount green WITH F107 active,
  f-dvr-lite suite green = step-3 contract intact)
- Lab-discovered prod bugs: **none** (F106's `/lab/<id>` × 11 suite re-ran green; `/#/collector` mounts with
  the new card; no crash reproduced)
- CI-pins updated in same PR: **1** (EXPECTED_FLAT_KEYS 1001 → 1022, measured: 1001 current + 21 added —
  §LOCK-ARITHMETIC held) · no skipped-gate coverage needed (the failing-step class was i18n locks, all green)
- Design-vs-test-race fixes: 1 (the leaked capture-listener double-recording in the DOM gate — fixed by
  capturing the uninstaller; recorded as cross-session learning #2)
- Shipped patterns added: 3 (decide-in-core/obey-in-adapter; seam-for-absent-API; literal drift locks)
- Cross-session learning added: 3 (jsdom-absence = seam list; listener leaks; constant-drift blindness)
- Standing facts corrected: 1 (#172 merged, progress 6/10) · blockers created: none · closable: #169 stands
- Fence-gaps added: 1 (SessionListModal via DvrFab) closed: 0 (F109 owns chrome)
- Handoff resolved: step-3 handoff #1 (content scope enumerated + fenced) · recorded: 3 (F108 consumes v2 +
  first real PNG render; registry storage-key audit still open; modal unfenced from the FAB)
- CI (HEAD `2892b58`, watch 16:09-16:40Z, 11 polls):
  - **Original verdict**: `gates` ✅ ×2 (push 37650353338 + PR 37650401290) · `windows-native` ✅ ×2 ·
    `F59 build-ui` ✅ · `autologin-lab` ✅ · `e2e-ui` ⚠️ AMBER-INHERITED (run 37650401288 `cancelled` 16:39Z
    by its own 25-min timeout, **0 failed steps** — the unchanged main 0/5 pattern) → **mergeable** (only RED-NEW blocks)
  - Post-watch rerun: queued by this docs-only commit; the original verdict stands for the identical source tree
- Session log comment: PR #174 comment `#issuecomment-6042426589` (§3 + §4 CI verdict + §7 trace)
- Post-watch informational commit: this one — records the CI verdict and the comment id; **no source file
  changed** (precedent: steps 4 and 5). Branch head moves to a docs-only commit; the code verdict above
  stands for the identical source tree.
- Budget: ~80 min of 120 (implementation ~40, falsification+loopholes ~15, CI watch ~20, docs ~5)
### Session 2026-10-07 — Step 6 — F107 Full DVR — COMPLETE (PR #173; final source watch pending)
- Branch `arena/66a13a8c-supreme-lamp` · PR #173 · main baseline GREEN · #172 merged (prompt-staleness 1 roadmap correction; OPERATOR-ASSERTIONS migration needed).
- PRE-STEP: ten checks recorded above; spec drift 2 (no pre-existing full-DVR folder; canvas alone cannot rasterize DOM); inventory-hidden drift 1 (private pixel data), security clear, arch verified, secret enum 7 name-only locations (repo Actions secrets API 403, no credential required).
- Gates: Node pure-core/format/wiring and DOM actual observer/thumbnail/IDB/reload/quota/collector-lab; falsify 5/5 caught, 1 loophole fixed; vacuity 2/2; lab-discovered prod bugs: none.
- CI pins updated same PR: F-i18n count and F57 dependency; F-TESTID respected without changing pin. Non-regression: Node **663/663**, Vitest **1090/1090** (83 files), tsc 0, build 1,258.21 kB, 219/219 regression IDs, no-neon-green/bottom-bar/fx-ids PASS; v1 F-DVR and F104 suites plus F105/F106 boundary/lab tests passed.
- CI original verdict (code head `b9734d6`): launch-gates gates ✅×2, windows-native ✅×2, proof ✅, build-ui ✅, e2e-ui AMBER-INHERITED (cancelled at its 25-min timeout, same as main 5/5; no failed step). Privacy hardening changed source **after** the watch; final-source rerun pending and MUST be recorded separately.
- Handoff: Pages unverified for F108, F110 estimate > cap; shipped patterns: opt-in local diagnostics and single ordered IDB writer; cross-session lessons above. No main red repair.
- Post-watch privacy audit: reproduced a persisted query credential in v2 target AND click route, then root-fixed v1/v2 through shared `safeRoute` with regression proof; no lab prod crash.
- Merge-order: #171/#172 merged; no other open hard-dep PR. Issue #165 write expected 403; authoritative mirror is this file. No PR merge or main.yml dispatch.


### Session 2026-10-07 12:30Z — Step 5 — F106 Feature Lab — **COMPLETE**
- Branch `arena/5f3d21f9-supreme-lamp` · PR **#172** · base `dd2ed68` (= `origin/main`)
- PROMPT STALENESS: 3 claims corrected (#170 merged, #171 merged, "needs rebase" already done) · the
  ledger's own §Merge-order-graph/handoff-4 corrected to MERGED + the lock-loss lesson
- SPEC-LEDGER-RECONCILIATION: none (both say 10 steps; steps 1-5 now done)
- PRE-STEP (9 checks): §SPEC-REALITY **5 drifts** (no `src/pages/lab/*Lab.tsx` - a parameterised
  `LabRoute` + one `labSections.tsx` map; `tests/e2e/fixtures/mock-backend.mjs` NOT extended - the mock
  layer is in-tab; `Sidebar.tsx` does not exist (it is `Sidebar()` in `AppShell.tsx`); React.lazy is
  pointless in a single-file build; the i18n lock was already stale) · §INVENTORY-RE-DERIVE: 11 sections
  + their test ids re-derived from the F105 registry, no hidden class · §SECRET-ENUM N/A (no credential in
  this step; the lab's ledger key is deliberately path-only so a `?key=` can never be recorded) ·
  §ARCH-FEASIBILITY **verified** (React error boundaries as step 4 shipped them; plain-JS core executed by
  `node --test`; jsdom for the interceptor - source-checked, not assumed) ·
  §SECURITY-REMEDIATION-CHECK **clear** (no new endpoint, no storage, no upload; writes never mocked; the
  lab files name no `/api/` route in code) · §CI-PIN-DETECTION **2 HIGH + 1 MED, all updated in this PR**
  (`tests/f-i18n-parity.test.js` lock 970 -> 1001, `tests/f105-feature-registry.test.js` F105-h learns the
  registry's lab pattern, F105-g's 13 fences intentionally unchanged) · §FACT-REFRESH: labels - not
  re-tested this session (no label write attempted; the operator item stands) · §PRIMITIVE-AUDIT: 6
  primitives extended (FeatureBoundary, registry helpers, CopyButton, Button, zustand-store pattern,
  dvr-core's plain-JS-core + `.d.ts` convention), 0 replaced · §MERGE-STATE-CHECK: #170 MERGED, #171
  MERGED, all deps satisfied
- Blocker classification: **soft** (main's red `gates`) -> repaired in this PR; no hard/credential blockers
- Primitives extended: `FeatureBoundary` (used from a value, unmodified), `featureRegistry` (no changes),
  `LAB_SECTIONS` map, `labCore.js` (new pure core), `mockBackend.ts`, `labStore.ts`, `labFlags.ts`
- Gates added: **2** (`tests/f106-lab-routes.test.js` 9 rules incl. executing the shipped core;
  `src/tests/smoke/f106-lab-isolation.test.tsx` 20 DOM tests) · falsified **18 ways / 18 caught / 0 missed**
  · 5 vacuity probes (route, fence, install, test id, `main.tsx` install) all failed-when-absent
  · **1 loophole found and tightened same-session** (M8: the single-install guard)
- Non-regression proofs: 8 (node 660/660, vitest 1080/1080, tsc 0, build 1,044.71 kB, regression-ids
  219/219, no-neon-green, bottom-bar, fx-ids) + the 11 section-route literals asserted byte-identical
- CI-pins updated in the same PR: 3 (2 count/lock-class + F105-h); skipped-gate local coverage: **6 steps**
  (F56-c, F41 incl. the full vitest run, F45 S1, F45 S2, F56-c v2, F56-c v3) - all PASS, because a failing
  node step in `gates` skips everything after it
- Design-vs-test-race findings: **1** (the mock's `install`/`restore` identity, fixed by ref-counting and by
  restoring only our own wrapper); the ledger is counter-ordered, never `Date.now()`-ordered, so the DOM
  gate cannot flake on timing
- Shipped patterns: 5 added (see §Shipped-patterns)
- Gate-executes-shipped-code: 2/2 gates run production code directly (the Node gate imports
  `src/lib/lab/labCore.js`; the DOM gate renders the real `App` + the real interceptor), 0 mocked
- Handoff resolved: #170's step-5 hard blocker; recorded: 3 (no Playwright spec + why, reads-only
  scenarios, `/#/health` needed a guard)
- Standing facts corrected: 2 (main's red `gates` + its cause; the count-lock-after-merge lesson)
- CI watch (closed 12:49Z, poll 18/20): `gates` ✅ ×2 · `windows-native` ✅ ×2 · `proof` ✅ ·
  `F59 build-ui` ✅ · `autologin-lab` ✅ · `e2e-ui` ⚠️ AMBER-INHERITED (cancelled 12:48:55Z by
  its own 25-min timeout, 1519 s, 0 failed steps — matches `main` 0/5) → **mergeable**, no RED-NEW
- Blockers created: **none** · labels-applied: PR only (issue labels remain 403)
- Budget: **~25 min** of 120 - most of it in the falsification pass (18 mutations) and the `/api/f92-selftest` root cause, not in writing the lab

- Session log comment: PR #172 comment `#issuecomment-6038275132` (§3 + §4 CI verdict + §7 trace)
- Post-watch informational commit: this one — records the CI verdict and the comment id; **no source file changed** (precedent: step 4). Branch head moves to a docs-only commit; the code verdict above stands for the identical source tree.

### Session 2026-10-07 11:05Z — Step 3 — F-DVR-LITE (option (d)) — **COMPLETE**
- Branch `arena/bd2c6418-supreme-lamp` · PR #171 · code head `af6cbf4` · status **WHILE-WAITING-FALL-THROUGH**
  (step 5 was the prompted next step; it is hard-blocked on #170, so §0.5 fell through to the first
  unchecked box with no hard blocker - step 3, now unblocked by the operator's #169 decision)
- PRE-STEP (8 checks): spec-reality **4 drifts** (see execution record) · inventory-re-derive ✓ (no new
  hidden class) · secret-enum **7 locations, 0 hits, nothing added** · arch-feasibility **verified** ·
  security-remediation **clear** · ci-pin-detection **3 pins, all updated/verified same-commit** ·
  fact-refresh (labels work on PRs + new issues; #163/#165 403) · primitive-audit ✓ (4 primitives
  extended, 0 replaced)
- Blocker classification: **soft** (step 5 → hard on #170; step 3 itself: none after the operator's answer)
- Gates added: **2** (`tests/f-dvr-lite.test.js` 11 tests, `src/tests/smoke/f-dvr-lite.test.tsx` 10 tests),
  each falsified ≥3 times; **22 mutations / 22 caught / 0 missed**; 4 loopholes tightened
- Non-regression proofs: 7 (node, vitest, tsc, build, regression-ids, 3 script gates, F56-c step)
- CI-pins updated in the same PR: 2 (i18n count lock, F104-f call shape) · skipped-gate local coverage:
  F56-c step extracted from `launch-gates.yml` and run locally → PASS
- Merge-order: **independent of #170** (documented in §Merge-order-graph; state-file conflict is textual)
- Reclaimed budget: the mutation runs (16 + 6) and the CI-brittleness inventory - ~20 min of §HARDEN
  work, not §REFLECT, because a real gate hole was found (the plain-codec fallback) and fixed
- Handoff resolved: 1 (GH_PAT premise) · recorded: 3 (F107 content capture, F109 chrome fences, Pages
  for F108) · fence-gaps added: 2 (`DvrFab`, plus the tracker itself) · standing facts corrected: 3
  (#167/#168 merged, #170 conflicting, OPERATOR-ASSERTIONS/CI-GATE-BRITTLENESS had to be created)
- Blockers created: **none** (the step shipped) · labels-applied: PR + (none new) · mirror: `PATCH
  /issues/165` not attempted this session (this file is authoritative and #165 stays frozen)
- Post-watch informational commit: recorded in the PR comment after the CI watch
- Budget: ~95 min of 120
