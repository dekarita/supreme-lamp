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

**Roadmap owner**: #165 · **Inventory prerequisite**: #163 · **Updated**: 2026-10-08 by arena/fa6a907d-supreme-lamp (maintenance steps M6 per-run key leak + M3 Pages freshness — see the record at the end of this file; M1 PR #182 merged, M4 PR #183 merged, M5 PR #184 merged, M2 PR #185 merged). **PHASE: the 10-step Observatory is SHIPPED** (step 9 / PR #180 merged 2026-10-08T02:40:31Z as `71f75cc`); work below this line is the post-ship maintenance phase (M1…), see §MAINTENANCE-STEPS-LOG.

## §OPERATOR-ASSERTIONS (v8; verify independently)
- GH_PAT: operator previously reported Worker environment variable; **not used** by F107 or by this repair. No secret value was read or stored.
- **Pages: ENABLED but PUBLISHING NOTHING — the v8 assertion above was WRONG IN THE DANGEROUS DIRECTION (corrected 2026-10-07, step 7).**
  v8 concluded "Pages is enabled ⇒ step 7 is not blocked ⇒ ship `docs/replay/index.html` and never add `actions/deploy-pages`".
  The first two clauses are right, the third is inverted. Measured five ways this session:
  1. `GET /repos/.../pages` → **200** (not the 404 previous sessions recorded), `build_type: "workflow"`, `source: main /`,
     `html_url: https://dekarita.github.io/supreme-lamp/`, `https_enforced: true`, `public: true`.
  2. `GET /repos/.../pages/builds` → **`[]`** (no legacy builds at all) · `GET .../pages/builds/latest` → 404.
  3. `GET /repos/.../actions/workflows` → the dynamic `pages-build-deployment` workflow exists with **16 825** historical runs,
     but the newest `GET /deployments` entry is **2026-10-01T16:42:27Z** (`creator: github-pages[bot]`, env `github-pages`) —
     while the watchdog kept committing to `main` for six more days.
  4. `GET /repos/.../pages/health` → **403 `Resource not accessible by integration`** (read-only token), and
     `POST /repos/.../pages/builds` → **403** — so this installation cannot flip or force the site from CI.
  5. **The published URL answers GitHub's own "There isn't a GitHub Pages site here"** on `/`, `/status.json` and
     `/explorer.html` (fetched 2026-10-07T23:37Z). `/status.json` is the discriminator the earlier sessions could not run:
     the watchdog rewrites that file every ~80 s, so a live legacy publisher would serve a timestamp minutes old.
  ⇒ **`has_pages: true` proves the setting is on. It does not prove the site is served.** With `build_type: workflow` and no
  workflow deploying, the site is DARK; a branch-folder source is NOT the active mechanism, so `actions/deploy-pages` is
  exactly the mechanism that is missing — adding it cannot "take the docs site down" (there is nothing being served today),
  and it is the only path that can bring it back from inside the repo (the alternative is a settings change:
  Settings ▸ Pages ▸ Source ▸ *Deploy from a branch* ▸ `main` / `docs`).
  **Blast radius of the outage**: `worker.js` line 1 is `const CORS_ORIGIN = 'https://dekarita.github.io'` — the docs site is
  the browser origin the Cloudflare Worker allows, so the dark site is a broken public surface, not cosmetics.
  **What step 7 did about it**: ships the viewer + `.github/workflows/replay-viewer.yml` (fenced `push` on the viewer's own
  paths + `workflow_dispatch`; the F108 gate rejects an unfenced deployer). `docs/replay/index.html` is still the right path
  (it is what a branch-source site would serve as `/replay/`, and what the Actions artifact serves today).
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
- [x] **Step 6 — F107** · landed on `arena/fa27adb3-supreme-lamp`, PR **#174** · Full DVR v2: DOM mutations +
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
- [x] **Step 7 — F108** · landed on `arena/48b758b2-supreme-lamp`, PR **#176** · merged 2026-10-08T00:47:09Z (`b6c1516`). Box ticked by the step-8 session: #176 appended its record but left this line `[ ]`, so "first unchecked box" pointed back at a MERGED step - the double-ship trigger. The "do NOT add `actions/deploy-pages`" clause below is FALSIFIED: #176 shipped the deployer and the site answers (four-method check, §MULTI-METHOD-VERIFICATIONS) · ETA 120min · Public Replay Viewer on Pages + Arena mode — **next actionable, NOT blocked on Pages**
  (see §OPERATOR-ASSERTIONS: Pages is enabled and publishes `main`/`docs`, so the viewer ships as `docs/replay/index.html`;
  do NOT add an `actions/deploy-pages` workflow). §PRE-STEP was run this session: all 8 planned paths are collision-free,
  both envelope tags (`mcrec1:` v1 clipboard, `mcrec2:` v2 export) confirmed present, and there is now exactly **ONE** v2
  producer (`exportCore.js`), so the viewer's reader contract is unambiguous.
- [x] **Step 8 — F109** · landed on `arena/33e36146-supreme-lamp`, PR **#178** (**MERGED** 2026-10-08 01:28:13Z by the operator as `01c94f5` (merge commit — this branch's base); the line still said "open" because it was written 41 min before a human read the PR - CI had been green for 3 h 45 min) · Debug HUD: Shift+F12 overlay, 5 panels, prod-safe default-off; fixed a lab-discovered prod bug (forced lab scenarios outliving the lab) and two F111 gate bugs (see the F109 session block) · · ETA 90min · Debug HUD overlay (F12-shift)

