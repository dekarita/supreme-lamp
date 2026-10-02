#!/usr/bin/env node
// [F41 §6.1] Bottom-bar time rows: the v2 AppShell must keep the F38 footer
// contract ids (timerElapsed/timerRemaining/timerRdpUsage/lastRdpLogon/
// bottomClock) wired to live tick sources (useNow / telemetry store), not
// one-shot mount values. Static gate: each id must be referenced from a
// component that also consumes useNow or the telemetry store.
// CRLF-safe: EOL-normalized reads only.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// [F62] Repo-root relative, CWD-independent.
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const norm = (p) => readFileSync(ROOT + p, "utf8").replace(/\r\n?/g, "\n");

const shell = norm("src/components/layout/AppShell.tsx");
const requiredIds = ["timerElapsed", "timerRemaining", "timerRdpUsage", "lastRdpLogon", "bottomClock"];
const missing = requiredIds.filter((id) => !shell.includes(`id="${id}"`));
if (missing.length) {
  console.error("FAIL: bottom-bar ids missing from AppShell: " + missing.join(", "));
  process.exit(1);
}
if (!/useNow\s*\(/.test(shell)) {
  console.error("FAIL: bottom bar is not wired to the 1s useNow tick.");
  process.exit(1);
}
// Values must come from the telemetry store (server-synced), not Date.now only.
if (!/useTelemetryStore/.test(shell)) {
  console.error("FAIL: bottom bar values must be sourced from useTelemetryStore (server-synced clock).");
  process.exit(1);
}
console.log("OK: bottom-bar time rows present and live-wired (useNow + telemetry store).");
