# M8 live-verification runbook (operator-only dispatch)

Purpose: verify the cancellation-safe status finalizer **in production** with a
controlled run, WITHOUT corrupting evidence. The agent must never dispatch or
cancel `main.yml`; every step below is operator-executed. There is **no fixed
"wait two minutes, then cancel" rule** — cancellation is readiness-based.

Scope guardrails (do not violate while doing this):

- The agent never dispatches/cancels production `main.yml`.
- Never "repair" evidence by hand-editing `docs/status.json` to match an
  expectation. A mismatch IS the finding.
- Keep other active sessions safe: confirm no important run is in flight
  before cancelling a controlled run (main.yml has **no concurrency group**;
  two live runs heartbeat the same `docs/status.json` and the older run's
  finalizer will — correctly — step aside).

## 0. Preconditions

1. The intended implementation is merged to `main`. Record the merge SHA:
   `gh api repos/dekarita/supreme-lamp/commits/main --jq .sha`
2. Inspect checks ON THE MERGE SHA (not the PR head):
   `gh api repos/dekarita/supreme-lamp/commits/<sha>/check-runs --jq '.check_runs[] | [.name,.status,.conclusion] | @tsv'`
   `gates` and `windows-native` must be `success`. The `windows-native` job
   must contain the step **"M8 finalizer behavioral harness"** and it must be
   green. `e2e-ui` is a separate lane; a cancelled/skipped state there does
   NOT verify or block the M8 finalizer.
3. Confirm no important active session:
   `gh run list --workflow=main.yml --limit 5`

## 1. Controlled run

4. Operator dispatches ONE run with safe supported inputs:
   `gh workflow run main.yml -f <safe-inputs-as-usual>`
   Record the run ID and attempt from `gh run list --workflow=main.yml --limit 1`.
5. **Readiness, not a timer.** Wait until the tracked snapshot identifies THIS
   run AND its heartbeat has demonstrably operated:
   - `https://raw.githubusercontent.com/dekarita/supreme-lamp/main/docs/status.json`
     (or the API `repos/dekarita/supreme-lamp/contents/docs/status.json?ref=main`)
     shows `runId` == the dispatched run's ID, `runStatus` == `in_progress`,
     `runAttempt` == 1, and a fresh `ts`. Poll with a bounded window
     (suggest: give up honestly after ~15 minutes and report NOT REACHED);
     do NOT promise a fixed interval.
6. Operator requests cancellation of that run:
   `gh run cancel <run-id>` (web UI Cancel is equivalent).

## 2. Observation stages (record each INDEPENDENTLY)

- **A. Finalizer executed.** `gh run view <run-id> --log | grep '\[m8\]'`
  shows the step "Finalize status.json (M8 ...)" ran (conclusion of the rdp
  job becomes `cancelled`). If the step never appears, the run was lost to a
  scheduling/runner/cancellation limitation — that is NOT an executed-script
  defect; record A=NOT_REACHED and stop honestly.

  **Stage A means FINALIZER EXECUTED — nothing else.** Dispatch, the initial
  `status.json` commit, and heartbeat commits are **readiness evidence**, not
  Stage A. They prove the writer is live; they say nothing about finalization.

  **Terminal vocabulary (two different sets — do not conflate).** The finalizer
  maps GitHub's `job.status` onto status.json's `runStatus`
  (`main.yml` L6634-L6639):

  | GitHub `job.status` | status.json `runStatus` |
  |---|---|
  | `success` | `completed` |
  | `failure` | `failed` |
  | `cancelled` | `cancelled` |
  | `skipped` / anything else | `unknown` (switch default) |

  Terminal set = `completed | cancelled | failed | unknown` (`main.yml` L6606).
  `finalizeReason` keeps the **GitHub** word (`job.status=cancelled`), so
  `runStatus` and `finalizeReason` legitimately use different vocabularies.
