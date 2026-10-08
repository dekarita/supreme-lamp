// [M5 / maintenance] AUTH ROUTING: the fetch client transmits the canonical dash token.
//
// THE BUG THIS STEP CLOSES (M4 finding, operator-approved fix): `requestFetch` resolved its
// token from `window.__GHRDP_DASH_TOKEN` - a global NOTHING in this repo writes (one reader,
// zero writers) - and from a `ghrdp-dash-token` localStorage read that M4 already deleted as
// dead. So POST /api/fetch always went out with NO `X-Dash-Token`, and the server requires one
// (401 `dash token required`, payloads/ghrdp-server.ps1), which broke the search download and
// the own-credential submit. M5 routes the client through src/lib/dashToken.ts, the ONE
// resolver every other client already used, and retires the unsettable window override.
//
// These are STATIC gates; the behaviour is pinned at runtime by
// src/tests/smoke/m5-auth-routing.test.ts. M4's deferred-decision pin
// (tests/m4-dead-read-cleanup.test.js M4-D5) was flipped in the same commit, deliberately.
//
// FALSIFY (each mutation applied, the named gate failed, file restored - see the M5 record):
//   F-a replace the resolver import with a private token source        -> M5-a fails
//   F-b re-add the `window.__GHRDP_DASH_TOKEN` read                    -> M5-a + M5-d fail
//   F-c drop `if (token) headers['X-Dash-Token'] = token;`             -> M5-b fails (runtime too)
//   F-d move the token into the query string (`?key=`)                 -> M5-b fails (runtime too)
//   F-e point DASH_TOKEN_STORAGE_KEY at the retired shadow key         -> runtime tests fail (M4-D3/F111 too)
//   F-f add a second `fetch(` call site that skips the header          -> M5-c fails
//   F-g stop delegating startFetch to requestFetch                     -> M5-c fails
//   F-h unmask the recorder's request headers                          -> M5-e fails
//   F-i leak the token into the request body                           -> runtime test fails
//   V-a scanner self-test on a synthetic fixture                       -> vacuity probe (in M5-d)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n?/g, "\n");

/** Code only: strip block and line comments, so an explanation is never mistaken for code. */
function codeOnly(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((l) => l.replace(/(^|[^:])\/\/.*$/, "$1"))
    .join("\n");
}

const CLIENT = "src/api/fetch/index.ts";
const RESOLVER = "src/lib/dashToken.ts";
const RECORDER = "src/lib/collectorAgent.ts";
const RUNTIME_TEST = "src/tests/smoke/m5-auth-routing.test.ts";

/** Every source file under `dir`, forward-slash relative. */
function walk(dir) {
  const out = [];
  for (const ent of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = dir + "/" + ent.name;
    if (ent.isDirectory()) out.push(...walk(rel));
    else if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(ent.name)) out.push(rel);
  }
  return out;
}

/** The retired window override. Kept as a scanner (not a bare grep), scanning CODE ONLY so an
 *  explanation of the retirement is never mistaken for a read of it - and self-tested in M5-d so
 *  the comment stripper cannot hide a real one. */
const RETIRED_OVERRIDE = "__GHRDP_DASH_TOKEN";
function scanRetiredOverride(text) {
  const code = codeOnly(text);
  const hits = [];
  code.split("\n").forEach((line, i) => {
    if (line.includes(RETIRED_OVERRIDE)) hits.push(i + 1);
  });
  return hits;
}

