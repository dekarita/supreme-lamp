// [M4 / maintenance] LATENT BUG CLEANUP: the `ghrdp-dash-token` dead read.
//
// `ghrdp-dash-token` was read by src/api/fetch/index.ts (getDashToken) and src/lib/f46.ts
// (getPerRunKey) and written by NOTHING. `git log --all -S"ghrdp-dash-token"` finds 8 commits and
// every added line in them is a read, so both reads always fell through. M4 deleted both reads.
// The canonical dash token is `ghrdp.dashToken` (src/lib/dashToken.ts), which M4 does not touch.
//
// These are STATIC gates: they pin the policy that the dead read stays gone and that the
// deferred routing decision stays a deliberate change. The behaviour-neutrality claim was checked
// separately (see the M4 session record in docs/OBSERVATORY-STATE.md).
//
// FALSIFY (each mutation was applied, the named gate failed, and the file was restored):
//   F-a re-add localStorage.getItem('ghrdp-dash-token') to src/lib/f46.ts     -> M4-D1 + M4-D2 fail
//   F-b add a writer setItem('ghrdp-dash-token', v) to src/lib/dashToken.ts   -> M4-D2 fails
//   F-c re-declare the shadow key in storageInventory.json keys[]              -> M4-D4 fails
//   F-d change DASH_TOKEN_STORAGE_KEY to "ghrdp-dash-token"                    -> M4-D3 fails
//   F-e make getDashToken() read localStorage again                            -> M4-D5 fails
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n?/g, "\n");
const SHADOW = "ghrdp-dash-token";
/** Code only: strip block comments and line comments, so the M4 explanations are not reads. */
function codeOnly(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((l) => l.replace(/(^|[^:])\/\/.*$/, "$1"))
    .join("\n");
}
const CONSUMERS = ["src/api/fetch/index.ts", "src/lib/f46.ts"];

/** Every source file under src/, forward-slash relative paths. */
function walkSrc(dir = "src", out = []) {
  for (const ent of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = dir + "/" + ent.name;
    if (ent.isDirectory()) walkSrc(rel, out);
    else if (/\.(ts|tsx|js|jsx|mjs|cjs|json)$/.test(ent.name)) out.push(rel);
  }
  return out;
}

test("M4-D1: neither former consumer mentions the shadow key any more", () => {
  for (const p of CONSUMERS) {
    assert.equal(codeOnly(read(p)).includes(SHADOW), false, p + " still reads " + SHADOW + " - the dead read came back");
  }
});

test("M4-D2: no quoted literal of the shadow key exists under src/ (the inventory data and its gate core are excluded)", () => {
  const quoted = new RegExp("[\"'`]" + SHADOW + "[\"'`]");
  // Production code only. src/tests/ (jsdom suites, never shipped) may SEED the retired key to prove
  // it is ignored, and src/lib/ci/ holds the inventory data and its gate core. Same convention as F111.
  const hits = walkSrc()
    .filter((p) => !p.startsWith("src/lib/ci/") && !p.startsWith("src/tests/") && !/\.test\.(ts|tsx|js|jsx)$/.test(p))
    .filter((p) => quoted.test(codeOnly(read(p))));
  assert.deepEqual(hits, [], "a quoted " + SHADOW + " literal is a read, write or remove of the dead key");
});

test("M4-D3: the canonical key is still ghrdp.dashToken, declared exactly once", () => {
  const text = read("src/lib/dashToken.ts");
  const decl = text.match(/export const DASH_TOKEN_STORAGE_KEY = "([^"]+)";/g) || [];
  assert.equal(decl.length, 1, "DASH_TOKEN_STORAGE_KEY must be declared exactly once");
  assert.equal(decl[0], 'export const DASH_TOKEN_STORAGE_KEY = "ghrdp.dashToken";');
});

test("M4-D4: the F111 inventory no longer declares the shadow key, and records its retirement", () => {
  const inv = JSON.parse(read("src/lib/ci/storageInventory.json"));
  assert.equal(inv.keys.some((k) => k.key === SHADOW), false, "the shadow key is still declared as a storage surface");
  const retired = (inv.drift && inv.drift.retiredByM4) || [];
  const rec = retired.find((r) => r.key === SHADOW);
  assert.ok(rec, "drift.retiredByM4 must record the retirement of " + SHADOW);
  assert.ok(typeof rec.why === "string" && rec.why.length > 40, "the retirement needs a real why");
});

test("M4-D5: getDashToken() in the fetch client has no localStorage access (the routing change is deliberate, not incidental)", () => {
  const src = read("src/api/fetch/index.ts");
  const m = codeOnly(src).match(/function getDashToken\(\)[^{]*\{([\s\S]*?)\n\}/);
  assert.ok(m, "getDashToken() must still exist");
  assert.equal(/localStorage/.test(m[1]), false, "getDashToken() reads localStorage again - route it through src/lib/dashToken.ts only as a deliberate, reviewed change");
});

test("M4-D6: getPerRunKey() in f46 has no localStorage access and sends no token from storage", () => {
  const src = read("src/lib/f46.ts");
  const start = src.indexOf("async function getPerRunKey");
  const end = src.indexOf("export async function encryptOwnCreds");
  assert.ok(start > 0 && end > start, "getPerRunKey() must still exist before encryptOwnCreds()");
  assert.equal(/localStorage/.test(codeOnly(src.slice(start, end))), false, "getPerRunKey() reads localStorage again");
});
