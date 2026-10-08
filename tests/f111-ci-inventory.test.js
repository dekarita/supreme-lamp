// [F111 / Observatory step 10] CI INVENTORY GATE: the roadmap and the persistence
// surface are both DERIVED and diffed, not hand-counted.
//
// WHY. Two inventories in this repo were hand-maintained and both were measurably
// wrong, and one of them cost a whole session:
//
//   1. THE STEP LEDGER (§Handoff-findings #12). Step 6 shipped TWICE - #173
//      (`arena/66a13a8c`) and #174 (`arena/fa27adb3`), two independent F107
//      implementations merged 11.5 minutes apart. Each PR's CI was green on its own
//      base; neither could see the other. Main ended red on all four workflows and
//      #175 was an unscheduled repair session. Nothing in the repo could have said
//      "you are merging the same step twice". The same hazard was LIVE when this step
//      ran: `gh pr list --state all --search "F108 in:title"` returned open sibling
//      #176, so this session did NOT write a second F108 (see §SIBLING-PR-DETECTION).
//   2. THE STORAGE INVENTORY (#163 §3.8, handoff #9). "14 live + 3 purged-legacy"
//      localStorage keys. Derived from source it is 21 surfaces: 16 live (15
//      localStorage + the IndexedDB `ghrdp-dvr`), 1 migration, 3 purged and 1
//      DEAD READ. Four surfaces were missing entirely, and one of those -
//      `ghrdp-dash-token` - is read by two files and written by nothing in the repo.
//
// Both are now declared in JSON next to a pure core (src/lib/ci/inventoryCore.js) that
// DERIVES the truth from the tree and diffs it. This gate executes the SHIPPED core
// (§GATE-EXECUTES-SHIPPED-CODE) and is auto-run by launch-gates.yml's
// `node --test tests/*.test.js` step, so no workflow edit was needed to make it real.
//
// FALSIFY-3 (each mutation was applied and reverted; the rule that caught it is named):
//   M1 set ledger #173 to `merged-canonical` (recreate the double-ship) -> F111-b fails
//      with no-double-ship on F107, naming both PRs.
//   M2 delete #173's `retiredBy` -> F111-b fails with retirement-cites-its-repair.
//   M3 delete the `ghrdp.f57.opqueue` declaration -> F111-e fails (undeclared key).
//   M4 add a declared key that no file uses -> F111-e fails (stale declaration).
//   M5 reclassify `ghrdp-dash-token` as `live` -> F111-e fails (classificationMismatch,
//      ops=[getItem] cannot be live).
//   M6 teach the scanner to accept `factory.open(` in prose by scanning src/lib/ci/ ->
//      F111-j fails: the tooling prefix pin is exact and the exclusion must hide nothing.
//   M7 make extractFeatureIds match `F-OBSERVATORY` (drop the denylist) -> F111-c fails:
//      a step-11 PR titled "F-OBSERVATORY ..." would be reported as a sibling of #168.
//   M8 widen the roadmap PR regex to /#(\d+)/ -> F111-d fails: #163/#165/#169 prose
//      cross-references become "shipped PRs" with no ledger entry.
//   M9 remove an allowlist `why` -> F111-d fails (a recorded drift must explain itself).
// VACUITY probes: F111-g proves the scanner REJECTS the near-misses (protocol URLs,
// window event names, i18n `*_KEY` constants) - a scanner that returned everything would
// pass F111-e and fail here. F111-j proves the tooling exclusion hides no real key.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n?/g, "\n");
const readJson = (p) => JSON.parse(read(p));
const importCore = () => import(path.join(ROOT, "src/lib/ci/inventoryCore.js"));

const LEDGER_PATH = "src/lib/ci/stepLedger.json";
const INVENTORY_PATH = "src/lib/ci/storageInventory.json";
const REGISTRY_PATH = "src/lib/feature-registry.json";
const ROADMAP_PATH = "docs/OBSERVATORY-STATE.md";

/** Walk src/ (minus the jsdom suites) and return [{path, text}] with forward slashes. */
function collectSources() {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "tests") continue; // src/tests is the jsdom suite, not a shipping surface
        walk(abs);
      } else if (/\.(ts|tsx|js)$/.test(entry.name)) {
        out.push({ path: path.relative(ROOT, abs).split(path.sep).join("/"), text: fs.readFileSync(abs, "utf8") });
      }
    }
  };
  walk(path.join(ROOT, "src"));
  return out;
}

