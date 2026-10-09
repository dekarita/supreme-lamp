// [M8] Cancellation-safe status.json finalizer in main.yml (PROB-004 / RC-02) -
// STRUCTURAL GATE. v18 follow-up: pins now cover the hardened implementation
// (timeout/deadline bounds, discriminating reader, generation-aware ownership,
// single-terminal-writer retirement of the Cleanup nested finalize, late-
// heartbeat sentinel), and the BEHAVIORAL proof moved to
// tests/m8-finalizer-behavior.test.js (extracted PowerShell executed for real).
//
// SCOPE OF THIS FILE (honest): structural pins cannot see runtime behavior.
// Reproduced on 2026-10-09 (node v22.22.3) against the PR-#188 workflow (git
// blob 696d1245e059c259e60d776d42a4a4625a15d4cc, verified byte-identical):
//   CONTROL  unmodified workflow, previous 10-rule suite       -> 10/10 PASS
//   MUT-A    unconditional `exit 0` after ErrorActionPreference -> 10/10 PASS (false negative)
//   MUT-B    HTTP PUT wrapped in `if ($false)`, $published=$true
//            left reachable                                   -> 10/10 PASS (false negative)
// The boundary holds on the HARDENED contract too (this 14-rule suite):
//   CONTROL  hardened workflow                                 -> 14/14 PASS
//   MUT-A (rebuilt, verified applied)                          -> 14/14 PASS -> behavioral-only
//   MUT-B (rebuilt full-line wrap, verified applied)           -> 14/14 PASS -> behavioral-only
// Both mutants are therefore reddened ONLY by the behavioral suite
// (M8-B-self-falsify), never by this file - do not "fix" that by banning the
// literal strings here.
//
// ORIGINAL DEFECT (recorded): the rdp job's Cleanup step carried a nested
// finalize that (a) wiped C:\ghrdp (including gh-pages-token.txt) BEFORE
// publishing, (b) never saw $env:GITHUB_TOKEN in that step, and (c) hardcoded
// runStatus='completed' + overallPct=100 regardless of outcome. Measured
// consequence: the run cancelled 2026-10-07T13:20:15Z left docs/status.json
// frozen at runStatus=in_progress for 58h+ (observed 2026-10-09) - the public
// Pages snapshot lied about a dead session (PROB-004/PROB-005).
//
// §FALSIFY - mutations each reddening its intended rule (M1-M7 verified
// locally against COPIES via M8_MAIN_YML; M8/M9 are behavioral-only):
//   M1  `if: always()` -> `if: success()`            -> M8-b MUST fail
//   M2  cancelled arm -> 'in_progress'               -> M8-d MUST fail
//   M3  delete the step's GITHUB_TOKEN env           -> M8-c MUST fail
//   M4  delete the whole M8 step (vacuity control)   -> M8-a MUST fail
//   M5  first `-ne $mine` -> `-eq $mine`             -> M8-f MUST fail
//   M6  strip every `-TimeoutSec $reqTimeoutSec`     -> M8-i MUST fail
//   M7  remove `runAttempt = $myAttempt` payload line -> M8-g MUST fail
//   M8  early `exit 0` (MUT-A)        -> BEHAVIORAL M8-B-self-falsify MUST fail
//   M9  disabled PUT (MUT-B)          -> BEHAVIORAL M8-B-self-falsify MUST fail
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const WORKFLOW_PATH = process.env.M8_MAIN_YML || ".github/workflows/main.yml";
const M8_STEP = "Finalize status.json (M8 cancellation-safe terminal state)";
const CLEANUP_STEP = "Cleanup (wipe profiles/storage";
const PUBLISH_URL_JOB = "\n  publish-url:";
const M8_COMMENT = "# [M8] CANCELLATION-SAFE STATUS FINALIZER";

const RAW = readFileSync(WORKFLOW_PATH, "utf8");

/** Strip YAML comments (quote-aware) so prose can never satisfy a pin.
 *  Full-line comments are removed FIRST (regex) so quoted code tokens INSIDE
 *  comment prose (e.g. documentation mentioning runStatus='completed') can no
 *  longer confuse the string tracker of the trailing-comment pass. */
function stripComments(src) {
  src = src.replace(/^[ \t]*#[^\n]*$/gm, "");
  let out = "";
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '"' || c === "'") {
      out += c;
      i += 1;
      while (i < src.length) {
        if (src[i] === "\\") { out += src[i] + (src[i + 1] || ""); i += 2; continue; }
        if (src[i] === c) { out += c; i += 1; break; }
        out += src[i];
        i += 1;
      }
      continue;
    }
    if (c === "#") { while (i < src.length && src[i] !== "\n") i += 1; continue; }
    out += c;
    i += 1;
  }
  return out;
}

