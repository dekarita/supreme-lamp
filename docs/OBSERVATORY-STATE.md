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
  · **BLOCKED (2026-10-07, `arena/6f15a7da`)** — 2 of 3 load-bearing premises falsified against reality;
    needs an operator decision on the upload target. See "Step 3 halt record" below. Step 3 was NOT executed.

## Phase 2 — Observatory core
- [ ] **Step 4 — F105** · ETA 90min · Feature Registry + 11 FeatureBoundaries
- [ ] **Step 5 — F106** · ETA 120min · `/#/lab/<section>` isolated test pages × 11
- [ ] **Step 6 — F107** · ETA 90min · Full DVR: DOM mutations + screenshots + IndexedDB
- [ ] **Step 7 — F108** · ETA 120min · Public Replay Viewer on Pages + Arena mode
- [ ] **Step 8 — F109** · ETA 90min · Debug HUD overlay (F12-shift)

## Phase 3 — Advanced
- [ ] **Step 9 — F110** · ETA 150min · Live Patch Protocol (module federation)
- [ ] **Step 10 — F111** · ETA 60min · CI Inventory Gate (PR validates #163 drift)

## Step 3 halt record — F-DVR-LITE (2026-10-07, `arena/6f15a7da-supreme-lamp`)
Halted in §0.3 PRE-STEP, before writing code: the spec's own halt condition fired, and the design it
prescribes cannot be built as written. §-1 "preserve the security guards" outranks shipping the step.
1. **GH_PAT is not an Actions secret.** `gh api /repos/dekarita/supreme-lamp/actions/secrets` → 403
   `Resource not accessible by integration` (a session can neither list nor mint it), and **no
   workflow in the repo reads `secrets.GH_PAT`**. Its only consumer is `worker.js:92` (`env.GH_PAT`)
   — a *Cloudflare Worker* env var backing `/dispatch`, `/cancel`, `/workflow` against `main.yml`.
   `ghrdp-server.ps1` has no GitHub-credential plumbing at all (only `GITHUB_SHA` + `GHRDP_*`), so
   "GET /api/f-dvr/github-token → masked presence" has no source to mask, and "waiting for the
   operator to add the secret" would not have unblocked anything.
2. **The server-side GitHub write path was removed by a prior remediation on purpose.** `Put-GhFile`
   and `Publish-GithubPagesData` (`payloads/ghrdp-lib.ps1:751,844`) open with
   `throw 'GHRDP: mirror/publish path removed per remediation (function neutered).'`, and
   `/api/diag-upload` + `/api/diag-file` are hard-404'd by the remediation guard
   (`ghrdp-server.ps1:6972`). `/api/f-dvr/upload` is that same endpoint class re-added; it needs
   sign-off, not a PR.
3. **There is no REST endpoint that attaches a file to an issue comment**, so "upload .mcrec to
   #165 as comment … return the URL" is unimplementable as specified. Falsified 3×: `gh issue
   comment --help` has no attachment flag; `gh api POST /upload/policies/assets` → 404 (the web
   paperclip rides a browser-session asset pipeline, not the API); community #46951/#28219 confirm
   the omission is deliberate. Any of these is a *spec change to choose from*: (a) gist-per-bundle
   minted by the Worker; (b) Contents-API commit onto an orphan `dvr` branch; (c) release asset on
   a rolling `dvr-bundles` release; (d) **no upload at all** — copy the `.mcrec` and let the
   operator paste it into Arena, which is 0 new secrets and 0 new endpoints on a tailnet box, i.e.
   the only option that fully respects guards (1)-(2). (d) is the recommendation.
**Frontend half is unblocked and ready.** `installGlobalClickCapture(recorder, opts)` takes an
injected `GlobalClickRecorder {record, update}`, so a DVR ring **can extend without replacing**
F104; re-derived constants are window 10s / dedup 500ms / 50-exchange cap (the "30s" in the spec is
the DVR's own window, not F104's) and the blind spot is exactly `[data-collector-ignore]`,
`[data-testid^='collector-']`, `[data-testid^='click-now-']`. Toast primitive exists and is
globally mounted (`primitives/Feedback` `<Toasts/>` at `App.tsx:75`, `useToast`); clipboard exists
(`src/lib/clipboard.ts#copyText`); **no FAB and no upload util exist**. `CompressionStream` is
present in the Node 22 vitest env and in Chromium, so a gzipped `.mcrec` costs no new dependency.
**Gate placement, re-derived**: `tests/f-dvr-upload.test.js` is auto-run by
`node --test tests/*.test.js` (`launch-gates.yml:2449`) and any `src/tests/smoke/f-dvr-*.test.tsx`
by `pnpm exec vitest run` — **not** `tests/smoke/`, which does not exist. Playwright sets
`testDir: "tests/e2e"` with no `testMatch`, so `tests/e2e/*.spec.ts` is auto-picked-up by
`pnpm run e2e`; since that job is the 25-min self-canceller, an e2e-only DVR proof would be
unfalsifiable in CI — keep it behind the two CI globs plus a jsdom DOM gate.
**Baseline main CI `4be94a7` (last 5 `push:main` each)**: launch-gates 5/5 GREEN · build-ui 5/5
GREEN · e2e-ui 0/5 `cancelled` (RED-INHERITED). Local on the same sha: Node 623/623 · Vitest
1004/1004 (78 files) · tsc 0. **Ledger count drift**: the shipped file has **10** steps, not 11 —
the repo folded F111's e2e re-plan into Step 10 — so numbering here follows the file, not the prompt.

**Blocker filed**: #169 (operator decision on the upload target; (d) clipboard-only recommended).
**Corrected standing fact — labels are NOT uniformly operator-only** (re-tested this session):
`POST /repos/.../labels` (create) works, and `POST /repos/.../issues/<N>/labels` works on a
**pull request** (#166 #167 #168 are now labelled `f-observatory` by the session) but returns `403`
on a **plain issue** — including an issue the same session just created (#169). So #163/#165 labels
stay manual, PR labels do not, and `f-observatory` + `blocked` now exist as repo labels for reuse.
`PATCH /issues/165` was attempted once, returned `403`, and is not retried; this file wins.
`gh gist create` is also `403`, so the session trace is inlined in the PR comment instead of linked.

### Session 2026-10-07 08:52Z — Step 3 — F-DVR-LITE — **HALTED BLOCKED in PRE-STEP**
- Branch `arena/6f15a7da-supreme-lamp` · PR #168 (docs-only) · blocker #169 · no feature code shipped
- Spec drift: `tests/smoke/` does not exist (smoke lives in `src/tests/smoke/`); the ledger has **10**
  steps, not 11; "GH_PAT Actions secret" is wrong — it is a Cloudflare Worker var (`worker.js:92`)
- Primitive audit ✓: toast + `copyText` exist, F104 recorder is injectable (extend-not-replace works);
  **no** FAB and **no** upload util exist
- Halt reason (each falsified 3×): no REST endpoint attaches a file to an issue comment; the server's
  GitHub write path is neutered by remediation (`ghrdp-lib.ps1:751,844` throw, `ghrdp-server.ps1:6972`
  404s `/api/diag-upload`); §-1 "preserve the security guards" outranks shipping the step
- Non-regression proof: diff is docs + `.gitignore` only — `src/`, `tests/`, `payloads/`, `worker.js`
  byte-identical to `main`; on the same base locally Node 623/623 · Vitest 1004/1004 (78 files) · tsc 0
- CI on `c4359fe` (head never changed; 0 supersedes): `gates` **GREEN** 2m · `windows-native` **GREEN** 10m
  · `e2e-ui` **AMBER-INHERITED** (cancelled by its own 25-min timeout, zero failed steps — identical to
  baseline main, which is 0/5 cancelled) → mergeable by the §4 criteria
- Budget: ~35 min of 120. Nothing was hard-earned by writing code that the falsification says must not ship.

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
