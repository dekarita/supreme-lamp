#!/usr/bin/env node
// [F108 §4] Mirror the shipped pure cores into the published replay root.
//
// WHY A COPY AT ALL. F108's viewer is published by GitHub Pages from `docs/`,
// and a page under `docs/replay/` cannot import out of that root - so the reader
// cores must exist INSIDE docs/. The alternative to copying is re-implementing
// them in docs/, which is exactly the "two parsers" hazard the F107 repair
// removed (one `.mcrec` v2 producer, one reader).
//
// WHY IT CANNOT DRIFT. The copy is generated, never edited: this script writes
// it, and tests/f108-replay-core.test.js asserts byte equality (CRLF-normalized)
// between every pair below. Editing a vendored file by hand fails the gate with
// the pair's name; editing the src file without re-running this script fails the
// same gate. `pnpm sync:replay` / `node scripts/sync-replay-vendor.mjs` fixes it.
//
// The mapping keeps RELATIVE IMPORTS intact: `src/…` maps to
// `docs/replay/vendor/…`, so `import … from "../lib/dvr/exportCore.js"` inside
// src/replay/replayCore.js resolves to the vendored core in the published tree
// without rewriting a single byte.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

/** src path -> published path. Order matters only for the log lines. */
export const VENDOR_PAIRS = [
  ["src/lib/dvr-core.js", "docs/replay/vendor/lib/dvr-core.js"],
  ["src/lib/dvr/exportCore.js", "docs/replay/vendor/lib/dvr/exportCore.js"],
  ["src/lib/dvr/screenshotCore.js", "docs/replay/vendor/lib/dvr/screenshotCore.js"],
  ["src/lib/dvr/routeCore.js", "docs/replay/vendor/lib/dvr/routeCore.js"],
  ["src/replay/replayCore.js", "docs/replay/vendor/replay/replayCore.js"],
];

/** Normalize line endings so a CRLF checkout is not "drift" (nothing else is). */
export function normalize(text) {
  return String(text).replace(/\r\n?/g, "\n");
}

export function main(argv = process.argv.slice(2)) {
  const check = argv.includes("--check");
  let drifted = 0;
  for (const [from, to] of VENDOR_PAIRS) {
    const src = readFileSync(join(ROOT, from), "utf8");
    if (check) {
      let dst = null;
      try {
        dst = readFileSync(join(ROOT, to), "utf8");
      } catch {
        console.error("MISSING " + to + " (run: node scripts/sync-replay-vendor.mjs)");
        drifted++;
        continue;
      }
      if (normalize(dst) !== normalize(src)) {
        console.error("DRIFT   " + to + " != " + from);
        drifted++;
      } else {
        console.log("ok      " + to);
      }
      continue;
    }
    mkdirSync(dirname(join(ROOT, to)), { recursive: true });
    writeFileSync(join(ROOT, to), src, "utf8");
    console.log("wrote   " + to);
  }
  if (check && drifted) {
    console.error(drifted + " vendored file(s) out of sync - the published reader is not the shipped reader");
    return 1;
  }
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  process.exit(main());
}
