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

**Roadmap owner**: #165 · **Inventory prerequisite**: #163 · **Updated**: 2026-10-07 11:0xZ by arena/bd2c6418-supreme-lamp (step 3)

## §OPERATOR-ASSERTIONS (operator-only writes)

Seeded from the operator's step-5 prompt, because **the section did not exist in this file before this
session** (the prompt assumed it did; recorded as drift below, not silently invented). Sessions may read
this section and may append corrections with a date - they may not rewrite it.

1. **`GH_PAT`**: created and stored as a **Cloudflare Worker environment variable** (`worker.js:92`,
   behind `/dispatch`, `/cancel`, `/workflow`). It is **not** an Actions secret, no workflow reads
   `secrets.GH_PAT`, and `gh api /repos/…/actions/secrets` is 403 for a session token. Step 3's halt
   record below is the falsification; this bullet is the operator's confirmation of the same fact.
2. **GitHub Pages**: the operator's assertion says "see assertions" - **no state was actually supplied**,
   and `dekarita/supreme-lamp` Pages is still unverified by any session. Step 7 (F108) is the first step
   that needs it, so this is an operator item with a deadline, not a blocker today.
3. **Labels**: `POST /repos/…/labels` (create) and `POST /issues/<n>/labels` **work** with the session
   token **on pull requests** and on issues created in the same session; `#163`/`#165` remain 403
   (plain issues the token did not create). Confirmed again in step 3 (PR label applied; #169 label
   applied); `PATCH /issues/165` remains 403 and is never retried.
