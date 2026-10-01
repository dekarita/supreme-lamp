#!/usr/bin/env node
// [F59 §2] FAIL-CLOSED SHA-256 verifier for prebuilt release assets.
//
// Usage: node scripts/f59-verify-sha256.mjs <file> <expected-sha256-hex> [--label <name>]
//        node scripts/f59-verify-sha256.mjs --checksums <file> <checksums-txt> [--label <name>]
//
// Exit 0 ONLY when the observed digest equals the pin byte-for-byte. Anything
// else - missing file, unreadable file, malformed pin, mismatched digest - is
// exit 1 with a ::error:: line. There is no warn-and-continue mode by design:
// an unverified prebuilt asset must never be staged or executed.
import { createHash } from "node:crypto";
import { createReadStream, readFileSync, statSync } from "node:fs";

function fail(msg) {
  console.error("::error title=F59 asset verification::" + msg);
  process.exit(1);
}

function digest(file) {
  return new Promise((resolve, reject) => {
    const h = createHash("sha256");
    const s = createReadStream(file);
    s.on("error", reject);
    s.on("data", (c) => h.update(c));
    s.on("end", () => resolve(h.digest("hex")));
  });
}

const argv = process.argv.slice(2);
let label = "";
const li = argv.indexOf("--label");
if (li >= 0) {
  label = argv[li + 1] || "";
  argv.splice(li, 2);
}

async function main() {
  let file;
  let expected;
  if (argv[0] === "--checksums") {
    file = argv[1];
    const checksumFile = argv[2];
    if (!file || !checksumFile) fail("usage: --checksums <file> <checksums.txt>");
    let text = "";
    try {
      text = readFileSync(checksumFile, "utf8");
    } catch (e) {
      fail("checksum file unreadable: " + checksumFile + " (" + e.message + ")");
    }
    const base = file.split(/[\\/]/).pop();
    const line = text
      .split(/\r?\n/)
      .filter((l) => l.trim() && l.includes(base))
      .pop();
    if (!line) fail("no checksum line for " + base + " in " + checksumFile);
    expected = (line.trim().split(/\s+/)[0] || "").toLowerCase();
  } else {
    file = argv[0];
    expected = (argv[1] || "").toLowerCase();
  }
  if (!file) fail("usage: <file> <expected-sha256>");
  if (!/^[0-9a-f]{64}$/.test(expected || "")) fail("pin is not a 64-hex sha256: '" + (expected || "") + "'");
  try {
    if (!statSync(file).isFile()) fail("not a regular file: " + file);
  } catch (e) {
    fail("asset missing/unreadable: " + file + " (" + e.message + ")");
  }
  const got = (await digest(file)).toLowerCase();
  if (got !== expected) {
    fail("SHA-256 mismatch for " + (label || file) + ": expected " + expected + " got " + got);
  }
  console.log("[F59 verify] " + (label || file) + " sha256=" + got + " OK");
}

main().catch((e) => fail("verification crashed: " + (e && e.message)));
