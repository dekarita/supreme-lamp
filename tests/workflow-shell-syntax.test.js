// [#223] Every `shell: bash` run block in every workflow must survive `bash -n`.
//
// WHY THIS EXISTS. Head 5ac45b3 added a comment inside an awk program that lives
// in a SINGLE-QUOTED shell string. The comment contained "Playwright's"; that
// apostrophe ended the shell string, so bash parsed the rest of the awk program
// as shell and the step died in 35 seconds with exit code 2 (job 114240714800)
// before ANY ::error:: annotation could print. The e2e lane went from "red with
// a named test" to "red with no evidence at all" - strictly worse than the defect
// it was meant to diagnose.
//
// The repo already carries the same lesson in prose twice:
//   - .github/workflows/launch-gates.yml F8: "grep the shell variables via
//     herestring, NEVER via `printf '%s' "$var" | grep -q`" (SIGPIPE/141);
//   - .github/workflows/e2e-ui.yml F82 §2.3: "no truncated pipeline can ever
//     kill the step again".
// Both are comments. A comment cannot stop the next person. `bash -n` can.
//
// SCOPE, stated honestly: `bash -n` is a SYNTAX check. It does not execute the
// step, does not prove any gate's assertions hold, and is not a substitute for
// the lane actually running. What it does prove is that a step cannot die before
// its own diagnostics print - the failure mode that made this lane
// undiagnosable for ~100 runs.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execFileSync } = require("node:child_process");

const WF_DIR = path.join(__dirname, "..", ".github", "workflows");

/** Pull every `run: |` / `run: >-` block out of a workflow, with its shell. */
function runBlocks(rel) {
  const lines = fs.readFileSync(path.join(WF_DIR, rel), "utf8").split("\n");
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*)run:\s*[|>][-+]?\s*$/);
    if (!m) continue;
    const keyIndent = m[1].length;

    // Resolve the step's shell by scanning BACKWARDS, stopping at whichever comes
    // first: an explicit `shell:` key, or the list item that starts this step.
    let shell = "bash"; // GitHub's default on ubuntu runners
    for (let j = i - 1; j >= 0; j--) {
      const sm = lines[j].match(/^\s*shell:\s*["']?([A-Za-z0-9_./-]+)/);
      if (sm) {
        shell = sm[1];
        break;
      }
      const item = lines[j].match(/^(\s*)-\s/);
      if (item && item[1].length <= keyIndent) break; // left this step
    }

    // Body = every following line that is blank or indented deeper than the key.
    const body = [];
    let bodyIndent = null;
    for (let j = i + 1; j < lines.length; j++) {
      const raw = lines[j];
      if (raw.trim() === "") {
        body.push("");
        continue;
      }
      const ind = raw.match(/^(\s*)/)[1].length;
      if (ind <= keyIndent) break;
      if (bodyIndent === null) bodyIndent = ind;
      body.push(raw.slice(Math.min(bodyIndent, ind)));
    }
    out.push({ rel, line: i + 1, shell, code: body.join("\n") + "\n" });
  }
  return out;
}

const workflows = fs
  .readdirSync(WF_DIR)
  .filter((f) => /\.ya?ml$/.test(f))
  .sort();

test("WF-SHELL-1: the guard is not vacuous - it actually finds bash run blocks", () => {
  assert.ok(workflows.length >= 10, "expected the shipped workflow set, got " + workflows.length);
  const blocks = workflows.flatMap(runBlocks);
  const bash = blocks.filter((b) => /bash/.test(b.shell));
  // launch-gates alone carries dozens of bash gates; a parser that silently
  // matched nothing would make every assertion below pass for free.
  assert.ok(bash.length >= 50, "only " + bash.length + " bash run blocks found - the parser is not matching");
  assert.ok(
    blocks.some((b) => /pwsh|powershell/.test(b.shell)),
    "no pwsh blocks found - the shell resolution is probably wrong",
  );
});

test("WF-SHELL-2: every bash run block parses (bash -n)", () => {
  const blocks = workflows.flatMap(runBlocks).filter((b) => /bash/.test(b.shell));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wfshell-"));
  const bad = [];
  for (const b of blocks) {
    const f = path.join(tmp, "block.sh");
    fs.writeFileSync(f, b.code, "utf8");
    try {
      execFileSync("bash", ["-n", f], { stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      const msg = String(e.stderr || e.message).split("\n").find((l) => /syntax error|unexpected/.test(l)) || "parse failed";
      bad.push(b.rel + ":" + b.line + " -> " + msg.trim());
    }
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  assert.deepEqual(bad, [], "bash run block(s) do not parse:\n" + bad.join("\n"));
});

test("WF-SHELL-3 (negative control): bash -n REJECTS the exact defect from 5ac45b3", () => {
  // A guard that cannot fail proves nothing. This replays the real defect - an
  // apostrophe inside a single-quoted awk program - and asserts the parser
  // rejects it. If bash -n ever stopped catching this, WF-SHELL-2 above would be
  // a green check that guards nothing.
  const broken = [
    "set -eo pipefail",
    "awk '",
    "  /^x/ {",
    "    # take Playwright's own lines",
    "    if (err != \"\" && nxt ~ /^[[:space:]]+(Expected|Received)/) { det = nxt }",
    "  }",
    "' e2e-run.log > out.txt || true",
    "",
  ].join("\n");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wfneg-"));
  const f = path.join(tmp, "broken.sh");
  fs.writeFileSync(f, broken, "utf8");
  let rejected = false;
  try {
    execFileSync("bash", ["-n", f], { stdio: ["ignore", "pipe", "pipe"] });
  } catch {
    rejected = true;
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  assert.ok(rejected, "bash -n accepted an apostrophe inside a single-quoted awk program - the guard is vacuous");
});
