#!/usr/bin/env node
// [F41 §6.1] Neon-green gate over the built v2 bundle: no banned green hex
// anywhere in ui/dist/index.html (singlefile). Success color must flow through
// var(--color-success) / Tailwind success-* tokens only. CRLF-safe via EOL
// normalization; the file is scanned as text, never line-split.
import { readFileSync } from "node:fs";

const BANNED = ["#22c55e", "#39ff14", "#00ff41", "#00ff00"];
const path = process.argv[2] || "ui/dist/index.html";
let src;
try {
  src = readFileSync(path, "utf8").replace(/\r\n?/g, "\n").toLowerCase();
} catch {
  console.error(`FAIL: bundle not found at ${path} - run the build first.`);
  process.exit(1);
}
const hits = BANNED.filter((b) => src.includes(b));
if (hits.length) {
  console.error("FAIL: banned green tokens in " + path + ": " + hits.join(", "));
  process.exit(1);
}
console.log("OK: no banned green tokens in " + path + " (" + src.length + " bytes scanned).");
