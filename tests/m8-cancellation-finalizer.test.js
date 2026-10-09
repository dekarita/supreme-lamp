// [M8] Cancellation-safe status.json finalizer in main.yml (PROB-004 / RC-02).
//
// WHAT THIS GATE EXISTS FOR
// The rdp job's Cleanup step carries a NESTED finalize that (a) wipes C:\ghrdp
// (including gh-pages-token.txt) BEFORE publishing, (b) never sees
// $env:GITHUB_TOKEN in that step, so Publish-StatusToGhPages silently returns,
// and (c) hardcodes runStatus='completed' regardless of the real outcome.
// Measured consequence: the run cancelled 2026-10-07T13:20:15Z left
// docs/status.json at runStatus=in_progress, frozen for 58h+ on 2026-10-09 -
// the public Pages snapshot lied about a dead session (PROB-004/PROB-005).
// M8 adds a dedicated LAST step in the rdp job (after Cleanup) that runs on
// EVERY outcome (if: always()), maps the real job.status to a truthful
// terminal runStatus, publishes docs/status.json through the contents API
// with an explicit GITHUB_TOKEN env (self-contained: no RUNNER_TEMP helper,
// no C:\ghrdp token file), and never clobbers the snapshot a NEWER run is
// actively heartbeating (ownership guard, re-checked before every PUT).
//
// WHY THIS GATE IS STRUCTURAL, NOT RUNTIME
// The sandbox has no pwsh and a session must never dispatch main.yml, so the
// finalize script cannot be executed here. The gate therefore pins the exact
// wiring that makes the runtime behavior correct (condition, env, mapping,
// API target, guard, bounded retry, best-effort exit), and the PowerShell
// itself is covered by scripts/ps-balance-audit.mjs (which tokenizes every
// pwsh block in main.yml) plus js-yaml parse validation in the PR checks.
//
// §FALSIFY-3 - five mutations, each executed locally against a copy of
// main.yml via the M8_MAIN_YML override (see the PR body for the transcript);
// all five reddened exactly the intended rule:
//   M1  `if: always()` -> `if: success()` in the M8 step (cancel/failure
//       never finalize - the original bug)              -> M8-b MUST fail
//   M2  `'cancelled' { $terminal = 'cancelled' }` -> `'in_progress'` (the
//       lie survives cancellation)                      -> M8-d MUST fail
//   M3  delete the step's `GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}` env
//       (the token-loss regression)                     -> M8-c MUST fail
//   M4  delete the entire M8 step (vacuity control)     -> M8-a MUST fail
//   M5  `-ne $mine` -> `-eq $mine` (ownership guard inverted: the finalizer
//       would skip its OWN run and clobber nothing)     -> M8-f MUST fail
//
// §VACUITY-PROBES - why the obvious check is not good enough, and what is:
//   P1  `raw.includes("Finalize status.json")` would pass on a COMMENT
//       mention - every rule reads the COMMENT-STRIPPED live text and the
//       step block itself (mutation M4 pokes this).
//   P2  `includes("if: always()")` is already true elsewhere in main.yml
//       (Cleanup, F46, F92 smoke steps) - the pin is scoped to the M8 step
//       block, not the file (mutation M1 pokes this).
//   P3  the mapping literals ('completed'/'cancelled'/'failed') also appear
//       in the Cleanup step - M8-d squashes whitespace and pins the exact
//       switch arms INSIDE the M8 block (mutation M2 pokes this).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// M8_MAIN_YML lets §FALSIFY-3 run this gate against mutated COPIES of the
// workflow without touching the tracked file. CI runs with the default.
const WORKFLOW_PATH = process.env.M8_MAIN_YML || ".github/workflows/main.yml";
const M8_STEP = "Finalize status.json (M8 cancellation-safe terminal state)";
const CLEANUP_STEP = "Cleanup (wipe profiles/storage";
const PUBLISH_URL_JOB = "\n  publish-url:";
const M8_COMMENT = "# [M8] CANCELLATION-SAFE STATUS FINALIZER";

const RAW = readFileSync(WORKFLOW_PATH, "utf8");