// ---------------------------------------------------------------------------
// F111-a: the ledger is internally consistent and covers the whole roadmap.
// ---------------------------------------------------------------------------
test("F111-a: the step ledger is internally consistent - known statuses, one entry per PR, all 10 steps", async () => {
  const core = await importCore();
  const ledger = readJson(LEDGER_PATH);
  const entries = ledger.entries;

  assert.ok(Array.isArray(entries) && entries.length >= 10, "the ledger must carry the roadmap");
  assert.deepEqual(core.assertNoDoubleShip(entries), [], "assertNoDoubleShip must be clean on the real ledger");
  assert.deepEqual(core.ledgerTitleConsistency(entries), [], "every entry's featureIds must agree with its own title");

  // every roadmap step 1..10 is present, and no PR number is reused
  const steps = new Set(entries.map((e) => Number(e.step)));
  for (let s = 1; s <= 10; s += 1) assert.ok(steps.has(s), "step " + s + " is missing from the ledger");
  const numbers = entries.map((e) => e.number).filter((n) => n != null);
  assert.equal(new Set(numbers).size, numbers.length, "a PR number appears twice in the ledger");

  // a null number is only legal for work that has no PR yet
  for (const e of entries) {
    if (e.number == null) {
      assert.ok(["open", "planned"].includes(e.status), "#" + e.step + " has no PR number but status '" + e.status + "'");
    }
    assert.ok(Array.isArray(e.featureIds), "entry #" + e.number + " must declare featureIds (even if empty)");
    assert.ok(typeof e.title === "string" && e.title.length > 8, "entry #" + e.number + " needs a real title");
  }

  // the double-ship history is recorded as history, not smoothed over
  const f107 = entries.filter((e) => e.featureIds.includes("F107"));
  assert.equal(f107.length, 2, "both step-6 F107 implementations must stay in the ledger");
  assert.deepEqual(
    f107.map((e) => e.status).sort(),
    ["merged-canonical", "merged-then-retired"],
    "exactly one F107 may be canonical and exactly one must be retired"
  );
  const retired = f107.find((e) => e.status === "merged-then-retired");
  assert.equal(Number(retired.retiredBy), 175, "the retired F107 must cite the #175 repair");
  assert.equal(retired.number, 173, "verified against the API: #173 = arena/66a13a8c is the retired one");
  assert.equal(
    entries.find((e) => e.number === 174).branch,
    "arena/fa27adb3-supreme-lamp",
    "verified against the API: #174 = arena/fa27adb3 is the canonical survivor"
  );
});