4. **Step 3 decision (the blocker this session inherited)**: #169 option **(d) - no upload at all**:
   build the `.mcrec` in the tab, copy it with the existing clipboard primitive, paste it into Arena.
   Written by the operator into #169's body during step 4's session; step 3 executed it and shipped
   no upload path, no new secret, no new endpoint.

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
- [ ] **Step 4 — F105** · ETA 90min · Feature Registry + 11 FeatureBoundaries
  · **OPEN as PR #170** (`arena/75bc347b`, head `f6a3d8a`, 16 files, +1691/−28). **NOT merged, and not
    mergeable as-is: `mergeStateStatus=DIRTY`** (textual conflicts in `docs/OBSERVATORY-STATE.md` and
    `src/i18n/si.json` against the now-merged #167). Its own checks were green at the pin: `gates` ✅
    2m54s · `windows-native` ✅ 10m57s · `f56d/f57/f60` ✅ · `e2e-ui` pending. **Operator action: rebase
    #170 onto `main` (keep #167's step-2 block *and* #170's step-4 block) or close it.**
- [ ] **Step 5 — F106** · ETA 120min · `/#/lab/<section>` isolated test pages × 11
  · **HARD-BLOCKED on step 4 landing**: `src/components/primitives/FeatureBoundary.tsx` and
    `src/lib/featureRegistry.ts` exist **only on PR #170's branch** - on `main` there is no
    `featureRegistry.ts` and no `featureBoundary.ts`, so `featureLabPath()` and `fence()` do not exist
    to build on. Re-derived this session (§SPEC-REALITY). Not a soft dependency: F106 without the
    primitive would either duplicate it (a second source of truth for the same 11 sections) or fork it.
- [ ] **Step 6 — F107** · ETA 90min · Full DVR: DOM mutations + screenshots + IndexedDB
- [ ] **Step 7 — F108** · ETA 120min · Public Replay Viewer on Pages + Arena mode
- [ ] **Step 8 — F109** · ETA 90min · Debug HUD overlay (F12-shift)

## Phase 3 — Advanced
- [ ] **Step 9 — F110** · ETA 150min · Live Patch Protocol (module federation)
- [ ] **Step 10 — F111** · ETA 60min · CI Inventory Gate (PR validates #163 drift)

## Step 3 execution record — F-DVR-LITE (2026-10-07 11:05Z, `arena/bd2c6418-supreme-lamp`)

**What shipped.** The diagnostic DVR, as option (d) of #169: the last 30 s of clicks, assembled in the
tab, copied through the existing clipboard primitive, pasted into Arena by the operator. Nothing else.
| file | role |
|---|---|
| `src/lib/dvr-core.js` (+ `.d.ts`) | the pure ring: 30 s window **and** 200-entry cap, `mcrec` v1 bundle, base64 + `mcrec1:<codec>:` paste envelope. Plain JS so the `node --test` job can *execute* the shipped rules with no DOM and no build - the F58 precedent. |
| `src/lib/dvr.ts` | the wiring: `installDvr(inner)` **decorates** the recorder F104 already receives by injection (extend-never-replace, the rule #168 derived); `installDvrObservers()` counts DOM mutations and records route changes; `dvrReport()` builds the exact bytes Copy writes. |
| `src/components/domain/DvrFab.tsx` | FAB + `Modal` panel: counts, codec, char count, the real envelope preview, Copy, Clear, pause. The preview **is** the payload. |
| `src/main.tsx`, `src/App.tsx` | one decoration at the F104 seam (inside the existing kill-flag guard, plus a DVR-specific `VITE_DVR_ENABLED`), one chrome mount beside `CollectorRunBridge`. |
| `src/i18n/{en,si}.json` | 21 `dvr.*` keys in **both** catalogs, with the parity count lock moved 949 → 970 in the same commit. |

**PRE-STEP (all 8 checks, as the prompt demands):**
- `§SPEC-REALITY` - **4 drifts**: (1) #167/#168 are **merged** and the roadmap said open; (2) PR #170 is
  **CONFLICTING**, not mergeable; (3) `docs/CI-GATE-BRITTLENESS.md` and `§OPERATOR-ASSERTIONS` did not
  exist although the prompt assumed both; (4) on `main` there is no `FeatureBoundary`/`featureRegistry`,
  so step 5 has a **hard** (not soft) dependency on #170. Also re-confirmed the standing drifts: smoke
  tests live in `src/tests/smoke/`, the ledger has **10** steps.
- `§INVENTORY-RE-DERIVE` - #163 §2 + F104's 219-id/174-button ledger re-read; hidden class re-checked
  (the 16 `collector.*` defaultValue-only keys from step 2 are real catalog entries now, so the DVR panel
  could be `t()`-driven from day one with no new default-only string).
- `§SECRET-ENUM` - 7-location search re-run for `GH_PAT`, `dvr`, `upload`, `token`: **no** credential is
  needed by option (d) and none was added. The only credential in scope remains the Cloudflare Worker var
  (`worker.js:92`) which this step never reads.
- `§ARCH-FEASIBILITY` - verified 3 ways: `installGlobalClickCapture(recorder)` takes an **injected**
  `GlobalClickRecorder` (read the module, not the summary); `CompressionStream` exists in Node 22 (probed)
  and is absent in jsdom (so the plain codec is a real path, and it is DOM-tested); the toast + `copyText`
  primitives exist and are the F27/F41 egress. **Feasible.**
- `§SECURITY-REMEDIATION-CHECK` - clear: no endpoint, no `fetch`, no storage, no DOM text, no re-added
  `/api/diag-upload` class. Asserted by gate, not by comment (`F-DVR-f`, `F-DVR-g`).
- `§CI-PIN-DETECTION` - **3 pins** evaluated: F56-c's `src/App.tsx` route greps (kept byte-true; the F56-c
  step was extracted and re-run locally → PASS), `tests/f104-global-click.test.js` F104-f **call shape**
  (updated same-commit, stricter), `tests/f-i18n-parity.test.js` **count lock** (949 → 970, same commit).
- `§FACT-REFRESH` - labels re-tested: PR label + new-issue label work; #163/#165 stay 403. Roadmap status
  re-tested against the API (see drifts above).
- `§PRIMITIVE-AUDIT` - extended, not replaced: F104 recorder (decoration), `Modal` + `Toasts`
  (F41/F91), `copyText` (F27), the `tests/*.test.js` glob (launch-gates:2449) and the
  `src/tests/smoke/**` vitest glob (:2478). **No new dependency.**

**Falsification (§FALSIFY-3, 3+ per gate): 22 mutations, 22 caught, 0 missed.**
- `tests/f-dvr-lite.test.js` (10): window eviction disabled; window constant 30 s → 10 s; a `fetch()`
  added to the core; format tag drifted; the cap keeping the *oldest*; F104 handed the **undecorated**
  recorder; a `dvr-*` testid dropped into F104's blind spot; the FAB using the raw clipboard API; a `si`
  translation deleted; DOM text captured in `dvr.ts`.
- `src/tests/smoke/f-dvr-lite.test.tsx` (6): `update()` no longer forwarded to the store; the pause
  switch made a no-op; the panel previewing a **summary** instead of the payload; opening the panel
  calling `fetch("/api/f-dvr/upload")`; the mutation counter dead; the panel testid renamed.
- vacuity probes (6): count lock moved to a wrong number; a key added to `en.json` only; two testids
  made equal; the plain-codec fallback deleted (caught by **both** gates after a same-session tightening);
  an extra fingerprint key added to the bundle target. Two of these were *found* by this session's own
  mutation run (the fallback was initially only caught by the DOM gate) - the fix was a stricter static
  pin, not a weaker assertion.
- **Loopholes tightened (4)**: (1) forbidden-token scans now strip comments first (the gate is about a
  file's actions, not its prose) which is what makes the `fetch`/`navigator.clipboard` mutations
  catchable *without* deleting the privacy comment; (2) the bundle-target check became a closed key-set
  assertion instead of a substring scan (a substring scan would have passed a `timezone` key); (3) the
  over-broad `.value` ban was narrowed to DOM APIs so the claim could stay strong; (4) the count-lock
  assertion was verified non-vacuous (it fails, loudly, when the lock and the catalogs disagree).

**Non-regression (positive proof).** `node --test tests/*.test.js` **640/640** (main baseline 629 +
this step's 11) · `pnpm`/`npx vitest run` **1033/1033, 80 files** (baseline 1023/79 → +10 DVR tests, no
losses) · `tsc -p tsconfig.build.json` **0** · `vite build` **1,023.94 kB** single file · `check-regression-ids`
219=219 · `check-no-neon-green` OK · `check-bottom-bar-time` OK · `check-fx-ids` PASS (10 ids + 1 class) ·
**F56-c launch-gates step re-run locally: PASS** (10 sidebar entries order-locked, 528 keys × 2 catalogs,
92 additive ids). `tests/f104-global-click.test.js` 14/14 and `tests/f-i18n-parity.test.js` 6/6 pass with
their updated pins - the pins that this step moved were re-run, not assumed.

**Handoffs.** Resolved: the step-3 "GH_PAT secret" premise (was false; option (d) needs no credential).
Recorded: (1) the DVR deliberately captures no DOM content → **F107** owns content capture and must
enumerate its own privacy surface; (2) the DVR is mounted as **chrome**, so it stays outside the 11
`FeatureBoundary` fences - see the fence-coverage tracker; (3) `docs/CI-GATE-BRITTLENESS.md` now exists
and every later step must consult it (F106 and F108 both edit `src/App.tsx`).

## Step 3 halt record — F-DVR-LITE (2026-10-07, `arena/6f15a7da-supreme-lamp`) — HISTORY, superseded by the execution record above
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

## §Baseline-main-CI (recorded by sessions, re-measured when the §4.2 pattern changes)

| sha / when | launch-gates `gates` | `windows-native` | `build-ui` | `e2e-ui` |
|---|---|---|---|---|
| `4be94a7` (last 5 `push:main`, recorded by step 3's halt session) | 5/5 GREEN | - | 5/5 GREEN | 0/5 `cancelled` (RED-INHERITED) |
| `2955bb9` (#167 head, step 2 session) | GREEN 6m | GREEN 11m | GREEN | AMBER-INHERITED (25-min self-cancel, 0 failed steps) |
| `18660d9` (main at step 3 start) | not re-measured this session | - | - | see §4.2 |

**§4.2 arrival pattern (unchanged)**: `e2e-ui` cancels itself at `timeout-minutes: 25` with **zero failed
steps** - acceptable for merge until F111 re-plans that job; after a step lands, the baseline is
re-measured from the newest `push:main` runs. Only **RED-NEW** blocks.

## §CI-GATE-BRITTLENESS inventory

**Built this session** (the file did not exist): `docs/CI-GATE-BRITTLENESS.md` - methodology, measured
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
1. **F107 (step 6) owns DOM *content* capture.** The DVR deliberately stores counts and descriptors only
   (`F-DVR-g` forbids `innerHTML`/`textContent`/`querySelector`/`getAttribute` in `dvr.ts`). F107 must
   enumerate its own privacy surface and extend the same two gate files rather than weakening them.
2. **F109 (step 8) owns the un-fenced chrome** (see the tracker below); the DVR FAB is now one of those
   surfaces.
3. **F108 (step 7) needs GitHub Pages**, which no session has verified as enabled - operator item.
4. **PR #170 must be rebased before step 5 can start.** Operator decision; the conflicts are purely
   textual (state file + `si.json`) and the resolution is "keep both steps' blocks".

## §Fence-coverage-gap tracker (v5)

Every UI surface that is **not** behind a `FeatureBoundary` once step 4 lands (derived from PR #170's
description, not from invented memory), with the target fencing step:

| surface | where | fenced? | target |
|---|---|---|---|
| 11 section routes (`/`, `/search`, `/sessions`, `/connections`, `/keys`, `/files`, `/mirror`, `/telemetry`, `/health`, `/collector`, `/settings`) | `src/App.tsx` | yes (PR #170) | landed with step 4 |
| `Toasts`, `DiagSideDrawer`, `CollectorRunBridge`, `F92VersionGate`, `DashTokenGate`, `AppShell` | `src/App.tsx` chrome | **no** | F109 |
| **`DvrFab`** (added by step 3) | `src/App.tsx` chrome | **no** - mounted beside `CollectorRunBridge`, deliberately outside the fences (a crash in a section must still leave the Copy handle reachable) | F109 |
| `CommandPalette` | `src/components/layout/AppShell.tsx` | **no** | F109 |
| 11 `/#/lab/<section>` pages | not built | n/a | F106 builds them **inside** the fence it inherits from step 4 |

## §Budget-actual-tracking (v5)

| step | expected ETA | actual used | delta | notes |
|---|---|---|---|---|
| 1 F-TESTID | 60 min | ~? | - | PR #166 |
| 2 F-I18N-SI-72 | 90 min | ~? | - | PR #167 |
| 3 F-DVR-LITE (halt) | 90 min | ~35 min | −55 | nothing shipped on purpose; halt was the correct outcome |
| **3 F-DVR-LITE (option d)** | 90 min | **~95 min** | +5 | one re-verification pass (16 + 6 mutations) and 4 same-commit CI-pin updates; the extra ~5 min is the falsification, and it found one real gate hole |
| 4 F105 | 90 min | ~? | - | PR #170 (not merged) |

## §Merge-order-graph (v5)

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

## Session log

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