/** Strip YAML comments (quote-aware) so prose can never satisfy a pin. */
function stripComments(src) {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '"' || c === "'") {
      out += c;
      i += 1;
      while (i < src.length) {
        if (src[i] === "\\") {
          out += src[i] + (src[i + 1] || "");
          i += 2;
          continue;
        }
        if (src[i] === c) {
          out += c;
          i += 1;
          break;
        }
        out += src[i];
        i += 1;
      }
      continue;
    }
    if (c === "#") {
      while (i < src.length && src[i] !== "\n") i += 1;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

const LIVE = stripComments(RAW);

/** The live body of one step, by its literal name, bounded by the next step
 *  or the next job - the M8 step is the LAST step of the rdp job, so the
 *  block must not swallow the publish-url job below it. */
function stepBlock(name) {
  const start = LIVE.indexOf(name);
  if (start < 0) return "";
  let end = LIVE.length;
  const nextStep = LIVE.indexOf("\n      - name:", start);
  const nextJob = LIVE.indexOf(PUBLISH_URL_JOB, start);
  if (nextStep > 0) end = Math.min(end, nextStep);
  if (nextJob > 0) end = Math.min(end, nextJob);
  return LIVE.slice(start, end);
}

const BLOCK = stepBlock(M8_STEP);
// Whitespace-squashed copy so multi-space switch arms match one literal.
const SQUASH = BLOCK.replace(/[ \t]+/g, " ");

test("M8-a: the M8 finalize step exists as live YAML and is the LAST step of the rdp job", () => {
  assert.ok(RAW.includes(M8_STEP), "the M8 step name must exist in " + WORKFLOW_PATH);
  assert.ok(LIVE.includes(M8_STEP), "the M8 step must be live YAML, not a comment");
  assert.ok(RAW.includes(M8_COMMENT), "the M8 design comment must document the defect above the step");
  const iM8 = LIVE.indexOf(M8_STEP);
  const iCleanup = LIVE.indexOf(CLEANUP_STEP);
  const iPublishUrl = LIVE.indexOf(PUBLISH_URL_JOB);
  assert.ok(iCleanup > 0, "the Cleanup step must still exist (M8 is additive)");
  assert.ok(iM8 > iCleanup, "the M8 step must run AFTER the Cleanup step (last writer wins)");
  assert.ok(iPublishUrl > iM8, "the M8 step must live inside the rdp job, before publish-url");
  assert.ok(BLOCK.length > 1500, "the M8 step body must be a real script, got " + BLOCK.length + " chars");
});

test("M8-b: the step runs on EVERY outcome (if: always())", () => {
  assert.ok(BLOCK.includes("if: always()"),
    "the M8 step must carry if: always() so cancellation/failure still finalize");
});

test("M8-c: the step carries an explicit GITHUB_TOKEN env (token-loss fix)", () => {
  assert.ok(BLOCK.includes("GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}"),
    "the M8 step must map secrets.GITHUB_TOKEN into the env - the Cleanup step's nested finalize silently failed because it never saw a token after the C:\\ghrdp wipe");
});

test("M8-d: job.status maps to a TRUTHFUL terminal runStatus (no hardcoded completed)", () => {
  assert.ok(SQUASH.includes("'success' { $terminal = 'completed' }"), "success must map to completed");
  assert.ok(SQUASH.includes("'cancelled' { $terminal = 'cancelled' }"), "cancelled must map to cancelled (the observed lie)");
  assert.ok(SQUASH.includes("'failure' { $terminal = 'failed' }"), "failure must map to failed");
  assert.ok(SQUASH.includes("$terminal = 'unknown'"), "unknown outcomes must map to unknown");
  assert.ok(SQUASH.includes("${{ job.status }}"), "the mapping must read the REAL job.status");
  assert.ok(BLOCK.includes("runStatus = $terminal"), "the published object must use the mapped value");
  assert.ok(!BLOCK.includes("runStatus = 'completed'"),
    "the M8 step must not hardcode runStatus='completed' (the Cleanup step's lie)");
});

test("M8-e: the publish is self-contained (contents API PUT, no wiped-token dependency)", () => {
  assert.ok(BLOCK.includes("contents/docs/status.json"), "the step must target docs/status.json");
  assert.ok(BLOCK.includes("-Method Put"), "the step must PUT the terminal snapshot");
  assert.ok(!BLOCK.includes("publish-status.ps1"),
    "the step must not dot-source the RUNNER_TEMP helper (absent-helper fallback is designed out)");
  assert.ok(!BLOCK.includes("gh-pages-token.txt"),
    "the step must not read C:\\ghrdp\\gh-pages-token.txt (the Cleanup wipe deletes it)");
});

test("M8-f: ownership guard - a finished run never clobbers a newer run's snapshot", () => {
  assert.ok(BLOCK.includes("$cur.runId -ne $mine"),
    "the guard must compare the remote runId against this run before writing");
  assert.ok(BLOCK.includes("GITHUB_RUN_ID"), "the guard must key on the run identity");
  assert.ok(BLOCK.includes("is owned by run"), "the skip path must be observable in the log");
  assert.ok(BLOCK.includes("now owns docs/status.json"),
    "the per-attempt re-check must abort when a newer run takes over between PUT attempts");
});

test("M8-g: schema compatibility - M7-read fields kept, finalizeReason additive", () => {
  assert.ok(BLOCK.includes("ts = (Get-Date -Format o)"), "ts must be written (the M7 freshness gate reads it)");
  assert.ok(BLOCK.includes("runStatus = $terminal"), "runStatus must be written (the M7 freshness gate reads it)");
  assert.ok(BLOCK.includes("runId = $mine"), "runId must be preserved (identity of the finalized run)");
  assert.ok(BLOCK.includes("runUrl ="), "runUrl must be preserved");
  assert.ok(BLOCK.includes("finalizeReason"), "finalizeReason must be added (observability of the terminal cause)");
  assert.ok(BLOCK.includes("overallPct = $pct"), "overallPct must carry the remote value, not a synthetic 100");
});

test("M8-h: best effort - the step can never fail the job", () => {
  assert.ok(BLOCK.includes("$ErrorActionPreference = 'Continue'"), "errors must not halt the script");
  assert.ok(BLOCK.includes("::warning::"), "a failed publish must surface as a warning, not silence");
  const lines = BLOCK.trimEnd().split("\n");
  assert.equal(lines[lines.length - 1].trim(), "exit 0", "the step must end with exit 0");
});

test("M8-i: the publish retry is bounded", () => {
  assert.ok(BLOCK.includes("$attempt -le 3"), "the PUT retry loop must be bounded (3 attempts)");
  assert.ok(BLOCK.includes("Start-Sleep -Seconds (2 * $attempt)"), "retries must back off");
});

test("M8-j: the live producer contract is unchanged (M8 is additive)", () => {
  assert.ok(RAW.includes("runStatus = 'in_progress'"),
    "the initial write and heartbeat must keep publishing in_progress");
  assert.ok(RAW.includes("Publish-StatusToGhPages -JsonText"),
    "the heartbeat helper path must stay intact");
  assert.ok(RAW.includes("[cleanup] status.json set to completed"),
    "the Cleanup step must be untouched (M8 supersedes but does not rewrite it)");
});
