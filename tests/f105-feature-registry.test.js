// [F105 / Observatory step 4] Feature Registry + Boundaries — the static gate.
//
// This file is the contract that keeps the registry HONEST, and it is
// deliberately re-derived rather than trusted: it re-implements the DAG walk,
// re-expands the ownership globs, re-reads App.tsx's route table and re-reads
// both i18n catalogs, then compares all of them against
// src/lib/feature-registry.json. If any artefact drifts - a 12th page appears,
// a route is renamed, a feature is wrapped twice, an evidence citation stops
// resolving, a boundary grows a fetch() - this job fails.
//
// Auto-run by launch-gates.yml's `node --test tests/*.test.js` step, so no
// workflow edit is needed for it to be enforced.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n?/g, "\n");

const REGISTRY = JSON.parse(read("src/lib/feature-registry.json"));
const APP = read("src/App.tsx");
const FEATURES = REGISTRY.features;

// The pinned sidebar order. #163 §1 and AppShell's NAV both fix this list; a
// registry that silently reorders or drops a section is a real regression.
const EXPECTED_ORDER = [
  "overview",
  "search",
  "sessions",
  "connections",
  "keys",
  "files",
  "mirror",
  "telemetry",
  "health",
  "collector",
  "settings",
];
const EXPECTED_ROUTES = {
  overview: "/",
  search: "/search",
  sessions: "/sessions",
  connections: "/connections",
  keys: "/keys",
  files: "/files",
  mirror: "/mirror",
  telemetry: "/telemetry",
  health: "/health",
  collector: "/collector",
  settings: "/settings",
};

const ids = FEATURES.map((f) => f.id);
const byId = new Map(FEATURES.map((f) => [f.id, f]));

/** Expand the registry's ownership globs. Only `dir/**` and plain paths are
 *  used on purpose - a richer glob syntax would make the partition check
 *  unfalsifiable. */
function expand(globs) {
  const out = [];
  for (const g of globs) {
    if (g.endsWith("/**")) {
      const dir = path.join(ROOT, g.slice(0, -3));
      assert.ok(fs.existsSync(dir), "owned glob points at a missing directory: " + g);
      const walk = (d) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          const p = path.join(d, e.name);
          if (e.isDirectory()) walk(p);
          else out.push(path.relative(ROOT, p).split(path.sep).join("/"));
        }
      };
      walk(dir);
    } else {
      assert.ok(fs.existsSync(path.join(ROOT, g)), "owned path does not exist: " + g);
      out.push(g);
    }
  }
  return out;
}

test("F105-a: the registry declares the 11 sections, in sidebar order, with the pinned routes", () => {
  assert.equal(REGISTRY.version, 1, "registry version must be pinned");
  assert.equal(FEATURES.length, 11, "there are exactly 11 sections (#163 §1)");
  assert.deepEqual(ids, EXPECTED_ORDER, "registry ids/order drifted from the #163 sidebar list");
  assert.deepEqual(
    [...FEATURES].map((f) => f.order),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
    "order must be 1..11 with no gaps or duplicates",
  );
  for (const f of FEATURES) {
    assert.equal(f.route, EXPECTED_ROUTES[f.id], "route drifted for " + f.id);
    assert.equal(f.navKey, "nav." + f.id, "navKey must reuse the existing nav.* key for " + f.id);
    assert.ok(f.component, "component element name missing for " + f.id);
    assert.ok(Array.isArray(f.owns) && f.owns.length > 0, "owns must not be empty for " + f.id);
  }
});

test("F105-b: the FeatureId union in featureRegistry.ts equals the JSON id set", () => {
  const src = read("src/lib/featureRegistry.ts");
  const m = src.match(/export type FeatureId =([\s\S]*?);/);
  assert.ok(m, "FeatureId union not found in src/lib/featureRegistry.ts");
  const union = [...m[1].matchAll(/"([a-z-]+)"/g)].map((x) => x[1]);
  assert.deepEqual(union.slice().sort(), ids.slice().sort(), "the hand-written union and the JSON disagree");
});

test("F105-c: ownership partitions src/pages exactly - every page file, one owner", () => {
  const owned = new Map();
  for (const f of FEATURES) {
    for (const p of expand(f.owns)) {
      if (!/\.(ts|tsx)$/.test(p)) continue; // fixtures/*.json are data, not surface
      assert.ok(!owned.has(p), p + " is owned by both " + owned.get(p) + " and " + f.id);
      owned.set(p, f.id);
    }
  }
  const unowned = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(e.name)) {
        const rel = path.relative(ROOT, p).split(path.sep).join("/");
        if (!owned.has(rel)) unowned.push(rel);
      }
    }
  };
  walk(path.join(ROOT, "src/pages"));
  assert.deepEqual(unowned, [], "page files with no registry owner (a new page must be registered)");
});

