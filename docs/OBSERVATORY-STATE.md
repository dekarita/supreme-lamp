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

**Roadmap owner**: #165 · **Inventory prerequisite**: #163 · **Updated**: 2026-10-07 07:18Z

## Phase 1 — Immediate value
- [x] **Step 1 — F-TESTID** · landed on `arena/ad1df050-supreme-lamp`, PR **#166**, head `5cf005a`
  · CI: `gates` ✅ 1m44s · `windows-native` ✅ · `e2e-ui` ⚠️ pre-existing 25-min self-cancel (see below)
  · measured gap was **76 missing of 174 button sites**, not 63 of 150 (see #163 §4 correction in the PR body)
- [ ] **Step 2 — F-I18N-SI-72** · ETA 30min · 72 missing `si` keys + en/si parity gate
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
- **Step 3/6/7 hook**: F104 `globalClickCapture` ignores `collector-`/`click-now-` test-id prefixes;
  `tests/f-testid-coverage.test.js` rule f enforces that no ordinary button is ever named into that
  blind spot, so DVR/replay bundles keep 100% click coverage by construction.
