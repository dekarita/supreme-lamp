// [M7] Pages publish-parity fence + /status.json freshness observability.
//
// WHAT THIS GATE EXISTS FOR
// M3 (PR #186) made the site REPUBLISH on a `*/10` cron, but nothing checked
// that the bytes Pages actually serves are the bytes main tracks. F108-h stops
// a second publisher from existing; it cannot see a stale Pages artifact - the
// exact outage F108 was opened for ("the last github-pages deployment is
// 2026-10-01T16:42Z, while the watchdog kept committing to main for six more
// days"). M7 adds the missing half: the deployer must PROVE parity after it
// publishes, and must REPORT the age of the snapshot it published.
//
// WHY generatedAt IS NOT PINNED HERE
// The status.json schema on main carries `ts` + `runStatus` (producer:
// main.yml:350 initial write, main.yml:~6280 in-session heartbeat via
// Publish-StatusToGhPages). There is no `generatedAt` field, and it must not be
// added: the writer lives in main.yml, and `generatedAt` is already the name of
// a DIFFERENT schema's field (the F45 explorer fx index, see
// src/components/explorer/data/schema.ts:72). This gate therefore pins the
// fields that actually exist.
//
// §FALSIFY-3 - three mutations this gate must catch (each executed locally
// against a copy of the workflow; all three reddened it, see the PR body):
//   M1  in the parity branch, change `exit 1` -> `exit 0` (a divergent page is
//       accepted)                                  -> M7-c MUST fail
//   M2  change the 480-minute session-ceiling literal to 0 (the in_progress
//       lie is never reported)                     -> M7-d MUST fail
//   M3  delete the `"${base}status.json"` fetch (parity is never evaluated)
//                                                  -> M7-b MUST fail
//   M4  (cross-gate control) unfence the push trigger -> F108-h MUST fail
//
// §VACUITY-PROBES - why the obvious check is not good enough, and what is:
//   P1  `raw.includes("docs/status.json")` is ALREADY true on the pre-M7 file:
//       the header comment says "the watchdog commits `docs/status.json` on main
//       every ~80 s". A whole-file substring check is therefore VACUOUS - it
//       would pass with the entire M7 step deleted. Every assertion below reads
//       the COMMENT-STRIPPED text and, where it matters, the step block itself.
//   P2  the parity comparison must be a live call site, not prose: the gate
//       pins `sha256sum "$tracked"` inside the stripped step block, so a
//       comment-only mention cannot satisfy it (this is what mutation M3 pokes).
//   P3  `"${base}status.json"` must appear exactly once, in the M7 step: a
//       stale copy pasted into another step would not be covered.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const WORKFLOW_PATH = ".github/workflows/replay-viewer.yml";
const TRACKED_STATUS = "docs/status.json";
const PUBLISHED_STATUS = '"${base}status.json"';
const CRON = '- cron: "*/10 * * * *"';
const F108_STEP = "Verify the published site answers (F108 §PAGES-VERIFICATION)";
const M7_STEP = "Verify publish parity and report freshness (M7 §PAGES-PARITY)";
const SESSION_CEILING_MIN = "480";
// Byte pin of the F108-h fenced push block (see tests/f108-replay-core.test.js:446).
// If this hash moves, the fence moved - and the fence must never move for a
// freshness step: widening it is how the site starts re-publishing on every
// watchdog heartbeat again.
const FENCE_SHA256 = "2d5f87f464259d21370ad63b95d171ed3fa8c9371f9cda52e0b525ab37e8655d";

const RAW = readFileSync(new URL("../" + WORKFLOW_PATH, import.meta.url), "utf8");

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

/** The live body of one step, by its literal name, up to the next `- name:`. */
function stepBlock(name) {
  const start = LIVE.indexOf(name);
  if (start < 0) return "";
  const next = LIVE.indexOf("\n      - name:", start);
  return next < 0 ? LIVE.slice(start) : LIVE.slice(start, next);
}

/** The F108-h fenced push block, byte-for-byte. */
function fence() {
  const i = RAW.indexOf("\n  push:");
  const j = RAW.indexOf("\n  # [M3] Scheduled");
  if (i < 0 || j < 0 || j < i) return null;
  return RAW.slice(i, j);
}

test("M7-a: the deployer carries the parity+freshness step as a live step", () => {
  assert.ok(RAW.includes(M7_STEP), "the M7 step name must exist in " + WORKFLOW_PATH);
  assert.ok(LIVE.includes(M7_STEP), "the M7 step must be live YAML, not a comment");
  const block = stepBlock(M7_STEP);
  assert.ok(block.length > 500, "the M7 step body must be a real script, got " + block.length + " chars");
  assert.ok(block.includes("set -euo pipefail"), "the M7 step must fail loudly");
});

test("M7-b: it compares the PUBLISHED bytes with the TRACKED bytes", () => {
  const block = stepBlock(M7_STEP);
  assert.ok(block.includes(TRACKED_STATUS), "the tracked snapshot must be " + TRACKED_STATUS + " by literal path");
  assert.ok(block.includes(PUBLISHED_STATUS), "the published snapshot must be fetched from the deploy's own page_url");
  assert.ok(block.includes('sha256sum "$tracked"'), "parity must be a hash of the tracked file, not a guess");
  assert.ok(block.includes("sha256sum /tmp/status.published.json"), "parity must hash what the CDN actually served");
  const fetches = LIVE.split(PUBLISHED_STATUS).length - 1;
  assert.equal(fetches, 1, "exactly one step may fetch the published status.json (found " + fetches + ")");
});

