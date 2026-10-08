// [M2 / maintenance step 2] Chrome unfencing — the Node gate.
//
// Auto-run by launch-gates.yml's `node --test tests/*.test.js` (no workflow edit).
// It EXECUTES the shipped pure core (src/lib/chromeBoundaryCore.js) and pins the
// wiring jsdom only sees indirectly. The DOM half is
// src/tests/smoke/m2-chrome-unfencing.test.tsx.
//
// WHAT IT IS DEFENDING. F105 (step 4) fenced the 11 SECTION routes and recorded
// the chrome as handoff #1. M2 fences the chrome. The failure modes this gate has
// to catch are therefore all of the "fence that does not fence" class:
//   1. a surface in the table that nothing mounts through a fence (a claim with
//      no code behind it);
//   2. a chrome mount in the shipped files that is NOT in the table (the gap
//      reopening quietly — the derived-inventory discipline of F111);
//   3. a chrome fence that registers in the F105 mount ledger (it would make the
//      Debug HUD's Features panel report sections that are not mounted);
//   4. a chrome fence that renders a node of its own (it would move the zero-DOM-
//      delta guarantee F105 proved, and every layout/regression-id pin with it);
//   5. a chrome failure that is silent, or filed as a broken SECTION;
//   6. a section fence quietly converted into a chrome fence (F105-g counts
//      exactly 13 `fence("...")` calls — pinned here too, from this side).
//
// FALSIFY-3 — 13 mutations, 13 caught, 0 missed (each applied, both gates run,
// restored byte-identically; `git status` clean afterwards). The rule that caught
// it is named; the DOM gate catching one too is how the wiring and the behaviour
// are proved to be two independent claims:
//   M1  drop the toasts row from the JS table                    -> M2-a + DOM
//   M2  add a 11th member to the .d.ts union only                -> M2-a + DOM
//   M3  unfence `{chrome("toasts", <Toasts />)}` in App.tsx      -> M2-b (DOM: by design
//       not - the MOUNT WIRING is this gate's claim; the DOM suite owns behaviour.
//       The two App-level tests do cover wiring for the two surfaces they crash)
//   M4  add a NEW chrome element after </Routes> unfenced        -> M2-b (block is fenced-only)
//   M5  make ChromeBoundary register in the F105 ledger          -> M2-c + DOM (ledger test)
//   M6  make ChromeBoundary paint a wrapper div when healthy     -> M2-c + DOM (byte-equal)
//   M7  drop `kind: CHROME_BOUNDARY_KIND` from the emitter       -> M2-d + DOM
//   M8  make boundaryCollectorRow ignore the chrome kind         -> M2-d + DOM
//   M9  turn a SECTION fence into a chrome() call                -> M2-e
//   M10 remove the command-palette fence inside AppShell         -> M2-b
//   M11 retry forever (unbounded budget)                         -> M2-a (policy pair) + DOM
//   M12 never publish the chrome failure (silent null)           -> M2-c + DOM
//   M13 file a chrome crash under the SECTION source tag         -> M2-a + M2-d + DOM
// §GATE-SELF-TEST — TWO defects in THIS gate, found by falsifying rather than by
// green, both fixed the same session:
//   (a) M12 initially PASSED: the rule was `includes("emitChromeBoundaryError")`,
//       which a leftover IMPORT satisfies while the fence reports nothing. The
//       rule now pins the CALL (regex on `emitChromeBoundaryError({`) inside the
//       componentDidCatch body - the §GATE-COMMENT-STRIPPING class of bug, one
//       level up: pin the use, not the name.
//   (b) the first driver's M5 mutation silently did not apply (its target string
//       did not exist), so that row was vacuous; the target is now asserted
//       (`assert old in s`) and the row re-run.
// VACUITY probes: the stripper is self-tested on a synthetic fixture (it keeps
// code, drops a trailing comment, and does not eat a URL's `//` inside a string);
// every scan asserts it SAW the thing it scans for (13 `fence(` calls, N table
// rows, N `chrome(` calls, a non-empty set of `{}` comment placeholders) so a
// scan that reads nothing fails instead of passing.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n?/g, "\n");
const importCore = () => import(path.join(ROOT, "src/lib/chromeBoundaryCore.js"));

