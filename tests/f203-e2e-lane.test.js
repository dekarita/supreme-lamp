// [WP-09 / #203] Static pins for the e2e-ui lane.
//
// BACKGROUND. The e2e-ui job produced 92 cancelled + 8 failed runs out of the
// last 100, every cancellation at ~25 minutes, and the step log was EMPTY
// because the run was redirected into a file that only got tailed after the
// command returned - which a cancelled job never does. Cancelled is not passed:
// the lane has had no green signal since run 37285114245 (2b66c11).
//
// These pins do not prove the lane is green (only a real browser run can). They
// pin the two properties that made the defect undiagnosable, plus the two that
// let it happen:
//   1. the step is BOUNDED and its log is STREAMED, so a stuck lane fails with
//      evidence instead of being cancelled in silence;
//   2. every popup an e2e spec opens is closed by that spec, so a Playwright
//      context teardown can never block on a third-party page;
//   3. no e2e spec navigates to a public http(s) host - the lane runs against
//      the local mock backend only.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));

const WORKFLOW = ".github/workflows/e2e-ui.yml";
const SPECS_DIR = "tests/e2e";
const specFiles = () =>
  fs
    .readdirSync(path.join(ROOT, SPECS_DIR))
    .filter((f) => f.endsWith(".spec.ts"))
    .sort();

test("F203-a: the e2e-ui step is bounded and its log is streamed (a hang must be visible)", () => {
  const wf = read(WORKFLOW);
  // Bounded: the step carries its own timeout, so the job FAILS (and the tail +
  // annotation still run) instead of being killed at the 25m job ceiling.
  assert.match(wf, /timeout\s+18m\s+pnpm run e2e/, "the step must bound itself with `timeout 18m`");
  // Streamed: `tee` puts the same bytes on stdout, so a cancelled or timed-out
  // run still shows the last test that started. The old form was `> e2e-run.log`.
  assert.match(wf, /\|\s*tee e2e-run\.log/, "the Playwright log must be teed to the job output, not only to a file");
  // The evidence survives a cancellation too.
  assert.match(wf, /if:\s*failure\(\)\s*\|\|\s*cancelled\(\)/, "the playwright report must be uploaded on cancellation as well");
  // No per-test budget was weakened by this repair.
  assert.equal(/\btimeout:\s*60000/.test(read("playwright.e2e-ui.config.ts")), true, "the 60s per-test budget stays");
  assert.equal(/\bretries:\s*1\b/.test(read("playwright.e2e-ui.config.ts")), true, "the retry policy stays");
});

test("F203-b: the lane is not silently gutted - the specs and the mock backend still exist", () => {
  const specs = specFiles();
  // A "fix" that deletes the specs would also make the lane green. The lane must
  // still carry the F78/F79 surface this workflow exists to prove.
  assert.ok(specs.length >= 11, "at least the 11 shipped e2e specs must remain, got " + specs.length);
  for (const required of ["f78-add-sites.spec.ts", "f79-google-simple.spec.ts", "f91-mirror-mode.spec.ts"]) {
    assert.ok(specs.includes(required), required + " must not be deleted or quarantined silently");
  }
  assert.ok(exists("tests/e2e/fixtures/mock-backend.mjs"), "the mock backend still ships");
});

test("F203-c: every popup an e2e spec opens is closed by that spec", () => {
  // Playwright closes the whole context at test teardown, and a context close
  // waits for every page in it. An unclosed popup pointed at a third-party site
  // is therefore a way to wedge the entire (workers:1) run - the mechanism
  // behind the systematic 25-minute timeout.
  for (const f of specFiles()) {
    const src = read(SPECS_DIR + "/" + f);
    const opens = src.match(/waitForEvent\(\s*["']page["']/g) || [];
    if (!opens.length) continue;
    const closesPopup = /closeExtraPages\s*\(/.test(src) || /popup\s*\??\.\s*close\s*\(/.test(src);
    assert.ok(
      closesPopup,
      f + " waits for a popup page but never closes it - a context teardown can block on it (see #203)",
    );
  }
});

test("F203-d: no e2e spec navigates to a public http(s) host", () => {
  // The lane runs against tests/e2e/fixtures/mock-backend.mjs on 127.0.0.1:7331.
  // A goto() at an absolute external URL makes CI depend on a third-party host.
  for (const f of specFiles()) {
    const src = read(SPECS_DIR + "/" + f);
    const bad = [...src.matchAll(/\.goto\(\s*["'](https?:)?\/\/[^"']+["']/g)].map((m) => m[0]);
    assert.deepEqual(bad, [], f + " navigates to an absolute external URL: " + bad.join(", "));
  }
});

test("F203-e: the mirror spec declares why it isolates the network (the comment is the contract)", () => {
  const src = read(SPECS_DIR + "/f91-mirror-mode.spec.ts");
  assert.match(src, /isolateExternalNetwork/, "the spec must stub external navigations");
  assert.match(src, /#203/, "the reason for the isolation must be recorded beside it");
  // The stub must not weaken the assertion: the popup URL is still checked.
  assert.match(src, /toContain\(site\)/, "the popup's target URL is still asserted");
  assert.match(src, /not\.toBe\("about:blank"\)/, "the popup must still be proven to have navigated");
});
