// [M4 / maintenance] THE ROADMAP DRIFT AND THE CHECK:UI LANDMINE.
//
// 1. Step 6's roadmap checkbox cited PR #173 for branch arena/fa27adb3, which IS PR #174 (#173 is
//    arena/66a13a8c, the retired sibling). The one-word fix is #173 -> #174. Under the F111 gate,
//    fixing the line makes BOTH of its allowlist entries unobserved, so both are deleted in the
//    same commit (ALLOWLIST-DELETE-WITH-FIX). F111-d fails if an allowlisted drift is left behind.
// 2. `check:ui` was referenced in prose but is not a script, not a workflow step and not a file.
//    The real artifact is ui/dist/index.html (vite.config.ts build.outDir), and the real gate that
//    reads it is `check:no-neon-green`. This gate pins those facts so the landmine stays closed.
//
// FALSIFY (each mutation was applied, the named gate failed, and the file was restored):
//   F-f put #173 back on the Step 6 roadmap line                    -> M4-R1 + F111-d fail
//   F-g restore one knownRoadmapDrift entry for the step-6 drift     -> M4-R2 + F111-d fail
//   F-h add a `check:ui` script to package.json                      -> M4-L1 fails
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n?/g, "\n");
const ROADMAP = "docs/OBSERVATORY-STATE.md";
const LEDGER = "src/lib/ci/stepLedger.json";

test("M4-R1: the Step 6 roadmap checkbox cites the canonical survivor #174 and no longer #173", () => {
  // Step 6 has three checkbox lines: the F107 line for arena/fa27adb3 (this one), an older F107 line
  // with no branch (#173's own record, untouched), and the REPAIR line (#175). Select by branch.
  const lines = read(ROADMAP).split("\n").filter((l) => /^- \[[ x]\] \*\*Step 6 — F107\*\*/.test(l) && l.includes("`arena/fa27adb3-supreme-lamp`"));
  assert.equal(lines.length, 1, "exactly one Step 6 F107 line must name arena/fa27adb3, got " + lines.length);
  const line = lines[0];
  assert.ok(line.includes("landed on `arena/fa27adb3-supreme-lamp`, PR **#174**"), "the Step 6 line must cite PR **#174** for arena/fa27adb3");
  assert.equal(line.includes("PR **#173**"), false, "the Step 6 line still cites #173 - the drift is back");
});

test("M4-R2: the two allowlist entries that this fix resolved are gone from knownRoadmapDrift", () => {
  const ledger = JSON.parse(read(LEDGER));
  const allow = ledger.knownRoadmapDrift;
  assert.ok(Array.isArray(allow), "knownRoadmapDrift must be an array");
  const resolved = [
    "roadmap Step 6 names branch arena/fa27adb3-supreme-lamp",
    "ledger #174 (step 6) is not cited by any Step 6 roadmap line",
  ];
  for (const r of resolved) {
    assert.equal(allow.some((a) => String(a.match || "").startsWith(r)), false, "an allowlist entry for an already-fixed drift remains: " + r);
  }
});

test("M4-L1: check:ui is referenced by no executable surface; the real artifact and gate are pinned", () => {
  const pkg = JSON.parse(read("package.json"));
  assert.equal(Object.keys(pkg.scripts || {}).some((k) => /check:ui/.test(k)), false, "package.json has a check:ui script");
  assert.equal(Object.values(pkg.scripts || {}).some((v) => /check:ui/.test(String(v))), false, "a package.json script invokes check:ui");

  const wfDir = path.join(ROOT, ".github/workflows");
  for (const f of fs.readdirSync(wfDir).filter((f) => /\.ya?ml$/.test(f))) {
    assert.equal(read(".github/workflows/" + f).includes("check:ui"), false, f + " invokes check:ui");
  }
  const scripts = path.join(ROOT, "scripts");
  for (const f of fs.readdirSync(scripts)) {
    const p = "scripts/" + f;
    if (fs.statSync(path.join(ROOT, p)).isFile()) assert.equal(read(p).includes("check:ui"), false, p + " invokes check:ui");
  }

  // the correct references: the build writes ui/dist/index.html, and check:no-neon-green reads it
  assert.match(read("vite.config.ts"), /outDir:\s*"ui\/dist"/, "vite build.outDir must stay ui/dist");
  assert.equal(pkg.scripts["check:no-neon-green"], "node scripts/check-no-neon-green.mjs", "the bundle gate must stay check:no-neon-green");
  assert.ok(read("scripts/check-no-neon-green.mjs").includes("ui/dist/index.html"), "check-no-neon-green must read ui/dist/index.html");
});
