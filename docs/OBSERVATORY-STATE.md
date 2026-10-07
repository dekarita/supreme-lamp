# Mission Control Observatory — orchestrator state (mirror of #165)

> **Why this file exists.** `POST /repos/.../issues/165/labels` and `PATCH /repos/.../issues/165`
> both return `403 Resource not accessible by integration` for the Arena session token, while
> `POST .../issues` and `POST .../issues/165/comments` succeed. The tracking issue can therefore be
> **created and commented on but not edited**, so the checkbox state cannot be kept there by a
> session. This file is the authoritative, mergeable mirror: a session that cannot PATCH the issue
> MUST update this file in its own PR and append the session log as an issue comment.
> The next session's §1 step determination = first unchecked box below (fall back to #165's body only
> if this file is missing), then cross-check #165's newest session-log comment.

**Roadmap owner**: #165 · **Inventory prerequisite**: #163 · **Updated**: 2026-10-07 07:14Z

## Phase 1 — Immediate value
- [x] **Step 1 — F-TESTID** · landed on `arena/ad1df050-supreme-lamp`, PR **#166**, head `5cf005a`
  · CI: `gates` ✅ 1m44s · `windows-native` ✅ · `e2e-ui` ⚠️ pre-existing 25-min self-cancel (see below)
  · measured gap was **76 missing of 174 button sites**, not 63 of 150 (see #163 §4 correction in the PR body)
- [ ] **Step 2 — F-I18N-SI-72** · ETA 30min · 72 missing `si` keys + en/si parity gate
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
- **Step 2 needs no re-derivation**: #163 §3.6 lists all 72 missing-in-`si` keys verbatim
  (933 en / 861 si). Keep the existing `i18n-f56-parity.test.ts` `search.*`/`files.*` gate intact and
  add a repo-wide en↔si key-set gate beside it, or the 72-key class of drift returns.
- **Step 3/6/7 hook**: F104 `globalClickCapture` ignores `collector-`/`click-now-` test-id prefixes;
  `tests/f-testid-coverage.test.js` rule f enforces that no ordinary button is ever named into that
  blind spot, so DVR/replay bundles keep 100% click coverage by construction.
