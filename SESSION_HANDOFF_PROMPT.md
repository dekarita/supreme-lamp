# GHRDP — SESSION HANDOFF (M8 follow-up, 2026-10-09)

Sanitized continuation prompt. Safe to paste into a new Arena.ai worker session or
hand to the operator. Contains no secrets, tokens, identities, request headers, or
private conversation data; every identity below is synthetic test data or public
git metadata.

## State at handoff

- Branch (this session, fixed): `arena/60cd3ac4-supreme-lamp`.
- Base: main == `c6de544712fc373f25ae08a0faee13bab6129723` (merge commit of PR #188,
  MERGED 2026-10-09T04:08:11Z; PR head `bf689310f956c7cab6d66b839cec424be0ba558e`).
- Working tree carries the M8 follow-up (uncommitted at handoff-write time; committed
  in this branch before PR creation).
- Pipeline state: IMPLEMENTED → LOCALLY_VERIFIED (structural) → PR_READY.
  **BEHAVIOR_VERIFIED** requires the windows-native lane to execute the new
  behavioral step on the follow-up PR. **LIVE_VERIFIED** is operator-only
  (runbook: `docs/M8-LIVE-VERIFICATION.md`) and is NOT RUN.
- A session never merges a PR and never dispatches/cancels `main.yml`.

## What this session did (v18 §1-§3)

1. Refreshed the checkpoint: #188 merged; merge-SHA checks at query time =
   gates success + windows-native success + proof success, e2e-ui in_progress
   (PR-head e2e-ui conclusion was `cancelled` — gh lists it as "fail"; a
   cancelled lane proves nothing). windows-native on #188 ran structure/labs;
   it never executed the M8 PowerShell. No sibling M8-hardening PR exists.
2. Reproduced both confirmed structural false negatives on isolated copies
   (mutations verified applied, control preserved): `exit 0` after
   `$ErrorActionPreference='Continue'` → 10/10 PASS; PUT wrapped in
   `if ($false)` with `$published = $true` reachable → 10/10 PASS.
3. Hardened the finalizer in `.github/workflows/main.yml`:
   per-request `-TimeoutSec $reqTimeoutSec` on BOTH read and PUT (seamed:
   `M8_REQUEST_TIMEOUT_SEC`, default 30s); monotonic overall deadline
   (`M8_FINALIZE_DEADLINE_SEC`, default 150s) gating loop + backoff truncation;
   discriminating reader (`ok|missing|auth|transient|invalid|invalid-identity`)
   so a failed read is never permission to overwrite; generation-aware
   ownership (`runAttempt` added to initial publish, heartbeat and finalizer;
   stale attempts step aside, terminal-foreign may be superseded under the sha
   fence, live-foreign is never overwritten); payload rebuilt per attempt from
   the freshest same-run read with explicit `progressSource` (no fabricated
   100%, no foreign counters); 409 → re-read/revalidate; duplicate
   finalization idempotent; success is gated on the OBSERVED 2xx; run-scoped
   terminal sentinel (`ghrdp-m8-terminal-<runId>.json` in RUNNER_TEMP)
   suppresses late heartbeats inside the generated `Publish-StatusToGhPages`.
4. §3-F: retired the Cleanup step's nested hardcoded `completed/100%` finalize
   (M8 is now the sole terminal writer; security cleanup untouched; the old
   M8-j pin was REPLACED by the stronger single-writer contract, not weakened).
5. New behavioral gate: `tests/m8-finalizer-behavior.test.js` +
   `tests/m8-finalizer-harness.ps1` — extracts the REAL step body from the
   workflow, executes it under pwsh in an isolated child process per scenario
   against a function-shadowed mocked contents API (no real network; any
   unmocked method/URI throws a refusal), records redacted request logs, and
   enforces a wall-clock kill. 23 acceptance scenarios + late-heartbeat helper
   test + self-falsify (MUT-A/MUT-B) + positive control cover the §4 matrix.
6. Wired the gate into `launch-gates.yml` windows-native as the step
   "M8 finalizer behavioral harness" (`M8_BEHAVIORAL=1`: a missing pwsh fails
   the lane instead of silently skipping).

