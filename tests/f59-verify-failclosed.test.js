// [F59 §4] NODE LAB - prebuilt asset SHA-256 verification is FAIL-CLOSED.
//
// Every cell below runs the REAL shipped verifier (scripts/f59-verify-sha256.mjs)
// against real fixture bytes and asserts the exit code, so "verified" can never
// silently degrade into "warn and continue" for either the binary lane or the
// UI-artifact lane.
const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = path.join(__dirname, "..");
const verifier = path.join(root, "scripts", "f59-verify-sha256.mjs");

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}
function run(args) {
  return spawnSync(process.execPath, [verifier, ...args], { encoding: "utf8" });
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "f59-verify-"));
const good = Buffer.from("F59 prebuilt asset fixture\n");
const goodPath = path.join(tmp, "aria2c-1.36.0-win-x64.exe");
fs.writeFileSync(goodPath, good);

test("F59-10 a correct pin passes (exit 0)", () => {
  const r = run([goodPath, sha256(good), "--label", "aria2c.exe"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /sha256=.*OK/);
});

test("F59-11 a tampered asset fails closed (exit 1, no staging)", () => {
  const tampered = path.join(tmp, "tampered.exe");
  fs.writeFileSync(tampered, Buffer.concat([good, Buffer.from("evil")]));
  const r = run([tampered, sha256(good), "--label", "tampered.exe"]);
  assert.equal(r.status, 1, "a digest mismatch MUST exit 1");
  assert.match(r.stderr, /SHA-256 mismatch/);
  assert.match(r.stderr, /::error title=F59 asset verification::/);
});

test("F59-12 a missing asset, a malformed pin and a missing checksum line all fail closed", () => {
  assert.equal(run([path.join(tmp, "nope.exe"), sha256(good)]).status, 1, "missing file must exit 1");
  assert.equal(run([goodPath, "not-a-hash"]).status, 1, "malformed pin must exit 1");
  const ck = path.join(tmp, "checksums.txt");
  fs.writeFileSync(ck, sha256(Buffer.from("other")) + "  other.exe\n");
  const r = run(["--checksums", goodPath, ck]);
  assert.equal(r.status, 1, "an asset with no checksum line must exit 1");
  assert.match(r.stderr, /no checksum line/);
});

test("F59-13 the checksums-only mode still enforces the pin it finds", () => {
  const ck = path.join(tmp, "checksums-good.txt");
  fs.writeFileSync(ck, sha256(good) + "  " + path.basename(goodPath) + "\n");
  const ok = run(["--checksums", goodPath, ck]);
  assert.equal(ok.status, 0, ok.stderr);
  fs.writeFileSync(ck, sha256(Buffer.from("other")) + "  " + path.basename(goodPath) + "\n");
  assert.equal(run(["--checksums", goodPath, ck]).status, 1, "a stale checksums.txt line must exit 1");
});

test("F77 UI-artifact lane waits for its exact SHA then uses the fail-closed verifier", () => {
  const main = fs.readFileSync(path.join(root, ".github/workflows/main.yml"), "utf8");
  const start = main.indexOf("Download SHA-pinned UI bundle");
  const end = main.indexOf("- name: Upload dist-ui", start);
  assert.ok(start >= 0 && end > start, "SHA-pinned download step should be present with no fallback step");
  const step = main.slice(start, end);
  assert.match(step, /scripts\/f59-verify-sha256\.mjs/, "the UI download must verify through the shipped verifier");
  assert.match(step, /actions\/workflows\/build-ui\.yml\/runs\?head_sha=\$\{GITHUB_SHA\}/, "the wait must query build-ui for the exact SHA");
  assert.match(step, /ui-dist-\$\{GITHUB_SHA\}\.zip not yet published/, "an asset miss must fail with an operator message");
  assert.doesNotMatch(step, /pnpm (install|run)|Fallback build/, "there is no on-runner or stale-SHA fallback");
  assert.ok(
    step.indexOf("f59-verify-sha256.mjs") < step.indexOf("ui/dist/index.html"),
    "verification must run BEFORE the bundle is staged"
  );
  assert.match(step, /set -euo pipefail/, "a nonzero verify must abort the step (no continue-on-error)");
  // and the binary lane verifies through the shipped PowerShell module
  const ps = fs.readFileSync(path.join(root, "payloads/f59-prebuilt-verify.ps1"), "utf8");
  assert.match(ps, /throw \('\[F59 prebuilt\] SHA-256 MISMATCH/);
  assert.match(ps, /EMPTY sha256 pin - refusing an unverified asset/);
});

test("F59-15 the verifier itself never writes, stages or executes an asset", () => {
  const src = fs.readFileSync(verifier, "utf8");
  for (const bad of [/execFileSync/, /spawnSync/, /writeFileSync/, /copyFileSync/, /chmod/]) {
    assert.equal(bad.test(src), false, "the verifier must be read-only: " + bad);
  }
  // sanity: execFileSync import is not needed and must not appear in the shipped file
  assert.equal(/from "node:child_process"/.test(src), false);
});
