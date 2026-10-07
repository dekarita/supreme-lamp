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

**Roadmap owner**: #165 · **Inventory prerequisite**: #163 · **Updated**: 2026-10-07 08:05Z by arena/0648e4eb-supreme-lamp

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
- [ ] **Step 3 — F-DVR-LITE** · ETA 90min · Share-with-AI button + GitHub attachment upload

## Phase 2 — Observatory core
- [ ] **Step 4 — F105** · ETA 90min · Feature Registry + 11 FeatureBoundaries
- [ ] **Step 5 — F106** · ETA 120min · `/#/lab/<section>` isolated test pages × 11
- [ ] **Step 6 — F107** · ETA 90min · Full DVR: DOM mutations + screenshots + IndexedDB
- [ ] **Step 7 — F108** · ETA 120min · Public Replay Viewer on Pages + Arena mode
- [ ] **Step 8 — F109** · ETA 90min · Debug HUD overlay (F12-shift)

## Phase 3 — Advanced
- [ ] **Step 9 — F110** · ETA 150min · Live Patch Protocol (module federation)
- [ ] **Step 10 — F111** · ETA 60min · CI Inventory Gate (PR validates #163 drift)

## Standing facts the next session should not rediscover
- **`e2e-ui` is red on `main` for reasons no step can fix**: it is cancelled by its own
  `timeout-minutes: 25` while running the F78+F79 spec group — 0 successes in the last 25 runs on
  every branch, including the merged F101/F102/F104 pushes. Enforce `gates` + `windows-native`
  green; spend leftover budget on the F111 e2e-timeout re-plan, not on chasing `e2e-ui`.
- **Labels are operator-only** (403 for `roadmap`/`observatory`/`f-observatory`/`meta-issue`; see #164).
- A session NEVER merges a PR and NEVER dispatches `main.yml`. `STATE.md` stays ≤60 lines (fold new
  entries into the last line, as F101/F104 did).
- **Inventory drift, for #163/F112**: button sites were 174/76 vs #163's 150/63 (step 1) and the i18n gap is 88 vs 72
  (step 2). A future F112 must therefore diff *derived* counts against #163 AND forbid a string living only in a
  `defaultValue` — the 16-key class no key-set audit can see.
- **i18n is closed and now ratcheted** (step 2 / #167): 949 en / 949 si, key-set identical. Do NOT re-add a
  `si` value that is byte-identical English prose — `ACCEPTED_ENGLISH_PROSE` in `tests/f-i18n-parity.test.js` is a
  22-entry shrink-only debt list (mirrorHostMatrix/*, banners/*, egress.line, search.fetch/*, files.v2.*, …); adding a
  23rd fails CI. `fallbackLng:"en"` in `src/i18n/index.ts` stays, so a future hole is silent at runtime and loud in CI.
  `i18n-f56-parity.test.ts`'s 528-key `search.*`/`files.*` lock is intact; the repo-wide gate was added beside it.
- **Step 4 starts with a known crash to bound**: `src/pages/Telemetry.tsx` throws on a standalone mount with an empty
  store (`BeaconJsonlViewer` dereferences a null `handlerChain`, React unmounts the tree). Found by the step-2 DOM gate;
  it is the failure class F105 `FeatureBoundary` exists for, and `tests/smoke`-style mounting is how to prove the boundary holds.
- **Step 3 inherits a localisable Collector**: the 16 `collector.*` keys are real catalog entries now, so the DVR FAB
  and its preview/confirm panel can be `t()`-driven from day one; the `defaultValue`s in `Collector.tsx` are redundant nets.
- **A gate that no one has to remember beats a new CI step**: put repo-wide static checks in `tests/*.test.js` — the
  launch-gates job already runs `node --test tests/*.test.js`. Any `src/tests/smoke/**.test.tsx` is picked up by
  `pnpm exec vitest run` in the same job. Both step-2 gates ride on globs, so neither can be dropped by a future edit.
- **DOM gates must read attributes, not just text** — `placeholder`/`title`/`aria-label` hold a real share of the UI copy
  (that one change took step 2's proven coverage from 59 to 70 keys). Assert both languages: `si` present AND `en` absent
  is what distinguishes a live switch from a bilingual constant.
- **Step 3/6/7 hook**: F104 `globalClickCapture` ignores `collector-`/`click-now-` test-id prefixes;
  `tests/f-testid-coverage.test.js` rule f enforces that no ordinary button is ever named into that
  blind spot, so DVR/replay bundles keep 100% click coverage by construction.
