// MERGE HYGIENE gates - the locks the step-6 DOUBLE MERGE proved we needed.
//
// WHAT HAPPENED (2026-10-07, main `e6dc5bd`). Observatory step 6 (F107 Full DVR)
// shipped TWICE: PR #173 (`arena/66a13a8c`) and PR #174 (`arena/fa27adb3`) are two
// independent implementations of the same step, and the operator merged both.
// #174's branch then merged main with an "accept both sides" resolution, which put
// four different kinds of damage on main at once:
//
//   1. `package.json` declared `fake-indexeddb` TWICE (`^6.2.5` and `6.2.4`) and
//      `pnpm-lock.yaml` carried both resolutions under one importer key. Duplicate
//      JSON keys PARSE FINE (last wins), so no gate saw it - `pnpm install
//      --frozen-lockfile` did, which is the SLOWEST possible place to find out:
//      `F59 build-ui` and `e2e-ui` both died inside 20 s of starting.
//   2. `src/i18n/{en,si}.json` were not valid JSON at all (side B's tail was
//      concatenated onto side A's block with no comma, plus duplicate
//      `dvr.sessions`/`dvr.clear`). `gates` died at F48-10/F48-14 on a SyntaxError.
//   3. `tests/f-i18n-parity.test.js` declared `const EXPECTED_FLAT_KEYS` twice
//      (1022 and 1010) - a count lock resolved by KEEPING BOTH SIDES is not a
//      lock, it is a crash.
//   4. `src/lib/dvr/{export,mutations,storage}.ts` had side B's chunk inserted
//      BEFORE the file's closing brace, and `SessionListModal.tsx` /
//      `Collector.tsx` carried two components, two cards, two `useState`s and a
//      duplicated `data-testid` - i.e. two incompatible DVRs in one tree.
//
// Net effect: `gates`, `windows-native`, `build-ui` AND `e2e-ui` were all red on
// main, so every later session's CI signal was meaningless until it was repaired.
//
// WHY THIS FILE EXISTS. tsc and the existing gates catch (4) once somebody runs
// them, but NOTHING in the repo caught (1), (2) or (3) as a class: duplicate keys
// are legal JSON, and the lockfiles are only validated by an install step that
// runs minutes into a job. These gates move that detection into the fast node lane
// (`node --test tests/*.test.js`, launch-gates.yml) and lock the de-duplication
// decisions the repair made, so a future "accept both" merge fails in seconds with
// a sentence that names the file - not in a runner with `exit code 1`.
//
// CONTRACT: read-only. No I/O beyond fs reads of tracked files, no network.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const exists = (p) => fs.existsSync(path.join(ROOT, p));
/** The shipped pure cores are ESM-syntax .js; the house pattern is a dynamic import. */
const core = (rel) => import(path.join(ROOT, rel));

/**
 * Every duplicate key in a JSON document, as `path.to.key` strings.
 *
 * `JSON.parse` silently keeps the LAST of a duplicated key, so the corruption
 * that broke main is invisible to any parse-then-inspect gate. This walks the raw
 * text instead: strings are skipped as atoms (so a `{` inside a string cannot
 * open a scope), a string followed by `:` is a key, and each `{` opens a fresh
 * key set that `}` closes.
 */
function duplicateKeys(text) {
  const dups = [];
  const stack = [new Set()];
  const scope = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length) {
        if (text[j] === "\\") { j += 2; continue; }
        if (text[j] === '"') break;
        j++;
      }
      const raw = text.slice(i, j + 1);
      let k = j + 1;
      while (k < text.length && /\s/.test(text[k])) k++;
      if (text[k] === ":") {
        const key = JSON.parse(raw);
        const top = stack[stack.length - 1];
        if (top.has(key)) dups.push(scope.concat(key).join("."));
        else top.add(key);
        scope.push(key);
      }
      i = j + 1;
      continue;
    }
    if (c === "{") { stack.push(new Set()); }
    else if (c === "}") { stack.pop(); scope.pop(); }
    i++;
  }
  return dups;
}

/** Flat leaf keys of a catalog, the same way the parity gate flattens them. */
function flatKeys(obj, prefix = "") {
  return Object.entries(obj).reduce(
    (acc, [k, v]) =>
      Object.assign(acc, v && typeof v === "object" ? flatKeys(v, prefix + k + ".") : { [prefix + k]: v }),
    {}
  );
}

