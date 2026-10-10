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

test("F203-f: a failing lane emits a per-spec tally, so the offender is named without the step log", () => {
  // WHY: the step log is NOT retrievable from the agent sandbox (only
  // api.github.com is reachable, and results-receiver.actions.githubusercontent.com
  // is not). The ONLY channel out of this lane is the ~500-char check-run
  // annotation -- and a single oversized ::error:: is truncated from the FRONT,
  // which is why run 38024230807 (the first run to leave any evidence at all)
  // showed exactly one test and nothing else.
  //
  // So the contract is: on failure the step emits SHORT annotations that carry
  // (a) an ok/fail count per spec file and (b) the last result lines.
  // Neither may be dropped by an early pipeline exit (`|| true` under
  // `set -eo pipefail`).
  const wf = read(".github/workflows/e2e-ui.yml");
  assert.match(wf, /F79-E2E-TALLY/, "a per-spec tally annotation must exist");
  assert.match(wf, /F79-E2E-LAST/, "a last-results annotation must exist");
  // The tally names the FILE, not the assertion. Runs 38027291171 -> 38057454362
  // all said only "f84-ux.spec.ts ✘=N" and the step log is unreachable from the
  // agent sandbox, so the failing test stayed unnamed for the whole run. A
  // per-test annotation (spec:line + title + first error line) is the minimum
  // that turns a red lane into an actionable one.
  assert.match(wf, /F79-E2E-FAIL/, "a per-test failure annotation must exist (the tally names only the file)");
  assert.match(wf, /e2e-fails\.txt/, "the per-test failures must be collected from the run log");
  // Bounded like the other two: an oversized ::error:: is truncated from the
  // FRONT by GitHub, and only a handful of offenders are ever worth emitting.
  assert.ok(/cut -c1-380/.test(wf), "the per-test annotation must be length-capped");
  assert.ok(/nfail.*-gt 4/.test(wf), "the per-test annotation must stop after a bounded number of failures");
  // Both annotations are length-capped before they are echoed: a single
  // oversized ::error:: is truncated from the FRONT by GitHub, which is how
  // the first instrumented run lost every line but one.
  const caps = (wf.match(/cut -c1-400/g) || []);
  assert.ok(caps.length >= 2, "both failure annotations must be length-capped (found " + caps.length + ")");
  for (const ann of ["F79-E2E-TALLY", "F79-E2E-LAST"]) {
    assert.ok(wf.includes("::error::" + ann), ann + " annotation missing");
  }
  // (b) is built by a grep whose empty result must not abort the step.
  const lastLine = wf.split("\n").find((l) => l.trim().startsWith("last=$(grep"));
  assert.ok(lastLine, "the LAST annotation is built from the log's result lines");
  assert.match(lastLine, /\|\| true/, "an empty grep must not abort the step before the annotations print");
});

test("F203-g: the disproven popup hypothesis is recorded where the next reader will see it", () => {
  // Honorary correction: the first #203 fix guessed that an unclosed f91 popup
  // at a third-party host wedged context teardown. The lane did NOT go green
  // (run 38024230807 failed at the new 18m bound) and the evidence it produced
  // points at tests/e2e/f86-ten-sites-deep.spec.ts:101 instead. The popup
  // hygiene is kept because it is correct on its own merits, but the comment
  // must say so -- otherwise it is a false root cause left standing in code.
  const src = read(SPECS_DIR + "/f91-mirror-mode.spec.ts");
  assert.match(src, /DISPROVEN hypothesis/, "the spec must record that the popup theory did not fix the lane");
  assert.match(src, /f86-ten-sites-deep\.spec\.ts/, "the spec must name what the evidence actually points at");
  assert.match(src, /INCOMPLETE/, "the popup theory must be labelled incomplete, not the fix");
});