## Evidence (actual, this session)

- `node --test tests/m8-cancellation-finalizer.test.js` → 14/14 PASS.
- Mutations M1–M7 (built + verified applied on copies): 7/7 redden intended
  rules (M1→M8-b, M2→M8-d, M3→M8-c, M4→M8-a/b/c, M5→M8-f, M6→M8-i, M7→M8-g).
- MUT-A/MUT-B rebuilt against the hardened file, verified applied → structural
  still 14/14 (documented boundary); reddened only by M8-B-self-falsify.
- `node --test tests/*.test.js` → 812 tests, 786 pass, 0 fail, 26 skipped
  (the skips ARE the pwsh-dependent behavioral scenarios, honestly labeled
  "pwsh unavailable — RUNTIME NOT RUN"; sandbox egress blocks the PowerShell
  release assets, so no local runtime).
- ps-balance py + mjs: 0 failed; YAML parse OK (both workflows);
  config-writer-audit main.yml: 66 regions, 0 bad. NOTE: running the same
  audit on launch-gates.yml fails identically on the PRISTINE baseline (F25
  false positive) — pre-existing, not a regression.
- e2e-ui plays no role in M8 acceptance; its cancelled lanes are recorded as
  their real states.

## Failed hypotheses / corrections made

- Sentinel-based pins: `runAttempt = $myAttempt` also appears in the sentinel
  one-liner — the M8-g pin was tightened to payload line-adjacency.
- The comment stripper treated quotes inside full-line comments as string
  openers — fixed by removing full-line comments first, then re-verified.
- npm `pwsh` package + GitHub release download both blocked by sandbox egress
  (release-assets host unreachable) → local runtime honestly NOT RUN.
- No pwsh/dotnet/mono exists in the sandbox image.

## Unresolved acceptance

- BEHAVIOR_VERIFIED: pending. Exact probe:
  `gh pr checks <followup-pr#>` → wait for `windows-native` → confirm the
  "M8 finalizer behavioral harness" step is green, and inspect its log for
  "[m8-behavior] runtime: node ...; pwsh 7.x" plus per-scenario results.
  Command: `gh run view --job <windows-native-job-id> --log | grep m8`
- LIVE_VERIFIED: operator-only, per `docs/M8-LIVE-VERIFICATION.md`
  (readiness-based; stages A/B/C/D recorded independently; bounded windows).

## Operator queue

1. Review/merge this follow-up PR (agent never merges).
2. Confirm windows-native's M8 behavioral step is green on the PR (and later
   on the merge SHA — refresh exact-SHA checks, PR head ≠ merge SHA).
3. Run the M8 live-verification runbook once (dispatch → readiness → cancel →
   A/B/C/D staged observation). Do not hand-edit docs/status.json.
4. Backlog (unchanged, NOT fixed by this step; do not mark fixed):
   scheduler observation/reliability (M3 cron ~10min cadence, skew unproven),
   F110 emitter + coordinated signing activation (#181),
   reported crypto-runtime issue (pending independent reproduction),
   credential persistence/fallback review, e2e-ui cancellation + missing
   coverage, Explorer/upload live acceptance, docs/config gaps.

## Budget uncertainty

Percentage telemetry is unavailable in this environment → usage is UNKNOWN.
Local signals only: single 120-min wall ceiling respected; work kept compact
(one focused PR; no unrelated maintenance). Treat cap risk as UNKNOWN, not LOW.
Next expensive step (watching CI to green) is incremental and stoppable.

## Reproduce locally (exact commands)

```bash
# structural suite (14 rules)
node --test tests/m8-cancellation-finalizer.test.js
# behavioral suite (pwsh required; without it: 26 labeled skips, exit 0)
node --test tests/m8-finalizer-behavior.test.js
# audits
python3 tests/ps-balance-audit.py && node scripts/ps-balance-audit.mjs \
  && python3 tests/config-writer-audit.py .github/workflows/main.yml
# mutation drill (copies only; never touches tracked files)
python3 - <<'EOF'
# insert 'exit 0' after ErrorActionPreference in a COPY, point M8_MAIN_YML at it
EOF
```
