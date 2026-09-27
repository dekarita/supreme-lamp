#!/usr/bin/env node
// [F41 §6.1] Regression-id cross-check: src/lib/regression-ids.ts must stay in
// lockstep with tests/f38-ui-glass.test.js BASELINE_IDS (219 ids). Any drift
// between the v1 fixture and the v2 lock file fails CI.
// CRLF-safe: both files are read with EOL normalization before regex work.
import { readFileSync } from "node:fs";

const norm = (s) => s.replace(/\r\n?/g, "\n");

function extractBaseline() {
  const src = norm(readFileSync("tests/f38-ui-glass.test.js", "utf8"));
  const m = src.match(/const\s+BASELINE_IDS\s*=\s*\[([\s\S]*?)\]/);
  if (!m) throw new Error("BASELINE_IDS not found in tests/f38-ui-glass.test.js");
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

function extractLock() {
  const src = norm(readFileSync("src/lib/regression-ids.ts", "utf8"));
  const m = src.match(/export const REGRESSION_IDS: readonly string\[\] = \[([\s\S]*?)\]/);
  if (!m) throw new Error("REGRESSION_IDS not found in src/lib/regression-ids.ts");
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

const base = extractBaseline();
const lock = extractLock();
const baseSet = new Set(base);
const lockSet = new Set(lock);

const missingInLock = base.filter((id) => !lockSet.has(id));
const extraInLock = lock.filter((id) => !baseSet.has(id));

if (base.length !== 219) {
  console.error(`FAIL: BASELINE_IDS is ${base.length}, expected the frozen 219 (did ui.html drift?).`);
  process.exit(1);
}
if (missingInLock.length || extraInLock.length || lock.length !== base.length) {
  console.error("FAIL: src/lib/regression-ids.ts is out of sync with BASELINE_IDS.");
  if (missingInLock.length) console.error("  missing in lock: " + missingInLock.join(", "));
  if (extraInLock.length) console.error("  extra in lock: " + extraInLock.join(", "));
  process.exit(1);
}
console.log(`OK: REGRESSION_IDS (${lock.length}) === BASELINE_IDS (219) - v2 regression lock in sync.`);
