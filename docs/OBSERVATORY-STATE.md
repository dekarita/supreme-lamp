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

**Roadmap owner**: #165 · **Inventory prerequisite**: #163 · **Updated**: 2026-10-07 22:55Z by arena/89b9650b-supreme-lamp (step-6 double-merge repair, PR #175)

## §OPERATOR-ASSERTIONS (v8; verify independently)
- GH_PAT: operator previously reported Worker environment variable; **not used** by F107 or by this repair. No secret value was read or stored.
- **Pages: ENABLED — the standing "unverified/required" assertion is now CORRECTED.** `GET /repos/dekarita/supreme-lamp` returns
  `has_pages: true` and this integration holds `admin: true`; `GET /repos/.../pages` still returns 404, which is a **token-scope
  artifact** (the Pages endpoints need a `pages: read` permission this installation lacks), NOT evidence that Pages is off.
  Publish root is **`main` / `docs`**: `docs/.nojekyll` is tracked (that file only exists to configure a Pages site served from
  its own folder), `docs/` is a committed static site (`index.html` → `explorer.html`, `search.html`, `archive.html`,
  `decrypt.html`, `sw.js`, `*.json`), and there is **no `gh-pages` branch** (30 branches: `main` + 29 `arena/*`) and **no
  Pages deploy workflow**. ⇒ **Step 7 F108 is NOT blocked on Pages.**
  ⚠️ **Constraint F108 must respect**: because the source is a branch folder, `actions/deploy-pages` is the WRONG mechanism —
  switching the repo to `source: workflow` would take the existing `docs/` site down. The viewer belongs at
  `docs/replay/index.html` (served as `/replay/` under the site root), committed like every other file in `docs/`.