const LIVE = stripComments(RAW);

/** The live body of one step, by its literal name, bounded by the next step
 *  or the next job. */
function stepBlock(name, fromLive) {
  const src = fromLive || LIVE;
  const start = src.indexOf(name);
  if (start < 0) return "";
  let end = src.length;
  const nextStep = src.indexOf("\n      - name:", start);
  const nextJob = src.indexOf(PUBLISH_URL_JOB, start);
  if (nextStep > 0) end = Math.min(end, nextStep);
  if (nextJob > 0) end = Math.min(end, nextJob);
  return src.slice(start, end);
}

const BLOCK = stepBlock(M8_STEP);
const SQUASH = BLOCK.replace(/[ \t]+/g, " ");
const CLEANUP_BLOCK = stepBlock(CLEANUP_STEP);
const count = (s, sub) => s.split(sub).length - 1;

test("M8-a: the M8 finalize step exists as live YAML and is the LAST step of the rdp job", () => {
  assert.ok(RAW.includes(M8_STEP), "the M8 step name must exist in " + WORKFLOW_PATH);
  assert.ok(LIVE.includes(M8_STEP), "the M8 step must be live YAML, not a comment");
  assert.ok(RAW.includes(M8_COMMENT), "the M8 design comment must document the defect above the step");
  const iM8 = LIVE.indexOf(M8_STEP);
  const iCleanup = LIVE.indexOf(CLEANUP_STEP);
  const iPublishUrl = LIVE.indexOf(PUBLISH_URL_JOB);
  assert.ok(iCleanup > 0, "the Cleanup step must still exist (M8 supersedes its finalize, not its security work)");
  assert.ok(iM8 > iCleanup, "the M8 step must run AFTER the Cleanup step");
  assert.ok(iPublishUrl > iM8, "the M8 step must live inside the rdp job, before publish-url");
  assert.ok(BLOCK.length > 3000, "the M8 step body must be the full hardened script, got " + BLOCK.length + " chars");
});

test("M8-b: the step runs on EVERY outcome (if: always())", () => {
  assert.ok(BLOCK.includes("if: always()"),
    "the M8 step must carry if: always() so cancellation/failure still finalize");
});

test("M8-c: the step carries an explicit GITHUB_TOKEN env (token-loss fix)", () => {
  assert.ok(BLOCK.includes("GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}"),
    "the M8 step must map secrets.GITHUB_TOKEN into the env - the retired Cleanup finalize silently failed without it");
  assert.ok(BLOCK.includes("GITHUB_TOKEN is not available"),
    "a missing token must produce a visible sanitized warning rather than an unauthorized write attempt");
});

test("M8-d: job.status maps to a TRUTHFUL terminal runStatus (no hardcoded completed)", () => {
  assert.ok(SQUASH.includes("'success' { $terminal = 'completed' }"), "success must map to completed");
  assert.ok(SQUASH.includes("'cancelled' { $terminal = 'cancelled' }"), "cancelled must map to cancelled (the observed lie)");
  assert.ok(SQUASH.includes("'failure' { $terminal = 'failed' }"), "failure must map to failed");
  assert.ok(SQUASH.includes("$terminal = 'unknown'"), "unknown outcomes must map to the explicit unknown fallback");
  assert.ok(SQUASH.includes("${{ job.status }}"), "the mapping must read the REAL job.status");
  assert.ok(BLOCK.includes("runStatus = $terminal"), "the published object must use the mapped value");
  assert.ok(!BLOCK.includes("runStatus = 'completed'"),
    "the M8 step must not hardcode runStatus='completed' (the retired Cleanup lie)");
});

test("M8-e: the publish is self-contained (contents API PUT, no wiped-token dependency)", () => {
  assert.ok(BLOCK.includes("contents/docs/status.json"), "the step must target docs/status.json");
  assert.ok(BLOCK.includes("-Method Put"), "the step must PUT the terminal snapshot");
  assert.ok(!BLOCK.includes("publish-status.ps1"),
    "the step must not dot-source the RUNNER_TEMP helper (absent-helper fallback is designed out)");
  assert.ok(!BLOCK.includes("gh-pages-token.txt"),
    "the step must not read C:\\ghrdp\\gh-pages-token.txt (the Cleanup wipe deletes it)");
});