const aliasOf = () => {
  const m = codeOnly(read(CLIENT)).match(/import\s*\{\s*getDashToken\s+as\s+(\w+)\s*\}\s*from\s*['"]@\/lib\/dashToken['"]/);
  assert.ok(m, "the canonical resolver import is missing from " + CLIENT);
  return m[1];
};

test("M5-a: the fetch client resolves the token through src/lib/dashToken.ts, not a private source", () => {
  const code = codeOnly(read(CLIENT));
  const alias = aliasOf();
  assert.ok(code.includes("const token = " + alias + "();"), "the client does not call the canonical resolver");
  assert.equal(/localStorage/.test(code), false, "the client reads storage directly - every source belongs to the resolver");
  assert.equal(/getItem\s*\(/.test(code), false, "the client reads a raw storage item");
  assert.equal(/function\s+getDashToken\s*\(/.test(code), false, "a private getDashToken() is back (the shadow M4 deleted)");
  assert.equal(code.includes(RETIRED_OVERRIDE), false, "the retired window override is back in the client");
});

test("M5-b: the token travels in X-Dash-Token only - never in a URL, never in the body", () => {
  const code = codeOnly(read(CLIENT));
  assert.equal(code.split("X-Dash-Token").length - 1, 1, "X-Dash-Token must appear exactly once (the header assignment)");
  assert.ok(code.includes("if (token) headers['X-Dash-Token'] = token;"), "the header assignment is missing or changed shape");
  assert.equal(/[?&]key=/.test(code), false, "a query-string credential appeared in this client");
  // The header must be built BEFORE the request is issued (a -1 index fails this too).
  const headerAt = code.indexOf("if (token) headers['X-Dash-Token'] = token;");
  const callAt = code.indexOf("await fetch(");
  assert.ok(headerAt > 0 && callAt > headerAt, "the request is issued before the auth header is built");
});

test("M5-c: every entry point funnels through the ONE authenticated call site", () => {
  const code = codeOnly(read(CLIENT));
  assert.equal((code.match(/\bfetch\(/g) || []).length, 1, "a second fetch() call site can skip the auth header");
  for (const fn of ["startFetch", "cancelFetch", "retryFetch"]) {
    const start = code.indexOf("export async function " + fn);
    assert.ok(start > 0, fn + " is missing");
    const body = code.slice(start, code.indexOf("\n}", start));
    assert.ok(body.includes("return requestFetch({"), fn + " must delegate to requestFetch (one auth path)");
  }
});

test("M5-d: the retired window override is readable NOWHERE outside the test that pins its absence", () => {
  const prod = [];
  const tests = [];
  for (const rel of walk("src")) {
    const hits = scanRetiredOverride(read(rel));
    if (!hits.length) continue;
    if (rel.startsWith("src/tests/")) tests.push(rel);
    else prod.push(rel + ":" + hits.join(","));
  }
  // §VACUITY-PROBE: the target really exists in code (and the stripper keeps code)...
  const fixtureCode = 'if (typeof window !== "undefined") return (window as any).' + RETIRED_OVERRIDE + ';';
  assert.equal(scanRetiredOverride(fixtureCode).length, 1, "the scanner cannot see its own target");
  assert.ok(codeOnly('const a = 1; // ' + RETIRED_OVERRIDE).includes("const a = 1;"), "the comment stripper eats code, not just comments");
  // ...while prose about it is not a read.
  assert.equal(scanRetiredOverride("// the retired " + RETIRED_OVERRIDE + " override used to live here").length, 0, "a comment counted as a read");
  assert.deepEqual(prod, [], "the retired override is read by production code again");
  // §TEST-SEEDS-RETIRED-KEY-EXCLUSION: the test tree is excluded, and the exclusion is
  // OBSERVABLE - exactly one file may seed it, and that file is the pin for its absence.
  // A second seeder fails here rather than quietly widening the blind spot.
  assert.deepEqual(tests, [RUNTIME_TEST], "the retired-override test seeder set changed");
  assert.ok(
    codeOnly(read(RUNTIME_TEST)).includes(RETIRED_OVERRIDE + ' = OVERRIDE'),
    "the excluded file must SEED the retired override on purpose - otherwise the exclusion is a drawer"
  );
});

test("M5-e: the F101 recorder masks the header by name, so this adds no stored plaintext copy", () => {
  const rec = read(RECORDER);
  assert.ok(rec.includes("const SECRET_HEADER = /token|authorization|cookie|key|secret|password/i;"), "the mask rule changed");
  assert.ok(new RegExp("token|authorization|cookie|key|secret|password", "i").test("X-Dash-Token"), "the mask must match the header this client now sends");
  assert.ok(rec.includes("maskHeaders(rawHeaders)"), "request headers are recorded UNMASKED - the new header would be stored in clear");
});

test("M5-f: the storage key is owned by the resolver, never named by the client", () => {
  const code = codeOnly(read(CLIENT));
  assert.equal(/ghrdp[.-]dashToken/.test(code), false, "the client names the storage key - the resolver owns it");
  assert.equal(/ghrdp-dash-token/.test(code), false, "the M4-retired shadow key is back in this client");
  // Positive control: the string this scan looks for really exists in the tree, so M5-a/M5-f
  // are absence-assertions over a target that a grep CAN see (not a typo-scan on nothing).
  assert.ok(read(RESOLVER).includes('const DASH_TOKEN_STORAGE_KEY = "ghrdp.dashToken";'), "the resolver no longer owns the canonical key");
});

test("M5-g: the runtime pin exists and is wired to the real client (not a copy of it)", () => {
  const t = read(RUNTIME_TEST);
  assert.ok(t.includes("from '@/api/fetch/index.ts'"), "the runtime pin must import the shipped client");
  assert.ok(t.includes("STORAGE_KEY = 'ghrdp.dashToken'"), "the runtime pin must use the canonical key");
  assert.ok(t.includes("X-Dash-Token"), "the runtime pin must assert the header");
});
