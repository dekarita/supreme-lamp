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

**Roadmap owner**: #165 · **Inventory prerequisite**: #163 · **Updated**: 2026-10-07 10:05Z by arena/75bc347b-supreme-lamp

## Phase 1 — Immediate value
- [x] **Step 1 — F-TESTID** · landed on `arena/ad1df050-supreme-lamp`, PR **#166**, head `5cf005a`
  · CI: `gates` ✅ 1m44s · `windows-native` ✅ · `e2e-ui` ⚠️ pre-existing 25-min self-cancel (see below)
  · measured gap was **76 missing of 174 button sites**, not 63 of 150 (see #163 §4 correction in the PR body)
- [ ] **Step 2 — F-I18N-SI-72** · ETA 30min · 72 missing `si` keys + en/si parity gate
- [ ] **Step 3 — F-DVR-LITE** · ETA 90min · Share-with-AI button + GitHub attachment upload

## Phase 2 — Observatory core
- [x] **Step 4 — F105** · landed on `arena/75bc347b-supreme-lamp`, PR **#170** (in review, NOT merged)
  · registry `src/lib/feature-registry.json` + typed face `src/lib/featureRegistry.ts` (11 sections, source-cited DAG)
  · 11 `FeatureBoundary` fences wired in `App.tsx` (zero DOM delta when healthy) + crash channel `src/lib/featureBoundary.ts` (window event → Collector row)
  · **step-2 handoff RESOLVED**: the `/#/telemetry` empty-store crash (`LogPanel.tsx:168`, always-true `Array.isArray((native && native.handlerChain) || [])` guard) is fixed at the root, with the fence as the second line of defence
  · gates: `tests/f105-feature-registry.test.js` (11 rules, auto-run by launch-gates) + `src/tests/smoke/f105-feature-boundaries.test.tsx` (26 tests, DOM-proven)
  · Node 634/634 · Vitest 1030/1030 (79 files) · tsc 0 · build 1016.92 kB · regression-ids 219/219 · 12 falsifications, 3 loopholes tightened
- [ ] **Step 5 — F106** · ETA 120min · `/#/lab/<section>` isolated test pages × 11
- [ ] **Step 6 — F107** · ETA 90min · Full DVR: DOM mutations + screenshots + IndexedDB
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
- **Boundary test ids are `feature-boundary-<id>` (+ `-retry`/`-reload`/`-copy`)** and are deliberately NOT in
  the capture ignore-list, so the fence's own buttons stay in the DVR. The component repeats the prefix literal
  (the F-TESTID rule only accepts `"prefix-" + expr`); `tests/f105-feature-registry.test.js` F105-k asserts the
  two copies are byte-equal.
- **Step 3/6/7 hook**: F104 `globalClickCapture` ignores `collector-`/`click-now-` test-id prefixes;
  `tests/f-testid-coverage.test.js` rule f enforces that no ordinary button is ever named into that
  blind spot, so DVR/replay bundles keep 100% click coverage by construction.

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
- Budget: ~75 min of 120