- **B. Terminal snapshot committed.** Fetch the tracked file as in step 5:
  `runStatus` == `cancelled`, `finalizeReason` == `job.status=cancelled`,
  `runId` == this run, `overallPct` carries the last heartbeat value
  (NOT a fabricated 100), `ts` is fresh. Record content + the API `sha`.
- **C. Deployment consumed the snapshot.** Identify the pages deployment
  for that commit (`gh api repos/dekarita/supreme-lamp/deployments?per_page=5`
  or the Actions run of the pages workflow); it must reference the SAME
  commit the finalizer produced.
- **D. Served response matches.** `curl -s https://<pages-host>/status.json`
  equals the deployed snapshot (compare `runId`, `runStatus`, `ts`).
  A/B passing does NOT establish C/D; record them separately.
- Record actual end-to-end latency (dispatch→snapshot, cancel→terminal,
  commit→served). There is no promised fixed interval.

## 3. Negative/diagnostic paths

- **B reached but wrong content**: capture the API response + job log
  (sanitized) and file it against the finalizer step — that IS a defect.
- **A reached, B not reached within the observation window**: report the
  staleness window honestly; check the step log for `::warning::[m8] ...`.
- **Finalizer warns "snapshot stays stale"**: distinguish transient API
  failure (bounded 3-attempt retry visible in log) from auth/token issues
  (explicit 401/403 warning lines).
- **Ownership step-aside is a SUCCESS-class outcome, not a failure.** The
  finalizer emits `::notice::[m8] ...` (NOT `::warning::`) and still exits 0
  when it deliberately declines to write (`main.yml` L6662-L6689). Grep `[m8]`
  at **any** severity and classify by the `action=` token:

  | `action=` | Meaning | Score as |
  |---|---|---|
  | `skip-foreign-active` | a **newer/other** run is heartbeating `in_progress` | **CORRECT** — record `B=NOT_OWNED`, not a defect |
  | `skip-superseded` | this run's snapshot was already superseded | **CORRECT** — `B=NOT_OWNED` |
  | `skip-owned` | terminal snapshot of this run+attempt already present | **CORRECT** — idempotent skip |
  | `skip-unknown` | remote state unidentifiable; stepped aside | **CORRECT (conservative)** — investigate the remote state separately |
  | `abort-read` | 401/403 reading the tracked file | **auth finding** — investigate token, not the finalizer logic |
  | `retry-read` | transient API failure; bounded retry | report the retry outcome |

  Misclassifying `skip-foreign-active` as a finalizer failure is the most
  likely false-positive in this runbook: it is the ownership policy working
  exactly as designed.
- **Cancellation happened BEFORE the first heartbeat**: the documented policy
  applies — the previous snapshot is either absent (finalizer creates the
  terminal state) or belongs to an earlier run; a terminal older-run snapshot
  is superseded, a live foreign snapshot is never overwritten.

## 4. Rollback

- The finalizer is additive and best-effort (`exit 0` always; it cannot fail
  the job). Rollback of the change itself = revert the follow-up PR's commit
  on `.github/workflows/main.yml` (M8 step + Cleanup retirement) — the
  pre-M8 behavior (stale `in_progress` after cancellation, PROB-004) returns;
  that is a KNOWN defect, not a new risk.
- Do NOT roll back by hand-writing `docs/status.json` during a session — a
  live run's heartbeat would treat it as a foreign/owned snapshot and
  ownership policy decides; contradicting it manually corrupts evidence.

## 5. Bounded observation window

Give every stage a deadline and report timeouts as NOT REACHED:

| Stage | Suggested bound | On timeout |
|---|---|---|
| first heartbeat visible (step 5) | 15 min | readiness NOT REACHED |
| terminal snapshot after cancel (B) | 10 min | report stale window |
| deployment consumed (C) | 30 min | C=NOT REACHED |
| served match (D) | 15 min after C | D=NOT REACHED |
