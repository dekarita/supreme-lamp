# Mission Control planning — Sanitized Continuation Handoff

Status at hand-off: **PLAN_PARTIAL** (research continues; nothing implemented). Parent:
[#191](https://github.com/dekarita/supreme-lamp/issues/191). Plan v1: PR [#190](https://github.com/dekarita/supreme-lamp/pull/190)
(`9aa6051`). This continuation: PR [#192](https://github.com/dekarita/supreme-lamp/pull/192), branch `arena/b7f4c19a-supreme-lamp` (fast-forwarded from #190's head, so it carries
#190's commits). Source revision researched: `823bcb6` (= application code on `main` `580f231`).

## Read first (in order)

1. [CORRECTION-LEDGER.md](CORRECTION-LEDGER.md) — what v1 got wrong and why.
2. [SOURCE-RESEARCH-LEDGER.md](SOURCE-RESEARCH-LEDGER.md) — exact ranges read; reuse READ rows only if the file is unchanged.
3. [WORK-PACKAGES.md](WORK-PACKAGES.md) — states, dependency graph, execution briefs.
4. [CONTROL-CENSUS.md](CONTROL-CENSUS.md) — census v1 and its method.

## Do / do not

- Do not dispatch, cancel or re-run `main.yml`; run 37903915039 belongs to the operator.
- Do not close #153/#156/#154; do not ask the operator to pick an issue number (recommendation already made).
- Do not ask the operator to re-create secrets (OPERATOR_CONFIRMED_CONFIGURATION).
- Do not print status.json values other than `ts, runId, runAttempt, runStatus, finalizeReason`.
- Temporary research tooling (census indexer, P-01 probe) lived in `/tmp` and is not in the repository; re-create it
  from CONTROL-CENSUS §A and ACCEPTANCE-PLAN §3 if needed.

## Exact next steps

1. **WP-01**: after run 37903915039 ends, collect M8 terminal evidence (brief in WORK-PACKAGES).
2. **WP-03A**: read `src/components/domain/PrimaryActions.tsx` (326 lines), then `WebDesktopCard.tsx` (382),
   `MirrorCard.tsx` (410); fill risk/request/effect for their census rows.
3. **WP-05A**: read `payloads/ghrdp-server.ps1` route table and the `/diag` + `/api/diag/comprehensive` handlers.
4. **WP-09**: find the first non-success `e2e-ui` run after `2b66c11` (2026-10-05) and its commit range.
5. First implementation package when authorized: **WP-13** ([#193](https://github.com/dekarita/supreme-lamp/issues/193), brief ready).

## Publication limitation

The integration can create issues/PRs but cannot edit issue bodies or comment (HTTP 403, 2026-10-09). Copy-ready
texts: [ISSUE-191-BODY.md](ISSUE-191-BODY.md), [GITHUB-COMMENTS-PENDING.md](GITHUB-COMMENTS-PENDING.md). Do not retry
denied writes; ask the operator to paste them or re-check permissions in a later session.

## Open questions

- Which identity is the intended RDP application account (ISSUE-RECONCILIATION §4)? — operator decision.
- Which spec hangs in `e2e-ui` for 25 minutes? — log access needed.
- Is `/ws` answered by the PowerShell server or the Rust dashboard in production? — WP-05A.
