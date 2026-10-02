// [F62] NODE LAB - main.yml build-ui "Download prebuilt UI bundle" step runs
// from $RUNNER_TEMP/ui-dl, not the repo root. Regression cells:
//  1. the CWD-sensitive gate scripts exit 0 when spawned from a foreign cwd
//  2. the ui-prebuilt step never invokes a repo script by a relative path
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");

for (const script of ["check-regression-ids.mjs", "check-bottom-bar-time.mjs"]) {
  test(`F62: scripts/${script} exits 0 from a non-repo cwd`, () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "f62-ui-dl-"));
    try {
      const r = spawnSync(process.execPath, [path.join(ROOT, "scripts", script)], { cwd, encoding: "utf8" });
      assert.equal(r.status, 0, `exit=${r.status}\n${r.stderr}`);
      assert.match(r.stdout, /^OK:/m);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
}

test("F62: main.yml ui-prebuilt step uses $GITHUB_WORKSPACE for every node script", () => {
  const yml = fs.readFileSync(path.join(ROOT, ".github/workflows/main.yml"), "utf8").replace(/\r\n?/g, "\n");
  const start = yml.indexOf("id: ui-prebuilt");
  assert.ok(start > 0, "ui-prebuilt step not found");
  const end = yml.indexOf("\n      - name:", start);
  const step = yml.slice(start, end > 0 ? end : undefined);
  const calls = [...step.matchAll(/^\s*node\s+(\S+)/gm)].map((m) => m[1]);
  assert.ok(calls.length >= 4, `expected >=4 node calls, got ${calls.length}`);
  for (const c of calls) assert.match(c, /^"\$GITHUB_WORKSPACE\/scripts\//, `relative script path: ${c}`);
});
