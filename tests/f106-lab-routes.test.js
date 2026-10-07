// [F106 / Observatory step 5] Feature Lab gate — the static half, plus REAL
// execution of the shipped mock rules.
//
// This file runs inside `node --test tests/*.test.js` (launch-gates' "Native UI
// and VPS contracts (Node)" step), so it needs no workflow edit to be enforced.
//
// WHY IT IS SPLIT THE WAY IT IS. The lab's interceptor patches window.fetch, so
// its behaviour is proven in jsdom (src/tests/smoke/f106-lab-isolation.test.tsx).
// What CAN be proven here - with no DOM at all - is the part that decides whether
// the lab is safe to have at all:
//   1. the routes are the registry's pattern, not a second copy of it;
//   2. the lab owns no section page (the F105 ownership partition stays exact);
//   3. the pure core (src/lib/lab/labCore.js) is EXECUTED: reads may be faked,
//      writes never, ?key= can never reach a ledger or a report, the ledger is
//      deterministic and bounded;
//   4. the interceptor can only be installed from the lab, and it restores the
//      exact function it replaced;
//   5. the lab names no endpoint, adds no route, and touches no storage - so the
//      #168/#169 remediated class cannot come back through a debugging tool;
//   6. the locked 11-entry sidebar contract is untouched.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n?/g, "\n");

const REGISTRY = JSON.parse(read("src/lib/feature-registry.json"));
const APP = read("src/App.tsx");
const LAB_ROUTE = read("src/components/lab/LabRoute.tsx");
const SECTIONS = read("src/components/lab/labSections.tsx");
const CORE_JS = read("src/lib/lab/labCore.js");
const MOCK_TS = read("src/lib/lab/mockBackend.ts");
const FLAGS = read("src/lib/lab/labFlags.ts");
const SHELL = read("src/components/layout/AppShell.tsx");
const MAIN = read("src/main.tsx");
const FEATURES = REGISTRY.features;
const IDS = FEATURES.map((f) => f.id);

/** The lab's own source, one list for the sweep rules below. */
const LAB_FILES = [
  "src/lib/lab/labCore.js",
  "src/lib/lab/labCore.d.ts",
  "src/lib/lab/labStore.ts",
  "src/lib/lab/mockBackend.ts",
  "src/lib/lab/labFlags.ts",
  "src/components/lab/labSections.tsx",
  "src/components/lab/LabRoute.tsx",
  "src/components/lab/FeatureLab.tsx",
  "src/components/lab/LabIndex.tsx",
  "src/components/lab/LabControls.tsx",
];

/** The shipped core, imported the way the DVR gate does it (plain-JS ESM). */
let corePromise = null;
function core() {
  if (!corePromise) corePromise = import(path.join(ROOT, "src/lib/lab/labCore.js"));
  return corePromise;
}

/** Every file under a directory, repo-relative, posix separators. */
function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = dir + "/" + e.name;
    if (e.isDirectory()) out.push(...walk(rel));
    else out.push(rel);
  }
  return out.sort();
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

test("F106-a: the lab routes are the F105 pattern, and no lab path collides with a section route", () => {
  const pattern = REGISTRY.labRoutePattern;
  assert.equal(pattern, "/lab/:featureId", "the registry's lab pattern is the F106 contract");
  assert.ok(APP.includes('<Route path="' + pattern + '"'), "App.tsx must register the registry's lab pattern verbatim");
  assert.ok(APP.includes('<Route path="/lab"'), "App.tsx must register the lab INDEX route");
  assert.ok(APP.includes('import LabRoute from "@/components/lab/LabRoute";'), "the lab route element is LabRoute");
  // The index path is derived from the pattern, never written twice.
  assert.ok(FLAGS.includes("labIndexPath(FEATURE_REGISTRY.labRoutePattern)"), "the index path must be derived from the registry pattern");
  // A lab path must not shadow a real section route.
  const realRoutes = new Set(FEATURES.filter((f) => f.routeKind !== "index").map((f) => f.route));
  for (const id of IDS) {
    const labPath = "/lab/" + id;
    assert.ok(!realRoutes.has(labPath), "lab path collides with a registered section route: " + labPath);
    assert.ok(!realRoutes.has(APP.match(new RegExp('path="' + labPath + '"')) ? labPath : "/never"), "unreachable");
  }
  // The 11 section routes are still present, byte-identical to the F105 form.
  for (const f of FEATURES) {
    const literal =
      f.routeKind === "index"
        ? '<Route index element={fence("' + f.id + '", <' + f.component + " />)} />"
        : '<Route path="' + f.route + '" element={fence("' + f.id + '", <' + f.component + " />)} />";
    assert.ok(APP.includes(literal), "the F105 route literal changed (NON-REGRESS): " + literal);
  }
});