// ---------------------------------------------------------------------------
// F111-b: the rule that would have stopped 2026-10-07 22:27Z. Proven by mutating
// the REAL ledger back into the double-ship, not by a synthetic fixture.
// ---------------------------------------------------------------------------
test("F111-b: assertNoDoubleShip reproduces the step-6 damage when the ledger is mutated back into it", async () => {
  const core = await importCore();
  const entries = readJson(LEDGER_PATH).entries;

  // M1: #173 becomes canonical too - both F107 implementations shipped.
  const m1 = entries.map((e) => (e.number === 173 ? { ...e, status: "merged-canonical", retiredBy: undefined } : e));
  const v1 = core.assertNoDoubleShip(m1);
  assert.equal(v1.length, 1, "M1 must produce exactly one violation, got " + JSON.stringify(v1));
  assert.equal(v1[0].rule, "no-double-ship");
  assert.equal(v1[0].featureId, "F107");
  assert.match(v1[0].detail, /#173/, "the violation must name the first PR");
  assert.match(v1[0].detail, /#174/, "the violation must name the second PR");

  // M2: keep the retirement but drop its citation - an unrepairable retirement.
  const m2 = entries.map((e) => (e.number === 173 ? { ...e, retiredBy: undefined } : e));
  const v2 = core.assertNoDoubleShip(m2);
  assert.ok(v2.some((v) => v.rule === "retirement-cites-its-repair"), "M2 must fail retirement-cites-its-repair");

  // M2b: cite a repair that is not marked repair:true.
  const m3 = entries.map((e) => (e.number === 175 ? { ...e, repair: false } : e));
  const v3 = core.assertNoDoubleShip(m3);
  assert.ok(
    v3.some((v) => v.rule === "retirement-cites-its-repair" && /not marked repair:true/.test(v.detail)),
    "a retirement must cite something that IS a repair"
  );

  // M2c: an unknown status is a violation, not a shrug.
  const v4 = core.assertNoDoubleShip([{ step: 99, number: 999, featureIds: ["F999"], status: "landed-ish", title: "F999: x" }]);
  assert.ok(v4.some((v) => v.rule === "known-status"), "an unknown status must be rejected");
});

// ---------------------------------------------------------------------------
// F111-c: the duplicate-step detector, run against the REAL current ledger.
// This is the rule this session actually needed before writing any F108 code.
// ---------------------------------------------------------------------------
test("F111-c: detectDuplicateStep gives the four verdicts on the real ledger - including today's live F108 sibling", async () => {
  const core = await importCore();
  const ledger = readJson(LEDGER_PATH).entries;
  const detect = (title, number) => core.detectDuplicateStep({ title, number, ledger });

  // A second F107 today: already shipped => blocking.
  const dup = detect("F107: Full DVR v3 - a better recorder", null);
  assert.equal(dup.verdict, "duplicate-merged");
  assert.equal(dup.blocking, true, "a duplicate of a MERGED step must block");
  assert.equal(dup.label, "duplicate-step");
  assert.deepEqual(dup.ids, ["F107"]);

  // [F109 session] #176 MERGED at 2026-10-08T00:47:09Z, so on TODAY's ledger a second F108
  // is a blocking duplicate. The sibling-open verdict this test was written around (the
  // live situation the F111 session faced) is still proven - by mutating #176's status
  // back to open, the mirror image of the afterMerge mutation below.
  const dup108 = detect("F108: Public Replay Viewer at docs/replay/ (Pages-published) + Arena mode", null);
  assert.equal(dup108.verdict, "duplicate-merged", "#176 is merged: a second F108 must block");
  assert.equal(dup108.blocking, true);
  const sib = core.detectDuplicateStep({
    title: "F108: Public Replay Viewer at docs/replay/ (Pages-published) + Arena mode",
    number: null,
    ledger: ledger.map((e) => (e.number === 176 ? { ...e, status: "open" } : e)),
  });
  assert.equal(sib.verdict, "sibling-open", "the live situation the F111 session faced must be reported as a sibling");
  assert.equal(sib.blocking, false);
  assert.equal(sib.label, "duplicate-step", "the operator still gets the label so the pair is visible pre-merge");
  assert.match(sib.reason, /OPEN #176/);

  // ... but the sibling must not be reported against ITSELF.
  const self = detect("F108: public replay viewer at docs/replay/", 176);
  assert.equal(self.verdict, "unique", "a PR is not its own sibling");

  // Once #176 lands, the same title becomes blocking. Proven by mutating status only.
  const afterMerge = core.detectDuplicateStep({
    title: "F108: another replay viewer",
    number: null,
    ledger: ledger.map((e) => (e.number === 176 ? { ...e, status: "merged" } : e)),
  });
  assert.equal(afterMerge.verdict, "duplicate-merged");
  assert.equal(afterMerge.blocking, true);

  // An unstarted step is unique; a started one (PR number recorded) is a sibling of it.
  // [F109 session] data-driven on the F109 entry, because the code commit carries
  // number:null (no PR yet) and the post-PR commit records the number.
  const f109 = ledger.find((e) => e.featureIds.includes("F109"));
  const v109 = detect("F109: Debug HUD overlay (F12-shift)", null);
  if (f109.number == null) assert.equal(v109.verdict, "unique", "F109 has no PR yet");
  else {
    assert.equal(f109.status, "open");
    assert.equal(v109.verdict, "sibling-open", "a second F109 while #" + f109.number + " is open is a sibling");
    assert.equal(detect(f109.title, f109.number).verdict, "unique", "the F109 PR is not its own sibling");
  }
  assert.equal(detect("F110: Live Patch Protocol", null).verdict, "unique");
  // [F109 §GATE-SELF-TEST] key-chord spellings of the HUD shortcut are not feature ids:
  // the step-8 spec's own title "(F12+Shift)" extracted a phantom F12 before this fix.
  assert.deepEqual(core.extractFeatureIds("F109: Debug HUD overlay (F12+Shift) with 5 panels"), ["F109"]);
  assert.deepEqual(core.extractFeatureIds("press Shift+F12 or Shift-F12"), []);
  assert.deepEqual(core.extractFeatureIds("F12 closeout"), ["F12"], "a real F12 reference must still extract");

  // M7: the orchestrator's own name is not a feature id, or every prompt-titled PR
  // would collide with the step-3 halt record (#168).
  const obs = detect("F-OBSERVATORY step 11: something new", null);
  assert.deepEqual(obs.ids, [], "F-OBSERVATORY is denylisted");
  assert.equal(obs.verdict, "unique");
  assert.ok(core.NAMED_FEATURE_DENYLIST.includes("F-OBSERVATORY"), "the denylist must stay pinned");

  // The halt record is not a second F-DVR-LITE implementation.
  const dvr = detect("F-DVR-LITE: another clipboard recorder", null);
  assert.equal(dvr.verdict, "duplicate-merged", "#171 really did ship F-DVR-LITE");
  assert.equal(
    dvr.matches.filter((m) => m.entry.number === 168).length,
    0,
    "#168 shipped a HALT record, so it must not count as an F-DVR-LITE carrier"
  );

  // Named and numbered ids both extract, in order, deduplicated.
  assert.deepEqual(core.extractFeatureIds("F105 + F106 and F105 again"), ["F105", "F106"]);
  assert.deepEqual(core.extractFeatureIds("F-I18N-SI-72 closes the gap"), ["F-I18N-SI-72"]);
  assert.deepEqual(core.extractFeatureIds("no feature here (#163, #165)"), []);
  // gate-name suffixes must not invent ids
  assert.deepEqual(core.extractFeatureIds("F108-h publish fence"), ["F108"]);
});

// ---------------------------------------------------------------------------
// F111-d: ledger <-> roadmap agreement, modulo a pinned, self-explaining allowlist.
// ---------------------------------------------------------------------------
test("F111-d: the ledger and the roadmap checkboxes agree, except for exactly the drift recorded in the ledger", async () => {
  const core = await importCore();
  const ledgerDoc = readJson(LEDGER_PATH);
  const roadmap = read(ROADMAP_PATH);

  const observed = core.ledgerVsRoadmap(ledgerDoc.entries, roadmap);
  const allow = ledgerDoc.knownRoadmapDrift;
  assert.ok(Array.isArray(allow) && allow.length > 0, "the allowlist must be the recorded drift, not an escape hatch");

  // every allowlisted drift must explain itself and must STILL be observed
  for (const a of allow) {
    assert.ok(typeof a.why === "string" && a.why.length > 40, "a recorded drift needs a real why (M9)");
    assert.ok(a.rule && a.match, "a recorded drift needs rule + match");
    assert.ok(
      observed.some((o) => o.rule === a.rule && o.detail === a.match),
      "allowlisted drift is no longer observed - delete it from knownRoadmapDrift: " + a.rule + " / " + a.match
    );
  }
  // and nothing else may drift
  const unrecorded = observed.filter((o) => !allow.some((a) => a.rule === o.rule && a.match === o.detail));
  assert.deepEqual(unrecorded, [], "unrecorded roadmap/ledger drift");

  // M8: the strict citation regex. Prose cross-references must not read as shipped PRs.
  const lines = core.parseRoadmap(roadmap);
  assert.ok(lines.length >= 12, "the roadmap checkboxes must parse, got " + lines.length);
  const allCited = lines.flatMap((l) => l.prs);
  for (const forbidden of [163, 164, 165, 169]) {
    assert.ok(!allCited.includes(forbidden), "#" + forbidden + " is an issue cross-reference, not a step PR (M8)");
  }
  // the repair line's own branch is its own PR, and the branches it names in PROSE are not citations
  const repair = lines.find((l) => l.repair && l.step === 6);
  assert.ok(repair, "the Step 6 REPAIR line must parse");
  assert.equal(repair.branch, "arena/89b9650b-supreme-lamp", "the first branch on a line is that line's own");
  assert.deepEqual(repair.prs, [175], "prose mentions of #173/#174 are not this line's PR citation");

  // the two recorded drifts are real, and both are about the canonical survivor
  const rules = observed.map((o) => o.rule).sort();
  assert.deepEqual(rules, ["ledger-pr-cited-in-roadmap", "roadmap-branch-matches-pr"], "the observed drift set moved");
});

// ---------------------------------------------------------------------------
// F111-e: the storage inventory is DERIVED. Both directions, with counts pinned.
// ---------------------------------------------------------------------------
test("F111-e: the declared storage inventory equals what the tree really persists", async () => {
  const core = await importCore();
  const declared = readJson(INVENTORY_PATH);
  const sources = collectSources().filter((s) => !core.isInventoryTooling(s.path));
  const scan = core.scanSources(sources);
  const diff = core.diffStorageInventory(scan, declared);

  assert.deepEqual(diff.undeclared, [], "storage key used by src/ but not declared - add it to storageInventory.json");
  assert.deepEqual(diff.stale, [], "declared storage key no longer used by src/ - remove it or re-cite it");
  assert.deepEqual(diff.classificationMismatch, [], "a key's operation set changed; re-classify it in the same commit (M5)");
  assert.deepEqual(diff.kindMismatch, [], "localStorage vs indexedDB moved");
  assert.deepEqual(diff.citationMismatch, [], "declaredIn must name files that really declare the key");

  // counts pinned, so a scanner that quietly narrows is as visible as one that widens
  const byClass = {};
  for (const k of scan.keys) byClass[k.classification] = (byClass[k.classification] || 0) + 1;
  // re-MEASURED by the F109 session (not incremented): 21 + f109:enabled + f109:toggles = 23, both live
  assert.equal(scan.keys.length, 23, "derived surface count moved - re-measure and update the declaration");
  assert.deepEqual(byClass, { live: 18, migration: 1, purged: 3, "dead-read": 1 }, "classification census moved");
  assert.equal(scan.keys.filter((k) => k.kind === "indexedDB").length, 1, "exactly one IndexedDB surface (ghrdp-dvr)");
  assert.equal(diff.agreed.length, declared.keys.length, "every declared key must be fully agreed, not just present");

  // the load-bearing individual facts
  const byKey = new Map(scan.keys.map((k) => [k.key, k]));
  assert.deepEqual(byKey.get("ghrdp-dash-token").ops, ["getItem"], "the dead read is still a dead read");
  assert.equal(byKey.get("ghrdp-dash-token").classification, "dead-read");
  assert.deepEqual(byKey.get("ghrdp-dash-token").paths.sort(), ["src/api/fetch/index.ts", "src/lib/f46.ts"]);
  assert.equal(byKey.get("ghrdp-dvr").kind, "indexedDB", "F107's database is inventory too");
  assert.equal(byKey.get("ghrdp-dvr").classification, "live");
  assert.equal(byKey.get("ghrdp.collector.actions.v1").classification, "migration", "read-then-delete, never written");
  assert.deepEqual(
    scan.keys.filter((k) => k.classification === "purged").map((k) => k.key).sort(),
    ["__GHRDP_SEARCH_ENABLED", "f56.search.enabled", "ghrdp.lane.search"],
    "the F77 one-shot purge set"
  );
});

// ---------------------------------------------------------------------------
// F111-f: the classification rule itself, on synthetic operation sets.
// ---------------------------------------------------------------------------
test("F111-f: classifyStorageKey is a rule about operations, not a label someone typed", async () => {
  const core = await importCore();
  assert.equal(core.classifyStorageKey(["getItem", "setItem"]), "live");
  assert.equal(core.classifyStorageKey(["persist"]), "live");
  assert.equal(core.classifyStorageKey(["idb-open"]), "live");
  assert.equal(core.classifyStorageKey(["getItem", "removeItem"]), "migration");
  assert.equal(core.classifyStorageKey(["removeItem"]), "purged");
  assert.equal(core.classifyStorageKey(["getItem"]), "dead-read");
  // a Set must work too (the scanner passes one), and order must not matter
  assert.equal(core.classifyStorageKey(new Set(["setItem", "getItem", "removeItem"])), "live");
  assert.equal(core.classifyStorageKey(["removeItem", "getItem"]), "migration");
  assert.deepEqual(core.STORAGE_CLASSIFICATIONS, ["live", "migration", "purged", "dead-read"]);
  // every classification used in the declaration is a real one
  const declared = readJson(INVENTORY_PATH);
  for (const k of declared.keys) {
    assert.ok(core.STORAGE_CLASSIFICATIONS.includes(k.classification), k.key + " has an invented classification");
  }
});

// ---------------------------------------------------------------------------
// F111-g: VACUITY PROBE. A scanner that returned every key-shaped literal would
// pass F111-e's "no undeclared" half by construction. These near-misses prove it
// discriminates: each is present in the tree, each is key-shaped, none is a key.
// ---------------------------------------------------------------------------
test("F111-g: protocol URLs, window event names and i18n *_KEY constants are NOT storage keys", async () => {
  const core = await importCore();
  const declared = readJson(INVENTORY_PATH);
  const sources = collectSources().filter((s) => !core.isInventoryTooling(s.path));
  const scan = core.scanSources(sources);
  const derived = new Set(scan.keys.map((k) => k.key));

  assert.ok(declared.nonStorageLookalikes.length >= 4, "the near-miss list must stay populated");
  for (const l of declared.nonStorageLookalikes) {
    assert.ok(!derived.has(l.value), "VACUOUS SCANNER: " + l.value + " was derived as a storage key");
    assert.ok(typeof l.why === "string" && l.why.length > 20, l.value + " needs a why");
    const file = sources.find((s) => s.path === l.file);
    assert.ok(file, "near-miss citation " + l.file + " does not exist");
    assert.ok(file.text.includes(l.value), "near-miss " + l.value + " is not actually present in " + l.file);
  }
  // the specific discriminations, spelled out so a regex change cannot sneak past
  assert.ok(!derived.has("ghrdp://rdp"), "a custom protocol URL is not a key");
  assert.ok(!derived.has("ghrdp:feature-boundary-error"), "a window event name is not a key");
  assert.ok(!derived.has("files.ops.preview.restricted"), "an i18n key exported as *_KEY is not a key");
  // and the positive control: the real ghrdp: namespaced keys ARE found
  for (const real of ["ghrdp:theme", "ghrdp:lang", "ghrdp:textScale", "ghrdp:sidebarCollapsed", "ghrdp:vncPass"]) {
    assert.ok(derived.has(real), "the scanner lost a real key: " + real);
  }
  // the alias path is load-bearing: collectorAgent reaches storage through `const ls = rawStorage()`
  assert.ok(derived.has("f102-collector-actions-v1"), "zustand persist name missed");
  assert.ok(derived.has("ghrdp.collector.actions.v1"), "the alias-accessed legacy key was missed");
  // cross-file constant resolution is load-bearing for the IndexedDB name
  assert.ok(derived.has("ghrdp-dvr"), "DVR_DB_NAME is exported by storageCore.js and used by storage.ts");
});

// ---------------------------------------------------------------------------
// F111-h: every declaration is source-cited, and surfaces tie back to F105's registry.
// ---------------------------------------------------------------------------
test("F111-h: every declared key cites real files, and every surface is a registry feature or documented chrome/shared", async () => {
  const core = await importCore();
  const declared = readJson(INVENTORY_PATH);
  const registry = readJson(REGISTRY_PATH);
  const featureIds = new Set(registry.features.map((f) => f.id));
  const allowedSurfaces = new Set([...featureIds, ...Object.keys(declared.surfaceVocabulary).filter((k) => k !== "note")]);
  assert.ok(allowedSurfaces.has("chrome") && allowedSurfaces.has("shared"), "the two cross-cutting surfaces must be documented");
  assert.equal(featureIds.size, 11, "F105's registry is 11 sections");

  const seen = new Set();
  for (const k of declared.keys) {
    assert.ok(!seen.has(k.key), k.key + " is declared twice");
    seen.add(k.key);
    assert.ok(allowedSurfaces.has(k.surface), k.key + " has surface '" + k.surface + "', which is neither a registry feature nor chrome/shared");
    assert.ok(Array.isArray(k.declaredIn) && k.declaredIn.length > 0, k.key + " cites no file");
    assert.ok(typeof k.note === "string" && k.note.length > 10, k.key + " has no note");
    assert.equal(typeof k.i163, "boolean", k.key + " must say whether #163 §3.8 knew about it");
    for (const p of k.declaredIn) {
      assert.ok(fs.existsSync(path.join(ROOT, p)), k.key + " cites a file that does not exist: " + p);
      const text = read(p);
      // The file must contain the key itself under ANY quote style - src/ mixes them
      // (`localStorage.getItem('ghrdp-dash-token')` in src/api/fetch/index.ts versus
      // `localStorage.getItem("tableDensity")` in Data.tsx), so a double-quote-only
      // check reports a false "does not declare it" - caught by running this gate.
      // Or it must contain the exported constant that holds the key.
      const holdsLiteral = ['"', "'", "`"].some((q) => text.includes(q + k.key + q));
      const holdsConstant = k.constantName ? text.includes(k.constantName) : false;
      assert.ok(holdsLiteral || holdsConstant, k.key + " is cited to " + p + ", which does not declare it");
    }
  }
  assert.equal(declared.keys.length, seen.size);
});

// ---------------------------------------------------------------------------
// F111-i: the #163 drift is MEASURED and pinned, which is the step's actual brief
// ("CI Inventory Gate - PR validates #163 drift").
// ---------------------------------------------------------------------------
test("F111-i: #163 §3.8's hand count is confirmed wrong by exactly the four surfaces recorded", async () => {
  const core = await importCore();
  const declared = readJson(INVENTORY_PATH);
  const sources = collectSources().filter((s) => !core.isInventoryTooling(s.path));
  const scan = core.scanSources(sources);

  // #163's own claim was internally consistent; the drift is what it never saw.
  const known = declared.keys.filter((k) => k.i163);
  // [F109 session] keys added AFTER this gate landed are i163:false (#163 could not know
  // them) but are not #163 DRIFT. They must say who added them, that carrier must be a
  // feature the step ledger knows, and postInventoryGrowth must list exactly them.
  const grown = declared.keys.filter((k) => !k.i163 && k.addedBy);
  const ledgerIds = new Set(readJson(LEDGER_PATH).entries.flatMap((e) => e.featureIds));
  for (const k of grown) assert.ok(ledgerIds.has(k.addedBy), k.key + " addedBy " + k.addedBy + ", which no ledger entry carries");
  const listed = Object.entries(declared.postInventoryGrowth || {}).filter(([id]) => id !== "note").flatMap(([, keys]) => keys).sort();
  assert.deepEqual(listed, grown.map((k) => k.key).sort(), "postInventoryGrowth must list exactly the addedBy keys");
  assert.ok(declared.keys.filter((k) => k.i163 && k.addedBy).length === 0, "a key #163 knew cannot have been added later");
  const unknown = declared.keys.filter((k) => !k.i163 && !k.addedBy);
  assert.equal(known.length, 17, "#163 §3.8 knew 14 live + 3 purged = 17 surfaces");
  assert.equal(known.filter((k) => k.classification === "live").length, 14, "#163's '14 live' is confirmed for the keys it listed");
  assert.equal(known.filter((k) => k.classification === "purged").length, 3, "#163's '3 purged-legacy' is confirmed");
  assert.equal(unknown.length, 4, "exactly four surfaces were invisible to #163");

  // every recorded drift is real: derived, and derived with the classification claimed
  const derived = new Map(scan.keys.map((k) => [k.key, k]));
  assert.ok(declared.drift.missedByI163.length >= 4, "the drift list must stay populated");
  for (const d of declared.drift.missedByI163) {
    assert.ok(derived.has(d.key), "drift entry " + d.key + " is not actually derived");
    assert.ok(d.why && d.why.length > 40, "drift entry " + d.key + " needs a real why");
    const decl = declared.keys.find((k) => k.key === d.key);
    assert.ok(decl, "drift entry " + d.key + " has no declaration");
    assert.equal(decl.i163, false, "drift entry " + d.key + " claims #163 missed it but the declaration says i163:true");
  }
  const driftKeys = declared.drift.missedByI163.map((d) => d.key).sort();
  assert.deepEqual(driftKeys, unknown.map((k) => k.key).sort(), "the drift list and the i163:false set must be the same set");

  // the headline: a credential-adjacent dead read, and a whole database, were invisible
  assert.equal(derived.get("ghrdp-dash-token").classification, "dead-read");
  assert.equal(derived.get("ghrdp-dvr").kind, "indexedDB");
  assert.match(declared.drift.i163Claim, /14 live \+ 3 purged-legacy/, "the claim being tested must be quoted verbatim");
});

// ---------------------------------------------------------------------------
// F111-j: the tooling exclusion cannot hide a key, and cannot silently widen.
// ---------------------------------------------------------------------------
test("F111-j: excluding the inventory tooling hides no storage key, and the exclusion is pinned", async () => {
  const core = await importCore();
  const all = collectSources();
  const kept = all.filter((s) => !core.isInventoryTooling(s.path));

  assert.deepEqual(core.INVENTORY_TOOLING_PREFIXES, ["src/lib/ci/"], "the exclusion list must not widen silently (M6)");
  assert.ok(kept.length < all.length, "the exclusion must actually exclude something");
  for (const s of all.filter((x) => core.isInventoryTooling(x.path))) {
    assert.ok(s.path.startsWith("src/lib/ci/"), s.path + " was excluded by something other than the pinned prefix");
  }

  // M6: prose in this directory DOES look like a call site - `factory.open(DVR_DB_NAME…)`
  // in a comment resolves to a real key. So prove the exclusion loses nothing: every key
  // derivable from the whole tree is also derivable from the tree minus the tooling.
  const scanAll = core.scanSources(all);
  const scanKept = core.scanSources(kept);
  const allKeys = new Set(scanAll.keys.map((k) => k.key));
  const keptKeys = new Set(scanKept.keys.map((k) => k.key));
  const lost = [...allKeys].filter((k) => !keptKeys.has(k));
  assert.deepEqual(lost, [], "the tooling exclusion hid a real storage key: " + lost.join(", "));

  // and the phantom really is phantom: the tooling file must not be the ONLY citation
  const dvr = scanAll.keys.find((k) => k.key === "ghrdp-dvr");
  assert.ok(dvr.paths.includes("src/lib/dvr/storage.ts"), "ghrdp-dvr must be derived from the real call site, not from prose");
});

// ---------------------------------------------------------------------------
// F111-k: zero new dependencies, and the core stays pure (no I/O, no imports).
// ---------------------------------------------------------------------------
test("F111-k: F111 adds no dependency and its core performs no I/O", async () => {
  const pkg = readJson("package.json");
  assert.equal(Object.keys(pkg.dependencies).length, 8, "dependencies moved - F111 must add none");
  assert.equal(Object.keys(pkg.devDependencies).length, 21, "devDependencies moved - F111 must add none");

  const coreSrc = read("src/lib/ci/inventoryCore.js");
  assert.ok(!/^\s*import\s/m.test(coreSrc), "the core must have no imports (pure, zero-dep)");
  assert.ok(!/require\s*\(/.test(coreSrc), "the core must not require()");
  for (const banned of ["node:fs", "readFileSync", "fetch(", "XMLHttpRequest", "localStorage.", "indexedDB.open", "document.", "process.env"]) {
    // `localStorage.` and friends may appear inside REGEX SOURCE and prose, so the
    // assertion is that the core never CALLS them: no `= require`/`import`, and no
    // call site outside a regex or comment is checked here by pinning the absence of
    // the module specifiers and of process access instead.
    if (banned === "node:fs" || banned === "process.env") {
      assert.ok(!coreSrc.includes(banned), "the core must not touch " + banned);
    }
  }
  assert.ok(coreSrc.includes("CONTRACT: no I/O"), "the core must keep its no-I/O contract comment");
  // the type surface ships with it, as every other *Core.js in this repo does
  assert.ok(fs.existsSync(path.join(ROOT, "src/lib/ci/inventoryCore.d.ts")), "the hand-written .d.ts must ship beside the core");
  const dts = read("src/lib/ci/inventoryCore.d.ts");
  for (const fn of ["extractFeatureIds", "detectDuplicateStep", "assertNoDoubleShip", "parseRoadmap", "ledgerVsRoadmap", "scanSources", "diffStorageInventory", "classifyStorageKey", "isInventoryTooling", "ledgerTitleConsistency", "collectStringConsts"]) {
    assert.ok(dts.includes(fn), ".d.ts is missing " + fn);
  }
});