test("M8-f: ownership guard - generation-aware, never clobbers a live newer owner", () => {
  assert.ok(BLOCK.includes("$cur.runId -ne $mine"),
    "the guard must compare the remote runId against this run before writing");
  assert.ok(BLOCK.includes("GITHUB_RUN_ID"), "the guard must key on the run identity");
  assert.ok(BLOCK.includes("GITHUB_RUN_ATTEMPT"), "the guard must coordinate the run-attempt generation");
  assert.ok(BLOCK.includes("is owned by run"), "the skip path must be observable in the log");
  assert.ok(BLOCK.includes("now owns docs/status.json"),
    "the per-attempt re-check must abort when a newer run takes over between PUT attempts");
  for (const action of ["skip-foreign-active", "skip-superseded", "skip-owned", "skip-unknown", "finalize"]) {
    assert.ok(BLOCK.includes("'" + action + "'"), "the ownership policy must name action " + action);
  }
  assert.ok(BLOCK.includes("$cur.runAttempt -gt $myAttempt"),
    "a NEWER attempt of the same run must supersede a stale attempt's heartbeat");
  assert.ok(BLOCK.includes("$cur.runAttempt -ge $myAttempt"),
    "duplicate finalization of the same run+attempt must be idempotent");
});

test("M8-g: schema compatibility - M7-read fields kept, generation + provenance additive", () => {
  assert.ok(BLOCK.includes("ts = (Get-Date -Format o)"), "ts must be written (the M7 freshness gate reads it)");
  assert.ok(BLOCK.includes("runStatus = $terminal"), "runStatus must be written");
  assert.ok(BLOCK.includes("runId = $mine"), "runId must be preserved (identity of the finalized run)");
  assert.ok(/runId = \$mine\s+runAttempt = \$myAttempt/.test(BLOCK),
    "the PAYLOAD must write runAttempt next to runId (generation coordination; the sentinel one-liner must not satisfy this pin)");
  assert.ok(BLOCK.includes("runUrl ="), "runUrl must be preserved");
  assert.ok(BLOCK.includes("finalizeReason"), "finalizeReason must be added (observability of the terminal cause)");
  assert.ok(BLOCK.includes("progressSource"), "progress carry provenance must be explicit (no silent staleness)");
  assert.ok(BLOCK.includes("overallPct = $pct"), "overallPct must carry the latest owned value, not a synthetic 100");
});

test("M8-h: best effort - the step can never fail the job", () => {
  assert.ok(BLOCK.includes("$ErrorActionPreference = 'Continue'"), "errors must not halt the script");
  assert.ok(BLOCK.includes("::warning::"), "a failed publish must surface as a warning, not silence");
  const lines = BLOCK.trimEnd().split("\n");
  assert.equal(lines[lines.length - 1].trim(), "exit 0", "the step must end with exit 0");
});

test("M8-i: every request is timed and the whole finalize is deadline-bounded", () => {
  assert.ok(count(BLOCK, "-TimeoutSec $reqTimeoutSec") >= 2,
    "BOTH the read and the PUT must carry an explicit per-request timeout");
  assert.ok(BLOCK.includes("M8_REQUEST_TIMEOUT_SEC"), "the request timeout must be seamed for verification");
  assert.ok(BLOCK.includes("M8_FINALIZE_DEADLINE_SEC"), "the overall deadline must be seamed for verification");
  assert.ok(BLOCK.includes("[System.Diagnostics.Stopwatch]::StartNew()"), "the deadline must be measured on a monotonic clock");
  assert.ok(BLOCK.includes("Test-M8Deadline"), "the retry loop and the backoff must consult the deadline");
  assert.ok(BLOCK.includes("$attempt -le $maxAttempts"), "the PUT retry loop must be bounded");
  assert.ok(BLOCK.includes("[Math]::Min(2 * $attempt,"), "backoff must be truncated to the remaining deadline budget");
  assert.ok(BLOCK.includes("Start-Sleep -Seconds $sleepSec"), "retries must back off with the bounded budget");
});

