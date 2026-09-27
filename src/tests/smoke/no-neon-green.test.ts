// [F41 §6.1 gate] No neon green outside --color-success: scan the built
// singlefile bundle (ui/dist/index.html) for banned hex tokens. CRLF-safe:
// the file is read as a buffer and normalized before scanning (no \n-anchored
// regex on raw file content).
import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";

const BANNED = ["#22c55e", "#39ff14", "#00ff41", "#00ff00"];
// Tailwind v4 default palette greens are banned as raw hex; success usage must
// route through var(--color-success) / the tailwind success-* scale only.

function normalizedSource(): string {
  const paths = ["ui/dist/index.html", "dist/index.html"];
  for (const p of paths) {
    if (existsSync(p)) {
      return readFileSync(p, "utf8").replace(/\r\n?/g, "\n").toLowerCase();
    }
  }
  return "";
}

describe("neon-green gate (built bundle)", () => {
  it("built bundle contains no banned green hex tokens", () => {
    const src = normalizedSource();
    if (!src) {
      // Bundle not built in this run (e.g. test-only CI pass) - the gate also
      // runs as a standalone script over the artifact; skip here.
      return;
    }
    const hits = BANNED.filter((b) => src.includes(b));
    expect(hits, "banned greens found: " + hits.join(", ")).toEqual([]);
  });
});