## Phase 3 — Advanced
- [x] **Step 9 — F110** · landed on `arena/28163f3f-supreme-lamp`, PR **#180** (opened this session; the ledger stays `open` until the operator merges, per the §POST-MERGE-ROADMAP-TICK split) · Live Patch Protocol: signed `patch` frames on the authenticated `/ws` -> `f109:toggles` -> IndexedDB `ghrdp-patches` audit -> `rollbackPlan()` in Settings. Shipped as F110a (no remote-code swap; the roadmap's "module federation" is infeasible on a singlefile build and unsafe here) with the asymmetric-signature half filed as #179 · ETA 150 min, ~55 used · node 716/716 · vitest 1126/1126 (86 files) · tsc 0 · build 1,096.80 kB · 0 new deps · 0 new i18n keys · regression-ids 219/219 · 21/21 falsifications + 5 vacuity probes (2 caught my own gate)
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
   **[M2 UPDATE]** F109 did not take it; M2 did. All six, plus `DebugHUD`, `LogonGateBanner`, `CommandPalette`
   and the transitive `SessionListModal`, are fenced by `ChromeBoundary` (10 surfaces, `chromeBoundaryCore.js`).
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
2. ~~**F109 (step 8) owns the un-fenced chrome**~~ **RESOLVED by M2** (maintenance step 2): F109 never took
   it (its F109-f gate is *about* the HUD being chrome, not about fencing chrome), and the chrome is now fenced
   by `ChromeBoundary` — 10 surfaces, each with an explicit "what is lost when it crashes" statement in
   `src/lib/chromeBoundaryCore.js`. The tracker below is updated in place.
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
10. ~~**F109 owns the SessionListModal's unfenced mount**~~ **RESOLVED by M2 (transitively)**: the modal
    renders from `DvrFab` and from the Collector page. M2 fenced `DvrFab` itself (`<ChromeBoundary
    surface="dvr-fab">`), and the modal renders INSIDE DvrFab's tree, so the FAB path is now fenced too — with
    no second fence on the modal (an unreachable-without-the-first surface is not a surface).
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
| `Toasts`, `DiagSideDrawer`, `CollectorRunBridge`, `F92VersionGate`, `DashTokenGate`, `AppShell` | `src/App.tsx` chrome | **YES (M2)** - all six, plus `DebugHUD` and `LogonGateBanner` (added after this tracker was written), through `chrome(<surface>, <mount>)` in the block after `</Routes>` and, for `shell`, as the route element | landed with M2 |
| **`DvrFab`** (added by step 3) | `src/App.tsx` chrome | **YES (M2)** - mounted beside `CollectorRunBridge`, deliberately outside the SECTION fences (a crash in a section must still leave the Copy handle reachable); the chrome fence preserves that property | landed with M2 |
| `CommandPalette` | `src/components/layout/AppShell.tsx` | **YES (M2)** - `<ChromeBoundary surface="command-palette">` inside the shell's own fence, so a crash nulls the palette only | landed with M2 |
| 11 `/#/lab/<section>` pages | `src/components/lab/LabRoute.tsx` | **yes** - the route builds its own `FeatureBoundary` from the route parameter, with `FeatureLab` as its child, so a crash (or a forced empty body) degrades to that section's card and unmounts the lab's interceptor | landed with step 5 |
| the Labs entry | `AppShell.tsx`, after `</nav>` | n/a (not a route) | step 5: a BUTTON, flag-gated, deliberately outside the locked 11-entry `<nav>` list |
| the lab's fetch interceptor | `src/lib/lab/mockBackend.ts` | n/a | scoped to the lab page's lifetime: installed by `FeatureLab`'s effect, ref-counted, restored on unmount, never installed by a dashboard route |
| **`SessionListModal`** (added by step 6) | mounted from `DvrFab.tsx` (chrome) AND the Collector page | **YES (M2)** - fenced when opened from `/collector` (the page's boundary) and now ALSO from the FAB, because the modal renders inside DvrFab's tree and DvrFab is inside `<ChromeBoundary surface="dvr-fab">`. `SessionListModal` deliberately got no fence of its own: a second fence would be a surface that cannot be reached without the first one. | closed transitively by M2 |
| `LogonGateBanner` (added by F93, after this tracker was written) | `src/components/layout/AppShell.tsx` | **YES (M2)** - a crashing banner used to blank the page it warns about | landed with M2 |
| `DebugHUD` (added by F109, after this tracker was written) | `src/App.tsx` chrome | **YES (M2)** - the HUD keeps its own `HudPanelBoundary` panels *and* now has a chrome fence, so a crash in the overlay itself cannot take the app with it | landed with M2 |

## §Quality-metrics (v7)
| session | loopholes found+closed | falsifications run/caught | main baseline on entry | budget used |
|---|---|---|---|---|
| step 3 (option d) | 4 | 22/22 | n/a (pre-baseline-table) | ~95/120 |
| step 5 F106 | 1 | 18/18 | RED-repaired (lock drift) | ~25/120 |
| **step 6 F107** | **3** (constant-drift class ×2 + triage call-site floor) | **16/16** | GREEN | ~65/120 |
| **step 6 REPAIR (#175)** | **1** (MH-e: an import-only pin would have passed while the `safeRoute` **call site** was dropped — the import and the call are now asserted separately) | **9/9** | **RED-repaired (all 4 workflows)** | ~45/120 |
| **M2 chrome unfencing** | **2** (the M12 class: `includes("emitChromeBoundaryError")` passed while the CALL was deleted — the rule now pins the call inside `componentDidCatch`; and the falsification driver's M5 mutation silently did not apply, making that row vacuous until the target was asserted) | **13/13** | GREEN (741 node / 1148 vitest on entry) | ~75/120 |

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

### Session 2026-10-07 23:35Z — Step 7 — F108 Public Replay Viewer — **COMPLETE**
- Branch `arena/48b758b2-supreme-lamp` · PR (opened this session) · main baseline on entry **GREEN** (#175 already merged —
  prompt-staleness correction #1: v9 said "#175 OPEN, mergeable; merge it first").
- §SIBLING-PR-DETECTION: **0 siblings** (`gh pr list --state all --search "F108 in:title"` and `"replay in:title"` both empty).
  No dedup decision needed; §PRE-STEP 12/12 run.
- §POST-MERGE-MAIN-VERIFICATION: main's head `edb4691` **is** the #175 merge commit; its CI was green before merge and the
  four workflows that the step-6 double merge broke are green after it. No inherited-red repair burden this session.
- §PAGES-VERIFICATION-MULTI-METHOD: **5 methods, unanimous: the site is NOT published** (see §OPERATOR-ASSERTIONS above).
  Prompt-staleness correction #2 and the session's single largest finding — v9's "Pages confirmed ENABLED … do NOT add
  actions/deploy-pages (would take docs down)" premise is falsified in the direction that *blocks delivery*.
- §DAMAGE-DETECTION-CASCADE applied: **no** (main was green on entry) · damage classes discovered: **1** (see below) ·
  privacy fixes harvested: **0 new** (the step-6 harvest, `routeCore.safeRoute`, is re-pinned at a NEW call site in the
  viewer: F108-e1 + the jsdom suite) · merge-hygiene gates added: **1** (`F108-h`, the publish-fence gate).
- Shipped: `docs/replay/{index.html,app.js,style.css}` + `docs/replay/vendor/**` (5 files, generated) · `src/replay/replayCore.js`
  (+ `.d.ts`) · `scripts/sync-replay-vendor.mjs` · `docs/REPLAY.md` · `.github/workflows/replay-viewer.yml` ·
  gates: `tests/f108-replay-core.test.js` (9 tests), `src/tests/smoke/f108-replay-dom.test.tsx` (7 tests).
- Zero new dependencies (`F108-i` pins that), zero i18n keys touched, no existing file modified except this state file.
- Non-regress proofs: 8 — `node --test tests/*.test.js` **683/683** (was 674 + 9 new) · vitest **1096/1096 (84 files)**
  (was 1089/83) · `tsc -p tsconfig.build.json` **0 errors** · vite build **1 068.09 kB** · regression-ids **219/219** ·
  no-neon-green · bottom-bar · fx-ids · vendor `--check` clean · all 15 workflow YAMLs parse (PyYAML).
- Design drift from the literal step spec, recorded deliberately: **(1)** no second vite config/`pnpm build:replay` — the page
  is hand-written static JS (the repo already paid for a build-step/bundle mismatch in step 6; a published artifact that only
  exists after a build is a class of failure Pages cannot surface). **(2)** No DOMPurify and no `innerHTML` at all: the DOM
  layer builds every node with `createElement` + `textContent`, which removes the sanitization class instead of mitigating it
  (the v2 bundle carries structure, never markup, so nothing needs sanitizing). **(3)** `src/replay/*` stays the source of
  truth and the published copies are generated + byte-pinned by the gate, instead of compiled into `docs/replay/main.js`.
- DAMAGE CLASS #5 (new): **published-copy drift** — a file under `docs/` that is a copy of a `src/` file can silently diverge
  from the shipped implementation, and the page under test would then not be the page shipped. Hygiene gate: `F108-a`
  (byte equality on every pair, and the comparator itself is falsified against a tampered scratch tree).
- §MERGE-ORDER: independent of every open PR *except* `main`'s Pages configuration; §FILE-PATH-COLLISION-CHECK: 8 planned
  paths, 0 tracked collisions; the workflow is the only new deployer (`F108-h` asserts no second one exists).
- Operator next: 1) merge this PR — the scoped `push` trigger then publishes `docs/` and the merge itself restores the site;
  2) verify `https://dekarita.github.io/supreme-lamp/replay/` (the workflow verifies it too, and fails loudly if not);
  3) if you prefer no Actions publisher, delete the `push:` block (hand-run only) or disable the workflow and set
  Settings ▸ Pages ▸ Source ▸ *Deploy from a branch* ▸ `main` / `docs`.
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

<!-- F109-begin -->
## Session 2026-10-08 00:49Z — Step 8 — F109 Debug HUD — **COMPLETE**, PR #178

- Branch `arena/33e36146-supreme-lamp` · base = main `b6c1516` (the #176 merge) · v10 prompt.
- **§PROMPT-STALENESS: 3 corrections.** (1) #176 F108 is **MERGED** (00:47:09Z, `b6c1516`), not open. (2) #177 F111 is **MERGED**
  (00:44:59Z, `b56d283`), not open. (3) `tinykeys` is **not a dependency** (package.json; F57 carries an in-repo
  "tinykeys-style" binder under `src/pages/file-explorer/`, owned by the files feature) → the HUD has its own 6-line pure matcher.
- **§SIBLING-PR-DETECTION: 0 siblings** (`F109`/`F110`/`Debug HUD`/`HUD`/`Live Patch` in:title, all states: empty).
- **§POST-MERGE-MAIN-VERIFICATION (#176 landed after #177 via a main→branch merge, `70ff560`)**: the combined tree was re-measured,
  not inferred from either PR's CI — `pnpm install --frozen-lockfile` ✓ · node **695/695** (= 674 + 10 F108 + 11 F111: the
  arithmetic of both PRs holds) · vitest **1096/1096** (84 files) · tsc 0. One **process damage** found, no code damage:
  #176's session appended its record but never ticked its roadmap line, so "first unchecked box" pointed at the MERGED step 7
  (the double-ship trigger again), and the ledger still said `open` for both #176 and #177. Fixed here (Step 7 line ticked +
  cites PR **#176**; ledger statuses → `merged` with `mergedAt`). `ledgerVsRoadmap` REQUIRES the two to move together, which is
  why the tick is not optional.
- **Shipped**: `src/lib/debugHudCore.js` (+ `.d.ts`, pure) · `src/lib/debugHud.ts` · `src/lib/featureToggles.ts` ·
  `src/components/DebugHUD.tsx` (portal overlay, 5 panels: features / network / websocket / toggles / actions) ·
  `src/components/FeatureDisabledCard.tsx` · gates `tests/f109-debug-hud.test.js` (10) + `src/tests/smoke/f109-debug-hud.test.tsx` (12).
  Wiring (additive): `App.tsx` chrome mount after `<DvrFab />` · `FeatureBoundary.tsx` reads toggles at mount ·
  `Settings.tsx` "Developer: Debug HUD" card · `useDashboardPolling.ts` 5 descriptor-only WS taps.
- **Design drift from the literal spec, recorded deliberately**: (a) mounted beside `DvrFab` in `App.tsx`, NOT inside AppShell —
  a crashed shell would take an AppShell-mounted HUD with it, violating "HUD must work when fences break"; (b) HUD panels get
  their own `HudPanelBoundary`, NOT `FeatureBoundary` — the latter registers in the F105 mount ledger, which is what the
  Features panel READS (wrapped panels would report phantom mounts); (c) toggles live in ONE literal key `f109:toggles`
  (`{"<id>":"off"}`), NOT `f109:toggles:<id>` — F111 derives only literal/const-bound keys, so a dynamic family would be an
  invisible 11-key undercount; (d) Network = passive `PerformanceObserver("resource")`, NOT an F104 stream — F104 has no
  stream (10 s per-click windows only) and a fourth `window.fetch` wrapper is exactly the hazard (e) below; (e) English-only
  developer strings (Settings' "Secret hygiene" card is the precedent) → **0 i18n keys**, lock stays 1030; the runtime
  full-capture switch reuses `dvr.fullStart`/`fullStop`/`fullWarning` (closes handoff #11's orphan-key half).
- **§LAB-DISCOVERS-PROD-BUGS: 1 (real, reproduced, fixed at the root).** `/#/lab/collector` mounts the shipped Collector,
  whose mount installs F101's PERMANENT fetch observer ON TOP of the lab's `labFetch`; the lab's restore guard
  (`window.fetch === patchedFetch`) then correctly refuses to unwrap — and `labFetch` had no off state, so **a forced lab
  scenario kept answering the real dashboard after the lab unmounted** (reproduced: real `/api/collector/state` → synthetic
  `500` + `x-lab-mock: error500` for the rest of the tab). Violates F106 invariant 1. Fix: one `live` flag per install
  generation; a retired wrapper that cannot be unwrapped becomes a pure forwarder (F104's own rule). All 4 F106 literal pins
  untouched; F106 node 9/9 + DOM 20/20 green; regression pinned twice (F109-h static + DOM, falsified: 500≠200 when reverted).
- **§DERIVED-INVENTORY-DISCOVERY / §GATE-SELF-TEST: 2 F111 gate bugs, found by RUNNING F111 against this tree.**
  (1) `STRING_CONST_RE`'s type annotation `(?::[^=]+)?` crossed `;`/newlines: the hand-written `.d.ts` line
  `export declare const HUD_ENABLED_KEY: "f109:enabled";` ran on to the next `=` (`type HudPanelId = "features" | …`) and the
  scanner derived a phantom key **`features`** — and since the first definition wins in `readdirSync` order (unordered on
  ext4), the result was filesystem-dependent. Fixed to `(?::[^=;\n]+)?`; the other 21 surfaces are provably unchanged (F111-e
  agrees on all 23). (2) `extractFeatureIds` read `F12` out of the step-8 spec's OWN PR title "(F12+Shift)" (and "Shift+F12");
  the F111 lookahead only handled "F12-shift". `ledgerTitleConsistency` would have failed the F109 entry. Fixed with chord
  look-arounds; `F12 closeout` still extracts `F12`.
- **Inventory re-measured, not incremented**: 21 → **23** surfaces (live 16 → 18): `f109:enabled`, `f109:toggles`, both
  `addedBy: "F109"`. F111-i extended in intent-preserving form: post-inventory growth (`addedBy`) is not #163 drift and must
  name a ledger feature id; the #163 drift set is still exactly the four recorded.
- **Non-regress proofs: 9** — node **705/705** (695 + 10) · vitest **1108/1108, 85 files** (1096 + 12) · tsc 0 · vite build
  **1,083.08 kB** (+15 kB) · regression-ids 219/219 · no-neon-green · bottom-bar · fx-ids · **prod default-off on the real
  bundle** (the only `setItem(<key>,"true")` sits inside `setHudEnabled(e)` behind its argument; DOM: no render, inert
  shortcut, no f109 key written, WS tap inert). F104 capture (ordinary click still recorded; HUD clicks ignored via
  `data-collector-ignore`), F105 (healthy boundary still returns `children`; F105-j/k green), F107 (build kill flags respected
  by the runtime switch) all re-proven.
- **§FALSIFY-3: 14/14 caught** (M1–M10 node, D1–D4 DOM; named in the gate header). **§VACUITY**: every static scan asserts it can
  see its target first (comment stripper keeps code; positive controls for the observer call, the hello send, the count lock);
  the DOM lab regression was falsified separately (fix reverted → `expected 500 to be 200`).
- **Test-hygiene finding**: `vi.unstubAllGlobals()` in an `afterEach` also removes `setup.ts`'s offline `fetch`/`FakeWebSocket`;
  later tests in the file then run against jsdom's REAL WebSocket (caught here as an extra real `close:1006` frame through the
  real hook tap). This gate restores only what it stubs. `f106-lab-isolation.test.tsx` uses the unstub-all pattern (not changed).
- **Labels**: REST `POST /issues/<n>/labels` (operator-only labels may 403 — recorded in the PR comment).

### §MULTI-METHOD-VERIFICATIONS (v10)
| claim (source) | method A | method B (different) | verdict |
|---|---|---|---|
| #176/#177 merged (prompt said open) | `gh pr list --state all` (mergedAt) | `git log` merge commits `b6c1516` / `b56d283` | **disagreement with prompt → current measurement wins** |
| main green after the double landing | CI: `F59 build-ui` ✅, `replay viewer` ✅ (others in progress at entry) | local: install/node/vitest/tsc on `b6c1516` | agree (GREEN) |
| Pages now publishes (was dark at 23:37Z) | `GET /deployments`: new `github-pages` deploy on `b6c1516` 00:47:13Z (first since 10-01) | run 37709567869: all 9 steps ✅ incl. "Verify the published site answers"; independent fetch of `/replay/` → the viewer page | **LIVE** — but `/status.json` on Pages is a FROZEN snapshot (ts 2026-10-07T13:19Z): F108-h fences the push trigger to viewer paths, so watchdog commits no longer republish |
| `tinykeys` available (spec) | package.json | `grep -rn tinykeys src` (only F57's in-repo binder) | **absent** → own matcher |
| F104 "fetch observer stream" (spec) | read `globalClickCapture.ts` | grep for an exported subscribe/stream API: none | **no stream** → passive resource timing |
Disagreements this session: 3 (all prompt-vs-reality) — under the 3+ halt threshold only if counted per claim class; recorded, no halt (each was resolved by measurement, none left the step unbuildable).

### §LATENT-BUGS-SURFACED (v10)
1. **Lab mock outlives the lab** (F106 × F101 ordering) — FIXED here (above).
2. **F111 const resolver hijack** via `.d.ts` declaration-only lines (+ readdir-order dependence) — FIXED here.
3. **F111 feature-id extractor** reads key chords as feature ids — FIXED here.
4. **`ghrdp-dash-token` dead read** (`src/api/fetch/index.ts:124`, `src/lib/f46.ts:51`) — still open; F109 touches no auth path, so not scanned further (handoff, unchanged).
5. **First-definition-wins in `collectStringConsts`**: two files defining the same const NAME with different values still resolve in readdir order. 0 instances today; recorded, not fixed.
Count from derived inventory: 2 (items 2, 5) — under the 5+ halt threshold.

### §KNOWN-DRIFT-REGISTRY (v10)
| drift | where | owner | status |
|---|---|---|---|
| Step 6 line cites `#173` for branch `arena/fa27adb3` (= #174) | roadmap Step 6 line | operator | open (allowlisted in `knownRoadmapDrift`, F111-d) |
| canonical #174 cited by no step line | roadmap | operator | open (allowlisted) |
| Step 7 box unchecked after merge | roadmap | — | **FIXED here** (ticked + cites PR **#176**) |
| ledger #176/#177 `open` after merge | stepLedger.json | — | **FIXED here** (`merged` + `mergedAt`) |
| §OPERATOR-ASSERTIONS Pages bullet + Step 10 line's "NOT merged" prose | this file | operator | prose only; not rewritten (another step's record) |
| `/status.json` on Pages frozen at deploy time | `.github/workflows/replay-viewer.yml` fence | operator | new; see Operator next |

### §MINIMAL-FOOTPRINT-STEPS (v10)
| step | package.json | lockfiles | i18n keys | workflows | conflict surface |
|---|---|---|---|---|---|
| 7 F108 (#176) | 0 | 0 | 0 | +1 (fenced deployer) | 1 shared file (this one) |
| 10 F111 (#177) | 0 | 0 | 0 | 0 | 1 shared file |
| **8 F109 (this)** | **0** | **0** | **0** | **0** | append-only: this file, `storageInventory.json`; additive: `App.tsx` (+7, no pinned literal moved — F56-c/f76/F105 green), `Settings.tsx`, `FeatureBoundary.tsx`, `useDashboardPolling.ts`, `mockBackend.ts`; pins moved in-PR: F111-c/e/i |

### Handoffs recorded (NOT done here)
- **Chrome fencing (handoffs #2/#10) is still open**: `Toasts`, `DiagSideDrawer`, `CollectorRunBridge`, `VersionGate`,
  `DashTokenGate`, `DvrFab` (+ FAB-opened `SessionListModal`), `CommandPalette` remain unfenced. F109 made the HUD itself
  crash-proof (own boundaries, mounted outside AppShell) and visible-when-broken, but wrapping six chrome mounts moves the
  `App.tsx` pins and deserves its own falsified step. Candidate: a `ChromeBoundary` (renders null + emits
  `ghrdp:feature-boundary-error` with a `chrome:<name>` id), zero DOM delta when healthy.
- **F110 (step 9) is the last unshipped step**; independent of F109. Its "live swap" half should read F109's toggles/feature
  state rather than add a second disable mechanism.
- `e2e-ui` re-plan (handoff #5) still open.
- **Budget**: ~125 min of 120 — overrun justified under §BUDGET-OVERRUN-WHEN-JUSTIFIED: the lab-cascade reproduction/fix and
  the two F111 gate bugs are critical safety verification (a debugging tool leaking fake failures into the live dashboard;
  an inventory gate whose result depended on directory order).
### §4 CI verdict for PR #178 (watch closed 01:27Z) — code head `0a86a60`
| check | result | classification |
|---|---|---|
| `gates` (launch-gates) | ✅ 3m13s | GREEN |
| `windows-native` | ✅ 10m50s | GREEN |
| `proof` | ✅ 5m39s | GREEN |
| `build-ui-prebuilt` | ✅ 37s | GREEN |
| `f56d-qbt-lab` / `f57-explorer-lab` / `f60-warm-lab` | ✅ | GREEN |
| `e2e-ui` | in progress at watch close: install ✅ (frozen lockfile), build ✅, inside "Run F78 + F79 E2E specs" with **0 failed steps** | ⚠️ **AMBER-INHERITED** (the recorded 25-min self-cancel step; NOT the #175 RED-NEW fast-failure class) |
Main `b6c1516` (CI, independent of the local run): launch-gates ✅ · build-ui ✅ · autologin-lab ✅ · replay viewer ✅ · e2e-ui cancelled (inherited). **Verdict: mergeable.** This post-watch commit is docs-only.
<!-- F109-end -->

---

## Session 2026-10-08 01:31Z — Step 9 — F110 Live Patch Protocol — **COMPLETE**, PR **#180** (the roadmap's last step)

- Branch `arena/28163f3f-supreme-lamp` · base = main `01c94f5` = **#178's merge commit** (mergedAt 2026-10-08
  01:28:13Z, i.e. this session started ~3 min after step 8 landed) · **v11 prompt** · 17 files / **+2417 −26** ·
  **0 new deps** · **0 new i18n keys** (lock 1030) · node **716/716** (was 705, +11) · vitest **1126/1126, 86 files**
  (was 1108/85, +18) · tsc 0 · build **1,096.80 kB** (+13.72 over step 8's 1,083.08) · regression-ids 219/219 ·
  no-neon-green · bottom-bar · fx-ids · §7 budget ~55 min of the 150 ETA (early-stop at 45 min of *waiting* never
  triggered: CI entry checks were seconds; the 90-min overrun threshold is far away).
- **Shipped** (`src/lib/livePatch/` + `src/components/livePatch/`): `patchCore.js` **329 lines / 32 exports** (+ a
  112-line hand-written `.d.ts`, 41 declaration lines) · `channel.ts` 283 (provider seam + ingest + prime + rollback)
  · `state.ts` 148 (arm flag, cross-tab sync, injectable reloader) · `audit.ts` 182 (IndexedDB) ·
  `PatchAuditPanel.tsx` 153 (Settings ▸ Developer) · `tests/f110-live-patch.test.js` 596 (11) ·
  `src/tests/smoke/f110-live-patch.test.tsx` 466 (18). Wiring: `useDashboardPolling.ts` (forward patches before
  `setProgress`), `Settings.tsx` (one `<PatchAuditPanel />`), `featureToggles.ts` (second enabler),
  `FeatureDisabledCard.tsx` (copy), both `src/lib/ci/*.json` inventories.
- **§PROMPT-STALENESS: 3 corrections.** (1) §1 "F110 is #174 OPEN, mergeable, needs a 6th manual label" → #174 is
  **F107's** canonical PR, **MERGED 2026-10-07 22:27:00Z**, `labels: [f-observatory, observatory]`;
  `gh pr list --search "F110 in:title" --state all` → empty. So there was no PR to label and the "re-check at commit
  time" clause is void (`#163/#164/#165` are closed). (2) §4.2 "F101 keepalive is still 45 s" → the shipped watchdog is
  **30 s** (`websocketWatchdogCore.js:37`, `App.tsx:107` passes no opts) → `PATCH_MAX_AGE_MS = 120000` is 4 × the real
  cadence (and 2.7× under the prompt's number: no window widened). (3) §2.2 named a Playwright spec for the row cap;
  `e2e-ui` runs only on `src/**`/`tests/e2e/**` changes and is step 8's 25-min self-canceller with no Chromium here,
  so the proof runs in jsdom with **fake-indexeddb driving real transaction semantics** instead.
  No halt: all three were resolved by measurement, none left the step unbuildable.
- **Design vs spec, and the crypto** (full table in the PR body): `jose` does **not** exist in this tree (F109-j pins 8
  deps / 21 devDeps; adding a 22nd was out of budget) → the MAC is **WebCrypto HMAC-SHA256** over
  **the dashboard token itself**, resolved by F94's `getDashToken()` (three sources: `?key=`, `#key=`,
  `localStorage["ghrdp.dashToken"]`), used **raw** - no derivation, no second copy, floor `PATCH_MAC_KEY_MIN = 16`. `verify*` exists **twice, both in the core**
  (`verifyPatchFrame`, `verifyPatchSignature`); `grep -c "function verify" src/lib/livePatch/{channel,state,audit}.ts`
  = **0** → one implementation. (There is **no** `computeDashboardSignature` and no date-salted key derivation in this
  tree - f46.ts is credential encryption, not token signing. The design sketch this session began from assumed one
  existed; measured before writing it down, and the shipped code does not claim it either: `grep -n "f46" 
  src/lib/livePatch/*` is empty.) Ed25519 (the spec's literal ask) is #179, and the reason is key distribution, **not**
  speed: measured on node v22's WebCrypto (1000–2000 ops) HMAC sign **0.097** / verify **0.060** ms, Ed25519 sign
  0.121 / verify **0.201** ms, P-256 0.115/0.189, canonicalize+encode 0.0008 → a full 200-row replay costs **40 ms**
  with asymmetric crypto.
- **§LAB-DISCOVERS-PROD-BUGS: 3 shipped as fixes** (each first proven with a trace, so none is a guess):
  the rollback button's row-count vs `rollbackPlan()` mismatch ("Roll back 2" over an empty plan, an empty marker row,
  no restore, `armed=false` without a reload); `appendAuditRow`'s **single**-transaction put+trim, which dies
  permanently once the cap is crossed (IDB auto-commits an idle transaction ⇒ `Transaction is dead`, `durable:false`
  forever, rollback silently degraded to this-session-only) — fixed with a put tx + a trim tx over a shared `readAll`,
  `db.close()` in `finally` on all three paths, `trim-error:` surfaced; and `primeAudit()`'s awaited read **clobbering**
  rows applied during the mount (now a `primeToken` generation guard that **merges** `res.value.concat(rows)` only while
  current, bumped by `forgetAuditLog` and the test reset).
- **Two non-bugs, recorded so nobody "fixes" correct code** (both were MY wrong expectations, settled by printing a
  `Storage.prototype.setItem` write trace before touching source): `rollbackPlan` restoring each row's **own** `prev`
  is right (two patches to one feature ⇒ the earlier row's `prev` wins until the marker), and a healthy
  `FeatureBoundary` renders **zero** extra DOM (there is no `feature-boundary-<id>` element unless a fallback shows).
- **§GATE-SELF-TEST: 2 bugs in my own new gate, both caught by probing rather than by green.** A whole-file `indexOf`
  ordering rule was **vacuous** (the export precedes the caller ⇒ always true) — now scanned inside `verifyPatchFrame`;
  and a `split("/** Forget")` slice was invisible to the comment-stripped source (`CODE()` strips comments first), so
  the append-body rule had silently widened to `clearAudit`'s transaction and reported "3" — which is what led me to
  the trim bug. Slices now anchor on `export async function clearAudit`. Both were fixed rather than relaxed.
- **§3 updates**: (a) `§CI-GATE-BRITTLENESS` F111 family, twice and **intent-preserving** — `knownRoadmapDrift` gained
  the line-101 `#173`-vs-`#174` drift (step 6's record; §UI-ACCUMULATOR-FILES forbids rewriting it by hand) and the
  line-147 "F110 is #174" claim, and the storage scanner now reads a `.js` + hand-written sibling `.d.ts` as **one**
  declaration set (that is how `patchCore.js` is typed; the old rule rejected the F-DVR-LITE pattern the gate exists to
  bless). (b) step 8's **§D5-F111-STORAGE-GATE** hazard is **discharged**: F110's two surfaces are declared in
  `storageInventory.json` (`f110:armed`, `ghrdp-patches`, both `addedBy:"F110"`, `drift.derived` re-worded to 25) and
  F111's storage tests re-run green. (c) **§Fence-coverage-gap tracker**: F110 adds **zero** new global mounts — the
  panel lives inside Settings' already-fenced section and its guard is a `FeatureBoundary` that never registers (the
  F109 fork, because the HUD's Features panel *reads* that registry). The unfenced rows are unchanged and still
  F109-targeted: `Toasts`, `DiagSideDrawer`, `CollectorRunBridge`, `F92VersionGate`, `DashTokenGate`, `AppShell` (+
  `DvrFab`, `CommandPalette`, and `SessionListModal`'s FAB path). (d) the operator's "`check:ui` / `dist/index.html`"
  item is **stale in this tree**: `check:ui` appears in no workflow and no `package.json` script, and every CI
  `dist/index.html` reference is `ui/dist/index.html` (`vite.config.ts:57 outDir: "ui/dist"`), which builds and is
  asserted. (e) `ghrdp-dash-token`'s dead read: **still open**, untouched (F110 verifies with the *derived* secret and
  never reads that key).
- **§FALSIFY-3: 21/21 caught** (M1–M11 node, D1–D10 DOM; each mutation reverted in-file and `grep`-verified) +
  **5 vacuity probes**. **§MOCK-LIFECYCLE-REGISTRY**, **§CROSS-SESSION-FIXES**, **§DESIGN-DRIFTS**,
  **§PROVENANCE** are recorded as tables directly below (new in v11); **§PAGES-STATUS** and
  **§DEBUG-TOOL-MOUNT-POINTS** are the two sections the v11 prompt asked for and this step could actually measure.

### §MOCK-LIFECYCLE-REGISTRY (v11 — every harness seam F110 installs or touches)
| # | seam | installed by | off switch | inert when off | leaks into prod? |
|---|---|---|---|---|---|
| 1 | the ingest seam: `useDashboardPolling` → `isPatchFrame(data)` → `ingestPatchFrame(evt.data)` | **nothing is installed** - there is no `window.__ghrdp*` global in the shipped design (the first draft had one; deleted as unreachable API surface). The switch is the arm flag alone | Settings ▸ Developer ▸ "Arm live patch channel" ⇒ `localStorage["f110:armed"]`, written only as the literal `"true"`, **removed** on off | ✅ disarmed answers `disarmed` **before** verification, before `f109:toggles` is read, before `ghrdp-patches` is opened - the DOM test spies on `indexedDB.open` and asserts zero calls ("ignores a valid signed patch before verifying it, writing nothing and opening no database") | **no**: default-off, and even armed the only effect is one map entry that `FeatureBoundary` reads at the **next** mount, never mid-render |
| 2 | `setPatchMacProvider(fn)` - the swappable MAC seam (F107's `setShotRasterizer` / `setExportDownload` convention) | tests, and #179's future verifier | `setPatchMacProvider(null)` restores the shipped `webCryptoMac`; `isDefaultMacProviderActive()` is the assertable proof | ✅ with a <16-char token `decidePatch` answers `no-channel-key` **before** any provider call; a throwing provider is caught and answers `provider-failed`, never crashes the socket | no new global - `crypto.subtle` is the browser's own |
| 3 | the only subscriptions F110 has: `subscribeLivePatch` (a `Set` behind `useSyncExternalStore`) + `installLivePatchCrossTab` (one `storage` listener) | the panel's effects | the effect cleanups (`listeners.delete`, `removeEventListener`) - "the ONLY way to leave", per state.ts's own comment | ✅ the DOM test reads `livePatchListenerCount()` around mount+unmount and requires the baseline back; `notifyLivePatch()` swallows subscriber errors so a patch-audit subscriber cannot break the page | no |
| 4 | **absence** of a socket seam: zero `.send`, zero `new WebSocket`, zero `addEventListener("message")` across `src/lib/livePatch/**` + the panel (grep-proven) | n/a - this is the property that keeps F101's hello/keepalive/reconnect machine untouched | n/a | ✅ a patch **arrives**; F110 never asks for one. DOM: an `EventSource`-shaped stub records zero `.send` calls while `/#/overview` still gets its F101 hello | no |
| 5 | `requestPatchReload()` (default `location.reload()`), used by rollback | the reloader seam | `setLivePatchReloader(fn)`; `isDefaultReloaderActive()` | ✅ tests count reloads instead of performing them - which is what made the "disarm without a reload" bug visible in a trace | no |
| 6 | jsdom harness: `fake-indexeddb`, `vi.spyOn(indexedDB,"open")`, `vi.stubGlobal("fetch",…)`, `window.localStorage`, real `crypto.subtle` | `src/tests/smoke/f110-live-patch.test.tsx` | per test, in BOTH hooks: `setLivePatchArmed(false)`, `__resetLivePatchForTests()`, `__resetLivePatchChannelForTests()`, `setPatchMacProvider(null)`, `restoreFetch()`, `clearAudit()` | ✅ the file's own `afterEach` asserts the fetch stub is gone - re-confirming step 8's finding that `vi.unstubAllGlobals()` also removes `setup.ts`'s offline stubs, so this suite restores **only what it stubs** | test-only; `vitest.config.ts` untouched (its jsdom include list is an F106 pin) |

Three gotchas worth keeping: IDB **and** `localStorage` persist across tests in a file (`clearAudit()` in both hooks);
`fake-indexeddb` defers completion to a macrotask, so `await act()` alone cannot see a post-IDB effect — assert with
`waitFor`; and 200+ signed frames blow the 5 s default, so the bulk test passes `30_000` as its own timeout.

### §CROSS-SESSION-FIXES (v11)
| # | where the bug lived | bug | fixed here? | proof |
|---|---|---|---|---|
| 1 | F109 step 8, `FeatureDisabledCard` (copy only) | the card promised the *only* way back in was the Debug HUD; since step 9 a signed patch is a second enabler and the audit log a second way out | **yes** (copy only) | grep: no gate pins that sentence (`FeatureDisabledCard` appears in F109's file list and an F105 first-literal rule, both still satisfied); the DOM test `renders the disabled card on the patched section` asserts the text a user reads contains "live patch (F110)" |
| 2 | F111 step 10, `.d.ts` rule | a hand-written `.d.ts` beside a **`.js`** core was unclassifiable (the rule assumed a TS sibling) | **yes**, intent-preserving: `.js` + sibling `.d.ts` = one declaration set | F111-a/b/d/e/f green; the other 21 surfaces unchanged |
| 3 | step 8's §D5 hazard | "declare new persistence or the build fails" had no worked example | **yes**, by doing it | node 716/716 |
| — | — | **prior-work bug count 3 < 5** ⇒ §6 halt rule not triggered | | |

### §DESIGN-DRIFTS (v11 — where the build differs from the literal §5/§10 ask)
1. **HMAC over the shared token derivation, not Ed25519 + `PATCH_PUBLIC_KEY`** (see §Crypto above): the property the
   spec wants ("an attacker who can reach `/ws` cannot mint a valid frame") is preserved; the *asymmetry* is deferred
   to #179 with measured numbers. Documented in `channel.ts`'s header.
2. **No "thin `cryptoVerify` shim" over `verifyDashboardTokenLocally`.** That function derives a key per date string and
   only ever *compares*; reusing it would have meant either a second verifier (banned by the spirit of §10) or
   re-deriving inside the core. The provider is instead a 7-line WebCrypto closure with a swappable seam.
3. **`toggle-off`/`toggle-on`, not `replace-component`** — the spec's own safety sentence decided it; there is no
   remote execution path in this tree.
4. **Audit entirely client-side** (no `/api/patches/audit`): the handler has no such route, and `decidePatch` is pure,
   so a server half can be bolted on without touching the decision.
5. **`f110:armed` is one literal key**, same reasoning as step 8's `f109:toggles`: F111 derives only
   literal/const-bound keys, so a dynamic family would be an invisible undercount.
6. **The cap is core-enforced AND store-enforced**; the DOM gate mutates the constant to prove the two agree.

### §PROVENANCE (v11)
A patch frame is trusted iff: it arrived on the same origin-protected `/ws` as every other frame; its HMAC over
`ghrdp-patch-v1|…` verifies **in the browser** against a key that is simply the page's own dashboard token;
`ts`/`exp` keep it inside 120 s (5 s skew); its `feature` is one of the 11 registry ids; and its `id` was not already
`applied`. It is **not** provenance in the strong sense — token-mint power equals frame-mint power, which is why the
channel is operator-armed by hand and why #179 exists. `prev` is deliberately **unsigned** (it is data the page
already knows, and signing it would make a patch depend on client state the signer cannot see).

### §PAGES-STATUS (v11, measured 2026-10-08 02:05Z)
* `GET /repos/dekarita/supreme-lamp/pages` → `build_type:"workflow"`, `source:{branch:"main",path:"/"}`,
  `html_url:"https://dekarita.github.io/supreme-lamp/"`, `https_enforced:true`, **`status:null`, `cname:null`**.
* `GET /repos/dekarita/supreme-lamp/deployments` → last `github-pages` deployment **2026-10-08T00:47:13Z** (`main`),
  before that 2026-10-01T16:42Z. So Pages **is** publishing and is **one or more merges behind** `main`.
* `GET /pages/jobs/latest-pages-build` → **404** (as would `/pages/builds` for a workflow-type site). Step 8's
  "`succeeded`, 9 steps" therefore can't be reproduced from that endpoint; its real signal was the deployment row.
  Its `status:"unknown"` reading of `/pages` came from an **unquoted** `gh api … | grep status` — **quote the path**.
* `GET https://dekarita.github.io/…` from this sandbox → **blocked by the host allowlist** (curl 000), so the
  `/status.json` *body* could not be re-read this session; step 8's 13:19Z snapshot is **not** restated as current.
* **Decision left with the operator, deliberately not taken here**: widen `replay-viewer.yml`'s fenced `push:` trigger
  so watchdog-era commits republish `/status.json`, or accept the staleness. Widening it silently changes what Pages
  ships (every ~80 s heartbeat commit would re-publish ~1000×/day, which is why the fence exists — F108-h) and would
  re-open that pin.

### §DEBUG-TOOL-MOUNT-POINTS (v11)
F110 mounts **nothing** new at the chrome level. What exists after this step: `Settings.tsx:183` renders one
`<PatchAuditPanel />` inside the already-fenced `/settings` section (153 lines, no portal, no global side effect beyond
`subscribeLivePatch`) · the *decision* path is `useDashboardPolling`'s frame handler (11 added lines, no JSX, no
context, no socket write) · `featureToggles.ts:76` is the single point where "does a stored `off` bite" is decided:
`isToggledOff(readFeatureToggles(), id, toggleSurfaceActive(isHudEnabled(), isLivePatchArmed()))`.
**Two first-draft components were deleted rather than shipped**: a `window.__ghrdpPatchChannel` install/uninstall API
(nothing needed it - Settings mounts the panel, so an install handle is purely new reachable surface) and
`PatchSurfaceBoundary` (a fork of F109's fork of `FeatureBoundary`): the audit panel is the *control* that turns
sections off, so fencing it would let a crashing section hide the way back out.

### Handoffs recorded (NOT done here)
1. **#179** — F110b: per-frame Ed25519 signatures + the pubkey-distribution decision (TOFU pin vs handler endpoint vs
   `state`-embedded `kid`), the `PATCH_MAC_DOMAIN`→`ghrdp-patch-v2` / `PATCH_SCHEMA_VERSION`→2 bump that makes v1
   frames provably invalid, and a handler-side signer (`payloads/ghrdp-handler` has no patch emitter today). Budget
   150 min including the Go half.
2. **#179 needs an operator touch, and the reason is a permission asymmetry worth recording.** Measured in one minute:
   `POST /issues/179` (create) **✓** · `POST /issues/179/labels` **403** · `gh issue edit --add-label` (GraphQL) **403**
   · `POST /issues/179/comments` **403** · `PATCH /issues/179` (body) **403** — but `PATCH /issues/180` (a **pull
   request's** body) **✓** and `POST /issues/180/labels` **✓** `[f-observatory, observatory]`. So this installation can
   create issues and edit PRs, and can do **nothing else** to an issue. Operator action: add `f-observatory` to #179 and
   fold in the three corrections it needs (its body was drafted from the pre-ship sketch, and the PR body carries the
   same corrections as a footer): there is **no** `src/lib/livePatch/mac/` dir (the provider seam is `setPatchMacProvider`
   / `webCryptoMac` inside `channel.ts`, so #179 is **~40 added lines**, not a module tree); there is **no**
   `computeDashboardSignature` / date-salted derivation in this tree, so its item 4 (key distribution) is the whole
   story rather than one option; and the ban/pin test-ids are **F110-a + F110-i**, not F110-d / F110-e.
3. Playwright `tests/e2e/f110-live-patch.spec.ts` (a real-Chromium arm→patch→reload→rollback loop) — still not worth an
   un-runnable file; the jsdom proof exists and the job is the 25-min self-canceller.
4. `/api/patches/audit` server-side mirror if the handler ever needs to *revoke* a frame (the dedupe set is
   per-browser today; a second tab arms independently — cross-tab sync covers the flag, not the id set).

## Session 2026-10-08 03:55Z — Maintenance step **M1** — F110b Ed25519 signing, shipped as a FAIL-CLOSED VERIFIER SCAFFOLD — PR **#182** (base `71f75cc` = the #180 merge)

**§OBSERVATORY-COMPLETION-CHECK: OBSERVATORY SHIPPED, 10/10.** Verified independently of the prompt: `gh pr view 180`
→ `state: MERGED`, `mergedAt: 2026-10-08T02:40:31Z`, `mergeCommit: 71f75ccca07d98d5afb41b233d9484d9a89b7b8a` — which is
exactly this branch's base commit, so F110a is on `main` and the roadmap's last step is in. The smoke flow listed in
§0.12 could **not** be run here (no browser, no RDP host, no live `/ws` in this sandbox — the standing fact since step
4), so it is **not** claimed as verified; it is listed for the operator instead.

### §MAINTENANCE-STEP-SELECTION (why M1 and not M2/M3/M4)
| candidate | impact | ease | urgency | chosen |
|---|---|---|---|---|
| **M1** F110b Ed25519 (#179, the only open follow-up from a shipped step) | high (it is the trust model of a socket-fed control path) | medium (verifier only; the emitter is out of reach) | high (#179 is the only OPEN issue created by the roadmap) | **yes** |
| M2 chrome unfencing (6 surfaces) | medium | high | low (F109-targeted, unchanged since step 8) | no |
| M3 Pages `/status.json` freshness | medium | low (a deploy-trigger decision the operator owns — §PAGES-STATUS) | low | no |
| M4 latent bugs (`ghrdp-dash-token` dead read, line-101 drift, stale `check:ui` refs) | low | high | low | no |

M1 won on impact × urgency. It shipped **partially by design**: see §GREP-DROPPED-FROM-DESIGN.

### §GREP-DROPPED-FROM-DESIGN (claims dropped before shipping, each with the grep that killed it)
| # | the sketch said | measured | decision |
|---|---|---|---|
| 1 | "public key pin in dashboard" | `git grep -cE "Ed25519\|PATCH_PUBLIC_KEY" 71f75cc -- src/` → **0 hits**; the only `importKey` calls in `src/` are `f46.ts` (AES-GCM credential encryption) and F110a's HMAC | ship `PATCH_PUBLIC_KEY_B64 = ""` and **fail closed**; do not invent a trust anchor |
| 2 | "the live `/ws` server" can sign+broadcast | `grep -cE '"type"\s*:\s*"patch"\|patchFrame\|SendPatch\|livePatch' payloads/ghrdp-server.ps1` → **0**; `Send-F99WsText` occurs **6×** = 1 definition + 5 send sites (`diagInit`, `hello-ack`, the echo, `diag2`, `ping`) | no end-to-end claim; the emitter is **#181** |
| 3 | "`payloads/ghrdp-handler` is the server to change" (#179 item 1) | `ls payloads/ghrdp-handler` → `GhrdpHandler.csproj`, `Program.cs`; `Program.cs:15` `RidPattern = \Aghrdp:connect\?rid=([0-9a-f]{32})\z` | recorded as a **mislabel**: it is the Windows URI handler; a broadcaster belongs in `ghrdp-server.ps1`'s `Invoke-F99WebSocketUpgrade` |
| 4 | #179 item 2's "`src/lib/livePatch/mac/WebCryptoPatchMacProvider.ts`" | `ls src/lib/livePatch` → `audit.ts channel.ts patchCore.js patchCore.d.ts state.ts` (no `mac/` dir) | the seam is `setPatchMacProvider` in `channel.ts`; the new one is `setPatchSignatureProvider` in `signature.ts` |
| 5 | #179 item 1's `GET /api/patch/pubkey` (runtime key fetch) | a pin fetched at runtime is not a pin | **dropped**: build-time constant/env only; `keys.ts` has no `fetch(` and the gate pins its absence |

### §EMPTY-STATE-GUARDS-ADDED
1. **`settings-live-patch-signer`** — the panel used to imply any signed frame could apply. It now states which
   scheme *this build* accepts, from the pin: `signer key: none (empty) … Ed25519 (v2) frames are refused as
   no-signer-pin` vs `Signer key pinned (abcd1234…) … HMAC (v1) frames are now refused as legacy-mac-refused`.
   Pinned by F110b-h (both refusal names must appear) and by two DOM tests.
2. **The refusal itself is the guard** — an Ed25519 frame on an unpinned build is not silently dropped: it is
   written to the audit log with `no-signer-pin`, so "nothing happened" is answerable from the UI.

### §IDB-TX-SPLITS-APPLIED
**None — none were needed, and that is a fact rather than an omission.** F110b adds **zero** persistence:
`keys.ts`/`signature.ts`/`signatureCore.js` contain no `localStorage`, `sessionStorage` or `indexedDB` (pinned by
F110b-g), and the v2 path reuses `appendAuditRow`, which step 9 already split into a put tx + a trim tx. F111's
derived storage diff re-run in F110b-h: **still 25 keys**.

### §GENERATION-GUARDS-ADDED
**None new.** F110a's `primeToken` generation guard in `channel.ts` already covers the v2 path: v2 rows enter the
same live view through the same `remember()` + `notifyLivePatch()` tail, and the DOM gate proves a v2 patch
survives a module reset + re-prime (`v2-durable`) and re-delivers as `duplicate` afterwards.

### The fail-closed matrix (`signatureCore.signatureGate`) — the step's whole security claim
| pin | frame | result | why |
|---|---|---|---|
| absent (this build) | v1 HMAC | F110a path, unchanged | non-regress |
| absent | v2 Ed25519 | `rejected / no-signer-pin` | a future emitter must not be trusted before the operator pins its key |
| present | v1 HMAC | `rejected / legacy-mac-refused` | pinning IS the upgrade switch; leaving v1 open means the strongest key in the repo protects nothing |
| present | v2 Ed25519 | verify → dedupe → apply | |
| either | anything else | `rejected / unknown-sig-alg` | |

### §MEASURED-RUNTIME-FACT (load-bearing for the design; re-measured on every run by F110b-i)
On **node v22.22.3**, which jsdom inherits:
`subtle.sign({name:"Ed25519"})` reproduces **RFC 8032 vectors 1 and 2 byte-for-byte**, while
`subtle.verify({name:"Ed25519"})` returns **false** for those same published signatures (`node:crypto`'s
`verify` returns **true** for both). So in a runtime like this one, a **correctly signed** frame is refused —
which is the right outcome and the reason the refusal reason is `sig-crypto-unavailable` (support gap) and not
`bad-signature` (attacker/wrong key). **Browser Ed25519 support is UNCHECKED here** (no Chromium); the operator's
own browser is where it gets confirmed, and `docs/F110B-SIGNING.md` says so.

### §FALSIFY-3 — 21/21 caught, 0 missed (each mutation applied, run, reverted, grep-verified)
M1 domain v2→v1 · M2 `sigAlg` unsigned · M3b decoded pin length unchecked · M4 **fail open** (unpinned accepts
Ed25519) · M5 pinned still accepts the MAC · M6 `exp < now` dropped · M7 missing verify result accepted ·
M8 `sigAlg` value unchecked · M9 **a throwing verifier answers `ok:true`** · M10 an invented pin ships ·
M11 conflicting pins ranked · M12b gate moved after the MAC · M13 a second audit-row shape ·
M14 *(vacuity)* `new WebSocket("/ws/patch")` · M15 *(vacuity)* structural verifier skipped · M16 the doc claims an
emitter · M17/M18 F110a's schema version / MAC domain moved · M19 the pin becomes a storage key · M20 v2 replay
window → 24 h · M21 signature length pin → 64 · M22 *(vacuity)* a refusal also toggles · M23 crypto on an
unvalidated frame (caught by F110b-g **and** 4 DOM tests).
**M3 and M12's first drafts were not real mutations** (a redundant pre-check, and a move that stayed *before* the
crypto call) — they were replaced by M3b/M12b rather than counted as caught.

### §GATE-SELF-TEST — 2 defects in the new gate + 1 flake, all found by probing rather than by green
1. **F110b-d had no case isolating `exp < now`.** Both expiry cases were *also* caught by the age check, so
   deleting the expiry check passed. Added "recent `ts`, `exp` already past" — only the expiry check can catch it.
2. **F110b-g's `indexOf("structural.ok") < s2` was vacuous.** Deleting the condition makes the index `-1`, and
   `-1 < s2` is true, so M23 passed the gate. Replaced with a literal pin on `const check = structural.ok` —
   the same class of bug step 9 found in its own `split("/** Forget")` slice.
3. **A flake, caught by running the gate 10× rather than once.** The url-safe base64 case was `k.pin` with
   `+/`→`-_`, which is a **no-op for roughly one random key in four** (256-bit keys rarely contain `+` or `/`):
   the gate was red on run 5 of 6. Replaced with a deterministic 32-byte literal whose base64 contains both
   characters, plus a positive control asserting the standard-alphabet form *is* a valid pin.
4. **A second flake, caught only by CI** (`launch-gates` push run `37724620097`, job `gates`, head `434da42`):
   `dedupes, rolls back and reloads a v2 patch exactly like a v1 one` asserted `expect(reloader)
   .toHaveBeenCalledTimes(1)` **beside** an `await waitFor(readFeatureToggles() === {})`. The rollback restores the
   toggles synchronously and calls `requestPatchReload()` only *after* `await appendAuditRow(marker)`, and
   fake-indexeddb defers that to a macrotask — so on a slower runner the waitFor resolved first and the spy had
   0 calls. Green locally 5/5, red on the runner. Fixed by waiting on the spy (repair commit below).

### §CROSS-SESSION-FIXES (v12 — including one lesson this session FAILED to follow)
| # | where the lesson lived | what happened | fixed here? | proof |
|---|---|---|---|---|
| 1 | `src/tests/smoke/f110-live-patch.test.tsx`, the rollback test's own comment: *"fake-indexeddb defers its callbacks to a macrotask, so the chain that ends in the reload outlives act()'s microtask flush: **wait for it, never assert beside it**"* | **I wrote the new v2 rollback test asserting beside it anyway.** It passed locally and reddened `launch-gates`/`gates` on the runner | **yes** — `await waitFor(() => expect(reloader).toHaveBeenCalledTimes(1))` now precedes the toggle assertion, with the reason written at the call site | 5 local runs + the full suite green under parallel load (1139/1139, 87 files); CI re-run on the repair commit |
| 2 | step 9's `§MOCK-LIFECYCLE-REGISTRY` gotcha list already names the same trap | the trap is now named in THREE places (F110's test, this table, and the F110b call site), because naming it twice did not stop it | n/a | — |

**The transferable rule:** a lesson recorded as *prose in a sibling test* does not transfer. If the next session
touches a rollback/reload/IDB assertion, the cheapest guard is to copy the sibling test's `waitFor` shape verbatim
rather than re-deriving the timing.

### §PROMPT-STALENESS (3 corrections)
1. "Step 9 F110a: 🟢 PR #180 OPEN, mergeable (SHIPS OBSERVATORY 10/10 WHEN MERGED)" → **MERGED**
   2026-10-08T02:40:31Z as `71f75cc`. The Observatory is shipped; §0.12's announcement applies and §0.13 selected M1.
2. "Close #169 (F-DVR option d implemented)" → #169 is **already closed**; the open issues are **#179**, **#165**,
   **#164** (the label-permission probe) and **#156/#153** (duplicate F99 titles).
3. "#179 needs operator labels + 3 body fixes" → confirmed and **unfixable from here**: `PATCH /issues/179`,
   `POST /issues/179/labels` and `POST /issues/179/comments` are 403 for this token (§PLAIN-ISSUE-WRITES-ARE-BLOCKED),
   so the corrections live in `docs/F110B-SIGNING.md`, in the PR body and in **#181**.
4. "State file §knownRoadmapDrift: **line 101** cites PR #173 with branch `arena/fa27adb3`" → the drift is real but the
   **line number is stale**: `grep -n fa27adb3 docs/OBSERVATORY-STATE.md` puts the roadmap checkbox line at **115**
   (`- [x] **Step 6 — F107** · landed on \`arena/fa27adb3-supreme-lamp\`, PR **#173**`); line 101 is an F106 gates line.
   The drift itself is allowlisted in `src/lib/ci/stepLedger.json` §knownRoadmapDrift (rule
   `roadmap-branch-matches-pr`), and that gate **fails on an allowlisted drift that stops being observed**, so the
   operator's one-word fix must delete the allowlist entry in the same commit. Cite the *rule*, not the line number.

### §KNOWN-DRIFT-REGISTRY additions
* **"#179's handler-side signer" points at the wrong binary.** `payloads/ghrdp-handler/` is a .NET console app for
  `ghrdp:connect?rid=`; `/ws` lives in `payloads/ghrdp-server.ps1`. #179's body cannot be edited by this token.
* **#179's body says F110a "shipped as PR #179"** — it shipped as **#180** (#179 is the follow-up issue itself).
* **#179 item 2's `src/lib/livePatch/mac/`** does not exist and never did.
* **`operator-assertions` correction**: nothing in this step reads a GH_PAT, and no secret value was read or stored;
  the operator keypair is generated on the operator's own machine by `scripts/f110b-sign-patch.mjs --genkey`, which
  **refuses to write inside a git work tree** (gate-asserted).

### Handoffs recorded (NOT done here)
1. **#181** — the patch emitter (broadcast + sign in `ghrdp-server.ps1`'s upgrade lane, key handling on the host,
   a PowerShell-side gate). **Do not pin a key before it lands**: pinning refuses every v1 frame while nothing can
   send v2 ones — that is a patch outage, and `docs/F110B-SIGNING.md` says so in words the emitter PR must delete.
2. **Operator labels**: #179 and #181 need `f-observatory` (PR labels work — #182 was labelled via
   `POST /issues/182/labels` — but plain-issue labels are 403).
3. **Key-rotation story** is still unwritten: a rotated key needs a rebuild+redeploy (that is the cost of a
   build-time pin, chosen over a fetchable one on purpose).
4. M2/M3/M4 unchanged and still open (6 unfenced chrome surfaces; Pages `/status.json` freshness; the
   `ghrdp-dash-token` dead read at `src/api/fetch/index.ts:124` + `src/lib/f46.ts:51` (both confirmed by grep this
   session), the roadmap `#173`→`#174` one-word drift, and the stale `check:ui` references).

### Lab numbers
`node --test tests/*.test.js` **725/725** (was 716; +9 from `tests/f110b-signing.test.js`, auto-run — no workflow
edit) · `vitest run` **1139/1139** over 87 files (was 1126/86; +13) · `tsc -p tsconfig.build.json` **0** ·
`tsc -p tsconfig.json` error count unchanged at the pre-existing 81 lines, **0** of them in this step's files ·
`vite build` clean **1,103.65 kB** (+6.85 over step 9's 1,096.80) · regression-ids **219/219** ·
no-neon-green / bottom-bar / fx-ids PASS · **0** dependencies (8 deps / 21 devDeps) · **0** i18n keys (lock 1030) ·
**0** new storage keys (derived inventory 25) · `patchCore.js` **byte-identical** (F110's 11 node + 18 DOM rules pass
unmodified). Budget ≈ 75 min of 120. GUARDS unchanged: no code execution in the patch surface, no new transport,
no new credential, no private key in `src/`, every allowlist untouched.

### §4 CI verdict for PR #182 (watch closed 04:25Z) — head `dbcfa4d`
| workflow / check | result | note |
|---|---|---|
| `launch-gates` → **gates** | **pass** (3 m 07 s) | includes the node lane `node --test tests/*.test.js`, i.e. the 9 new F110b rules |
| `launch-gates` → **windows-native** | **pass** (11 m 26 s) | PowerShell side untouched by this step |
| `launch-gates` (push + pull_request, both `e3565bc` and `dbcfa4d`) | **success** | |
| `F59 build-ui (prebuilt UI release asset)` | **success** (44 s) | the single-file build this step grew by 6.85 kB |
| `autologin-lab` | **success** | |
| `f56d-qbt-lab` / `f57-explorer-lab` / `f60-warm-lab` | **pass** | |
| `e2e-ui` | **cancelled at ~25 min** | the documented self-canceller — and the SAME outcome `main` produced for #180 and #178, so it is the baseline, not a regression |

**§PATTERN-FOLLOWS-PRIOR-GATE-UPDATE — one deliberate non-update, recorded so nobody "fixes" it.**
`src/lib/ci/stepLedger.json` was **not** given an M1 entry. The ledger is "one entry per PR that carried a *roadmap*
step", and `tests/f111-ci-inventory.test.js` fails on a ledger entry that no roadmap checkbox cites (that is exactly
why #174 sits in `knownRoadmapDrift` as `ledger-pr-cited-in-roadmap`). A maintenance step has no checkbox, so adding
one would create a NEW drift and redden the gate. The maintenance phase is tracked in this document
(§MAINTENANCE-STEPS-LOG) instead. If maintenance steps should become ledger entries, the ledger needs a
`phase: "maintenance"` marker and the citation rule needs to exempt it — its own step, not a drive-by.

## Session 2026-10-08 — Maintenance step **M4** — latent bug cleanup (`ghrdp-dash-token` dead read · roadmap `#173`→`#174` drift · `check:ui` landmine) — branch `arena/d5b6da04-supreme-lamp`

**Scope.** M4 is independent of M1 (the F110b PRs), so no ordering applies. Nothing was merged, `main.yml` was not dispatched, no plain issue was edited, and M2/M3 were not touched. No Ed25519 key was pinned. PR **#183**. The CI verdict is in the M4 row of §MAINTENANCE-STEPS-LOG.

### §M4-PROMPT-STALENESS — the brief checked against the tree (measured this session)
- "#181 server emitter, OPEN, merge first": **#181 is an OPEN ISSUE** (F110c, the patch emitter), not a PR (`gh pr view 181` finds no PullRequest). There is nothing to merge, and M4 does not depend on it.
- "#182 client verifier, OPEN, CI green": **#182 is MERGED** (2026-10-08T09:03:10Z, merge commit `b1c0f3a`). That commit is this branch's base.
- "#169 closable": already CLOSED. "#173" and "#174": both MERGED. #174 is the canonical step-6 survivor (`arena/fa27adb3`). #173 is the retired sibling (`arena/66a13a8c`).
- "#179 body stale": still OPEN. Arena's plain-issue writes return 403, so this stays an operator task.
- "`check:ui` is a gate": **no executable reference exists**. It is not a script, not a workflow step, and not a file under `scripts/`. Its only occurrences are historical prose in this file (append-only records) and one line of the STATE.md history, all left as written. The correct artifact is `ui/dist/index.html` (vite `build.outDir`, `vite.config.ts`). The gate that reads it is `npm run check:no-neon-green`. On a checkout with no build, that gate exits 1 with "bundle not found", which is expected and not a regression. It passes after `vite build`.

### §M4-DECISION — Option A (delete the reads), as the operator chose
- Evidence that the key was never written: `git log --all -S"ghrdp-dash-token"` on the full history returns 8 commits, and every added line that mentions the key is a read. No commit ever added a `setItem` for it. The session clone was shallow, so the history was fetched with `git fetch --unshallow` first.
- Behaviour check (temporary vitest harness, deleted, not committed). HEAD and this branch were run under three localStorage states. With nothing stored, both send no `X-Dash-Token`. With the canonical `ghrdp.dashToken` stored, both still send no token. With the shadow key injected by hand, which this repo cannot produce, HEAD sends the injected value and this branch sends none. The third state is the only observable difference, and it is the point of the change.
- The permanent runtime test `src/tests/smoke/m4-dead-read.test.ts` pins that third state: a value stored under the retired key is never sent.

### §M4-FINDING — the dead read sat next to a live auth gap (NOT fixed here; operator decision)
- `requestFetch` (`src/api/fetch/index.ts`) never reads the canonical key `ghrdp.dashToken`, which `DashTokenGate` stores. So it sends no `X-Dash-Token`. The harness shows this for a normal stored token.
- The server requires the token on `POST /api/fetch` (`payloads/ghrdp-server.ps1`, `$path -eq '/api/fetch'`). Without a valid `X-Dash-Token` or Bearer token it returns 401 `dash token required`. Per the server source, the search download and own-credential submit paths therefore cannot authenticate. Those paths are `src/lib/fetchStub.ts` → `requestFetch`, used by ResultsGrid, LabInspector and OwnCredentialModal. **This was not observed against the live runner**, because the sandbox has no network path to it.
- The fix shape is to route `getDashToken()` through the canonical resolver `src/lib/dashToken.ts`. That changes which credential is sent, and to whom, so it needs an explicit decision and an end-to-end check. M4-D5 pins the current no-storage-read behaviour so the change has to be deliberate. The same applies to `window.__GHRDP_DASH_TOKEN`, which `getDashToken` reads and nothing writes. It is not a storage key, so F111 does not see it.

### §M4-SECURITY — recorded, not fixed (out of M4 scope; operator decision)
- `getPerRunKey` (`src/lib/f46.ts`) takes its AES key from `mirrorKey` in the `/api/config` response. The server never emits `mirrorKey`. `Remove-CredKeys` strips it (`ghrdp-server.ps1`, about line 1880), and no other response path contains it (grep). So the key is always the browser's random fallback.
- `OwnCredentialModal` then posts that key as `credKeyB64` in the same JSON body as the ciphertext (`credUserEnc`, `credPassEnc`). The server reads all three from the body and decrypts with the posted key (`ghrdp-server.ps1`, about line 3034: "client-side ephemeral key fallback"). Against anyone who can read that request body, the AES layer adds nothing over TLS. `src/lib/collectorAgent.ts` wraps `window.fetch` and records up to 2,000 request-body characters per call. I did not trace where those records go, so I make no claim that they leave the browser.
- The fix shape is to deliver the key out of band, or to have the server own the key and never accept it in the body. That is a design decision, not a cleanup.

### §M4-CHANGES
- `src/api/fetch/index.ts`: the `ghrdp-dash-token` read is deleted from `getDashToken()`. The comment cites this record. The window fallback is unchanged.
- `src/lib/f46.ts`: the same read is deleted from `getPerRunKey()`, which now calls `fetch('/api/config')`. That is the same request, since an empty headers object was always sent.
- `docs/OBSERVATORY-STATE.md`: Step 6 roadmap line 115 `PR **#173**`→`PR **#174**`. This is the one-word fix and the only edit to another step's line, which the M4 brief authorises. Also the header, the M4 row of §MAINTENANCE-STEPS-LOG, and this record.
- `src/lib/ci/stepLedger.json`: `knownRoadmapDrift` is emptied. Both entries (`roadmap-branch-matches-pr`, `ledger-pr-cited-in-roadmap`) are resolved by the same edit and are deleted in the same commit. No ledger entry was added for M4, because a maintenance step has no roadmap checkbox (see the M1 record).
- `src/lib/ci/storageInventory.json`: `ghrdp-dash-token` is removed from `keys` (25→24). It is recorded under `drift.retiredByM4` and removed from `drift.missedByI163` (3 remain). The derived-count sentence is updated.
- `src/lib/ci/inventoryCore.js`: three comments moved to past tense. No logic changed.
- `tests/f111-ci-inventory.test.js`: the pins move to a derived count of 24, a census of `{live:20, migration:1, purged:3}`, 3 surfaces invisible to #163 (was 4), and an observed drift set of `[]`. F111-d's allowlist floor `length > 0` is now a type check, because an empty allowlist is the goal state. Unrecorded drift still fails.
- `tests/f110-live-patch.test.js` (F110-j) and `tests/f110b-signing.test.js` (F110b-h): the derived-count pins move 25→24, with the reason stated in each. F110b still asserts that it adds no surface.
- New gates: `tests/m4-dead-read-cleanup.test.js` (M4-D1…D6), `tests/m4-drift-fixed.test.js` (M4-R1, M4-R2, M4-L1) and `src/tests/smoke/m4-dead-read.test.ts` (2 runtime tests).
- No assertion was deleted. Each changed number follows directly from the removed key or the fixed drift.

### §M4-FALSIFY — mutations applied one at a time, gates run, file restored; the working-tree diff was checked byte-identical afterwards
| id | mutation | caught by |
|---|---|---|
| F-a | re-add `localStorage.getItem('ghrdp-dash-token')` in `getPerRunKey` | M4-D1, M4-D2, M4-D6, F111-e, F111-i; runtime test fails too |
| F-b | add a writer, `setItem('ghrdp-dash-token', …)`, in `src/lib/dashToken.ts` | M4-D2, F111-e, F111-i |
| F-c | re-declare the key in `storageInventory.json` `keys` | M4-D4, F111-e, F111-i |
| F-d | `DASH_TOKEN_STORAGE_KEY` = `"ghrdp-dash-token"` | M4-D3, M4-D2, F111-e, F111-i |
| F-e | `getDashToken()` reads the canonical key (a BEHAVIOUR change: it starts sending the token) | M4-D5; the harness shows the header is sent |
| F-f | `#173` back on the Step 6 line | M4-R1, F111-d |
| F-g | one allowlist entry restored, so the drift is no longer observed | M4-R2, F111-d |
| F-h | a `check:ui` script added to `package.json` | M4-L1 |

The runtime test also fails when the dead read is re-added to `getDashToken` and when it is re-added to `getPerRunKey`. F-a is runtime-neutral today, because nothing writes the key. It is therefore a policy mutation, and the runtime test is what makes it fail on behaviour. F-e is the behaviour mutation.

### §M4-VERIFY — measured on the final tree, before the PR
- `node --test tests/*.test.js`: **734/734** pass (baseline 725/725, plus 9 M4 gates). Node v22.22.3.
- `vitest run`: **88 files, 1141/1141** pass (baseline 87 files, 1139/1139, plus the new runtime file with 2 tests).
- `tsc -p tsconfig.build.json`: exit 0. `vite build`: `ui/dist/index.html` 1,103.65 kB at baseline and 1,103.70 kB on the final tree. The 0.05 kB difference was not investigated.
- After the build: `check:no-neon-green` OK. `check:regression-ids`, `check:bottom-bar` and `check:fx-ids` exit 0.
- Installed with `pnpm@9.15.9 install --frozen-lockfile` (the repo's `packageManager`), 308 packages.
- Not run locally: Playwright e2e. It is outside the launch-gates node lane, and CI covers it.

### §M4-HANDOFFS — each needs an operator decision; none was done in M4
1. **Route the canonical token into `requestFetch` and `getPerRunKey`** (§M4-FINDING). This is the highest priority, because it decides whether the search download path works. It needs an end-to-end check against the live server, and M4-D5 must change in the same commit.
2. **Stop posting the per-run key in the request body** (§M4-SECURITY).
3. **`window.__GHRDP_DASH_TOKEN`** is read and never written. Remove it together with item 1.
4. **#179** body and **#181** labels are operator edits, since Arena gets 403 on plain issues. #181 is an OPEN issue for F110c, not a PR.
5. **STATE.md** (the 60-line ledger, at its line cap) was not updated. §MAINTENANCE-STEPS-LOG in this file is the record of truth for maintenance steps.
6. **`e2e-ui` never reaches a verdict.** Its F78 + F79 Playwright run does not finish inside the workflow's 25-minute `timeout-minutes` (`.github/workflows/e2e-ui.yml`). It was cancelled on each of the last four pushes to main and on PR #183, always at the same step with zero failed steps. So the E2E specs have no recorded pass or fail on either branch. Playwright browsers cannot be downloaded from this sandbox, so this could not be run locally. Raising the timeout or sharding the specs is a separate CI task.

### §M4-LANDING — PROJECT-CONTEXT rule 7
Session-branch push, then PR, then merge with `merge_method=merge`, done by the operator. No `main.yml` dispatch.

### §MAINTENANCE-STEPS-LOG
| step | scope | status | PR / issue |
|---|---|---|---|
| **M1** | F110b Ed25519 signing | **verifier half COMPLETE**; pin + emitter outstanding | PR **#182** (green), emitter **#181** |
| M2 | chrome unfencing (6 global surfaces) | not started | — |
| M3 | Pages `/status.json` freshness | not started (operator decision: widen `replay-viewer.yml`'s fenced push trigger, or accept staleness) | — |
| M4 | latent bug cleanup | **code COMPLETE on `arena/d5b6da04-supreme-lamp`**: the `ghrdp-dash-token` dead read is deleted at both sites; Step 6 line 115 `#173`→`#174` with both allowlist entries deleted in the same commit; `check:ui` replaced by `ui/dist/index.html` + `check:no-neon-green` (pinned by M4-L1). Gates M4-D1…D6, M4-R1/R2, M4-L1, plus a runtime test. | PR **#183** (head `b8ecb25b`). CI on `b8ecb25b`: `gates` ✅ 13m2s · `windows-native` ✅ 11m28s · `proof` ✅ · `build-ui-prebuilt` ✅ · labs `f56d-qbt-lab` / `f57-explorer-lab` / `f60-warm-lab` ✅ · `e2e-ui` ⚠️ cancelled by its 25-min `timeout-minutes` during `Run F78 + F79 E2E specs`, 0 failed steps. That is the pattern of the last four pushes to main (AMBER-INHERITED, not caused by M4). Merge is the operator's call. |
| **M5** | auth routing (the bug M4 found behind the dead read): `requestFetch` sends the canonical `X-Dash-Token` | **code COMPLETE on `arena/3a1f08df-supreme-lamp`** (operator approved the behaviour change in the v14 session; M6 explicitly not taken): `src/api/fetch/index.ts` resolves through `src/lib/dashToken.ts`; `window.__GHRDP_DASH_TOKEN` retired (1 reader / 0 writers) and pinned absent; `M4-D5` flipped deliberately; new gate `tests/m5-auth-routing.test.js` (7 rules) + runtime pin `src/tests/smoke/m5-auth-routing.test.ts` (7). Not scope-crept into `getPerRunKey` (f46) — `/api/config` is not token-gated. | PR **#184** (**MERGED** 2026-10-08T11:11:13Z) |
| **M2** | chrome unfencing (F105 handoff #1: "a crash in one of those overlays still blanks the app") | **code COMPLETE on `arena/4d9cc1a2-supreme-lamp`**: new `ChromeBoundary` primitive + pure core (10 surfaces, each with a `lost` statement) + the shared crash channel extended with a `kind` discriminant (additive; absent == section, so F105's data/tests are unchanged). Null render on crash, bounded auto-retry (3 × 2 s), no F105 ledger registration, no wrapper DOM. `fence()` still counts 13 in App.tsx (M2's helper is `chrome()`), F105/F109/F-DVR-i/F56-c pins all still literally true. Gates `tests/m2-chrome-unfencing.test.js` (6) + `src/tests/smoke/m2-chrome-unfencing.test.tsx` (8). | PR **#185** |

## Session 2026-10-08 10:27Z — Maintenance step **M5** — auth routing fix (operator-approved) — branch `arena/3a1f08df-supreme-lamp`

**§STEP-SELECTION (v14 §1).** The prompt's priority order is M5 → M6 → M3 → M2, with the first two
gated on an operator decision that had **not** been recorded (no comment on the merged #183, no
issue, no state-file entry — checked before asking). The operator was asked and chose **M5**; M6
(the per-run key leak) was explicitly **not** chosen, so it stays open with its three options.
M3 (Pages freshness) and M2 (chrome unfencing) were not attempted. Nothing was merged, `main.yml`
was not dispatched, no plain issue was written, no Ed25519 key was pinned.

### §M5-PROMPT-STALENESS — the v14 brief checked against the tree (measured this session)
| # | the brief said | measured | consequence |
|---|---|---|---|
| 1 | "M4 Latent Bug Cleanup: 🟢 PR **#183** OPEN, mergeable — merge it when ready" | **#183 is MERGED** (2026-10-08T10:23:47Z, merge commit `533213f` = this branch's base; `gates` ✅ `build-ui-prebuilt` ✅ at entry) | §MERGE-STATUS-RE-CHECK: the operator's step 3 was already done, and this session's branch base is that merge — so M5 starts on top of M4's cleanup, not beside it |
| 2 | "Issue #163/#164/#165: all CLOSED" | **#164 OPEN** (the label-permission probe) and **#165 OPEN** (the roadmap owner) — #163 and #169 are closed | §CLOSURE-STATUS-RE-CHECK: recorded, not "re-closed"; both are operator items, and this token cannot PATCH/label a plain issue anyway |
| 3 | "#179 body: 3 stale items; #181 labels" | still true, still unfixable here: `PATCH /issues/179`, `POST /issues/179/labels` and `POST /issues/179/comments` are 403 for this installation (measured in the M1 session; re-confirmed pattern) | operator task, unchanged |
| 4 | "M5 … if operator approves" (no approval recorded) | no approval existed in any of the three places it could live | asked the operator before touching behaviour — that gate is the whole point of M4's pin |

### §PRE-STEP — all 12 checks run (v14)
1. **§SPEC-REALITY — 1 drift.** The brief says "route `getDashToken()` through `src/lib/dashToken.ts`".
   The tree says the honest shape is **delete the local function** and import the resolver: a local
   wrapper keeping the private name would be the very shadow M4 deleted, and the alias is what the
   gates pin. Recorded, not silently "fixed differently".
2. **§DEAD-READ-HIDES-WORSE-BUG — discharged, and this step is the payoff.** M4's dead read hid the
   401; M5 closes it. The "worse bug" is not theoretical: `requestFetch` is the path under
   `ResultsGrid` (search download), `LabInspector`, `OwnCredentialModal`, `cancelFetch`, `retryFetch`.
3. **§BEHAVIOR-PINNING-AS-DELIBERATE-GATE — honoured.** `M4-D5` + `src/tests/smoke/m4-dead-read.test.ts`
   were written to *force* this decision; both are updated in this commit, with the reason at each site,
   and the mutation that flips M4-D5 back (M5 in §FALSIFY) is still caught.
4. **§TRUST-LADDER-ANALYSIS — see the table below.** Verdict: not theatre. The chain was *broken at
   the last link*, not duplicated.
5. **§FULL-SUITE-REVEALS-ISOLATED-HIDES — run, and it mattered.** Both full lanes, not the touched
   files: `node --test tests/*.test.js` and `vitest run`. No hidden pin moved (F101's masking DOM test,
   F84's client pins, F111's inventory, F110/F110b, M4's own gates all green). See
   §FULL-SUITE-REVEALED-FAILURES.
6. **§TEST-SEEDS-RETIRED-KEY-EXCLUSION — applied.** The prod scan for the retired override excludes
   `src/tests/**`, and the exclusion is **observable**: exactly one file may seed it, that file must
   really seed it (`… = OVERRIDE`, comment-stripped), and a second seeder fails M5-d.
7. **§ALLOWLIST-GOAL-STATE-TYPE-CHECK — N/A** (no allowlist touched; `knownRoadmapDrift` stays empty).
8. **§SECRET-ENUM — 0 new locations.** No secret value was read, printed or stored; the token's value is
   never logged (the F101 mask is asserted) and never enters a URL or a body. Name-only locations checked:
   the canonical writer (`src/lib/dashToken.ts`), the F94 gate, F110's channel, the F101 recorder mask,
   the new tests (seeders, excluded from the prod scan).
9. **§CI-PIN-DETECTION — 1 family, 0 pins moved.** `launch-gates.yml`'s F56-d step greps
   `src/api/fetch/index.ts` for `requestId` / `traceId` / `idempotencyKey` / `isProvenanceBlocked` — all
   still present. `tests/f84-download-fetch.test.js` reads the same file and pins the download URL +
   envelope: untouched. No workflow edit needed (the node lane globs `tests/*.test.js`).
10. **§MERGE-STATE-CHECK** — #183 merged (correction #1); #182 merged; no open sibling PR
    (`gh pr list --search "M5 in:title"`/`auth routing` → empty at bootstrap).
11. **§FILE-PATH-COLLISION-CHECK** — 3 new paths (`tests/m5-auth-routing.test.js`,
    `src/tests/smoke/m5-auth-routing.test.ts`, this record) verified absent from `main` first; M4's
    `m4-*` files are edited, never renamed.
12. **§MAIN-BASELINE-CHECK — GREEN on entry** (`533213f`: `gates` ✅, `build-ui-prebuilt` ✅;
    `windows-native`/`proof`/`e2e-ui` were in progress and were re-read before the PR). Local baseline
    measured before writing anything: `node --test tests/*.test.js` **734/734**. No inherited-red repair.

### §TRUST-LADDER-ANALYSES (v14 §3.1)
| # | feature | asset | threat model | chain | verdict |
|---|---|---|---|---|---|
| 1 | **dash-token routing into `requestFetch` (M5)** | the dashboard token (write access to the runner) | (a) anyone reading the wire, (b) anyone reading local recorder rows, (c) the operator losing a `?key=` URL | generation: F94 resolver (`?key=` → `#key=` → storage) → storage: `ghrdp.dashToken` (already inventoried) → transmission: `X-Dash-Token` header, **now on all clients** → verification: server constant-time compare | **not theatre — it repairs a broken link.** Before: the generation/storage/verification links existed and the transmission link was *missing entirely* on this client (0 of its requests could authenticate). After: every link is the same one the other 15 clients already use. Added value = the operations become possible. Risk delta = one more request shape carries the credential, and it is header-only, masked by the recorder, absent from URL and body ⇒ **no new copy at rest or in logs**. |
| 2 | **`window.__GHRDP_DASH_TOKEN` (retired by M5)** | same token | anyone who can run script in the page | generation: *nothing* (0 writers) → storage: n/a → transmission: a read in one client → verification: server | **theatre, and removed.** A source that cannot be set protects against nothing while looking like a supported override. Deleted + pinned absent (M5-a/M5-d). |
| 3 | **F101 recorder masking of `X-Dash-Token`** | the token | anyone with the local Collector/DVR rows | the recorder masks by name (`SECRET_HEADER = /token\|authorization\|cookie\|key\|secret\|password/i`) and renders `present(len=…,sha=…)` | **holds, and M5 depends on it** — pinned by `f101-collector-depth.test.tsx` (a real request with a token records the masked shape) and by M5-e (the mask rule and its call site must stay). Without it, M5 would have *added* a plaintext credential copy to the ring. |
| 4 | **the fix's residual** | the token | the runner's own configuration | server: `if ($presented -and $Token)` | **honest gap, not verifiable here**: if the host has no `dash-token.txt`/snapshot token, the server refuses even a correct token. No network path to the runner from the sandbox ⇒ the operator's end-to-end check (search download → expect 202, not 401). |

### §DEAD-READ-HIDDEN-BUGS (v14 §3.1)
| # | dead read | what it was hiding | state |
|---|---|---|---|
| 1 | `ghrdp-dash-token` (deleted by M4) | the auth gap below | **fixed by M5** |
| 2 | the auth gap itself: `requestFetch` resolved a token from `window.__GHRDP_DASH_TOKEN` (1 reader, 0 writers) and sent **no** `X-Dash-Token` to a route that requires one | search download + own-credential submit + cancel/retry could never authenticate (401 `dash token required`) | **fixed by M5**; a second, undocumented dead read (the window global) was retired with it |
| 3 | `getPerRunKey()` in `src/lib/f46.ts` still sends no token | **not a bug**: `/api/config` is not token-gated in `ghrdp-server.ps1`, so attaching the credential would be a gratuitous copy | deliberately **not** changed (M4 handoff #1's second half; belongs with M6) |

### §BEHAVIOR-PINS-TBD (v14 §3.1) — what remains pinned awaiting an operator decision
| # | pinned behaviour | pin | decision needed |
|---|---|---|---|
| 1 | the per-run AES key is posted in the same body as the ciphertext (`credKeyB64`), and the server never emits `mirrorKey` (`Remove-CredKeys` strips it) ⇒ AES-over-TLS adds nothing against a body reader | M4's record + §M4-SECURITY; **not** pinned by a new test in M5 (M6 owns it) | **M6**, options A (server owns/returns the key), B (remove the layer), C (envelope + pinned public key) — the operator declined to choose this session |
| 2 | `getPerRunKey()`'s no-token request | `M4-D6` (still green, unchanged) | resolved as a *scope* decision in M5: `/api/config` needs no token, so this is correct code, not a gap (recorded at the call site too) |

### §FULL-SUITE-REVEALED-FAILURES (v14 §3.1)
**None — and this is a measured "none", not an assumption.** M5 changes the token behaviour of a client
that five other gates read or exercise, so both full lanes were run: `node --test tests/*.test.js`
**741/741** (baseline 734) and `vitest run` **1148/1148 over 89 files** (baseline 1141/88). Every
pre-existing pin that touches this path was checked by *running*, not by reasoning: F84's client pins,
F111's inventory gate, F101's masking DOM test (the step-8 lesson: it expects a token-bearing request to
record `present(len=10,sha=…)` — exactly what M5 now produces), F56-d's client test, F110/F110b's
channel tests, and M4's own two files. One **self-inflicted** gate failure was found and fixed during
the falsification pass (see below), which is the pattern §FULL-SUITE-REVEALS-ISOLATED-HIDES exists for.

### §M5-FINDING-BEFORE-THE-FIX (§GATE-SELF-TEST — my own new rule failed on my own code)
M5-d initially scanned **raw text** for the retired override, so it flagged the *comment* that explains
the retirement (`src/api/fetch/index.ts:135`) as a read — a false positive that would have forced either
a worse comment or a weakened rule. Fixed by scanning **comment-stripped code** (M4's `codeOnly`
convention) and by making the stripper itself falsifiable *inside* the rule: the scanner must find the
literal in a synthetic code fixture, must find `const a = 1;` when a trailing comment is stripped, and
must **not** count prose about the override as a read. Same class as step 9's vacuous `indexOf` and
step 10's phantom comment-derived inventory entry.

### §FALSIFY-3 — 12 mutations, **12 caught, 0 missed** (each applied, run, restored byte-identically; `git status` clean afterwards)
M1 private token source · M2 drop the header assignment · M3 token in the query string · M4 re-add the
window override read · M5 re-add the M4-retired shadow-key read and *use* it · M6 a second,
unauthenticated `fetch()` call site · M7 `cancelFetch` stops delegating · M8 the recorder stops masking ·
M9 the token leaks into the body · M10 the header is set even when empty · M11 the resolver key drifts to
the retired shadow key · V1 *(vacuity)* delete the runtime pin file. Caught by: the M5 node gate (7 rules),
the flipped M4-D5 / M4-D3, and the 7 runtime pins — every mutation was caught by **at least two**
independent gates except M6/M7/M8 (static-only, by construction) and M9 (runtime-only, by construction).

### §MEASURED (this tree, before the PR)
`node --test tests/*.test.js` **741/741** (+7) · `vitest run` **1148/1148, 89 files** (+7) ·
`tsc -p tsconfig.build.json` **0** · `vite build` **1,103.58 kB** — with the **baseline measured on this
machine** by swapping the client file back to `HEAD`: **1,103.70 kB**, so the bundle *shrank* 0.12 kB
(the local shim was replaced by a call into code already in the graph; the earlier "0.05 kB difference
not investigated" note in M4's record is the same class of build-level noise, now with both sides
measured) · `check:regression-ids` **219/219** · `check:no-neon-green` · `check:bottom-bar` ·
`check:fx-ids` PASS · **0** dependencies (8 / 21) · **0** i18n keys (lock stays 1030) · **0** new storage
keys (F111's derived set unchanged; the token key was already declared) · `patchCore.js` and every
F110/F110b file untouched · budget ≈ 35 min of 120.

### §3 updates made
- this file (header, §MAINTENANCE-STEPS-LOG M5 row, this record + the four v14 sections) · `STATE.md`
  (folded into the last line, which is at the 60-line cap) · PR **#184** body (§PRE-STEP, trust ladder,
  falsification table, scope decision) · PR-body footer corrections: none needed.
- **No ledger entry for M5** — the M1 precedent, restated because it is a trap: `stepLedger.json` is
  "one entry per PR that carried a *roadmap* step", and `tests/f111-ci-inventory.test.js` fails on a
  ledger entry no roadmap checkbox cites. A maintenance step has no checkbox ⇒ adding one would create a
  new drift and redden the gate. The maintenance phase is tracked here.
- **Operator-decision record**: the M4→M5 handoff was answered as a comment on **#183**
  (`#issuecomment-6058075174`) so the decision lives with the finding: *M5 approved; M6 not taken.*
- Labels: PR **#184** got `f-observatory` + `observatory` via the REST call (PR labels work; plain-issue
  labels are still 403 — #179/#181 remain operator items).

### Handoffs recorded (NOT done here)
1. **M6 — the per-run key leak** (M4 §M4-SECURITY). Still open, options A/B/C. Nothing in M5 touches
   `f46.ts`, so `M4-D6` remains a true pin.
2. **The end-to-end check only the operator can run**: with a live runner, a search download should now
   answer 202 instead of 401 `dash token required`; if it still 401s, read the server's `$Token`
   configuration (`dash-token.txt` / snapshot) — the client half is no longer the missing piece.
3. **M2 chrome unfencing** (6 surfaces, unchanged) · **M3 Pages `/status.json` freshness** (operator
   deploy-policy decision) · **#181** the patch emitter (do not pin a key first) · **#179** body/labels ·
   **`e2e-ui` never reaches a verdict** (25-min self-cancel; F111's re-plan owns it).

### §4 CI verdict for PR #184 — code head `8f099eb`, final (docs-only) head `2d28752`
| workflow / check | `8f099eb` (the tree that ships) | `2d28752` (docs-only) | classification |
|---|---|---|---|
| `launch-gates` → **gates** (push) | ✅ 2m06s | ✅ | GREEN |
| `launch-gates` → **gates** (PR) | ✅ 3m12s | ✅ | GREEN |
| `launch-gates` → **windows-native** (push + PR) | ✅ 9m39s / 10m43s | ✅ | GREEN |
| `proof` | ✅ 7m06s | (path-filtered) | GREEN |
| `F59 build-ui (prebuilt UI release asset)` | ✅ 36s | (path-filtered: docs-only) | GREEN |
| `autologin-lab` | ✅ | (path-filtered) | GREEN |
| `e2e-ui` | ⚠️ **cancelled** at 11:06:12Z, `created 10:40:51Z` = **1521 s**, only non-success step = `Run F78 + F79 E2E specs` **cancelled by its own 25-min `timeout-minutes`**, **0 failed steps** | ⚠️ same | **AMBER-INHERITED** — checked against the §4.2 discriminator (*< 2 min + ≥1 failed step ⇒ RED-NEW*; *≈25 min + 0 failed steps ⇒ inherited*), not by colour. Identical to main's last four pushes. |

⇒ **mergeable by the §4 criteria** (only RED-NEW blocks): every blocking lane green on both heads,
`MERGEABLE`, `mergeStateStatus: UNSTABLE` (the amber `e2e-ui` alone). Nothing was merged by this
session and `main.yml` was not dispatched. Session-log comment: PR #184.

## Session 2026-10-08 11:35Z — Maintenance step **M2** — chrome unfencing (`ChromeBoundary`, 10 surfaces) — branch `arena/4d9cc1a2-supreme-lamp`

**§STEP-SELECTION (v15 §1).** The v15 brief's suggested order after #184 was M2 → M6 → M3, with M2
recommended because it needs **no operator decision**. That held: M2 was executed. M6 (the per-run key
leak) still needs A/B/C and M3 still needs a Pages deploy policy, so neither was attempted, nothing was
merged, `main.yml` was not dispatched, no plain issue was written, and no Ed25519 key was pinned.

### §M2-PROMPT-STALENESS — the v15 brief checked against the tree (measured this session, 2 corrections)
| # | the brief said | measured | consequence |
|---|---|---|---|
| 1 | "M5 Auth Routing: 🟢 PR **#184** OPEN, mergeable ... MERGE PR #184 when ready" | **#184 is MERGED** (2026-10-08T11:11:13Z) — and this branch's HEAD **is** that merge commit (`553e165`), so M2 starts on top of M5, not beside it | §MERGE-STATUS-RE-CHECK: the operator's item 3 was already done. No sibling PR exists (`gh pr list --search "M2 in:title OR chrome in:title OR unfencing in:title"` → `[]`) |
| 2 | "M2 Chrome Unfencing: **6 surfaces** still exposed" (with a note that DvrFab/CommandPalette "may be additional, verify via grep") | **10 surfaces.** The F105 handoff named 6 (Toasts, DiagSideDrawer, CollectorRunBridge, F92VersionGate, DashTokenGate, AppShell); the tracker added DvrFab + CommandPalette; and two were added AFTER the tracker was written — `LogonGateBanner` (F93) and `DebugHUD` (F109). All 10 are fenced | §INVENTORY-RE-DERIVE: the PR TITLE states the honest count (10) and the body records the brief's "6" with the re-derivation — the brief's own instruction was to verify it |

Everything else in the brief checked out: #182/#183 MERGED, #179/#181 OPEN and *issues* (not PRs),
#164/#165 OPEN, #163/#169 CLOSED, the Ed25519 pin still empty (`PATCH_PUBLIC_KEY_B64 = ""`),
labels PR-only for this token.

### §PRE-STEP — all 12 checks run (v11 + v15)
1. **§SPEC-REALITY — 1 drift, executed as written anyway.** The brief's implementation sketch said
   "`src/components/primitives/ChromeBoundary.tsx` (new) ... same error-boundary pattern as
   FeatureBoundary ... emits same `ghrdp:feature-boundary-error` event". Kept: one channel, one event
   name, one reporter. Changed: the detail gained a `kind` discriminant and the row builder branches,
   because "a chrome crash filed as a broken SECTION" is the one thing a shared channel makes easy to get
   wrong (`kind` is optional so every pre-M2 producer, test and stored row still means "a route fence").
   Recorded, not silently re-scoped.
2. **§INVENTORY-RE-DERIVE — 10, not 6** (correction #2 above). Derived from `grep -n "data-testid"`-level
   code reading of `App.tsx` + `AppShell.tsx`, not from the tracker.
3. **§SECRET-ENUM — 0 new locations, 0 values read.** The new files name no credential, no endpoint and no
   storage key; the Node gate scans them for the F105-j/M5 banned-token class.
4. **§ARCH-FEASIBILITY — verified.** `FeatureBoundary` is the proven pattern; the chrome variant differs in
   exactly three intended ways (null instead of a card; bounded retry; no mount-ledger registration).
5. **§SECURITY-REMEDIATION-CHECK — clear.** No new route/endpoint/storage; the fence wraps existing mounts,
   and `DashTokenGate`'s crash mode is documented as "the server is still the authority (403)".
6. **§CI-PIN-DETECTION — 6 pin families, 0 pins moved.** F105-g (`exactly 13 fence("…")` calls), F105-h
   (route literals), F56-c (`launch-gates.yml` sidebar order + two verbatim route elements), F-DVR-i
   (`<DvrFab />` literal + `indexOf("<CollectorRunBridge />") < indexOf("<DvrFab />")`), F109-f
   (`<DebugHUD />` after `</Routes>` before `</HashRouter>`, once, not in AppShell), F-TESTID a–f. Every one
   is satisfied because **the mount expressions are byte-identical** — M2 adds fences around them and moves
   nothing. Verified by running the full node lane and the full vitest lane, not by reasoning.
7. **§FACT-REFRESH — done** (§M2-PROMPT-STALENESS).
8. **§PRIMITIVE-AUDIT — the right primitive exists and is reused.** `sanitizeBoundaryMessage`,
   `sanitizeBoundaryRoute`, `FEATURE_BOUNDARY_EVENT`, `installFeatureBoundaryReporter` (installed in
   `main.tsx` for F105) are all reused unchanged; `ChromeBoundary` is the only new component, and it is a
   sibling of `FeatureBoundary` rather than a parameterised version of it — a `FeatureBoundary` with a
   "chrome mode" flag would have made the mount ledger and the i18n card conditional inside the one
   component every F105 gate reads.
9. **§MERGE-STATE-CHECK — GREEN on entry** (`553e165`, the #184 merge; re-read before the PR).
10. **§MAIN-BASELINE-CHECK — GREEN and measured on this machine**: `node --test tests/*.test.js`
    **741/741** · `vitest run` **1148/1148 (89 files)** · `tsc -p tsconfig.build.json` **0** ·
    `vite build` **1,103.58 kB** (byte-identical to M5's final number). No inherited-red repair.
11. **§FILE-PATH-COLLISION-CHECK — 5 new paths, all free** (`src/lib/chromeBoundaryCore.js` + `.d.ts`,
    `src/components/primitives/ChromeBoundary.tsx`, both gates) — verified absent on `main` first.
12. **§SIBLING-PR-DETECTION — none** (query above). **§CALL-SITE-MAJORITY-SIGNAL (v15):
    N/A-with-a-twist** — there was no majority call-site to align to: F105 has exactly ONE producer, so the
    design question was "extend the channel or fork it", and the answer followed the F107 precedent
    (two producers, two provenance tags, one mechanism).

### §SCOPE-DECISIONS (v15 §TOUCH-ONLY-WHAT-NEEDS-TOUCHING)
| # | adjacent code | touched? | why |
|---|---|---|---|
| 1 | `src/components/primitives/FeatureBoundary.tsx` (F105's card) | **no** | the section fence's behaviour is not part of M2's bug; the shared types it consumes are widened optionally, so the component needed no change at all — and its DOM gate proves the card still renders on a section crash |
| 2 | `src/lib/debugHud.ts` (F109's `lastErrors` map) | **no** | chrome details DO reach the HUD's error map (`kind` is carried, the guard is unchanged), but the Features panel renders errors keyed by the 11 registry ids, so a chrome key has no card. Adding a chrome errors panel is F109's surface, not M2's — recorded as a handoff instead of a drive-by |
| 3 | `SessionListModal` | **no new fence** | it renders inside DvrFab's tree (`DvrFab.tsx:198`), so the `dvr-fab` fence covers the FAB path and the Collector page's own fence covers the page path |
| 4 | `i18n` catalogs (the count lock is at 1030) | **no** | the chrome card renders nothing, so M2 introduces **0** user-visible strings — the one place where "chrome differs from sections" pays for itself |
| 5 | `src/lib/ci/stepLedger.json` / `storageInventory.json` | **no** | a maintenance step has no roadmap checkbox (M1's precedent: adding a ledger entry a checkbox does not cite reddens F111-d), and M2 adds no storage key |

### §DESIGN — one channel, two provenances, three deliberate differences
- **Same event, same subscriber, same dedup budget, same row cap.** A second event name would have meant a
  second reporter, and two implementations of one budget is exactly the drift class the step-6 double-merge
  (#175) is remembered for. `emitChromeBoundaryError` mints `kind: "chrome"` + `feature: "chrome:<surface>"`
  so a caller cannot forget either half; `boundaryCollectorRow` branches BEFORE the section wording, so a
  chrome failure is never described as a broken section. F105's original shape survives as "absent kind" —
  the F101 rule ("every new field optional so old rows keep rendering") applied to a live contract.
- **Null, not a card** (rule 2 in `ChromeBoundary.tsx`): the prompt's policy, and the right one — a crash
  card for an overlay would paint over a dashboard that is still working.
- **Bounded auto-retry (3 × 2 s)**: chrome has no Retry button (it renders nothing), so a transient crash
  would otherwise neuter the surface for the whole session. A deterministic crash settles after ~6 s.
- **No mount-ledger registration**: `mountedFeatureIds()` is what F105's sweep and the Debug HUD's Features
  panel read; chrome registering there would make the HUD report sections that are not mounted (the reason
  F109 refused `FeatureBoundary` for its own panels).

### §FALSIFY-3 — 13 mutations, **13 caught, 0 missed** (applied, both gates run, restored byte-identically; §GATE-SELF-TEST below)
M1 drop the `toasts` row from the table · M2 add an 11th id to the `.d.ts` union only · M3 unfence the
Toasts mount · M4 add a NEW chrome element after `</Routes>` unfenced · M5 register in the F105 ledger ·
M6 paint a wrapper div when healthy · M7 drop the `kind` from the emitter · M8 ignore the chrome kind in the
row builder · M9 convert a SECTION fence into a `chrome()` call · M10 remove the AppShell fence ·
M11 unbounded retry · M12 silent null (emitter removed) · M13 file chrome under the SECTION source tag.
Caught by: M2-a (id set + union parity + policy pair), M2-b (mount/block derivation), M2-c (fence
properties), M2-d (channel provenance), M2-e (13 `fence()` calls) and the DOM suite's byte-equal / sweep /
ledger / retry / App-level / reporter tests — most mutations caught by two independent rules.

### §GATE-SELF-TEST — 2 defects in THIS step's own gates, found by falsifying rather than by green
1. **The silent-failure loophole (M12).** M2-c originally pinned `code.includes("emitChromeBoundaryError")`.
   Replacing the call with `void ({` **passed it**, because the leftover import still contains the name. A
   gate that pins a NAME is satisfied by an unused import; it now pins the **call** (`/emitChromeBoundaryError\(\{/`)
   inside the `componentDidCatch` body, and the retry call site with it. This is the F105/M5
   comment-stripping lesson one level up: **pin the use, not the mention.**
2. **The vacuous mutation (M5 of the driver).** The first falsification driver's M5 target string did not
   exist, so that mutation silently did not apply and the row proved nothing. The driver now asserts the
   target is present; the row was re-run and is caught. (Same class as the M1 record's "a scan that reads
   nothing must fail, not pass".)
3. **A test that could not see what it asserted.** The DOM retry test was first written with a per-render
   `capture()` helper that unsubscribes when the render returns — so the events fired during
   `advanceTimersByTime` were invisible and the assertion was blind. It subscribes once per test now, and
   advances one interval at a time so the SPACING is proved rather than the total.

### §HONEST-RESIDUALS (v15 §HONEST-RESIDUAL-DOCUMENTATION)
1. **The App-level DOM proofs cover 2 of the 10 surfaces** (DvrFab and AppShell are the two this suite
   mocks to throw). The other eight are proved by the sweep that mounts each fence directly with a throwing
   child, and by the Node gate's mount/derivation rules — but "the real App survives a crash in Toasts"
   specifically is asserted structurally (the fence's containment + App's own mount list), not by making the
   shipped `<Toasts />` throw. Making all ten throw inside the real App would need ten module mocks.
2. **The mount wiring is a static claim.** Mutation M3 (unfence the Toasts mount) is caught by the Node gate
   and NOT by the DOM suite — deliberate (a static property belongs in a static gate), and recorded here so
   the next reader does not read "DOM: MISSED" as a hole.
3. **A chrome crash is invisible on screen, by design.** The diagnosis is the Collector row (source
   `chrome-boundary`, reason naming the surface and what was lost) plus the HUD's error map — the HUD's
   *Features* panel does not render chrome keys (scope decision 2), so the collector page is the surface
   where an operator sees it. That is a real, documented gap in the HUD's coverage, handed to F109's owner.
4. **No live-runner verification is possible from this sandbox.** Nothing in M2 touches the wire, so the
   residual is narrower than M5's: the browser rendering of a nulled overlay (e.g. the toast container
   disappearing mid-session) was NOT observed in a real browser — jsdom proves containment and retry, and
   the visual behaviour follows from a null render.
5. **`e2e-ui` still has no verdict** (25-min self-cancel; unchanged, not M2's class).
6. **Pages `/status.json` freshness could not be measured here** (M3's premise): `curl` to
   `dekarita.github.io` has no network path from this sandbox (HTTP 000), so the brief's "ENABLED + LIVE but
   frozen" claim is neither confirmed nor refuted by this session; the committed `docs/status.json` still
   carries a 2026-10-07T13:19Z watcher timestamp, which is consistent with "frozen".

### §BUNDLE-SIZE-CHANGE (v15 §BUNDLE-SIZE-CAN-SHRINK) — **+4.01 kB (GREW), measured both sides**
baseline (with the new source files present but the App.tsx/AppShell.tsx fences removed): **1,103.58 kB** —
byte-identical to M5's final number, measured on this machine before M2's first edit. Final tree with all
10 fences: **1,107.59 kB**. Unlike M5 (which shrank by routing through code already in the graph), M2 adds
real code — a component, a pure core and their types — so the honest answer is "grew, by 4.01 kB, and that
is what a new fence costs". `check:regression-ids` 219/219 · `check:no-neon-green` · `check:bottom-bar` ·
`check:fx-ids` all PASS after the build.

### §MEASURED (this tree, before the PR)
`node --test tests/*.test.js` **747/747** (+6) · `vitest run` **1156/1156, 90 files** (+8 tests, +1 file) ·
`tsc -p tsconfig.build.json` **0** · `vite build` **1,107.59 kB** · **0** dependencies added (8 / 21) ·
**0** i18n keys added (lock stays 1030) · **0** new storage keys (F111's derived set unchanged) · budget
≈ 75 min of 120.

### §3 updates made
- this file (header, §Fence-coverage-gap tracker rows, §Handoff-findings 2 and 10, F105's record handoff 1
  annotated, §MAINTENANCE-STEPS-LOG M2 row, §Quality-metrics row, this record) · `STATE.md` (folded into the
  last line, which is at the 60-line cap) · PR **#185** body (§PRE-STEP, design notes, falsification table,
  scope decisions, honest residuals, MERGE-ORDER-DOC).
- **§DECISION-ON-FINDING-PR**: the finding M2 resolves is F105's handoff #1, documented in PR **#170** and
  carried in this file. The decision ("fence the chrome, null-render policy, bounded retry") is recorded on
  **#170** as a comment cross-referencing #185, so the decision flows back to the PR where the finding lived.
  #165 (the tracking issue) cannot be commented by this token (403) — it stays an operator item.
- Labels: PR #185 gets `f-observatory` + `observatory` via the REST call (PR labels work; plain-issue labels
  are still 403 for #179/#181).
- **No ledger entry for M2** (the M1/M4/M5 precedent, restated: `tests/f111-ci-inventory.test.js` fails on a
  ledger entry no roadmap checkbox cites, and a maintenance step has no checkbox).

### §CROSS-SESSION-LEARNING (new with M2)
**A gate that pins a NAME instead of a USE is defeated by an unused import** — the mutation that deleted the
only emission call passed a scan for the emitter's identifier. Pin the call, scope it to the function that
must make it (`componentDidCatch`), and keep the rule's own comment-stripping/vacuity controls. This is the
same family as the M5 record's "M5-d scanned raw text and flagged its own comment", and it is now the third
time this repo has learned it: **the gate must assert the behaviour, not the vocabulary.**

### Handoffs recorded (NOT done here)
1. **The HUD does not render chrome errors**: `debugHud.ts` ingests chrome details (the guard accepts them)
   and the *actions* panel's share summary is feature-keyed, so the Features panel shows nothing for a
   crashed overlay. F109's owner should add a small "chrome" section or key it into the errors panel — the
   data is already there; only a renderer is missing.
2. **M6 — the per-run key leak** (A/B/C) · **M3 — Pages `/status.json` freshness** (operator deploy policy) ·
   **#181** the patch emitter (do not pin a key first) · **#179** body/labels · **`e2e-ui`** never reaches a
   verdict (25-min self-cancel).
3. **`LogonGateBanner`'s crash mode is a UX question worth a second look**: the banner is the F93 evidence
   surface, and nulling it means "no banner" rather than "unknown logon state" — the bottom bar still
   reports the last logon, which is why the fence is justified, but an operator who relies on the banner
   should know the two are not identical.

### M6 Per-run key leak — envelope encryption (Option C) — PR pending
- **What changed**: The raw AES-256 per-run key (`credKeyB64`) no longer travels in the POST body.
  Client generates an ephemeral AES-256 key, encrypts creds with it, wraps the ephemeral key with
  the server's RSA-OAEP public key (RSA-2048, SHA-256). Only the wrapped envelope travels over the wire.
- **Files**: `src/lib/f46.ts` (envelope path + legacy fallback), `src/api/fetch/index.ts` (credEnvelope field),
  `src/pages/search/v2/OwnCredentialModal.tsx` (sends envelope), `payloads/ghrdp-server.ps1` (RSA keypair
  generation, public key in /api/config, envelope unwrap in /api/fetch).
- **Gates**: `tests/m6-envelope-encryption.test.js` (10 rules).
- **LAB**: node 757/757 (+10), vitest 1156/1156, tsc 0, build 1,108.51 kB (+0.92), 0 deps.
- **Backward compat**: when server doesn't publish `envelopePublicKey`, client falls back to legacy path.
- **Honest residuals**: live round-trip verification impossible from sandbox (no PowerShell on Linux).
  WebCrypto RSA-OAEP is standard API; PowerShell RSA.Decrypt(OaepSHA256) is standard .NET. The pins
  in the tests assert code presence, not runtime behaviour.

### M3 Pages data freshness — scheduled republish (Option 2) — PR pending
- **What changed**: `replay-viewer.yml` gains `schedule: cron: */10 * * * *` — re-publishes docs/ every 10 min.
- **Files**: `.github/workflows/replay-viewer.yml`, `tests/m3-pages-freshness.test.js`.
- **Gates**: 5 rules (schedule exists, cron ≤30 min, deploy allows schedule, preflight runs on schedule,
  single deployer invariant). F108-h gate preserved (push trigger fencing unchanged).
- **Cost**: ~144 Actions runs/day (within public-repo free tier).
- **Honest residuals**: schedule runs need the live repo to verify (GitHub Actions scheduler, not sandbox).

### §3 updates made
- STATE.md (M6+M3 entry appended to last line, stays ≤60 lines).
- docs/OBSERVATORY-STATE.md (header updated, M6+M3 records appended).

### M8 Cancellation-safe status finalizer — this session (arena/374acee7-supreme-lamp) — PR #188
- **What changed**: `main.yml` rdp job gains a final step `Finalize status.json (M8 cancellation-safe terminal state)` (`if: always()`, explicit `GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}` env, self-contained contents-API PUT with bounded 3x retry, always `exit 0`). It maps the real `job.status` to a truthful terminal `runStatus` (success→completed, cancelled→cancelled, failure→failed, else unknown), adds an additive `finalizeReason` field, carries the remote `overallPct`/`filesDone`/`filesTotal` (no synthetic 100%), and guards ownership so a finished run never clobbers a newer run's heartbeat (initial check + re-check before every PUT attempt).
- **Root cause fixed (PROB-004/PROB-005, RC-02)**: the Cleanup step's nested finalize wiped `C:\ghrdp\gh-pages-token.txt` before publishing and that step never sees `$env:GITHUB_TOKEN`, so `Publish-StatusToGhPages` silently returned; a cancelled run left `runStatus=in_progress` published (frozen at `2026-10-07T13:19:42Z`, observed 58h+ on 2026-10-09). It also hardcoded `completed` regardless of outcome. M8 is the LAST writer in the rdp job, so its truthful terminal state always wins.
- **Files**: `.github/workflows/main.yml` (+100 lines, additive step after Cleanup; Cleanup untouched), `tests/m8-cancellation-finalizer.test.js` (new, 10 rules M8-a..M8-j), `STATE.md` (M8 entry folded into last line, stays ≤60 lines), `SESSION_HANDOFF_PROMPT.md` (new, repo root).
- **Gates**: §FALSIFY-3 5/5 mutations caught by their intended rule (M1 `always()`→`success()`→M8-b, M2 `cancelled`→`in_progress`→M8-d, M3 env removal→M8-c, M4 step deletion→M8-a (+8 more), M5 guard inverted→M8-f). §VACUITY-PROBES P1-P3 documented in the test header. Positive control: 10/10 on the unmutated file.
- **LAB**: node 781/781 (+10), ps-balance py+mjs 0 failed (the mjs audit tokenizes every pwsh block in main.yml), `js-yaml` parse OK, config-writer-audit 66 step regions 0 overwrite-style writers, launch-gates absence pins re-verified clean (dnsName/piracy/torrent/hex32/vnc-password/GHRDP_LAB_), F108-h fence SHA unchanged (replay-viewer.yml not modified), M7 FENCE_SHA256 gate still green.
- **Honest residuals**: live dispatch+cancel verification is OPERATOR-ONLY (a session never dispatches main.yml); no pwsh in the sandbox, so the finalize script is structurally audited (ps-balance + YAML parse) but not executed; a job killed by `timeout-minutes` reports `job.status=failure` → `failed` (timeout not distinguished from generic failure); the Cleanup step's nested finalize is superseded but left in place (removal is a separate RC-05-style cleanup); the ownership guard has a seconds-wide race that self-heals via the newer run's ~80s heartbeat.
- **Operator next**: merge the PR, then dispatch main.yml once and cancel it; confirm `docs/status.json` flips to `runStatus=cancelled` with a fresh `ts` and `finalizeReason=job.status=cancelled` within ~30s, and that the next replay-viewer.yml deploy's M7 freshness summary no longer `::warning::`-fires on it.

### §3 updates made
- STATE.md (M8 entry folded into last line, stays ≤60 lines).
- docs/OBSERVATORY-STATE.md (this block appended).
- SESSION_HANDOFF_PROMPT.md created at repo root.