test("F203-h: the established #203 root cause stays fixed - no spec waits for the retired ladder transport on a mirror click", () => {
  // ROOT CAUSE (runs 38027291171 / 38036173948, tally + last annotations):
  // F91 (1827d3f0) moved every result/row click from POST /api/launch-url to
  // MIRROR MODE (POST /api/launcher/queue + local popup), but f86/f78 kept
  // waiting for /api/launch-url. Each site test burned its full 60s budget on
  // a request that can never come, and 11 sites x (attempt + retry) consumed
  // the 18m bound before f88/f91/f10x could run. These pins keep the repair:
  //   1. f86 asserts the mirror contract (queue POST + acceptance + the
  //      mock's independent /__f91/jobs readback) - the user requirement "the
  //      click really reaches the RDP session" is preserved on the new
  //      transport, and a silent local-only fallback still FAILS it;
  //   2. no spec waits for /api/launch-url after clicking a mirror control.
  const f86 = read(SPECS_DIR + "/f86-ten-sites-deep.spec.ts");
  assert.match(f86, /\/api\/launcher\/queue/, "f86 must assert the mirror transport");
  assert.match(f86, /__f91\/jobs/, "f86 must read the launch back from the mock's own job record");
  assert.match(f86, /mode\)\.toBe\("navigate"\)/, "f86 must pin the queue job mode");
  assert.ok(
    !/waitForRequest\([^)]*\/api\/launch-url/.test(f86),
    "f86 must not wait for the retired ladder transport on a mirror click",
  );
  const f78 = read(SPECS_DIR + "/f78-add-sites.spec.ts");
  assert.ok(
    !/page\.route\(\s*["']\*\*\/api\/launch-url["']/.test(f78),
    "f78 must not intercept the retired ladder transport for the row click",
  );
  assert.match(f78, /\/api\/launcher\/queue/, "f78 test 17 must assert the mirror transport");
});

test("F203-i: no in-page fetch may target a mock route by relative path (the SPA-fallback fake-green class)", () => {
  // The page under test is served by vite preview on :5173; the mock lives on
  // :7331 (apiBase()). An in-page `fetch("/api/...")` therefore NEVER reaches
  // the mock - vite's SPA fallback answers 200 + index.html for ANY unknown
  // path, so a dead contract reads green. This is how f84 test 5's queue-fence
  // assertion (expects the mock's 400) was failing against a 200 HTML page on
  // every run since F91. Every in-page fetch must use the mock base constant.
  for (const f of specFiles()) {
    const src = read(SPECS_DIR + "/" + f);
    const bad = [...src.matchAll(/fetch\(\s*["'](\/api\/|\/__f91)/g)].map((m) => m[0]);
    assert.deepEqual(bad, [], f + " fetches a mock route by relative path: " + bad.join(", "));
  }
});

test("F203-j: popup proof is waitForEvent + explicit close, never a page.on('popup') listener array", () => {
  // The listener-array pattern raced the queue job (the f91 §1.3 red) and its
  // unclosed popups pointed at third-party hosts, which a context teardown
  // waits for (the F203-c wedge class). waitForEvent fails LOUDLY on a blocked
  // popup; closeExtraPages keeps teardown clean.
  for (const f of specFiles()) {
    const src = read(SPECS_DIR + "/" + f);
    assert.ok(!/page\.on\(\s*["']popup["']/.test(src), f + " uses the racy page.on('popup') listener pattern");
  }
});

test("F203-k: every spec that clicks a mirror control isolates the external network and closes its popups", () => {
  // A mirror click opens a popup at the row's own REAL third-party URL. The
  // lane must stay isolated (no public-host wait, no wedged teardown), so any
  // spec that clicks a mirror control must stub external navigations AND
  // close every page it opens.
  //
  // Detection is two-ply: (a) the known mirror-click lanes, pinned by name so
  // a refactor cannot silently drop one from the requirement; (b) a generic
  // catch for any FUTURE spec that clicks a mirror control directly
  // (`getByTestId("<mirror>").first().click()`). f79's `card-direct-url`
  // reference is deliberately NOT flagged: it asserts CSS on the control, it
  // never clicks it, so no popup is opened there.
  const MIRROR_CLICK_SPECS = [
    "f78-add-sites.spec.ts",
    "f84-ux.spec.ts",
    "f86-ten-sites-deep.spec.ts",
    "f91-mirror-mode.spec.ts",
  ];
  const DIRECT_MIRROR_CLICK =
    /getByTestId\("(lab-link-open|card-direct-url|card-open-rdp|f87-diag-test-launch)"\)[^;\n]*\.click\(/;
  for (const f of specFiles()) {
    const src = read(SPECS_DIR + "/" + f);
    const isKnown = MIRROR_CLICK_SPECS.includes(f);
    const isDirect = DIRECT_MIRROR_CLICK.test(src);
    if (!isKnown && !isDirect) continue;
    assert.match(src, /isolateExternalNetwork\(/, f + " clicks a mirror control but never stubs external navigations");
    assert.match(src, /closeExtraPages\(/, f + " clicks a mirror control but never closes the popups it opens");
  }
});
