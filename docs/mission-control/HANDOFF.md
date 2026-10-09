# Mission Control planning — Sanitized Continuation Handoff

Status at hand-off: **PLAN_PARTIAL** (research continues; nothing implemented). Parent:
[#191](https://github.com/dekarita/supreme-lamp/issues/191). Plan v1: PR [#190](https://github.com/dekarita/supreme-lamp/pull/190)
(`9aa6051`). Plan v2: PR [#192](https://github.com/dekarita/supreme-lamp/pull/192) (`d077e57`). **Plan v2.1 (this
session): continuation branch `arena/822ae03c-supreme-lamp`, rebased onto #192's head `d077e57`, so it carries
#192's commits and adds corrections on top.**

## Checkpoint (refreshed 2026-10-09T09:19Z)

| Dimension | Value |
|---|---|
| application source revision | `823bcb6e94df8117a2f43d491a73e60265a968a1` (PR #189 merge) — **unchanged** |
| `main` HEAD | `adffebc0` — advanced from `580f231` by **40 status-only commits** touching only `docs/status.json` |
| documentation revision | PR #192 head `d077e57` + this session's commits |
| `merge-base(main, #192)` | `823bcb6` ⇒ #192 cannot conflict with main |
| PR #190 | OPEN @ `9aa6051` — **superseded by #192; creates the same two files with different content** |
| PR #192 | OPEN @ `d077e57` |
| workflow run | [37903915039](https://github.com/dekarita/supreme-lamp/actions/runs/37903915039) on `823bcb6`, `in_progress`, started 08:16:09Z |
| M8 stages | **A = NOT_REACHED** (finalizer not executed); readiness only (initial + heartbeat) |
| deployment/build identity | unchanged from `823bcb6` (no application build since PR #189) |

**Do not treat a heartbeat/status commit as a new application build** (ledger J11). Compatible build identity must
be the application tree, not the commit SHA.

## Read first (in order)

1. [CORRECTION-LEDGER.md](CORRECTION-LEDGER.md) — **the v21 rows (J1–J12) are this session's output.**
2. [SOURCE-RESEARCH-LEDGER.md](SOURCE-RESEARCH-LEDGER.md) — §4 is this session's read record.
3. [PRIVACY-SINK-MAP.md](PRIVACY-SINK-MAP.md) — **new**: the WP-13 scope proof (sinks S1–S11).
4. [ENDPOINT-CONTRACTS.md](ENDPOINT-CONTRACTS.md) — **new**: 76-route inventory + the two-layer auth model.
5. [WORK-PACKAGES.md](WORK-PACKAGES.md) — WP-01, WP-07, WP-13, WP-14 corrected in place.

## What changed this session (summary)

- **J1** — WP-01's `runStatus ∈ {success, failure, cancelled}` was wrong; the real terminal set is
  `{completed, cancelled, failed, unknown}` and `finalizeReason` carries the GitHub word.
- **J2** — ownership step-aside is a `::notice::`-level SUCCESS outcome, not a failure; the runbook only told you to
  look for `::warning::`.
- **J3** — WP-14's "`.rdp` result reflects `window.open` return value" is **not implementable**: with `noopener` the
  spec returns `null` on success. Rule rejected and replaced.
- **J4** — the `.rdp` row also persists the runner **IP**; previously unassigned, now WP-14.
- **J5–J7** — WP-13's 3-file scope **cannot** meet its own acceptance: `.mcrec` v2 `shots[]` and IndexedDB are out of
  scope. Acceptance split; **WP-13 downgraded to `SPECIFIED`**; new **WP-13b**. Screenshots are opt-**out**, not opt-in.
- **J6 / MC-P24** — the screenshot pipeline's "reads STRUCTURE only" fence is **unsound**: `XMLSerializer` serializes
  text nodes and attribute values.
- **J8** — Alt+D has **no in-app conflict** (verified) but **is browser-reserved**; shortcut rejected, `NOT_MEASURED`
  in the real RDP browser.
- **J9** — server auth is **two-layer**; `Test-GhrdpDashToken` covers only 3 route groups; `/ws` is answered by the
  **PowerShell** server on 7331 (bind `0.0.0.0`), resolving the previous open question.
- **J12** — the sandbox clone was **shallow**; ancestry claims need `--unshallow` first.

**No work package is currently `READY_FOR_IMPLEMENTATION`.** The two that claimed it were downgraded on evidence.

## Do / do not

- Do not dispatch, cancel or re-run `main.yml`; run 37903915039 belongs to the operator.
- Do not close #153/#156/#154; do not ask the operator to pick an issue number.
- Do not ask the operator to re-create secrets (OPERATOR_CONFIRMED_CONFIGURATION). A 401/403 in a diagnostic names a
  **layer**, not a missing secret.
- Do not print status.json values other than `ts, runId, runAttempt, runStatus, finalizeReason`.
- **Never** target `/remote-exec`, `/terminal-exec`, `/api/rdp-creds`, `/launch`, `/api/fetch` with a probe.
- Re-create research tooling from CONTROL-CENSUS §A; nothing in `/tmp` is reproducible evidence.

## Exact next steps (ordered)

1. **WP-05A**: read `payloads/ghrdp-server.ps1` **L2593-L2692** (`/diag`) — WP-14 MC-P14 is blocked on it. Then
   **L7568-L7990** (`/api/diag/comprehensive`), then the **L8542** `/terminal` guard.
2. **WP-13b / MC-P24**: render-level probe — does `CopyLink` render `secrets.credWinPass` as visible DOM text?
   (`Copy.tsx` L69-end is unread.) This decides whether screenshots are a confirmed leak or a confirmed mechanism.
3. **WP-03A**: `PrimaryActions.tsx` (326) → `WebDesktopCard.tsx` (382) → `MirrorCard.tsx` (410) — still not started;
   the 277 `SITE_ONLY` rows are unchanged.
4. **Original user problems still untouched**: Explorer (`src/lib/explorer/*`, `src/pages/file-explorer/*`) and the
   upload/mirror path (`src/lib/mirror.ts`). **These must not be displaced by the diagnostics plan.**
5. **WP-01**: re-check run 37903915039 for Stage A; classify by the `action=` token table in
   `docs/M8-LIVE-VERIFICATION.md` §3.

## Publication

The token reports `admin: true, push: true` on the repo (checked 2026-10-09T09:2xZ), which **differs** from the
403 recorded earlier today at ~08:52Z. Actual write results are recorded in
[GITHUB-COMMENTS-PENDING.md](GITHUB-COMMENTS-PENDING.md); copy-ready text is retained there regardless.

## Open questions

- Which identity is the intended RDP application account (ISSUE-RECONCILIATION §4)? — operator decision; does not
  block any other research.
- Which spec hangs in `e2e-ui` for 25 minutes? — log access needed.
- ~~Is `/ws` answered by the PowerShell server or the Rust dashboard?~~ **RESOLVED: PowerShell** (J9).
- Does `CopyLink` render credential text into the DOM? — needs a render probe (step 2).