test("M7-c: divergence between main and Pages FAILS the deploy", () => {
  const block = stepBlock(M7_STEP);
  assert.ok(
    block.includes("M7: Pages is not serving the"),
    "the mismatch must be named in the failure message"
  );
  const mismatchAt = block.indexOf("M7: Pages is not serving the");
  const exitAt = block.indexOf("exit 1", mismatchAt);
  assert.ok(exitAt > mismatchAt, "the mismatch branch must reach `exit 1` (FALSIFY-3 M1 flips this)");
  assert.ok(!/continue-on-error/.test(block), "parity must not be softened with continue-on-error");
});

test("M7-d: freshness is REPORTED, and an impossible in_progress claim is loud", () => {
  const block = stepBlock(M7_STEP);
  assert.ok(block.includes("GITHUB_STEP_SUMMARY"), "the age must land in the run summary the operator reads");
  assert.ok(block.includes("runStatus"), "the published runStatus must be read (it is the lie detector)");
  assert.ok(block.includes("in_progress"), "the in_progress state must be handled explicitly");
  // §PIN-THE-USE-NOT-THE-MENTION: pin the COMPARISON, not the number. The first
  // draft asserted `block.includes("480")`, which the warning sentence alone
  // satisfied - so mutation M2 (480 -> 0 in the comparison) slipped through it.
  assert.ok(
    block.includes('"$age_min" -gt ' + SESSION_CEILING_MIN),
    "the age COMPARISON must read `-gt " + SESSION_CEILING_MIN + "` (FALSIFY-3 M2 changes this and must be caught)"
  );
  assert.ok(block.includes("::warning::"), "an over-age in_progress claim must surface as a warning, not silence");
  const warnBranch = block.slice(block.indexOf("::warning::"));
  assert.ok(
    !warnBranch.includes("exit 1"),
    "reporting must not fail the deploy - the freshness warning must not exit non-zero"
  );
});

test("M7-e: parity runs AFTER the publish it is checking", () => {
  const f108 = LIVE.indexOf(F108_STEP);
  const m7 = LIVE.indexOf(M7_STEP);
  assert.ok(f108 > -1, "the F108 verification step must still be present");
  assert.ok(m7 > f108, "the M7 parity step must run after the F108 verification step");
  const tail = LIVE.slice(m7);
  assert.ok(!/uses:\s*actions\/(deploy-pages|upload-pages-artifact|configure-pages)/.test(tail),
    "M7 must not add a publisher - it only attests to one");
});

test("M7-f: the F108-h push fence did not move (§SECURITY-REMEDIATION-CHECK)", () => {
  const f = fence();
  assert.ok(f, "the push fence must be findable (marker `  # [M3] Scheduled` must stay)");
  const hash = createHash("sha256").update(f, "utf8").digest("hex");
  assert.equal(hash, FENCE_SHA256, "the fenced push block changed - the fence must stay byte-identical");
  for (const forbidden of [TRACKED_STATUS, "docs/**", "paths-ignore", '"**"']) {
    assert.ok(!f.includes(forbidden), "the fence must never include " + forbidden + " (watchdog heartbeat path)");
  }
  assert.ok(f.includes('"docs/replay/**"'), "the fence must still cover the viewer's own directory");
  // Self-test note: the first draft of this rule also banned the bare `**`, which
  // matches INSIDE `docs/replay/**` and `src/replay/**` - it reddened on a
  // perfectly legal fence. The F108-h gate bans the QUOTED `"**"` for the same
  // reason; this rule now does too, and that is why it is falsified by M7's
  // mutation M4 rather than by its own false positive.
});

test("M7-g: one publisher, pinned exactly as M3 left it", () => {
  const count = (needle) => LIVE.split(needle).length - 1;
  assert.equal(count("uses: actions/deploy-pages@v4"), 1, "exactly one deploy-pages");
  assert.equal(count("uses: actions/upload-pages-artifact@v3"), 1, "exactly one upload-pages-artifact");
  assert.equal(count("uses: actions/configure-pages@v5"), 1, "exactly one configure-pages");
  assert.equal(count("uses: actions/checkout@v4"), 1, "exactly one checkout");
  assert.equal(LIVE.split("uses:").length - 1, 4, "M7 must not introduce a fifth action");
});

test("M7-h: no secret is read, and M3's cadence is untouched", () => {
  assert.ok(!/\bsecrets\./.test(LIVE), "the deployer must keep reading zero secrets");
  assert.ok(LIVE.includes(CRON), "M3's cron literal must survive this change");
  assert.ok(LIVE.includes("workflow_dispatch"), "the operator's one click must survive");
  assert.equal(stepBlock(M7_STEP).includes("ACTIONS_RUNTIME_TOKEN"), false, "no hidden runtime token dependency");
});

test("M7-i: §PIN-THE-USE-NOT-THE-MENTION - the naive check is vacuous, this one is not", () => {
  // P1: the header comment already mentions the tracked path, so a whole-file
  // substring check would pass with the entire M7 step deleted.
  assert.ok(RAW.includes(TRACKED_STATUS), "control: the raw file mentions the path in prose");
  // The stripped file still carries it - because the live step carries it.
  assert.ok(LIVE.includes(TRACKED_STATUS), "the LIVE step must also carry it");
  // And the load-bearing assertion is the call site, comment-stripped.
  const block = stepBlock(M7_STEP);
  assert.ok(block.includes('sha256sum "$tracked"'), "the hash call site must be live code");
  assert.ok(!block.includes("# sha256sum"), "a commented-out call must never satisfy this pin");
});