- Labels: PR labels **work** (re-verified this session: `f-observatory` + `observatory` applied to PR #175 via
  `POST /issues/175/labels`; `gh pr edit --add-label` fails on the Projects-classic deprecation, so use the REST call).
  Plain-issue labels on #163/#164/#165 remain 403. #169 is closed; operator decision.

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
- [x] **Step 6 REPAIR — double-merge de-duplication** · `arena/89b9650b-supreme-lamp`, PR **#175** · step 6 shipped TWICE
  (#173 `arena/66a13a8c` + #174 `arena/fa27adb3`, two independent F107 implementations, both merged); #174's in-branch
  "accept both" resolution left main red on **all four** workflows and the tree non-compiling. #174 kept as canonical,
  #173's browser half retired, #173's `safeRoute` privacy fix preserved as `src/lib/dvr/routeCore.js`. See the session record below.
- [ ] **Step 7 — F108** · ETA 120min · Public Replay Viewer on Pages + Arena mode — **next actionable, NOT blocked on Pages**
  (see §OPERATOR-ASSERTIONS: Pages is enabled and publishes `main`/`docs`, so the viewer ships as `docs/replay/index.html`;
  do NOT add an `actions/deploy-pages` workflow). §PRE-STEP was run this session: all 8 planned paths are collision-free,
  both envelope tags (`mcrec1:` v1 clipboard, `mcrec2:` v2 export) confirmed present, and there is now exactly **ONE** v2
  producer (`exportCore.js`), so the viewer's reader contract is unambiguous.
- [ ] **Step 8 — F109** · ETA 90min · Debug HUD overlay (F12-shift)

## Phase 3 — Advanced
- [ ] **Step 9 — F110** · ETA 150min · Live Patch Protocol (module federation)
- [x] **Step 10 — F111** · landed on `arena/0fb601e2-supreme-lamp`, PR **#177** (opened this session, NOT merged) · CI Inventory Gate: the storage inventory and the step ledger are DERIVED and diffed, not hand-counted. Closes §Handoff #9 (#163 §3.8 says "14 live + 3 purged"; the tree has 21 surfaces, and `ghrdp-dash-token` is a DEAD READ - read by two files, written by nothing) and §Handoff #12 (the double-ship detector, proven by mutating the real ledger back into #173+#174). Reached by §WHILE-WAITING fall-through: step 7 belongs to open sibling #176.

## Session 2026-10-07 22:27Z — Step 6 REPAIR (double-merge de-duplication) — **COMPLETE**, PR #175

### What was found on entry (§0.3 §MAIN-BASELINE-GREEN-CHECK → **RED, all four workflows**)
`main` at `e6dc5bd` (the #174 merge, 22:27:00Z) was red everywhere, and `e2e-ui` was **not** the familiar 25-min
self-cancel — it died at *"Install dependencies (pnpm, frozen lockfile)"* in 13 s:

| workflow | verdict on `e6dc5bd` | failing step | cause |
|---|---|---|---|
| `F59 build-ui` | ❌ failure (16 s) | Build single-file bundle | `pnpm install --frozen-lockfile` |
| `e2e-ui` | ❌ failure (13 s) | Install dependencies | `pnpm install --frozen-lockfile` |
| `launch-gates` / `gates` | ❌ failure | F48 token-less mirror gates | `src/i18n/en.json` SyntaxError → F48-10 + F48-14 |
| `launch-gates` / `windows-native` | ❌ failure | F45 S4 Explorer file-API routes | 2/138, fx-lab timing (`server-ok.txt absent`, `missing [fx op=]`) — no `payloads/` file is touched by #174; classified flake, PR #175's own run is the evidence |

### Root cause: Observatory step 6 shipped TWICE
#173 (`arena/66a13a8c`, head `4ff03c1`) and #174 (`arena/fa27adb3`, head `b145098`) are **two independent F107
implementations**, and the operator merged both. #174's branch then merged `main` with an *accept-both-sides*
resolution (`b145098`), which put four damage classes on main at once:

1. `package.json` declared `fake-indexeddb` **twice** (`^6.2.5` + `6.2.4`); `pnpm-lock.yaml` carried both resolutions
   under one importer key. **Duplicate JSON keys parse fine** (last wins) → no in-repo gate could see it; the slowest
   possible detector (`--frozen-lockfile`, minutes into a runner job) was the one that did.
2. `src/i18n/{en,si}.json` were **not valid JSON**: side B's `dvr` tail concatenated onto side A's block with no comma,
   plus duplicate `dvr.sessions` / `dvr.clear`.
3. `tests/f-i18n-parity.test.js` declared `const EXPECTED_FLAT_KEYS` **twice** (1022 + 1010) — a count lock resolved by
   keeping both sides is a hard SyntaxError, and it killed the whole `gates` node lane at once.
4. `src/lib/dvr/{export,mutations,storage}.ts` had side B's chunk inserted **before the file's closing brace**
   (tsc `TS1005` ×3); `SessionListModal.tsx` carried two components; `Collector.tsx` two cards + two `dvrSessionsOpen`
   states + two modal mounts; `dvr-sessions-open` existed in two files (F-TESTID-d). Two incompatible DVRs in one tree —
   `listSessions(db)` vs `listSessions(now)` cannot share a module.

### The repair (one implementation survives; nothing of value is lost)
- **#174 is canonical** — it is what `main.tsx` wires (`installDvrFull` behind `VITE_DVR_ENABLED` + `VITE_F107_FULL_DVR`),
  what this file's roadmap checkbox describes (four plain-JS cores the Node gate executes), and what step 7 F108 is
  specced against (`validateBundleV2`, `.mcrec v2` export). Its files were restored **byte-for-byte from `4cbadb2`**
  (`git checkout 4cbadb2 -- <9 paths>`), never hand-retyped.
- **#173's browser half retired**: `full.ts` deleted; `export.ts`, `mutations.ts`, `storage.ts`, `screenshots.ts`,
  `SessionListModal.tsx`, `DvrFab.tsx`, `Collector.tsx` restored to the surviving variant.
- **#173's privacy fix KEPT, not buried with it**: `safeRoute` (strip `?token=` from a HashRouter route before it is
  recorded) now lives in its own pure core **`src/lib/dvr/routeCore.js`** (+`.d.ts`), still called at the read site in
  `dvr.ts` (`currentRoute()`), so it covers the v1 clipboard ring **and** the v2 timeline that rides it. The rest of
  `full-core.js` is retired **on purpose**: `buildFullBundle` was a SECOND `.mcrec` v2 producer, and two shapes under one
  envelope tag is a reader hazard for F108.
- **`html2canvas` removed from `dependencies`** — its only consumer was the retired rasterizer. The surviving pipeline is
  SVG foreignObject → canvas with the documented `setShotRasterizer` seam. `tests/f57-explorer-ops.test.js`'s freeze pin
  was updated **in the same commit** and now asserts the *absence*, so a re-addition needs a cited consumer.
- **Lockfiles REGENERATED, never hand-merged** (§LOCK-FILE-REGENERATION-DISCIPLINE): `pnpm install --lockfile-only` +
  `npm install --package-lock-only`. Both agree with `package.json` specifier-for-specifier, and MH-b now locks that.
- **Catalogs repaired to the UNION, verified lossless**: **1030** keys each — 0 lost vs #173's 1010, 0 lost vs #174's
  1022, 0 invented; the `dvr` namespace is byte-identical to main's pre-damage version (diffed, not assumed).
- **Count lock re-MEASURED, never incremented** (§COUNT-LOCK-AS-COMPUTED-INVARIANT): `EXPECTED_FLAT_KEYS = 1030`, ONE
  declaration, with `// measured 2026-10-07 at HEAD e6dc5bd … = 1030` above it.

### Gates added: 1 file / 5 rules — `tests/merge-hygiene.test.js` (auto-run by `node --test tests/*.test.js`)
- **MH-a** no duplicate key anywhere in `package.json` — a raw-text scanner, because `JSON.parse` hides last-wins
  duplicates — + literal pins (`fake-indexeddb` = `6.2.4`, `html2canvas` absent, `packageManager` = `pnpm@9.15.9`).
- **MH-b** BOTH lockfiles agree with `package.json` specifier-for-specifier, and no orphan `fake-indexeddb@6.2.5`
  resolution survives → a stale lock now fails in the **fast node lane**, not minutes into a runner job.
- **MH-c** both catalogs parse, no duplicate key at any depth, and the count lock is declared **exactly once** and equals
  the measured size (read from the parity gate — a second copy of the number in this file would be its own drift hazard).
- **MH-d** the retired variant stays retired: `full.ts`/`full-core.*` absent, one `listSessions`, one `saveSession`, no
  `ghrdp-dvr-v2`, one `SessionListModal` (+ one default export), one Collector state/card/mount, one
  `dvr-sessions-open` repo-wide (in `Collector.tsx`, with the FAB keeping the distinct `dvr-sessions-button`), and no
  second `buildFullBundle`.
- **MH-e** the sanitizer survived **and is still called**: behaviour pinned with literals
  (`#/collector?token=SECRET` → `#/collector`, `SAFE_ROUTE_MAX_CHARS` = `256`, a 400-char route cut to 256) plus the
  import and the call site asserted **separately**, so a refactor cannot keep one and drop the other.

### v8 session fields
- §OWN-PR-CONFLICT-preemption: rebased on latest `main` before pushing (branch base = `e6dc5bd` = current head; no rebase
  needed). Conflict surface vs open PRs: **0 files** — no open PR touches `src/lib/dvr/*`, the catalogs' `dvr` namespace,
  `package.json` or `Collector.tsx`'s DVR card. #175 is independent of every open PR and should merge FIRST.
- §FILE-PATH-COLLISIONS: **none** for this repair. New paths created: `src/lib/dvr/routeCore.js`, `routeCore.d.ts`,
  `tests/merge-hygiene.test.js` (all verified absent from `main` via `git ls-files` first). Paths DELETED: `full.ts`,
  `full-core.js`, `full-core.d.ts`.
- §LITERAL-PINS-FOR-CONSTANTS: **7** constants pinned literally (`6.2.4`, `pnpm@9.15.9`, `1030`, `256`,
  `#/collector?token=SECRET` → `#/collector`, absence of `html2canvas`, absence of `ghrdp-dvr-v2`).
- §UI-ACCUMULATOR-FILES-TOUCHED: `src/pages/Collector.tsx` (section-insert → **de-duplicated to one card**, see the new
  registry below) and `src/i18n/{en,si}.json` (namespace → union). `src/App.tsx` NOT touched.
- §LOCK-FILE-REGEN: **yes** — both `pnpm-lock.yaml` and `package-lock.json`, regenerated not merged.
- §FALSIFICATION-BUDGET-RATIO: falsification ≈ 12 min of ≈ 45 min total = **≈27%** (just under the 30-40% target; the
  over-spend was diagnosis — four independent damage classes had to be identified before any mutation could be written).
- §FALSIFY-3: **9/9 caught, 0 missed** — duplicate dep re-added · lock specifier drifted · `en.json` comma removed ·
  `si.json` key duplicated · count lock re-duplicated · `full.ts` resurrected · testid re-duplicated into the FAB ·
  `safeRoute` call site dropped **while keeping the import** (the loophole class MH-e exists for) · `SAFE_ROUTE_MAX_CHARS`
  drifted 256→512 (caught by the literal pin).
- §VACUITY-PROBES: MH-d's "files absent" and MH-b's "no orphan resolution" are absence-assertions, so each was probed by
  re-creating the thing it denies (M6 resurrected `full.ts`; M1/M2 re-added the dep and the stale specifier) — all failed
  when the damage was present, i.e. none is vacuous.
- prompt-staleness-corrections: **2** — (a) the prompt called step 6 "🟡 PR #174 (conflicts resolved … then merged)":
  #174 was **already MERGED** at 22:27:00Z, 27 s before this session's first command; (b) §OPERATOR-ASSERTIONS'
  "GitHub Pages … REQUIRED for step 7 / unverified" is **wrong in the blocking direction** — Pages is enabled, so step 7
  needs no blocker sub-issue and no §WHILE-WAITING fall-through to step 9.
- pre-step-11-checks: **all pass** (run for step 7, recorded below, since step 7 was the prompted step and the repair is
  its precondition) · main-baseline-on-entry: **RED-repaired** · inherited-red-repairs: **4 damage classes / 4 workflows**
- spec-drift: **3** (step 7): `actions/deploy-pages` is unusable with a branch-folder Pages source; the viewer artifact
  must be committed under `docs/`, not deployed by a workflow; and `vite.config.ts` should NOT gain a second entry (it is
  pinned by `build-ui.yml`'s path filter and by F59's single-file contract — a separate config or a standalone builder is
  the safe route).
- primitive-audit: ✓ (`exportCore.validateBundleV2`, `dvr-core.decodeEnvelope`, `routeCore.safeRoute`, the `*Core.js` +
  hand-written `.d.ts` convention, the "plain-JS core the Node gate EXECUTES" pattern) — 0 replaced.
- secret-enum-locations-checked: **0 needed** (no credential in this repair; nothing read, stored or added).
- arch-feasibility: **verified** (Pages publish path derived from tracked evidence: `docs/.nojekyll` + committed `docs/`
  site + no `gh-pages` branch + no deploy workflow).
- security-remediation: **clear, and one remediation PRESERVED** — the `?token=` route leak fixed by #173 survives as
  `routeCore.safeRoute`, pinned behaviourally and at its call site (MH-e). No new endpoint, no upload, no storage.
- ci-pins-detected: **2**, both updated in this same PR (F57's dependency freeze; the i18n count lock) · ci-pins-updated-same-pr: **2**
- non-regress-proofs: **7** — `pnpm install --frozen-lockfile` PASS (the failing CI step) · tsc 0 (was TS1005 ×3) ·
  node **674/674** (was 652/656 + SyntaxError) · vitest **1089/1089** (83 files) · vite build **1,068.26 kB** ·
  regression-ids **219/219** + fx-ids + no-neon-green + bottom-bar PASS · the extracted `launch-gates` **F48** step PASS.
- lab-discovered-prod-bugs: n/a (no lab run this session) · shipped-patterns-added: **2** · cross-session-learning-added: **3**
- merge-order: **independent — merge FIRST** · blockers-created: **none** · labels-applied: PR (`f-observatory`, `observatory`)
- next-actionable-step: **7 (F108)**, unblocked, with its §PRE-STEP already run.

### §4 CI verdict for this repair (watch closed 23:14Z) — code head `d8aba1f`
| workflow | verdict | vs `main` at `e6dc5bd` |
|---|---|---|
| `launch-gates` (push) | ✅ **success** — `gates` ✅ **and** `windows-native` ✅ | both were ❌ (F48 SyntaxError; F45 S4 2/138) |
| `launch-gates` (PR) | ✅ **success** | — |
| `F59 build-ui` | ✅ **success** | was ❌ in 16 s at `pnpm install --frozen-lockfile` |
| `autologin-lab` | ✅ **success** | ✅ |
| `e2e-ui` | ⚠️ **AMBER-INHERITED** — `cancelled` 23:13:57Z after **1518 s**, **0 failed steps**, at "Run F78 + F79 E2E specs" | was ❌ **RED-NEW** in 13 s with a named failed step — i.e. the install red is repaired and the job is back to its inherited self-cancel |

⇒ **mergeable by the §4 criteria** (only RED-NEW blocks); GitHub reports `mergeable: MERGEABLE`,
`mergeStateStatus: UNSTABLE` (the amber `e2e-ui`), no conflicts.
**§POST-WATCH-RERUN-OBSERVED: yes** — the docs-only commit `f252782` re-ran `launch-gates` ✅ **×2** on an
identical source tree. The `windows-native` F45 S4 failure on `e6dc5bd` did not reproduce here and no
`payloads/` file is touched by this PR, so it was cascade/flake from the un-installable tree.
- Session log comment: PR #175 comment `#issuecomment-6048770592` (§3 + §4 CI verdict + §7 trace).
- Post-watch informational commit: this one — records the CI verdict and the comment id, and re-points the two
  §Shipped-patterns citations that named the retired `full.ts`; **no source file changed** (precedent: steps 4, 5, 6).
  The code verdict above stands for the identical source tree.

### §PRE-STEP for step 7 F108 (run this session so the next one can execute directly)
1. §SPEC-REALITY: **3 drifts** (above). 2. §INVENTORY-RE-DERIVE: both envelope tags confirmed in source —
   `mcrec1:` (step 3 clipboard, `src/lib/dvr-core.js`) and `mcrec2:` (step 6 export, `src/lib/dvr/exportCore.js`);
   after this repair there is exactly **ONE** v2 producer, so the viewer needs one v2 reader (`validateBundleV2`) + the v1
   `decodeEnvelope` path. Hidden class: v2 bundles carry base64 PNG thumbs — a public viewer must not leak them by URL.
3. §SECRET-ENUM: N/A (static site, no credential; Pages publishes with GitHub's own token).
4. §ARCH-FEASIBILITY: **verified** — publish path `docs/replay/index.html`; `docs/.nojekyll` already disables Jekyll, so a
   subdirectory with its own `index.html` serves as-is.
5. §SECURITY-REMEDIATION-CHECK: clear (no endpoint, no upload). 6. §CI-PIN-DETECTION: no existing workflow mentions
   `replay`, `docs/replay` or a Pages deploy → a new build/verify step collides with nothing; note `build-ui.yml`'s path
   filter includes `vite.config.ts` and `scripts/**`.
7. §FACT-REFRESH: PR labels work (REST), Pages enabled. 8. §PRIMITIVE-AUDIT: ✓ above.
9. §MERGE-STATE-CHECK: steps 1-6 merged; #175 (this repair) must merge before F108 can build.
10. §MAIN-BASELINE-CHECK: RED on entry → repaired here.
11. §FILE-PATH-COLLISION-CHECK: all 8 planned paths **0 tracked files** — `src/replay/`, `docs/REPLAY.md`, `docs/replay/`,
   `.github/workflows/replay-viewer.yml`, `tests/f108-replay-core.test.js`, `src/tests/smoke/f108-replay-dom.test.tsx`,
   `tests/e2e/f108-replay-full.spec.ts`, `vite.replay.config.ts`. No collision, no rename needed.

## §UI-ACCUMULATOR-FILES (v8)
Files that grow by one block per step. The double merge is what happens when two sessions append to one of these without
markers, so the strategy column is now normative.

| file | growth pattern | last touching step | merge conflict strategy |
|---|---|---|---|
| `docs/OBSERVATORY-STATE.md` | one session record + checkbox line per step | step-6 repair (#175) | **keep both blocks**; never rewrite another step's record |
| `src/i18n/en.json` / `si.json` | one namespace per step (`dvr.*`, `dvrSessions.*`, `featureLab.*`, `boundary.*`) | step-6 repair (#175) | **keep both namespaces**, then RE-MEASURE the count lock; a missing comma here is a hard SyntaxError that kills the whole node lane |
| `src/pages/Collector.tsx` | one `<Card>` per step, appended before the closing `</div>` | step-6 repair (#175) — **de-duplicated from two DVR cards to one** | **append, never interleave**; one card + one state + one modal mount per feature |
| `src/App.tsx` | one fenced route per step | step 5 (F106 lab routes) | append inside `<Routes>`; **3 artifacts pin it** (`launch-gates` F56-c `grep -qF`, `f76-sidebar-search`, `f105-feature-registry` 13 `fence()` calls) |
| `package.json` + both lockfiles | one dependency per step | step-6 repair (#175) | **NEVER accept both sides**; regenerate (`pnpm install --lockfile-only`) — MH-a/MH-b now fail on a duplicate key or a stale lock |
| `tests/f-i18n-parity.test.js` | the count lock moves with every catalog edit | step-6 repair (#175) | one `const EXPECTED_FLAT_KEYS` declaration, value = measured count |

Recommended from now on: wrap a step's appended block in `<!-- F108-begin --> … <!-- F108-end -->` (docs) or a
`// [F108 §n] begin|end` comment pair (source), so a merge is append-vs-append and resolvable by "accept both".

## §FILE-PATH-COLLISION-REGISTRY (v8)
Every path a session created or deleted, so a future "new file" cannot silently replace or orphan an existing one.

| step / PR | created | deleted / retired |
|---|---|---|
| 3 F-DVR-LITE (#171) | `src/lib/dvr-core.js` (+`.d.ts`), `src/lib/dvr.ts`, `src/components/domain/DvrFab.tsx`, `tests/f-dvr-lite.test.js`, `src/tests/smoke/f-dvr-lite.test.tsx` | — |
| 4 F105 (#170) | `src/lib/feature-registry.json`, `src/lib/featureRegistry.ts`, `src/lib/featureBoundary.ts`, `src/components/primitives/FeatureBoundary.tsx`, 2 gates | — |
| 5 F106 (#172) | `src/components/lab/{LabRoute,FeatureLab,LabControls}.tsx`, `src/lib/lab/{labCore.js,mockBackend.ts,labStore.ts,labFlags.ts}`, 2 gates | — |
| 6 F107 (#174, canonical) | `src/lib/dvr/{mutationCore,screenshotCore,storageCore,exportCore}.js` (+`.d.ts`), `session.ts`, `src/components/dvr/SessionListModal.tsx`, 2 gates | — |
| 6 F107 (#173, **RETIRED by #175**) | — | `src/lib/dvr/full.ts`, `src/lib/dvr/full-core.js`, `full-core.d.ts` (superseded by #174's `session.ts` + cores; **do not resurrect** — MH-d fails) |
| 6 REPAIR (#175) | `src/lib/dvr/routeCore.js` (+`.d.ts`), `tests/merge-hygiene.test.js` | the three above; `html2canvas` dependency |
| 7 F108 (planned, verified collision-free) | `src/replay/*`, `docs/replay/index.html`, `docs/REPLAY.md`, `.github/workflows/replay-viewer.yml`, 2-3 gates | — |

## §LOCK-FILE-REGENERATION-LOG (v8)
| date | lock | why | command |
|---|---|---|---|
| 2026-10-07 | `pnpm-lock.yaml` + `package-lock.json` | the #174 merge hand-merged both (duplicate `fake-indexeddb` key + two resolutions); `--frozen-lockfile` failed on `main` in two workflows | `pnpm install --lockfile-only` + `npm install --package-lock-only` |
| 2026-10-07 | both | `html2canvas` retired with the duplicate step-6 variant (no consumer left) | same two commands |

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
  **Since #175 there is exactly ONE v2 producer** (`src/lib/dvr/exportCore.js`): the retired #173 variant's
  `buildFullBundle` also claimed `version: 2` with a different shape, which would have made F108's reader
  contract ambiguous. MH-d pins the absence of a second producer.
- **The count lock is now 1030** (`tests/f-i18n-parity.test.js`, ONE declaration): the union of the two step-6
  branches (#173's 1010 + #174's 1022 → 1030 distinct keys, verified lossless both directions).
  §COUNT-LOCK-AS-COMPUTED-INVARIANT held: measured from the CURRENT catalogs, never incremented, never
  "previous lock + delta". F-DVR-k reads the constant by regex, MH-c asserts it is declared exactly once and
  equals the measured size — so a duplicated lock is now a gate failure, not a SyntaxError in CI.
- **There is ONE Full DVR implementation** (#174's: `session.ts` + `mutationCore`/`screenshotCore`/`storageCore`/
  `exportCore` + `mutations.ts`/`screenshots.ts`/`storage.ts`/`export.ts`, IndexedDB `ghrdp-dvr` v1). The #173
  variant (`full.ts` + `full-core.js`, IndexedDB `ghrdp-dvr-v2`) is **retired**; `tests/merge-hygiene.test.js`
  MH-d fails if its files come back. Its one surviving contribution is the route sanitizer, now
  **`src/lib/dvr/routeCore.js` → `safeRoute()`**, called from `dvr.ts`'s `currentRoute()` (so v1 and v2 both
  record query-stripped routes) and pinned behaviourally + at the call site by MH-e.
- **`html2canvas` is no longer a dependency.** It was admitted as the single F57 exception for the retired
  variant's rasterizer. The surviving screenshot pipeline is SVG foreignObject → canvas → `toDataURL("image/png")`
  with the documented `setShotRasterizer` seam and an honest-failure branch. If F108 finds the foreignObject
  pipeline cannot rasterize the real dashboard (external/cross-origin assets taint the canvas), that seam is
  where an html2canvas-backed rasterizer goes — and the dependency must come back with a cited consumer,
  because F57 now asserts its ABSENCE.
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
| `30bd4d4` (#173 MERGE commit, 22:15Z) | GREEN (37695006738) | GREEN | GREEN (37695006787) | in_progress at the time #174 merged |
| **`e6dc5bd` (#174 MERGE commit = main at this session's entry, 22:27Z)** | ❌ **RED-NEW** — `gates` failed at "F48 token-less mirror gates" (`src/i18n/en.json` SyntaxError → F48-10 + F48-14); `windows-native` ❌ at F45 S4 (2/138, fx-lab timing) | ❌ **RED-NEW** | ❌ **RED-NEW** — `pnpm install --frozen-lockfile` (16 s) | ❌ **RED-NEW** — the SAME frozen-lockfile install (13 s), **not** the 25-min self-cancel |
| `d8aba1f` (#175, this repair) — LOCAL evidence | node **674/674** · extracted F48 step **PASS** | n/a locally (no Windows) | vite build **1,068.26 kB** · regression-ids 219/219 · fx-ids/no-neon-green/bottom-bar PASS · `--frozen-lockfile` PASS | vitest **1089/1089** (83 files) · tsc 0 |

**§4.2 arrival pattern (unchanged)**: `e2e-ui` cancels itself at `timeout-minutes: 25` with **zero failed
steps** - acceptable for merge until F111 re-plans that job; after a step lands, the baseline is
re-measured from the newest `push:main` runs. Only **RED-NEW** blocks.

**#175 COROLLARY — read the FAILURE MODE, not just the colour.** On `e6dc5bd` `e2e-ui` was `failure` in 13 s
with a *named* failed step ("Install dependencies (pnpm, frozen lockfile)"). That is NOT the inherited
25-min/zero-failed-steps pattern and must never be classified as AMBER-INHERITED: a fast failure with a named
step is RED-NEW until proven otherwise. Discriminator: duration < 2 min **and** ≥1 failed step ⇒ RED-NEW;
duration ≈ 25 min **and** 0 failed steps ⇒ inherited self-cancel.

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
   **#175 UPDATE — three things F108 must know before it writes a line**: (a) there is now exactly ONE v2
   producer (`exportCore.js`), so one reader is enough; (b) **Pages publishes `main`/`docs`**, therefore the
   viewer ships as a committed `docs/replay/index.html` and **must not** add an `actions/deploy-pages`
   workflow (switching the Pages source to `workflow` would take the existing `docs/` site down); (c) a public
   viewer renders base64 PNG thumbs that may contain private pixels — the load path must stay a local
   `File`/`FileReader` (or an explicit operator paste), never a URL-fetchable bundle, or a `.mcrec` becomes a
   public leak. All 8 planned paths are collision-free (§FILE-PATH-COLLISION-REGISTRY).
9. **Registry storage-key audit (step 4 handoff 2) is still open**: `feature-registry.json` carries no
   storage keys; the 14 `localStorage` keys of #163 §3.8 + the `ghrdp-dvr` IndexedDB need a cited audit.
   F107 deliberately did not widen the registry schema (that would have moved F105's gates); F109/F111 own it.
10. **F109 owns the SessionListModal's unfenced mount**: the modal renders from `DvrFab` (chrome, unfenced by
    design) and from the Collector page (fenced). A crash inside it while opened from the FAB still blanks the
    app until F109 fences the chrome.
11. **The surviving Full DVR has NO runtime off switch** (new with #175). `installDvrFull()` runs automatically
    from `main.tsx` behind two BUILD-time kill flags (`VITE_DVR_ENABLED`, `VITE_F107_FULL_DVR`); the retired
    #173 variant had a FAB toggle (`dvr-full-toggle` + `dvr.fullWarning`/`fullStart`/`fullStop`, whose i18n keys
    still exist in both catalogs and are now unreferenced). An operator who wants capture off must rebuild.
    F109's HUD is the natural home for a runtime stop; whoever adds it should reuse those three keys rather
    than inventing new ones (the count lock would move again).
12. **The roadmap can schedule the SAME step twice, and nothing detects it** (process hazard, new with #175).
    Two sessions ran step 6 in parallel (`arena/66a13a8c` → #173, `arena/fa27adb3` → #174), both titled
    "F107: Full DVR v2 …", and both were merged 12 minutes apart. Neither PR's CI could see the other: each was
    green on its own base. F111 (CI Inventory Gate) is the step that should fail a PR whose title/feature id
    matches an already-merged one, or at minimum label it `duplicate-step` for the operator. Until then the
    operator's pre-merge check is: `gh pr list --state open --search "F107 in:title"`.

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
| **step 6 REPAIR (#175)** | **1** (MH-e: an import-only pin would have passed while the `safeRoute` **call site** was dropped — the import and the call are now asserted separately) | **9/9** | **RED-repaired (all 4 workflows)** | ~45/120 |

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
4. **Duplicate JSON keys are invisible to every parse-based gate** (#175). `JSON.parse` keeps the last one and
   says nothing, so `package.json` shipped to main declaring `fake-indexeddb` twice and the only thing that
   noticed was `pnpm install --frozen-lockfile` — the slowest, most expensive detector in the repo. Scan the
   RAW TEXT for duplicate keys (MH-a/MH-c) and assert the lockfiles agree with `package.json`
   specifier-for-specifier (MH-b), so the failure lands in the fast node lane with the file name in it.
5. **"Accept both sides" is a valid strategy for prose and a fatal one for code** (#175). It worked for the
   docs and for the i18n key *union*; it produced invalid JSON in the catalogs, a doubly-declared count lock,
   three files whose appended chunk landed *before* the closing brace, two components with one name, and two
   functions with one name and incompatible signatures. Rule for the next merge: union the DATA, choose ONE
   side of the CODE, and prove the choice by running tsc + the node lane + vitest before pushing.
6. **A retired implementation's fixes must be harvested, not deleted with it** (#175). The duplicate step-6
   variant carried the only `?token=` route sanitizer in the tree; retiring the variant wholesale would have
   silently re-opened a persisted-credential leak. Before deleting a superseded file, grep it for anything a
   *security* or *privacy* gate pins, and give that piece a home in the surviving design (`routeCore.js`).
7. **Read the failure MODE, not the colour** (#175). `e2e-ui` being red is normally the inherited 25-min
   self-cancel; on `e6dc5bd` it was `failure` in 13 s with a named step. Duration + failed-step count is the
   discriminator (see the §4.2 corollary), and mis-classifying it as AMBER-INHERITED would have left main red.

## §Closable-blockers (v8)
- **#169 (F-DVR architecture decision)**: option (d) shipped in step 3 (#171) and extended by step 6 (#174);
  closed by the operator. No further action.
- **The "GitHub Pages must be enabled before step 7" blocker is DISSOLVED, not closed by an operator**: Pages
  was already enabled (#175 verified `has_pages: true` + derived the publish root from tracked evidence).
  Three sessions carried it as an open operator item; it never was one. Step 7 needs no sub-issue.
- No new blockers created by #175. The only thing standing between `main` and a readable CI signal is #175 itself.

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
| **6 REPAIR** | 0 min (unscheduled — main was red on entry) | **~45 min** | +45 | PR #175; ~20 min of it was DIAGNOSIS (four independent damage classes, two of which no in-repo gate could see), ~12 min falsification (9 mutations), ~13 min repair + verification. Bought back every later session's CI signal |

## §Merge-order-graph (v8)

```
main (e6dc5bd = #174 merge — RED on all four workflows; #175 repairs it)

steps 1-6 MERGED: #166 · #167 · #168 · #171 · #170 · #172 · #173 · #174
                  (step 6 shipped twice: #173 AND #174 — see handoff #12)

#175  step-6 REPAIR  ← MERGE THIS FIRST, it is independent of every open PR
      touches: package.json + BOTH lockfiles (regenerated), src/i18n/{en,si}.json (union, 1030),
               src/lib/dvr/{export,mutations,storage,screenshots}.ts, src/lib/dvr.ts,
               src/components/{domain/DvrFab,dvr/SessionListModal}.tsx, src/pages/Collector.tsx,
               tests/{f107-dvr-full,f-i18n-parity,f57-explorer-ops}.test.js,
               src/tests/smoke/f107-dvr-full.test.tsx
      creates: src/lib/dvr/routeCore.{js,d.ts}, tests/merge-hygiene.test.js
      deletes: src/lib/dvr/full.ts, full-core.{js,d.ts}
      Nothing else can be trusted until this lands: main cannot install, compile, build or gate.

next: step 7 F108 (HARD-depends on #175 — the tree must compile; SOFT-depends on nothing else:
      Pages is ENABLED and publishes main/docs, so no operator action is needed. Design constraint:
      ship docs/replay/index.html, do NOT add actions/deploy-pages)
      · step 8 F109 (after 1-7; now also owns handoffs #10, #11) · steps 9/10 independent
```

### Previous graph (v7, for the record)

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
- {name: "Opt-in local diagnostic content", why: "pixel data may contain secrets; never silently capture", file: "src/lib/dvr/session.ts (was full.ts:38 — that file was RETIRED by #175 when step 6's duplicate implementation was de-duplicated; the surviving equivalent is the kill-flagged install)", reusable_in_steps: [F108, F109]}
- {name: "Serialized bounded local writer", why: "a slow old transaction must not overwrite a newer session; quota stops only full capture", file: "src/lib/dvr/storage.ts + session.ts (was full.ts:33 — retired by #175; the surviving writer is the single ordered IDB path in storage.ts with storageCore deciding budget/retention/quota)", reusable_in_steps: [F108, F109]}


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
9. **Restore, don't retype** (#175). When a merge mangles files that existed intact on one side, recover them
   with `git checkout <that-side's-tip> -- <paths>` and prove the result with the suites. Nine files came back
   byte-for-byte from `4cbadb2` in one command; hand-editing them would have introduced a third variant.
10. **Gate the ABSENCE of what you retired** (#175). Deleting a duplicate implementation is not enough — the
    next merge can put it straight back. MH-d asserts the retired files do not exist, that the retired DB name
    (`ghrdp-dvr-v2`) and the second bundle builder (`buildFullBundle`) appear nowhere, and F57 now asserts
    `html2canvas` is ABSENT from `package.json`. An absence-pin turns "we chose one" into something CI enforces.

## §Prompt-staleness-findings (v8)

**Step-6 REPAIR session (2026-10-07 22:27Z, v8 prompt)**: **TWO corrections, one of them load-bearing.**
1. The prompt's roadmap said step 6 was "🟡 PR #174 (conflicts resolved by operator or next session, then
   merged)". **#174 was already MERGED** at 22:27:00Z — 27 seconds before this session's first command — so
   §MERGE-CONFLICT-ESCALATION-SELF had no subject: there was no open own-PR to rebase. Progress at entry was
   therefore 6/10 (60%) as the prompt computed, but the *reason* the next step could not start was different
   from the one the prompt predicted: not an unmerged PR, but a **red main** caused by that very merge.
2. §OPERATOR-ASSERTIONS said GitHub Pages availability was unverified and "REQUIRED for step 7", and §1
   instructed: if Pages is not enabled → create a blocker sub-issue and fall through to step 9 F110.
   **Pages IS enabled** (`has_pages: true`, this integration has `admin: true`), so the fall-through was
   unnecessary and no blocker sub-issue was created. The 404 that previous sessions recorded from
   `GET /repos/.../pages` is a **token-scope artifact** (the Pages endpoints need a `pages: read` permission
   this installation lacks) — three sessions nearly made a decision on it. Evidence for the publish root is
   in §OPERATOR-ASSERTIONS above (`docs/.nojekyll` + committed `docs/` site + no `gh-pages` branch + no
   deploy workflow), and it changes F108's DESIGN, not just its go/no-go: the viewer must be committed under
   `docs/replay/`, and an `actions/deploy-pages` workflow would break the existing site.
3. Not a staleness item but worth recording: the prompt's §CURRENT-ROADMAP-STATUS listed "Step 6 F107 Full DVR:
   🟡 PR #174" while the state file's own step-6 checkbox said "PR **#173**". Both were true — that is the
   double merge. Neither document contained the word "duplicate", which is why handoff #12 now exists.

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

## Session 2026-10-08 00:10Z — Step 10 — F111 CI Inventory Gate — **COMPLETE** (§WHILE-WAITING fall-through; step 7 belongs to sibling #176)

- Branch `arena/0fb601e2-supreme-lamp` · main baseline on entry **GREEN** (`edb4691` = the #175 merge: `gates` ✅
  `windows-native` ✅ `proof` ✅ `build-ui-prebuilt` ✅, `e2e-ui` ⚠️ cancelled = the recorded AMBER-INHERITED
  25-min self-cancel pattern, 0 failed steps). Re-measured locally before writing anything: `tsc` 0 ·
  `node --test tests/*.test.js` **674/674** · vitest 1089/1089 (83 files).
- **§SIBLING-PR-DETECTION: 1 OPEN sibling found — this session did NOT execute step 7.**
  `gh pr list --state all --search "F108 in:title"` → **#176** (`arena/48b758b2-supreme-lamp`, MERGEABLE, created
  2026-10-07T23:49:01Z = 17 min AFTER #175 merged at 23:32:07Z, so it is based on the repaired main; `gates` ✅
  `windows-native` ✅ `build-ui-prebuilt` ✅ `proof` ✅ `f56d`/`f57`/`f60` labs ✅, `e2e-ui` in progress). Writing a
  second F108 would have been the #173/#174 damage class repeated one step later, so per §SIBLING-PR-DETECTION
  ("OPEN siblings → coordinate; don't duplicate") this session **verified #176 and fell through** the §DAG to the
  independent node. §Merge-order-graph v8 says "steps 9/10 independent"; step 9 (F110) is ETA 150 min and step 8
  (F109) soft-depends on 7, so **step 10 F111 (ETA 60 min, no siblings — `F109`/`F110`/`F111 in:title` are all
  empty) was the correct fall-through.**
- **§SIBLING VERIFICATION (independent, not taken on trust).** #176's central premise was re-measured here and
  **CONFIRMED**: `GET /pages` → 200 with `build_type:"workflow"`, `source: main /`, `status: null`;
  `GET /pages/builds` → `[]`; `GET /pages/builds/latest` → 404; `GET /actions/workflows` lists the dynamic
  `pages-build-deployment`; newest `GET /deployments` (env `github-pages`) = **2026-10-01T16:42:27Z**; and
  `grep -rn "deploy-pages\|upload-pages-artifact" .github/workflows/` → **no deployer exists**. So the site is dark
  and #176's fenced `.github/workflows/replay-viewer.yml` is the missing mechanism, not a hazard. Cross-check on
  honesty: #176 claims node 684 = this session's measured 674 + its 10 new `tests/f108-replay-core.test.js` tests
  (counted: F108-a…F108-j = 10), and vitest 1096 = 1089 + its 7 DOM tests. Both arithmetic checks pass.
  **One inconsistency found in #176 and reported on the PR**: its session log below says "`tests/f108-replay-core.test.js`
  (9 tests)" and "node **683/683** (was 674 + 9 new)", but the file has **10** tests and the total is **684**, which is
  what #176's own PR body says. The PR body is right; the state-file log it appended is off by one.
- **§OPERATOR-ASSERTIONS: Pages — independently CONFIRMED, not re-corrected.** The v8 assertion in this file
  ("publish root is `main`/`docs`; do NOT add `actions/deploy-pages`; switching the source to `workflow` would take the
  docs site down") is wrong on the mechanism, and #176 already rewrote that bullet with five methods. This session
  re-derived the same verdict by a **different** route (workflow grep + deployments list + builds endpoint) rather than
  editing the same lines twice — see §PAGES-VERIFICATION-METHOD below. **The v9 prompt's Step-7 constraint
  "CRITICAL: Do NOT add actions/deploy-pages workflow … would TAKE DOWN existing docs site" is falsified**: there is no
  served site to take down.
- **§HANDOFF #9 RESOLVED (registry storage-key audit, open since step 4).** `#163 §3.8` claims **"14 live + 3
  purged-legacy"** localStorage keys. Derived from `src/` it is **21 surfaces**: 16 live (15 localStorage + **1
  IndexedDB**), 1 migration, 3 purged, **1 dead read**. #163's own count is internally consistent for what it listed
  (14 live + 3 purged = 17, all re-confirmed) and it missed exactly four:
  | surface | class | why #163 could not see it |
  |---|---|---|
  | `ghrdp.f57.opqueue` | live | F57 Explorer op queue (`QUEUE_STORAGE_KEY`, `src/lib/explorer/queue.ts`) — simply absent from the table |
  | `ghrdp-dvr` | live (**IndexedDB**) | F107/step 6 post-dates #163, and §3.8 only ever counted localStorage — the largest persistence surface in the app (recordings + base64 PNG thumbs, 5 MB/session, 30-day retention) was invisible |
  | `ghrdp-dash-token` | **dead-read** | **LATENT BUG.** Read by `src/api/fetch/index.ts:124` and `src/lib/f46.ts:51`, written by **nothing in the repo** — both reads always fall through. The canonical key is `ghrdp.dashToken` (dot, not hyphen). A shadow key one character from a credential key, invisible to a hand count |
  | `ghrdp.collector.actions.v1` | migration | Mentioned inline in §3.8's f102 row ("legacy … migrated once") but never counted as a surface |
  Declared in `src/lib/ci/storageInventory.json` (every key source-cited + classified + `i163` flag), derived by
  `scanSources()` in `src/lib/ci/inventoryCore.js`. Design drift recorded deliberately: the audit lives in its OWN
  cited file rather than widening `feature-registry.json` per feature, because F105's gates partition `src/pages`
  exactly (F105-c) and a second ownership rule for the same fact would drift from the first; surfaces instead carry a
  `surface` field validated against the registry's 11 ids plus documented `chrome`/`shared`.
- **§HANDOFF #12 RESOLVED (the roadmap can schedule the SAME step twice and nothing detects it).**
  `src/lib/ci/stepLedger.json` + `detectDuplicateStep()` / `assertNoDoubleShip()`. The double-ship rule was proven by
  mutating the REAL ledger back into the damage rather than by a synthetic fixture: setting #173 to
  `merged-canonical` makes `assertNoDoubleShip` report `no-double-ship` on **F107 naming both #173 and #174** (F111-b
  M1) — i.e. the gate fails at 2026-10-07T22:27Z. Run against today's ledger it returns `sibling-open` for any second
  **F108** PR (naming OPEN #176, label `duplicate-step`, non-blocking) and `duplicate-merged`/blocking for a second
  **F107**, and `unique` for #176 asked about itself. `F-OBSERVATORY` and `F-INVENTORY` are denylisted so a
  prompt-titled PR never collides with the step-3 halt record #168, whose title names `F-DVR-LITE` without shipping it
  (`titleNamesButDoesNotShip` + `waiverWhy`, pinned by `ledgerTitleConsistency`).
- **NEW DRIFT FOUND IN THIS FILE, recorded not rewritten.** The Step-6 roadmap line reads "landed on
  `arena/fa27adb3-supreme-lamp`, PR **#173**" — but `arena/fa27adb3` is **#174** (API-verified: #173 =
  `arena/66a13a8c` 22:15:29Z, #174 = `arena/fa27adb3` 22:27:00Z). The line describing the double-ship mis-attributes
  which PR was which, and the canonical survivor **#174 is cited as no step's PR** (it appears only in the repair
  line's prose). Both are pinned in the ledger's `knownRoadmapDrift` with a `why`, and the gate fails **both** on a new
  drift **and** on an allowlisted drift that stops being observed, so the list cannot become a rubbish drawer. Not
  edited in place: §UI-ACCUMULATOR-FILES forbids rewriting another step's record. *Operator fix, if wanted: change that
  line's `#173` → `#174`, add a `PR **#174**` citation for the canonical survivor, and delete both allowlist entries in
  the same commit.*
- Shipped: `src/lib/ci/inventoryCore.js` (+ hand-written `.d.ts`, pure: no imports, no I/O, no DOM),
  `src/lib/ci/storageInventory.json`, `src/lib/ci/stepLedger.json`, `tests/f111-ci-inventory.test.js` (11 rules,
  auto-run by `launch-gates.yml:2449` `node --test tests/*.test.js` — **no workflow edit needed**, which is why this
  gate is not vacuous). No existing file modified except this state file. Zero new dependencies (F111-k pins 8 deps /
  21 devDeps), zero i18n keys (the `EXPECTED_FLAT_KEYS = 1030` lock does not move), zero UI.
- **Non-regress proofs: 7** — node **685/685** (674 + 11 new) · vitest **1089/1089 (83 files)** unchanged ·
  `tsc -p tsconfig.build.json` **0** · regression-ids **219/219** · bottom-bar OK · fx-ids PASS (10 ids + 1 class,
  F38 collision-free) · `npm run build` + no-neon-green on the real bundle.
- **Falsified 9 ways, 0 missed** (M1–M9 are named in the gate header, each mapped to the rule that caught it). Two
  REAL BUGS were found by running the gate rather than by reasoning about it, and both are pinned now:
  **(1)** `scanSources` turned its OWN doc comment into inventory — the prose
  `// factory.open(DVR_DB_NAME, DVR_DB_VERSION)` in `inventoryCore.js` resolved cross-file and produced a phantom
  `ghrdp-dvr` entry attributed to the tooling. Fixed with `INVENTORY_TOOLING_PREFIXES` + F111-j, which proves the
  exclusion **hides nothing** (every key derivable from the whole tree is derivable from the tree minus `src/lib/ci/`)
  and pins the list to exactly one prefix so it cannot widen silently. **(2)** `extractFeatureIds` read `F12` out of
  F109's own title "(F12-shift)" — a keyboard shortcut that is *also* a real historical feature id in this repo
  (`tests/f12-closeout.test.js`); fixed with a lookahead that keeps the gate-suffix form `F107-h` but rejects
  `F12-shift`. A third was caught in the gate itself: `#163 §3.8`-style prose cross-references (`#163`, `#165`,
  `#169`) were being parsed as shipped PRs until the citation regex was narrowed to the strict `PR **#N**` form (M8).
- **§VACUITY-PROBES**: F111-g is the probe for the whole storage half — a scanner that returned every key-shaped
  literal would pass "no undeclared keys" by construction, so the gate asserts the four documented near-misses
  (`ghrdp://rdp` protocol URL, `ghrdp:feature-boundary-error` + `ghrdp:search-lane` window event names,
  `files.ops.preview.restricted` an i18n key exported as `*_KEY`) are ABSENT from the derived set, that each is really
  present in the file it cites, and that the real `ghrdp:*` keys are still found (positive control).
- **§CI-PIN-DETECTION**: no existing pin covers `src/lib/ci/` or a step ledger; nothing moved. `tests/merge-hygiene.test.js`
  MH-a (raw duplicate-JSON-key scan over all `*.json`) picks up the two new JSON files automatically — they are covered
  by the merge-hygiene baseline from the moment they land, with no edit to that gate.
- **§PRIVACY-FIX-HARVEST**: nothing retired this session, so nothing to harvest. One privacy-adjacent fact is now
  inventoried instead: `ghrdp:vncPass` is declared as a **credential at rest in the browser** with both its writers
  cited, so any new reader/writer of a secret key is a reviewed inventory change rather than a silent one.
- **§MERGE-HYGIENE-GATE**: F111-j is this session's addition to the hygiene baseline (a documented exclusion must
  prove it hides nothing). §ACCEPT-BOTH-IS-DANGEROUS: the two new files are JSON → **never accept both**; MH-a already
  scans them for duplicate keys.
- **§OWN-PR-CONFLICT-PREEMPTION**: branch is exactly main `edb4691`, so no rebase was needed. Conflict surface vs
  open #176 = **1 file** (`docs/OBSERVATORY-STATE.md`), append-only on both sides (this session appended a new
  section and deliberately did NOT re-edit the §OPERATOR-ASSERTIONS Pages bullet that #176 already rewrote) ⇒
  §ACCEPT-BOTH-IS-DANGEROUS classifies it SAFE. Zero source/test/workflow overlap: #176's 17 files and this step's 4
  share no path.
- **Merge order**: independent. Can merge before or after #176; the only shared file is append-only.
- **§DELIBERATE-UNUSED-BUDGET**: step 9 (F110 Live Patch, ETA 150 min) and the `e2e-ui` re-plan (handoff #5, "F111's
  e2e replan owns it") were **not** attempted. The e2e re-plan means editing a 25-min self-cancelling job with no
  Chromium in this sandbox — an un-runnable change is not evidence, so it stays a handoff rather than shipping a guess
  inside a 120-min cap. Recorded below.
- **Handoff recorded for the next session**: `e2e-ui` re-plan (handoff #5) is still open and is now the ONLY F111-scoped
  item left; `detectDuplicateStep` is pure and CI-ready, so wiring it into a PR workflow needs only `pull-requests: read`
  + a `gh pr list --search` feed — the core needs no rewrite to become a live pre-merge check.