const APP = "src/App.tsx";
const SHELL = "src/components/layout/AppShell.tsx";
const BOUNDARY = "src/components/primitives/ChromeBoundary.tsx";
const CHANNEL = "src/lib/featureBoundary.ts";
const CORE = "src/lib/chromeBoundaryCore.js";
const CORE_DTS = "src/lib/chromeBoundaryCore.d.ts";

/** Strip // and /* *\/ comments (string-aware) so prose can never satisfy a code
 *  pin. Copied from tests/f109-debug-hud.test.js's implementation, and
 *  self-tested in the first test below (the M5 lesson: a stripper is a scanner
 *  too, and a broken one silently changes what every rule after it means). */
function stripComments(src) {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '"' || c === "'" || c === "`") {
      const q = c;
      out += c;
      i++;
      while (i < src.length) {
        if (src[i] === "\\") {
          out += src[i] + (src[i + 1] || "");
          i += 2;
          continue;
        }
        out += src[i];
        if (src[i] === q) {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** The lines of the region strictly between two markers (exclusive). */
function between(src, startMarker, endMarker) {
  const a = src.indexOf(startMarker);
  const b = src.indexOf(endMarker, a + 1);
  assert.ok(a >= 0, "missing marker: " + startMarker);
  assert.ok(b > a, "missing marker after " + startMarker + ": " + endMarker);
  return src.slice(a + startMarker.length, b);
}

test("M2-V: the comment stripper is not vacuous (keeps code, drops prose, survives a string with //)", () => {
  const fixture = 'const a = 1; // trailing prose\nconst url = "https://x//y";\n/* block prose */ const b = 2;';
  const code = stripComments(fixture);
  assert.ok(code.includes("const a = 1;"), "the stripper ate real code");
  assert.ok(!code.includes("trailing prose"), "a trailing // comment survived the stripper");
  assert.ok(!code.includes("block prose"), "a block comment survived the stripper");
  assert.ok(code.includes('"https://x//y"'), "the stripper ate a string containing //");
  assert.ok(code.includes("const b = 2;"), "the stripper ate the code after a block comment");
  // and the stripper really is doing something on the file it will scan
  const raw = read(APP);
  const stripped = stripComments(raw);
  assert.ok(stripped.length > 200 && stripped.length < raw.length, "App.tsx: expected code kept and prose dropped");
});

test("M2-a: the surface table is the single closed list, with a loss statement per surface", async () => {
  const core = await importCore();
  const ids = core.CHROME_SURFACE_IDS;
  assert.equal(ids.length, 10, "the closed set is 10 surfaces: F105's 6 handoff surfaces + DvrFab + CommandPalette + the two chrome mounts added after the tracker (LogonGateBanner F93, DebugHUD F109)");
  assert.equal(new Set(ids).size, ids.length, "duplicate surface id");
  // The literal pin: a surface cannot be quietly dropped from the table, because
  // dropping the ROW is the way the fence disappears without a diff in App.tsx.
  assert.deepEqual([...ids].sort(), [
    "collector-bridge",
    "command-palette",
    "dash-token-gate",
    "debug-hud",
    "diag-drawer",
    "dvr-fab",
    "logon-banner",
    "shell",
    "toasts",
    "version-gate",
  ]);
  for (const s of core.CHROME_SURFACES) {
    assert.equal(typeof s.mount, "string", s.id + ": no mount expression");
    assert.ok(s.mount.startsWith("<") && s.mount.endsWith("/>"), s.id + ": mount must be a self-closing JSX literal, got " + s.mount);
    assert.ok(fs.existsSync(path.join(ROOT, s.file)), s.id + ": mount file does not exist: " + s.file);
    assert.ok(typeof s.lost === "string" && s.lost.trim().length >= 20, s.id + ": `lost` must state what the operator stops seeing (>= 20 chars)");
  }
  // The typed union is the second artefact; it must be byte-equal as a SET (the
  // F105 pattern: "a 12th section cannot be added to one artefact without the
  // other").
  const dts = read(CORE_DTS);
  const union = between(dts, "export type ChromeSurfaceId =", ";");
  const members = [...union.matchAll(/"([a-z-]+)"/g)].map((m) => m[1]);
  assert.equal(members.length, ids.length, "the .d.ts union has a different arity than the JS table: " + members.join(","));
  assert.deepEqual([...members].sort(), [...ids].sort(), ".d.ts union and JS table disagree");
  // The subject prefix is shared, not re-typed per module.
  assert.equal(core.CHROME_SUBJECT_PREFIX, "chrome:");
  assert.equal(core.chromeSubject("toasts"), "chrome:toasts");
  assert.equal(core.isChromeSurfaceId("toasts"), true);
  assert.equal(core.isChromeSurfaceId("nope"), false);
  assert.equal(core.chromeSurfaceById("nope"), null, "an unknown surface must answer null, never throw");
});

test("M2-b: every surface is fenced at its shipped mount, and nothing chrome is mounted unfenced", async () => {
  const core = await importCore();
  const appRaw = read(APP);
  const shellRaw = read(SHELL);
  const app = stripComments(appRaw);
  const shell = stripComments(shellRaw);
  const rowsFor = (f) => core.CHROME_SURFACES.filter((s) => s.file === f);
  const appRows = rowsFor(APP);
  const shellRows = rowsFor(SHELL);
  // Exactly ONE App.tsx surface is mounted as the route ELEMENT (the shell), the
  // rest sit in the chrome block after </Routes>. Derived, not assumed: a second
  // route-element surface would have to be classified before this gate passes.
  const routeRows = appRows.filter((s) => s.id === "shell");
  assert.equal(routeRows.length, 1, "expected exactly one App.tsx surface mounted as the route element (the shell)");
  const blockRows = appRows.filter((s) => s.id !== "shell");

  // The mount expression was NOT rewritten: it appears verbatim, exactly once,
  // in its file — so the surface's own ids/props/order are untouched by M2.
  for (const s of core.CHROME_SURFACES) {
    const src = s.file === APP ? app : shell;
    const n = src.split(s.mount).length - 1;
    assert.equal(n, 1, s.id + ": expected exactly one " + s.mount + " in " + s.file + ", found " + n);
  }
  // App.tsx surfaces go through the `chrome(...)` helper; the shell's two go
  // through the component directly (they are inside the shell's own fence).
  for (const s of appRows) {
    assert.ok(app.includes('chrome("' + s.id + '", ' + s.mount + ")"), s.id + ": not mounted through chrome(<surface>, <mount>) in App.tsx");
  }
  for (const s of shellRows) {
    const open = '<ChromeBoundary surface="' + s.id + '">';
    const at = shell.indexOf(open);
    assert.ok(at >= 0, s.id + ": no " + open + " in AppShell.tsx");
    const close = shell.indexOf("</ChromeBoundary>", at);
    const inner = shell.slice(at + open.length, close);
    assert.ok(inner.includes(s.mount), s.id + ": " + s.mount + " is not inside its own ChromeBoundary");
  }
  // THE DERIVED HALF: the whole region between </Routes> and </HashRouter> must
  // be fenced mounts and nothing else. A new overlay added there without a fence
  // fails here — which is the gap reopening, the thing M2 exists to close.
  const block = between(app, "</Routes>", "</HashRouter>");
  // Careful with the JSX comments: stripComments removes the prose but leaves the
  // braces that held it (`{}`), and that placeholder is the ONLY statement shape
  // this block is allowed to contain besides a fenced mount - so a comment can
  // never stand in for a fence, and a fence can never hide inside one.
  const lines = block
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const statements = lines.filter((l) => l !== "{}");
  const placeholders = lines.filter((l) => l === "{}");
  assert.ok(placeholders.length > 0, "expected the block's JSX comments to leave {} placeholders - if this is 0 the stripper changed behaviour");
  assert.equal(statements.length, blockRows.length, "the chrome block should hold exactly one statement per block surface, got " + statements.length);
  for (const st of statements) {
    assert.match(st, /^\{chrome\("[a-z-]+", <[A-Za-z0-9]+ \/>\)\},?$/, "unfenced (or oddly fenced) chrome mount in the block: " + st);
  }
  // and the mounts in that block are exactly the table's App.tsx rows
  const mounted = statements.map((st) => st.match(/^\{chrome\("([a-z-]+)",/) [1]);
  assert.deepEqual(mounted, blockRows.map((s) => s.id), "the chrome block's order/content drifted from the table");
  // The shell region: every component-level element it renders is either a
  // pinned layout part or one of the two fenced chrome mounts.
  const shellFn = shell.slice(shell.indexOf("export function AppShell()"));
  const elems = new Set([...shellFn.matchAll(/<([A-Z][A-Za-z0-9]*)[\s/>]/g)].map((m) => m[1]));
  assert.deepEqual([...elems].sort(), ["BottomBar", "ChromeBoundary", "CommandPalette", "LogonGateBanner", "Main", "Sidebar", "TopBar"], "AppShell renders an element M2 has not classified (fence it, or extend the table and this pin)");
  // The shell itself is fenced as a route element (it is not in the chrome block).
  assert.ok(app.includes('element={chrome("shell", <AppShell />)}'), "the shell must be fenced as the route element - it is the outermost chrome fence");
  // SessionListModal is fenced TRANSITIVELY: from the FAB it renders inside
  // DvrFab's tree, and from the Collector page inside that page's FeatureBoundary.
  const fab = read("src/components/domain/DvrFab.tsx");
  assert.ok(fab.includes('import { SessionListModal }') && fab.includes("<SessionListModal "), "the FAB path must still render the modal inside the fenced tree");
  // Positive control: the fence count in each file equals the table's rows for it.
  assert.equal((app.match(/chrome\(/g) || []).length, appRows.length + 1, "App.tsx: chrome() call count (surfaces + the helper's own definition) drifted");
  assert.equal((shell.match(/<ChromeBoundary/g) || []).length, shellRows.length, "AppShell.tsx: ChromeBoundary count drifted from the table");
});

test("M2-c: the fence nulls, never paints, never registers as a section, and always reports", async () => {
  const core = await importCore();
  const raw = read(BOUNDARY);
  const code = stripComments(raw);
  // (1) NULL on crash, children unwrapped when healthy.
  assert.match(code, /if \(this\.state\.error !== null\) return null;/, "the crashed branch must return null");
  assert.match(code, /return this\.props\.children;/, "the healthy branch must return the child directly");
  // (2) It renders no node of its own. A wrapper element here would move the
  // zero-DOM-delta property F105 proved for the section fence.
  for (const token of ["<div", "<span", "<section", "className=", "data-testid"]) {
    assert.ok(!code.includes(token), BOUNDARY + " renders a node of its own (" + token + ") - chrome boundaries must be invisible when healthy");
  }
  // (3) The F105 mount ledger stays section-only: the HUD reads it to say which
  // SECTIONS are mounted, and F109 refused FeatureBoundary for its own panels for
  // exactly this reason.
  assert.ok(!code.includes("registerMountedFeature") && !code.includes("featureRegistry"), "the chrome fence must not touch the F105 mount ledger");
  // (4) A crash is never silent, and never invented locally: the emitter mints
  // the kind + the chrome: subject (see M2-d). The CALL SITE is what is pinned,
  // inside componentDidCatch - a leftover import would satisfy an
  // `includes("emitChromeBoundaryError")` scan while the fence reported nothing
  // (found by falsification: replacing the call with `void ({` passed the first
  // version of this rule).
  const catchAt = code.indexOf("componentDidCatch(");
  const renderAt = code.indexOf("render(): React.ReactNode");
  assert.ok(catchAt >= 0 && renderAt > catchAt, "expected componentDidCatch before render in " + BOUNDARY);
  const catchBody = code.slice(catchAt, renderAt);
  assert.match(catchBody, /emitChromeBoundaryError\(\{/, "the fence must publish the failure from componentDidCatch, not merely import the emitter");
  assert.ok(code.includes("sanitizeBoundaryMessage") && code.includes("sanitizeBoundaryRoute"), "the fence must reuse F105's sanitizers, not invent its own");
  // (5) Retry is bounded and cleaned up - read at CATCH time, from the core.
  assert.match(catchBody, /chromeRetryDecision\(this\.state\.retries\)/, "the retry budget must be read from the core at catch time, not a literal here");
  assert.match(catchBody, /this\.retryTimer = setTimeout\(/, "the retry must be scheduled in componentDidCatch");
  assert.match(catchBody, /CHROME_BOUNDARY_RETRY_MS/, "the retry spacing must come from the core");
  assert.ok(/componentWillUnmount\(\)[\s\S]{0,200}clearTimeout/.test(code), "the retry timer must be cleared on unmount");
  assert.ok(core.CHROME_BOUNDARY_MAX_RETRIES === 3 && core.CHROME_BOUNDARY_RETRY_MS === 2000, "the retry policy literals moved - re-read what the node gate pins");
  assert.deepEqual(core.chromeRetryDecision(0), { retry: true, attempt: 1, budget: 3 });
  assert.deepEqual(core.chromeRetryDecision(2), { retry: true, attempt: 3, budget: 3 });
  assert.deepEqual(core.chromeRetryDecision(3), { retry: false, attempt: 4, budget: 3 }, "the budget must stop the loop");
  assert.deepEqual(core.chromeRetryDecision("junk"), { retry: true, attempt: 1, budget: 3 }, "a junk counter must not unlock infinite retries");
  // (6) The F105-j/M5 security class, applied to the new files.
  for (const rel of [BOUNDARY, CORE, CHANNEL]) {
    const c = stripComments(read(rel));
    for (const banned of ["fetch(", "XMLHttpRequest", "sendBeacon", "new WebSocket", "localStorage", "sessionStorage", "dangerouslySetInnerHTML", "innerHTML", "eval(", "Put-GhFile", "Publish-GithubPagesData", "/api/diag-upload", "/api/diag-file"]) {
      assert.ok(!c.includes(banned), rel + " contains banned token " + JSON.stringify(banned) + " (crash-report path has no network/storage)");
    }
  }
});

test("M2-d: one channel, two provenances - a chrome failure can never be filed as a broken section", async () => {
  const core = await importCore();
  const channel = stripComments(read(CHANNEL));
  // The emitter mints BOTH halves of the identity; a caller cannot forget either.
  assert.match(channel, /export function emitChromeBoundaryError\(/, "the chrome emitter must live on the shared channel module");
  const emit = channel.slice(channel.indexOf("export function emitChromeBoundaryError("));
  assert.ok(emit.slice(0, 700).includes("kind: CHROME_BOUNDARY_KIND"), "the chrome emitter must set the kind discriminant");
  assert.ok(emit.slice(0, 700).includes("feature: chromeSubject(detail.surface)"), "the chrome emitter must mint the chrome: subject");
  assert.equal(core.CHROME_BOUNDARY_KIND, "chrome");
  // The branch runs BEFORE the section row is built.
  const row = channel.slice(channel.indexOf("export function boundaryCollectorRow("));
  const branchAt = row.indexOf("isChromeBoundaryDetail(detail)");
  const sectionAt = row.indexOf("FeatureBoundary caught a render error");
  assert.ok(branchAt >= 0 && sectionAt > branchAt, "boundaryCollectorRow must branch on the chrome kind before the section wording");
  // Back-compat is load-bearing: `kind` stays OPTIONAL, and F105's producer does
  // not set it - so every pre-M2 detail (and every stored row) still means
  // "a route fence".
  const fbTypes = stripComments(read("src/lib/featureBoundary.ts"));
  assert.match(fbTypes, /kind\?: "feature" \| typeof CHROME_BOUNDARY_KIND/, "`kind` must stay optional or every F105 producer/test has to change with it");
  const f105Producer = stripComments(read("src/components/primitives/FeatureBoundary.tsx"));
  assert.ok(f105Producer.includes("emitFeatureBoundaryError("), "F105's producer must keep using the plain emitter");
  assert.ok(!/emitFeatureBoundaryError\(\{[\s\S]{0,200}kind:/.test(f105Producer), "F105's producer must not set a kind: absent kind == feature is the compatibility rule");
  // The row shape: same action as F105's, different source tag, and the F105
  // shape is untouched for section rows.
  const chromeRow = core.chromeBoundaryCollectorRow({ surface: "toasts", message: "kaboom", route: "#/files", count: 1, ts: "2026-10-08T00:00:00.000Z" });
  assert.equal(chromeRow.action, "renderError");
  assert.equal(chromeRow.source, core.CHROME_BOUNDARY_SOURCE);
  assert.notEqual(core.CHROME_BOUNDARY_SOURCE, "feature-boundary", "the two provenances must not share a tag");
  assert.equal(chromeRow.feature, "chrome:toasts");
  assert.equal(chromeRow.error, "kaboom");
  assert.equal(chromeRow.verdict.status, "fail");
  assert.equal(chromeRow.verdict.relatedIssue, "#165");
  assert.ok(chromeRow.verdict.suggestedFix.includes(core.chromeSurfaceById("toasts").lost), "the row must carry what was lost, not a generic message");
  assert.ok(!JSON.stringify(chromeRow).includes("stack"));
  const unknown = core.chromeBoundaryCollectorRow({ surface: "nope" });
  assert.equal(unknown.feature, "chrome:nope");
  assert.ok(unknown.verdict.suggestedFix.includes("unknown surface"), "an unknown surface must be reported honestly, never crash the reporter");
});

test("M2-e: F105's section fences are exactly as they were - 13 fence() calls, none of them moved to chrome", async () => {
  const core = await importCore();
  const app = stripComments(read(APP));
  const calls = [...app.matchAll(/fence\(\s*"([a-z-]+)"/g)].map((m) => m[1]);
  assert.equal(calls.length, 13, "F105-g pins exactly 13 fence() calls (11 sections + the Lab sub-route + the catch-all); M2 must not convert one of them");
  // the positive control: the count is non-vacuous only if the regex really sees
  // the section fences, and those ids are the registry's.
  for (const id of ["overview", "search", "settings", "collector"]) {
    assert.ok(calls.includes(id), "the section fences disappeared from App.tsx: " + id);
  }
  // The chrome helper is a DIFFERENT name, and the table is what it claims.
  assert.match(app, /function chrome\(surface: ChromeSurfaceId, node: ReactNode\)/, "the chrome helper must be typed by the surface union");
  assert.ok(app.includes('import ChromeBoundary from "@/components/primitives/ChromeBoundary"'), "App.tsx must import the chrome fence");
  assert.ok(read(SHELL).includes('import ChromeBoundary from "@/components/primitives/ChromeBoundary"'), "AppShell.tsx must import the chrome fence");
  // F105's own artefacts are intact (its gate is the authority; this is the
  // cross-check that M2 did not edit them).
  const f105 = read("src/components/primitives/FeatureBoundary.tsx");
  assert.ok(f105.includes("registerMountedFeature"), "the section fence must keep registering in the mount ledger");
  assert.ok(f105.includes("BoundaryFallback"), "the section fence must keep rendering its card");
  assert.ok(fs.existsSync(path.join(ROOT, "tests/f105-feature-registry.test.js")) && fs.existsSync(path.join(ROOT, "src/tests/smoke/f105-feature-boundaries.test.tsx")), "F105's gates must still exist");
  // The two producers share ONE event name (one channel): the app must not grow
  // a second crash event that nobody subscribes to.
  assert.equal((stripComments(read(CHANNEL)).match(/ghrdp:feature-boundary-error/g) || []).length, 1, "exactly one crash event name on the channel");
  assert.equal(core.CHROME_SURFACE_IDS.length, 10);
});
