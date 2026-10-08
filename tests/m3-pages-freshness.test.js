// [M3] Pages data freshness — scheduled republish (Option 2).
// Verifies the replay-viewer workflow has a cron schedule that re-publishes
// docs/ every 10 minutes, capping /status.json staleness at ~10 min.
//
// Mutation targets:
//   M3-1  remove schedule trigger                          → workflow gate
//   M3-2  change cron to >60 min (stale again)            → interval gate
//   M3-3  deploy condition excludes schedule              → condition gate
//   M3-4  remove F108 preflight from scheduled path       → preflight gate
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const WORKFLOW = readFileSync(new URL("../.github/workflows/replay-viewer.yml", import.meta.url), "utf8");

// ---------------------------------------------------------------------------
// M3-1: schedule trigger exists
// ---------------------------------------------------------------------------
test("M3-1: replay-viewer.yml has a schedule trigger for periodic republish", () => {
  assert.ok(
    /^\s*schedule\s*:/m.test(WORKFLOW),
    "workflow does not have a schedule trigger"
  );
  assert.ok(
    WORKFLOW.includes("cron:"),
    "schedule trigger does not have a cron expression"
  );
});

// ---------------------------------------------------------------------------
// M3-2: cron interval is ≤30 minutes (staleness cap)
// ---------------------------------------------------------------------------
test("M3-2: cron interval is frequent enough to cap staleness (≤30 min)", () => {
  const cronMatch = WORKFLOW.match(/cron:\s*"([^"]+)"/);
  assert.ok(cronMatch, "cron expression not found");
  const cron = cronMatch[1];
  // Parse minute field: */N means every N minutes, N alone means at minute N
  const minuteField = cron.split(/\s+/)[0];
  if (minuteField.startsWith("*/")) {
    const interval = parseInt(minuteField.slice(2), 10);
    assert.ok(Number.isFinite(interval), "cron interval is not a number");
    assert.ok(interval <= 30, `cron interval */${interval} exceeds 30-min staleness cap`);
    assert.ok(interval > 0, "cron interval must be positive");
  } else if (minuteField === "*") {
    // Every minute — valid but aggressive
    assert.ok(true, "every-minute cron is within the cap");
  } else {
    // Specific minute(s) — at most once per hour, might be too infrequent
    const minutes = minuteField.split(",").map(Number);
    if (minutes.length === 1) {
      assert.fail("single-minute cron runs only once per hour — too infrequent for freshness");
    }
  }
});

// ---------------------------------------------------------------------------
// M3-3: deploy steps run on scheduled triggers (not just workflow_dispatch)
// ---------------------------------------------------------------------------
test("M3-3: deploy step condition allows scheduled runs", () => {
  // The deploy step should not be gated ONLY on inputs.target (which doesn't exist on schedule).
  // It should either have no condition or handle the schedule case.
  const deployIdx = WORKFLOW.indexOf("uses: actions/deploy-pages");
  assert.ok(deployIdx > -1, "deploy-pages action not found");
  // Look backwards for the `if:` condition
  const deployBlock = WORKFLOW.slice(Math.max(0, deployIdx - 500), deployIdx + 100);
  // If there's an `if:` with `inputs.target`, it must also handle the schedule case
  if (deployBlock.includes("if:") && deployBlock.includes("inputs.target")) {
    assert.ok(
      deployBlock.includes("github.event_name") || deployBlock.includes("event_name"),
      "deploy condition checks inputs.target but does not handle schedule trigger (event_name)"
    );
  }
});

// ---------------------------------------------------------------------------
// M3-4: F108 preflight runs on all triggers (including schedule)
// ---------------------------------------------------------------------------
test("M3-4: F108 preflight check is not gated to workflow_dispatch only", () => {
  const preflightIdx = WORKFLOW.indexOf("F108 preflight");
  assert.ok(preflightIdx > -1, "F108 preflight step not found");
  // The preflight step should not have an `if:` condition that excludes schedule
  const preflightBlock = WORKFLOW.slice(preflightIdx, preflightIdx + 500);
  // If there's an `if:`, it should not exclude schedule runs
  if (preflightBlock.includes("if:")) {
    const ifLine = preflightBlock.match(/if:\s*(.+)/);
    if (ifLine) {
      assert.ok(
        !ifLine[1].includes("workflow_dispatch") || ifLine[1].includes("||"),
        "F108 preflight is gated to workflow_dispatch only — scheduled runs would skip the preflight"
      );
    }
  }
});

// ---------------------------------------------------------------------------
// M3-5: the workflow still has exactly one Pages deployer (F108-h invariant)
// ---------------------------------------------------------------------------
test("M3-5: adding schedule did not create a second deployer", () => {
  // The F108-h gate already checks this, but this test documents the invariant
  // at the M3 level too. Count only `uses:` lines, not comments.
  const usesDeploy = (WORKFLOW.match(/^\s*uses:\s*actions\/deploy-pages/gm) || []).length;
  const usesUpload = (WORKFLOW.match(/^\s*uses:\s*actions\/upload-pages-artifact/gm) || []).length;
  assert.equal(usesDeploy, 1, "exactly one deploy-pages action must exist");
  assert.equal(usesUpload, 1, "exactly one upload-pages-artifact action must exist");
});