test("M8-j: producer contract - live fields stay, the Cleanup nested finalize is RETIRED (single terminal writer)", () => {
  assert.ok(RAW.includes("runStatus = 'in_progress'"),
    "the initial write and heartbeat must keep publishing in_progress");
  assert.ok(RAW.includes("Publish-StatusToGhPages -JsonText"),
    "the heartbeat helper path must stay intact");
  assert.ok(CLEANUP_BLOCK.length > 0, "the Cleanup step must still exist");
  assert.ok(!CLEANUP_BLOCK.includes("Publish-StatusToGhPages"),
    "the Cleanup nested finalize is retired - M8 is the sole terminal writer (a leftover writer could resurrect completed/100 if M8 later fails)");
  assert.ok(!CLEANUP_BLOCK.includes("runStatus = 'completed'"),
    "the hardcoded completed-lie must not survive anywhere in the Cleanup step");
  assert.ok(RAW.includes("# [M8 follow-up RC-02] the nested terminal publication that used to sit"),
    "the retirement must be documented at the step (comment-bearing RAW; the LIVE text correctly carries no writer)");
  assert.ok(CLEANUP_BLOCK.includes("[cleanup] secure cleanup starting") && CLEANUP_BLOCK.includes("[cleanup] done"),
    "the security cleanup itself (process kill, profile/account wipe, funnel reset) is preserved");
});

test("M8-k: read failures are DISCRIMINATED (no conflated null-state)", () => {
  for (const state of ["'missing'", "'auth'", "'transient'", "'invalid'", "'invalid-identity'"]) {
    assert.ok(BLOCK.includes(state), "the reader must distinguish state " + state);
  }
  assert.ok(count(BLOCK, "-SkipHttpErrorCheck") >= 2, "status codes must be inspected, not thrown into a shared catch");
  assert.ok(count(BLOCK, "-StatusCodeVariable") >= 2, "BOTH read and PUT must capture the HTTP status");
  assert.ok(BLOCK.includes("if ($sc -eq 404)"), "a confirmed-absent file must be distinguished from an error");
  assert.ok(BLOCK.includes("$sc -eq 401 -or $sc -eq 403"), "auth failure must be distinguished");
  assert.ok(BLOCK.includes("Resolve-FinalizeAction"), "the ownership decision must be a single named policy");
  assert.ok(BLOCK.includes("retry-read"), "transient read failure gets a bounded retry, never a blind PUT");
  assert.ok(BLOCK.includes("'abort-read'"), "auth failure aborts without a credential retry storm");
});

test("M8-l: terminal monotonicity - late heartbeats cannot regress a finalized run", () => {
  assert.ok(BLOCK.includes("ghrdp-m8-terminal-"), "the step must write the run-scoped terminal sentinel after a real publish");
  assert.ok(RAW.includes("terminal sentinel present"),
    "the generated Publish-StatusToGhPages helper must check the sentinel");
  assert.ok(RAW.includes("late publish suppressed"),
    "the suppression must be observable (a surviving publisher sees it in the log)");
  const iSentinel = BLOCK.indexOf("ghrdp-m8-terminal-");
  const iMarker = BLOCK.indexOf("[m8] status.json finalized:");
  assert.ok(iSentinel > 0 && iSentinel < iMarker,
    "the sentinel is only written on the real-publish branch, before the success marker");
});

test("M8-m: the payload is rebuilt from the FRESHEST read inside the retry loop", () => {
  const iLoop = BLOCK.indexOf("for ($attempt");
  const iReread = BLOCK.indexOf("$cur = Get-TrackedStatus", iLoop);
  const iPct = BLOCK.indexOf("$pct = [double]$cur.pct");
  const iObj = BLOCK.indexOf("runStatus = $terminal", iPct);
  assert.ok(iLoop > 0 && iReread > iLoop, "every attempt re-reads the remote state");
  assert.ok(iPct > iReread, "progress is re-carried AFTER the per-attempt re-read (never stale across retries)");
  assert.ok(iObj > iPct, "the payload is built after the progress refresh");
  assert.ok(BLOCK.includes("$cur.runId -eq $mine"), "counters are carried only from a same-run snapshot");
  assert.ok(BLOCK.includes("'none-observed'"), "when nothing was observed the payload must say so, not borrow foreign counters");
});

test("M8-n: success is gated on an OBSERVED 2xx, not on script position (MUT-B class)", () => {
  assert.equal(count(BLOCK, "-Method Put"), 1, "exactly one PUT call site (a blind duplicate PUT is a policy violation)");
  assert.equal(count(BLOCK, "$published = $true"), 1, "exactly one success assignment");
  const iPut = BLOCK.indexOf("-Method Put");
  const iPub = BLOCK.indexOf("$published = $true");
  const iCond = BLOCK.lastIndexOf("if ($scPut -ge 200 -and $scPut -lt 300)", iPub);
  assert.ok(iPub > iPut, "the success assignment must follow the PUT");
  assert.ok(iCond >= 0 && iCond < iPub, "the success assignment must be gated on the OBSERVED PUT status");
  assert.ok(BLOCK.includes("could not publish terminal status.json"), "failure to publish must be a visible warning, not a success claim");
});