test("F105-d: every declared store hook and endpoint is really in the owning files", () => {
  for (const f of FEATURES) {
    const blob = expand(f.owns)
      .filter((p) => /\.(ts|tsx)$/.test(p))
      .map((p) => read(p))
      .join("\n");
    for (const s of f.stores) {
      assert.ok(blob.includes(s), f.id + ": declares store " + s + " but its files never mention it");
    }
    for (const e of f.endpoints) {
      assert.ok(blob.includes(e), f.id + ": declares endpoint " + e + " but its files never mention it");
      assert.match(e, /^\/api\//, f.id + ": endpoints must be /api/ paths");
    }
  }
});

test("F105-e: no edge without evidence, no evidence without an edge, every citation resolves", () => {
  const edges = new Set();
  for (const f of FEATURES) {
    for (const to of f.dependsOn) edges.add(f.id + "|state|" + to);
    for (const to of f.navigatesTo) edges.add(f.id + "|route|" + to);
  }
  const cited = new Set();
  for (const e of REGISTRY.evidence) {
    const key = e.from + "|" + e.kind + "|" + e.to;
    assert.ok(edges.has(key), "evidence cites an edge that is not in the DAG: " + key);
    assert.ok(!cited.has(key), "duplicate evidence row for " + key);
    cited.add(key);
    assert.ok(fs.existsSync(path.join(ROOT, e.file)), "evidence file missing: " + e.file);
    assert.ok(read(e.file).includes(e.symbol), e.file + " does not contain the cited symbol: " + e.symbol);
  }
  for (const key of edges) {
    assert.ok(cited.has(key), "DAG edge without source evidence: " + key);
  }
  assert.ok(REGISTRY.evidence.length >= 1, "the contract must not be vacuous");
});

test("F105-f: the dependency graph is acyclic and its edges all reference known features", () => {
  const known = new Set(ids);
  for (const f of FEATURES) {
    for (const to of [...f.dependsOn, ...f.navigatesTo]) {
      assert.ok(known.has(to), f.id + " points at an unknown feature: " + to);
      assert.notEqual(to, f.id, f.id + " must not depend on itself");
    }
  }
  // Independent DFS (not the TS helper): a cycle would make F106's warm-up
  // order and F108's replay order undefined.
  const state = new Map(FEATURES.map((f) => [f.id, f.dependsOn.filter((d) => known.has(d))]));
  const seen = new Map();
  const stack = [];
  const visit = (id) => {
    seen.set(id, "gray");
    stack.push(id);
    for (const next of state.get(id) || []) {
      const c = seen.get(next);
      assert.notEqual(c, "gray", "dependency cycle: " + [...stack, next].join(" -> "));
      if (!c) visit(next);
    }
    stack.pop();
    seen.set(id, "black");
  };
  for (const id of ids) if (!seen.get(id)) visit(id);
});

test("F105-g: App.tsx fences every feature - exactly 13 fence() calls, all registered ids", () => {
  const calls = [...APP.matchAll(/fence\(\s*"([a-z-]+)"/g)].map((m) => m[1]);
  assert.equal(calls.length, 13, "expected 11 sections + the Lab sub-route + the catch-all route");
  const known = new Set(ids);
  for (const c of calls) assert.ok(known.has(c), "fence() called with an unregistered feature id: " + c);
  for (const id of ids) {
    assert.ok(calls.includes(id), "feature " + id + " has NO FeatureBoundary in App.tsx");
  }
  // The ladder itself must stay imported: a fence around an unimported page is
  // a rendering bug this gate can see statically.
  assert.ok(APP.includes('from "@/components/primitives/FeatureBoundary"'), "App.tsx must import the boundary");
});

test("F105-h: every registry route exists in App.tsx and every App.tsx page route is registered", () => {
  const paths = [...APP.matchAll(/<Route\s+path="([^"]+)"/g)].map((m) => m[1]);
  const knownPaths = new Set();
  for (const f of FEATURES) {
    const p = f.routeKind === "index" ? null : f.route;
    if (p) {
      assert.ok(paths.includes(p), "registry route missing from App.tsx: " + p);
      knownPaths.add(p);
    }
    if (f.labRoute) {
      assert.ok(paths.includes(f.labRoute), "lab sub-route missing from App.tsx: " + f.labRoute);
      knownPaths.add(f.labRoute);
    }
  }
  for (const p of paths) {
    assert.ok(knownPaths.has(p) || p === "*", "App.tsx renders a page route no feature owns: " + p);
  }
  assert.ok(APP.includes("<Route index element={fence(\"overview\""), "the index route must be the overview fence");
  assert.ok(APP.includes('<Route path="*" element={fence("overview"'), "the catch-all route must be fenced too");
});

test("F105-i: the section labels reuse existing nav.* keys; the new boundary.* keys exist in BOTH catalogs", () => {
  const en = JSON.parse(read("src/i18n/en.json"));
  const si = JSON.parse(read("src/i18n/si.json"));
  const flat = (o, p = "") =>
    Object.entries(o).reduce((acc, [k, v]) => {
      if (v && typeof v === "object") Object.assign(acc, flat(v, p + k + "."));
      else acc[p + k] = String(v);
      return acc;
    }, {});
  const FE = flat(en);
  const FS = flat(si);
  for (const f of FEATURES) {
    assert.ok(f.navKey in FE, f.navKey + " is missing from en.json");
  }
  // The strings the boundary itself renders are THIS step's additions, so they
  // must be complete in both languages (step 2's repo-wide gate owns the rest).
  const used = [...read("src/components/primitives/FeatureBoundary.tsx").matchAll(/t\("(boundary\.[a-zA-Z]+)"/g)].map((m) => m[1]);
  assert.ok(used.length >= 6, "expected the boundary to render at least 6 of its own keys");
  for (const k of used) {
    assert.ok(k in FE, k + " is missing from en.json");
    assert.ok(k in FS, k + " is missing from si.json");
    const ph = (s) => (s.match(/\{\{[a-zA-Z]+\}\}/g) || []).sort().join(",");
    assert.equal(ph(FE[k]), ph(FS[k]), "placeholder mismatch between en and si for " + k);
    assert.ok(FS[k].trim().length > 0, k + " has an empty si value");
  }
});

test("F105-j: no remediated capability is reintroduced, and the crash path has no network/storage", () => {
  const files = [
    "src/components/primitives/FeatureBoundary.tsx",
    "src/lib/featureBoundary.ts",
    "src/lib/featureRegistry.ts",
  ];
  const banned = [
    "fetch(",
    "XMLHttpRequest",
    "sendBeacon",
    "new WebSocket",
    "localStorage",
    "sessionStorage",
    "dangerouslySetInnerHTML",
    // The F-DVR-LITE / #169 class: the write path was removed on purpose
    // (ghrdp-lib.ps1:751,844 neutered; ghrdp-server.ps1:6972 hard-404) and a
    // diagnostic channel is not allowed to be the way it comes back.
    "/api/diag-upload",
    "/api/diag-file",
    "Put-GhFile",
    "Publish-GithubPagesData",
  ];
  for (const rel of files) {
    const src = read(rel);
    for (const b of banned) {
      assert.ok(!src.includes(b), rel + " contains a banned token: " + b);
    }
  }
  for (const f of FEATURES) {
    for (const e of f.endpoints) {
      assert.ok(!/diag-upload|diag-file|f-dvr|upload/i.test(e), "registry declares a remediated endpoint class: " + e);
    }
  }
});

test("F105-k: the fallback test ids sit before F104's blind spot, and the boundary is addressable", () => {
  const src = read("src/components/primitives/FeatureBoundary.tsx");
  // GLOBAL_CLICK_IGNORE deletes collector-/click-now- prefixed test ids from the
  // DVR; a boundary built on those prefixes would be invisible to its own
  // recorder (tests/f-testid-coverage.test.js rule f makes the same point).
  const testIds = [...src.matchAll(/data-testid=\{?"?([a-z0-9-]+)/g)].map((m) => m[1]);
  for (const t of testIds) {
    assert.ok(!t.startsWith("collector-") && !t.startsWith("click-now-"), "boundary test id in the F104 blind spot: " + t);
  }
  const registry = read("src/lib/featureRegistry.ts");
  assert.ok(registry.includes('"feature-boundary-"'), "the boundary test-id prefix must be pinned in the registry");
  assert.ok(registry.includes("registerMountedFeature"), "the mount ledger is how F105 proves 11/11 boundaries are live");
  // The component repeats the prefix so the F-TESTID derivation rule can see it;
  // this is what stops the two copies drifting apart.
  const literal = src.match(/data-testid=\{"([a-z0-9-]+)" \+ feature/);
  assert.ok(literal, "the boundary must build its test ids as a literal prefix + feature id");
  assert.equal(literal[1], "feature-boundary-", "the component's literal prefix drifted from the registry constant");
  const prefixes = [...src.matchAll(/data-testid=\{"([a-z0-9-]+)" \+ feature/g)].map((m) => m[1]);
  assert.ok(prefixes.length >= 4, "expected the card + retry/reload/copy affordances to carry derived test ids");
});