test("F106-b: the lab owns no section page - the F105 ownership partition stays exact", () => {
  const pageFiles = walk("src/pages");
  assert.ok(!pageFiles.some((p) => /^src\/pages\/lab\//.test(p)), "the lab must not live under src/pages (that partition is the registry's)");
  assert.ok(!pageFiles.some((p) => /lab/i.test(path.basename(p)) && !p.startsWith("src/pages/search/")), "unexpected lab page under src/pages: " + pageFiles.filter((p) => /lab/i.test(p)).join(","));
  // The section map covers EXACTLY the registry ids, and imports the registry's component names.
  for (const id of IDS) assert.ok(SECTIONS.includes(id + ":"), "labSections.tsx is missing a section for " + id);
  for (const f of FEATURES) {
    assert.ok(SECTIONS.includes("import " + f.component + " from"), "labSections.tsx must import the shipped " + f.component);
  }
  const mapped = [...SECTIONS.matchAll(/^\s{2}([a-z]+):/gm)].map((m) => m[1]);
  assert.deepEqual(mapped.sort(), IDS.slice().sort(), "the section map must be exactly the registry's 11 ids");
});

test("F106-c: the pure core is executed - reads may be faked, writes never, ?key= never survives", async () => {
  const C = await core();
  // (1) path normalisation is the token defence: origin, query and hash all go.
  assert.equal(C.normalizeRequestPath("http://host:7331/api/config?key=SECRET123"), "/api/config");
  assert.equal(C.normalizeRequestPath("/api/collector/run?key=SECRET123"), "/api/collector/run");
  assert.equal(C.normalizeRequestPath("/api/x#/files"), "/api/x");
  assert.equal(C.normalizeRequestPath(""), "/");
  assert.equal(C.normalizeRequestPath("api/relative"), "/api/relative");
  assert.equal(C.normalizeRequestPath(undefined), "/");
  // (2) method rules
  assert.equal(C.normalizeMethod(undefined), "GET");
  assert.equal(C.normalizeMethod("post"), "POST");
  assert.equal(C.isMockableMethod("GET"), true);
  assert.equal(C.isMockableMethod("HEAD"), true);
  for (const m of ["POST", "PUT", "PATCH", "DELETE"]) assert.equal(C.isMockableMethod(m), false, m + " must never be mockable");
  // (3) resolveMock: passthrough by default, and ALWAYS for a write.
  const empty = C.resolveMock({}, "GET", "/api/config");
  assert.equal(empty.kind, "passthrough");
  assert.equal(empty.reason, "scenario");
  const write = C.resolveMock({ "/api/collector/run": "empty200" }, "POST", "/api/collector/run");
  assert.equal(write.kind, "passthrough", "a forced scenario must never fabricate a write");
  assert.equal(write.reason, "method");
  // (4) the three forcings
  const e200 = C.resolveMock({ "/api/config": "empty200" }, "GET", "/api/config?key=SECRET");
  assert.equal(e200.kind, "response");
  assert.equal(e200.status, 200);
  assert.equal(e200.path, "/api/config");
  const e500 = C.resolveMock({ "/api/config": "error500" }, "GET", "/api/config");
  assert.equal(e500.kind, "response");
  assert.equal(e500.status, 500);
  const off = C.resolveMock({ "/api/config": "offline" }, "GET", "/api/config");
  assert.equal(off.kind, "network-error");
  // an unknown scenario value is not a licence to fake anything
  assert.equal(C.resolveMock({ "/api/config": "wat" }, "GET", "/api/config").kind, "passthrough");
  // (5) no decision may carry the token into a key-shaped field
  assert.ok(!JSON.stringify(e200).includes("SECRET"), "the query string (and any dash token in it) must not survive normalisation");
  // (6) the ledger: dedupe by method+path, bounded, deterministic
  const ledger = C.createLedger(3);
  ledger.record({ method: "GET", path: "/api/a", kind: "passthrough", scenario: "passthrough" });
  ledger.record({ method: "GET", path: "/api/a", kind: "passthrough", scenario: "passthrough" });
  ledger.record({ method: "POST", path: "/api/a", kind: "passthrough", scenario: "passthrough" });
  assert.equal(ledger.size(), 2, "same path, different method = two rows");
  assert.equal(ledger.list()[0].count, 2, "the repeated GET is one row with count 2");
  ledger.record({ method: "GET", path: "/api/b", kind: "response", scenario: "error500" });
  ledger.record({ method: "GET", path: "/api/c", kind: "response", scenario: "empty200" });
  assert.equal(ledger.size(), 3, "the ledger is capped");
  assert.deepEqual(ledger.list().map((r) => r.path), ["/api/a", "/api/b", "/api/c"], "eviction drops the OLDEST first");
  assert.equal(ledger.list()[1].scenario, "error500");
  assert.equal(ledger.clear(), 3);
  assert.equal(ledger.size(), 0);
  // (7) mergeLedgerRow is pure and follows the same rules
  const before = [{ method: "GET", path: "/api/a", kind: "passthrough", scenario: "passthrough", count: 1, firstSeq: 1, lastSeq: 1 }];
  const after = C.mergeLedgerRow(before, { method: "get", path: "/api/a?key=X", kind: "response", scenario: "error500" }, 10);
  assert.equal(before[0].count, 1, "mergeLedgerRow must not mutate its input");
  assert.equal(after[0].count, 2);
  assert.equal(after[0].scenario, "error500");
  assert.equal(after[0].path, "/api/a", "the merged key is normalised (a token cannot enter the ledger)");
  // (8) summary + report. The row remembers its LAST outcome, so after the merge
  // above both of its requests count as "on a row whose latest outcome was a mock"
  // - the field is named for that rule, not for a per-request tally the row cannot
  // support (a silently mislabelled number is worse than a longer name).
  assert.deepEqual(C.ledgerSummary(after), { paths: 1, requests: 2, mockedLastSeen: 2 });
  assert.deepEqual(C.ledgerSummary([]), { paths: 0, requests: 0, mockedLastSeen: 0 });
  const report = C.labReport({ ts: "T", feature: "files", route: "/lab/files?key=SECRET", enabled: true, scenarios: { "/api/config": "error500" }, ledger: after, mounted: ["files"] });
  const text = JSON.stringify(report);
  assert.ok(!text.includes("SECRET"), "the copied report must never carry the dash token");
  assert.equal(report.format, "mclab");
  assert.equal(report.feature, "files");
  assert.deepEqual(report.mounted, ["files"]);
  // (9) derivations the UI keys off
  assert.equal(C.labIndexPath("/lab/:featureId"), "/lab");
  assert.equal(C.pathSlug("/api/collector/run"), "api-collector-run");
  assert.equal(C.pathSlug("/"), "root");
});

test("F106-d: the interceptor is scoped to the lab, labelled, reference-counted and restored", () => {
  // installed from the lab page, never from the app entry
  assert.ok(read("src/components/lab/FeatureLab.tsx").includes("installLabFetchMock()"), "the lab page installs the mock");
  // Match IMPORT statements, not the word: the core and the store both NAME
  // mockBackend in explanatory comments, and a comment is not a dependency.
  const importers = walk("src")
    // test doubles are not UI surface (the F-TESTID scanner excludes src/tests for
    // the same reason): src/tests/smoke/f106-lab-isolation.test.tsx imports the
    // interceptor on purpose, to prove the lifetime and restoration rules.
    .filter((f) => !f.startsWith("src/tests/"))
    .filter((f) => /\.tsx?$/.test(f))
    .filter((f) => /import[^;]*from "(@\/lib\/lab\/mockBackend|\.\/mockBackend)"/.test(read(f)));
  assert.deepEqual(importers, ["src/components/lab/FeatureLab.tsx"], "exactly ONE shipped file may import the interceptor (the lab page), found: " + importers.join(", "));
  // Precise: main.tsx must not IMPORT or install anything from the lab. A bare
  // /lab/ substring would match the word "Killable" in main.tsx's own comments -
  // a false positive that would have to be silenced by weakening the rule.
  assert.ok(!/from "@\/lib\/lab\/|from "@\/components\/lab\/|installLabFetchMock|mockBackend/.test(MAIN), "main.tsx must not know the lab exists (the dashboard runs stock fetch)");
  assert.ok(!/installLabFetchMock/.test(APP), "App.tsx must not install the interceptor - the lab page owns its lifetime");
  // captures the original, refcounts, and restores only its own wrapper
  assert.ok(MOCK_TS.includes("const before = window.fetch;"), "the original fetch must be captured before patching");
  assert.ok(MOCK_TS.includes("window.fetch = originalFetch"), "uninstall must put the original back");
  assert.ok(MOCK_TS.includes("window.fetch === patchedFetch"), "uninstall must never clobber a later patch or a test stub");
  assert.ok(/installs \+= 1/.test(MOCK_TS) && /installs = Math\.max\(0, installs - 1\)/.test(MOCK_TS), "the install must be reference-counted (React StrictMode double-effects)");
  // ...and the PATCH must happen exactly once, on the 0 -> 1 transition. Without
  // this literal, `if (installs >= 1)` would re-wrap our own wrapper on every
  // install: two layers of recording, one ledger row per layer. Found by
  // falsification M8 - the mutation was invisible to the count assertions above.
  assert.ok(MOCK_TS.includes("if (installs === 1) {"), "the patch must be applied on the 0 -> 1 transition only");
  assert.ok(MOCK_TS.includes("patchedFetch = wrapper"), "the wrapper must be kept for the restore guard");
  // every mocked answer is labelled
  assert.ok(MOCK_TS.includes("LAB_MOCK_HEADER"), "a mocked response must carry the label header");
  assert.ok(MOCK_TS.includes("headers"), "the response shape must expose headers to the caller");
});

/**
 * Strip // and /* *\/ comments, quote-aware, so the API-token scan reads CODE.
 * A regex literal containing "//" (labCore has one, in the absolute-URL test) is
 * not a comment, and a banned token inside a quote is a string the code really
 * has - both must survive the strip, which is why this is a character scanner and
 * not a line grep. The sanity assertion below is the vacuity guard: a stripper
 * that ate the file would make every "must not contain" check pass.
 */
function stripComments(src) {
  let out = "";
  let quote = "";
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (quote) {
      out += c;
      if (c === "\\") { out += n || ""; i += 2; continue; }
      if (c === quote) quote = "";
      i += 1;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { quote = c; out += c; i += 1; continue; }
    if (c === "/" && n === "/") { while (i < src.length && src[i] !== "\n") i += 1; continue; }
    if (c === "/" && n === "*") { i += 2; while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i += 1; i += 2; continue; }
    out += c;
    i += 1;
  }
  return out;
}

test("F106-e: no endpoint, no storage, no network in the core - the #168/#169 class stays out", () => {
  // The core is pure: it cannot call anything. Comments are stripped first, so a
  // line like "touches window.fetch" in the header is not a false positive - and
  // the stripper is sanity-checked so this rule cannot pass vacuously.
  const CODE = stripComments(CORE_JS);
  assert.ok(CODE.includes("export function resolveMock"), "the comment stripper ate the core - the scan below would be vacuous");
  for (const banned of ["fetch(", "XMLHttpRequest", "sendBeacon", "new WebSocket", "localStorage", "sessionStorage", "dangerouslySetInnerHTML", "document.", "window.", "Date.now", "new Date", "Math.random", "setTimeout", "setInterval", "require(", "process.", "[F106"]) {
    assert.ok(!CODE.includes(banned), "src/lib/lab/labCore.js must not contain (in code): " + banned);
  }
  // No lab file names an endpoint IN CODE: the lab reacts to observed paths only,
  // so it cannot become a second, drifting inventory of the API (F105 owns
  // endpoints). Comments are stripped - the core's examples ("/api/config?key=")
  // are documentation of the normaliser, not a route this code can call.
  for (const rel of LAB_FILES) {
    if (!fs.existsSync(path.join(ROOT, rel))) continue;
    const body = read(rel);
    const code = stripComments(body);
    assert.ok(!/["'`]\/api\//.test(code), rel + " names an endpoint literal in code - the lab must only observe paths");
    for (const banned of ["/api/diag-upload", "/api/diag-file", "Put-GhFile", "Publish-GithubPagesData", "sendBeacon", "XMLHttpRequest", "dangerouslySetInnerHTML"]) {
      assert.ok(!code.includes(banned), rel + " contains a remediated/banned token in code: " + banned);
    }
  }
  // The interceptor is the only file allowed to touch window.fetch, and only to
  // wrap it: in CODE it must never call a bare `fetch(...)` - every passthrough
  // goes through the captured, bound original (`bound(input, init)`), which is what
  // makes "restore the exact function" possible.
  const MOCK_CODE = stripComments(MOCK_TS);
  assert.ok(MOCK_CODE.includes("installLabFetchMock"), "the comment stripper ate mockBackend - the scan below would be vacuous");
  const bareFetchCalls = [...MOCK_CODE.matchAll(/[^.\w]fetch\(/g)].length;
  assert.equal(bareFetchCalls, 0, "mockBackend must call the captured original, never the global fetch by name");
  assert.ok(/\bbound\(input, init\)/.test(MOCK_CODE), "passthrough must go through the captured bound original");
  // No storage anywhere in the lab: a scenario must not outlive the tab.
  for (const rel of LAB_FILES) {
    if (!fs.existsSync(path.join(ROOT, rel))) continue;
    const code = stripComments(read(rel));
    assert.ok(!/localStorage|sessionStorage/.test(code), rel + " must not persist lab state in code");
  }
});

test("F106-f: every lab control is addressable, and none lands in F104's blind spot", () => {
  for (const rel of LAB_FILES.filter((f) => f.endsWith(".tsx"))) {
    const body = read(rel);
    const tags = [...body.matchAll(/<(Button|button|CopyButton|IconButton|Toggle)\b[\s\S]*?>/g)].map((m) => m[0]);
    for (const tag of tags) {
      assert.ok(/data-testid=/.test(tag), rel + " has an unaddressable control: " + tag.replace(/\s+/g, " ").slice(0, 80));
    }
    for (const m of body.matchAll(/data-testid=\{"([a-z0-9-]+)"\s*\+/g)) {
      assert.ok(!/^(collector-|click-now-)/.test(m[1]), rel + " derives a test id into F104's capture blind spot: " + m[1]);
    }
    for (const m of body.matchAll(/data-testid="([^"]*)"/g)) {
      assert.ok(/^[a-z0-9][a-z0-9]*(-[a-z0-9]+)*$/.test(m[1]), rel + " has a non-kebab-case literal test id: " + m[1]);
    }
  }
  // The scenario buttons derive their id from the path slug, so each observed path
  // gets its own addressable set (and the slug is core-tested in F106-c).
  const controls = read("src/components/lab/LabControls.tsx");
  assert.ok(controls.includes('data-testid={"lab-scenario-" + pathSlug(row.path) + "-" + id}'), "scenario buttons must derive a id per path+scenario");
});

test("F106-g: every featureLab.* string exists in BOTH catalogs with matching placeholders", () => {
  const en = JSON.parse(read("src/i18n/en.json"));
  const si = JSON.parse(read("src/i18n/si.json"));
  const flat = (o, p = "") =>
    Object.entries(o).reduce((acc, [k, v]) => Object.assign(acc, v && typeof v === "object" ? flat(v, p + k + ".") : { [p + k]: v }), {});
  const FE = flat(en);
  const FS = flat(si);
  const labKeys = Object.keys(FE).filter((k) => k.startsWith("featureLab."));
  assert.ok(labKeys.length >= 20, "expected the lab's own key namespace, found " + labKeys.length + " keys");
  assert.deepEqual(labKeys, Object.keys(FS).filter((k) => k.startsWith("featureLab.")), "the lab namespace must be identical in en and si");
  const ph = (s) => (String(s).match(/\{\{\s*\w+\s*\}\}/g) || []).sort().join(",");
  for (const k of labKeys) {
    assert.ok(String(FS[k]).trim().length > 0, "empty si translation for " + k);
    assert.equal(ph(FE[k]), ph(FS[k]), "placeholder mismatch for " + k);
  }
  // Every key the lab source asks for must exist - including the dynamic prefix.
  const used = new Set();
  for (const rel of LAB_FILES) {
    if (!fs.existsSync(path.join(ROOT, rel))) continue;
    for (const m of read(rel).matchAll(/\bt\(\s*"(featureLab\.[A-Za-z.]+)"/g)) used.add(m[1]);
  }
  assert.ok(used.size >= 15, "the lab should render its own strings, found " + used.size);
  for (const k of used) {
    if (k.endsWith(".")) {
      assert.ok(labKeys.some((x) => x.startsWith(k)), "t(\"" + k + "\" + x) resolves to no key");
    } else {
      assert.ok(k in FE, "the lab calls t(\"" + k + "\") but en.json has no such key");
      assert.ok(k in FS, "the lab calls t(\"" + k + "\") but si.json has no such key");
    }
  }
});

test("F106-h: the locked 11-entry sidebar contract is untouched, and the Labs entry is gated", () => {
  // The NAV array keeps exactly its 11 hrefs - the lab adds none of them.
  const nav = SHELL.split("const NAV: NavItem[]")[1].split("];")[0];
  const tos = [...nav.matchAll(/to:\s*"([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(tos, ["/", "/search", "/sessions", "/connections", "/keys", "/files", "/mirror", "/telemetry", "/health", "/collector", "/settings"], "the sidebar order is a locked contract (F56-c)");
  assert.ok(!/to:\s*"[^"]*lab/.test(nav), "no lab route may live inside the locked NAV array");
  assert.ok(!/labIndexRoute|featureLabPath/.test(nav), "the locked NAV array must not call the lab path helpers");
  // It is rendered OUTSIDE <nav> (so every `nav a` selector keeps its 11 links)...
  const afterNav = SHELL.split("</nav>")[1] || "";
  assert.ok(SHELL.includes('data-testid="lab-nav-entry"'), "the lab entry exists");
  assert.ok(afterNav.includes('data-testid="lab-nav-entry"'), "the lab entry must render after </nav>, never inside it");
  assert.ok(!SHELL.split("</nav>")[0].includes('data-testid="lab-nav-entry"'), "the lab entry must not be inside <nav>");
  // ...and gated by the flag module (default: only while on a lab route).
  assert.ok(SHELL.includes("labEntryVisible()"), "the sidebar must ask the flag module");
  assert.ok(FLAGS.includes('import.meta.env.VITE_F106_LABS'), "the build flag must be the documented one");
  assert.ok(/isLabRouteHash/.test(FLAGS), "the lab route itself must make the way back visible");
  assert.ok(!/localStorage|sessionStorage/.test(FLAGS), "the gate must not persist anything");
});

test("F106-i: the lab route is fenced with the id that was asked for", () => {
  // A parameterised route cannot use App.tsx's literal fence() helper (the F105
  // gate counts those), so the boundary is built from the value - which is the
  // point: /#/lab/health must degrade into the HEALTH card, not a generic one.
  assert.ok(LAB_ROUTE.includes("<FeatureBoundary feature={"), "LabRoute must wrap the lab page in a FeatureBoundary");
  assert.ok(/FEATURE_IDS\.includes\(/.test(LAB_ROUTE), "an unregistered id must be handled explicitly");
  assert.ok(LAB_ROUTE.includes('data-testid="feature-lab-unknown"'), "an unknown feature must render a notice, not a crash");
  assert.ok(LAB_ROUTE.includes("<LabIndex />"), "the index route (no parameter) must render the index");
  // The two lab routes are exactly these lines: no fence() literal (which is
  // counted by F105-g) and no page component mounted outside LabRoute's boundary.
  assert.ok(APP.includes('<Route path="/lab" element={<LabRoute />} />'), "the lab index route must render LabRoute unwrapped");
  assert.ok(APP.includes('<Route path="/lab/:featureId" element={<LabRoute />} />'), "the lab param route must render LabRoute unwrapped");
  // The gate itself is addressable for the DOM suite.
  assert.ok(read("src/components/lab/FeatureLab.tsx").includes('data-testid={"feature-lab-" + feature}'), "the lab page must be addressable per feature");
});