/** name -> specifier for one importer block of pnpm-lock.yaml (lockfileVersion 9). */
function pnpmImporterSpecifiers(text) {
  const out = {};
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l === "importers:");
  assert.ok(start >= 0, "pnpm-lock.yaml must carry an importers: section");
  let section = null;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^\S/.test(line) && line.trim() !== "") break; // left the importers block
    if (/^    (dependencies|devDependencies):$/.test(line)) { section = line.trim().slice(0, -1); continue; }
    if (/^    \S/.test(line) && !/^    (dependencies|devDependencies):$/.test(line)) { section = null; continue; }
    // Dependency names sit at exactly 6 spaces; pnpm quotes scoped names
    // ('@types/react':), so the quote is part of the YAML key, not the name.
    const dep = line.match(/^      ([^\s].*?):\s*$/);
    if (dep && section) { out[dep[1].replace(/^['"]|['"]$/g, "")] = { section, specifier: null }; continue; }
    const spec = line.match(/^        specifier: (.+)$/);
    if (spec) {
      const last = Object.keys(out).pop();
      if (last && out[last] && out[last].specifier === null) out[last].specifier = spec[1].trim();
    }
  }
  return out;
}

test("MH-a: package.json has no duplicate keys, and the step-6 devDependency is the value the merge already meant", () => {
  const text = read("package.json");
  // The corruption class, pinned literally: this file declared fake-indexeddb twice.
  assert.deepEqual(duplicateKeys(text), [], "package.json carries a duplicate key - a merge kept both sides");
  const pkg = JSON.parse(text);
  assert.equal(pkg.devDependencies["fake-indexeddb"], "6.2.4", "literal pin: the surviving specifier is the exact one main proved green with");
  assert.equal(pkg.dependencies.html2canvas, undefined, "the retired F107 rasterizer dependency must not come back without a cited consumer");
  assert.equal(pkg.packageManager, "pnpm@9.15.9", "literal pin: the lockfile is pnpm's; CI installs with corepack + --frozen-lockfile");
});

test("MH-b: BOTH lockfiles agree with package.json, so --frozen-lockfile cannot be the first thing to notice", () => {
  const pkg = JSON.parse(read("package.json"));
  const wanted = { ...pkg.dependencies, ...pkg.devDependencies };

  // pnpm: the importer's specifiers must be exactly package.json's.
  const pnpm = pnpmImporterSpecifiers(read("pnpm-lock.yaml"));
  const pnpmNames = Object.keys(pnpm).sort();
  assert.deepEqual(pnpmNames, Object.keys(wanted).sort(), "pnpm-lock.yaml's importer and package.json disagree - regenerate the lock, never hand-merge it");
  for (const [name, spec] of Object.entries(wanted)) {
    assert.equal(pnpm[name].specifier, spec, "pnpm-lock.yaml specifier drift for " + name + " - run `pnpm install --lockfile-only`");
  }
  // A duplicated importer key leaves a stale second resolution behind; assert the
  // retired one is gone from the whole lockfile, not just from the importer.
  assert.ok(!read("pnpm-lock.yaml").includes("fake-indexeddb@6.2.5"), "an orphan resolution survived the lock regeneration");

  // npm: the root package entry must list the same specifiers.
  const npmLock = JSON.parse(read("package-lock.json"));
  const npmRoot = npmLock.packages[""];
  assert.deepEqual({ ...npmRoot.dependencies, ...npmRoot.devDependencies }, wanted, "package-lock.json disagrees with package.json");
});

test("MH-c: both i18n catalogs parse, carry no duplicate key at any depth, and the count lock is a measurement", () => {
  for (const file of ["src/i18n/en.json", "src/i18n/si.json"]) {
    const text = read(file);
    assert.deepEqual(duplicateKeys(text), [], file + " carries a duplicate key - a merge kept both sides of a namespace");
    let parsed;
    assert.doesNotThrow(() => { parsed = JSON.parse(text); }, file + " must be valid JSON: an 'accept both' concatenation loses a comma");
    assert.ok(parsed && parsed.dvr && typeof parsed.dvr === "object", file + " must keep the dvr namespace");
  }
  const en = flatKeys(JSON.parse(read("src/i18n/en.json")));
  const si = flatKeys(JSON.parse(read("src/i18n/si.json")));
  assert.deepEqual(Object.keys(si).sort(), Object.keys(en).sort(), "the two catalogs must carry the identical key set");

  // ONE lock, not two: read the parity gate's constant instead of pinning a second
  // copy of the number here (two locks that must move together is how 1022/1010
  // both ended up on main).
  const parity = read("tests/f-i18n-parity.test.js");
  const locks = parity.match(/const EXPECTED_FLAT_KEYS = (\d+)/g) || [];
  assert.equal(locks.length, 1, "EXPECTED_FLAT_KEYS must be declared exactly once - a duplicated count lock is a SyntaxError, not a lock");
  const expected = Number((parity.match(/const EXPECTED_FLAT_KEYS = (\d+)/) || [])[1]);
  assert.equal(Object.keys(en).length, expected, "the count lock must equal the measured catalog size (never previous + delta)");
  // measured 2026-10-07 at HEAD e6dc5bd + this repair: the union of #173 (1010) and #174 (1022)
  assert.equal(expected, 1074, "literal pin: the repaired union (1030) + 20 R-METRICS/R-SEARCH/R-FILES/R-DL keys + 24 R-GLASS/R-UX keys = 1074 keys in BOTH catalogs");
});

test("MH-d: the retired step-6 DVR variant stays retired - one implementation, one session list, one testid", () => {
  // Two F107 implementations cannot coexist: their storage APIs share names with
  // incompatible signatures (`listSessions(db)` vs `listSessions(now)`).
  for (const gone of ["src/lib/dvr/full.ts", "src/lib/dvr/full-core.js", "src/lib/dvr/full-core.d.ts"]) {
    assert.equal(exists(gone), false, gone + " belongs to the retired #173 variant; resurrecting it re-opens the duplicate-DVR collision");
  }
  const storage = read("src/lib/dvr/storage.ts");
  assert.equal((storage.match(/export async function listSessions/g) || []).length, 1, "storage.ts must export listSessions exactly once");
  assert.equal((storage.match(/export async function saveSession/g) || []).length, 1, "storage.ts must export saveSession exactly once");
  assert.ok(!storage.includes("ghrdp-dvr-v2"), "the retired variant's second IndexedDB name must not come back");

  const modal = read("src/components/dvr/SessionListModal.tsx");
  assert.equal((modal.match(/export function SessionListModal/g) || []).length, 1, "one session-list component, not one per merged branch");
  assert.equal((modal.match(/export default SessionListModal/g) || []).length, 1, "one default export");

  const collector = read("src/pages/Collector.tsx");
  assert.equal((collector.match(/const \[dvrSessionsOpen, setDvrSessionsOpen\] = useState/g) || []).length, 1, "Collector must hold ONE dvrSessionsOpen state");
  assert.equal((collector.match(/<SessionListModal /g) || []).length, 1, "Collector must mount the session list once");

  // F-TESTID-d proves uniqueness repo-wide; this pins the specific id that the
  // double merge duplicated across two files, so the failure names the incident.
  const withOpenId = ["src/pages/Collector.tsx", "src/components/domain/DvrFab.tsx"]
    .map((f) => [f, (read(f).match(/data-testid="dvr-sessions-open"/g) || []).length])
    .filter(([, n]) => n > 0);
  assert.equal(withOpenId.length, 1, "dvr-sessions-open must live in exactly one file (it was in two after the double merge)");
  assert.equal(withOpenId[0][0], "src/pages/Collector.tsx", "the Collector owns dvr-sessions-open; the FAB's handle is dvr-sessions-button");
  assert.ok(read("src/components/domain/DvrFab.tsx").includes('data-testid="dvr-sessions-button"'), "the FAB keeps its own distinct sessions handle");
  assert.ok(!read("src/lib/dvr/exportCore.js").includes("buildFullBundle"), "one .mcrec v2 producer only: two shapes under one envelope tag is a reader hazard for F108");
});

test("MH-e: the route-credential sanitizer SURVIVED the de-duplication, and is still called where routes are read", async () => {
  // The privacy fix came from the RETIRED variant; dropping it with the rest would
  // have silently re-opened a persisted-credential leak. It now lives in its own
  // pure core so the surviving recorder keeps it.
  const corePath = "src/lib/dvr/routeCore.js";
  assert.ok(exists(corePath), "the shared route sanitizer must exist as a pure core");
  const { safeRoute, SAFE_ROUTE_MAX_CHARS } = await core("src/lib/dvr/routeCore.js");

  // Behaviour, with literal pins (§LITERAL-PINS-FOR-CONSTANTS): a mutation that
  // moves the constant AND its use must still fail here.
  assert.equal(safeRoute("#/collector?token=SECRET"), "#/collector", "the query string is where a dash token lives - it must never be recorded");
  assert.equal(safeRoute("#/collector"), "#/collector", "a clean route passes through unchanged");
  assert.equal(safeRoute(null), "", "a missing route is an empty string, never 'null'");
  assert.equal(safeRoute("#/keys?token=A&b=2"), "#/keys");
  assert.equal(SAFE_ROUTE_MAX_CHARS, 256, "literal pin: the route length cap");
  assert.equal(safeRoute("#/" + "x".repeat(400)).length, 256, "the cap is enforced, not just declared");

  // Wiring: the import alone is not the fix - the call site is. Both are pinned so
  // a refactor cannot keep one and drop the other.
  const dvr = read("src/lib/dvr.ts");
  assert.ok(dvr.includes('import { safeRoute } from "./dvr/routeCore";'), "dvr.ts must import the sanitizer from the surviving core");
  assert.match(dvr, /return safeRoute\(window\.location\.hash \|\| window\.location\.pathname \|\| ""\);/, "currentRoute() must sanitize at the read site (this covers the v1 ring AND the v2 timeline that rides it)");
  assert.ok(!dvr.includes("./dvr/full\""), "the retired variant must not be imported by the live recorder");
});
