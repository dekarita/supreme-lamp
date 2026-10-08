// [F111 §1] begin — CI INVENTORY CORE: the pure half of the F111 inventory gate.
//
// WHY THIS FILE EXISTS. Two hazards in this repo are *inventory* hazards, and both
// have already cost a session:
//
//   (1) DOUBLE-SHIP (state file §Handoff-findings #12). Step 6 was scheduled twice,
//       two independent F107 implementations (#173 `arena/66a13a8c`, #174
//       `arena/fa27adb3`) were merged 12 minutes apart, and each PR's CI was green on
//       its own base - neither could see the other. Main ended red on all four
//       workflows and a whole repair session (#175) was spent de-duplicating it. The
//       same hazard is LIVE again right now: `gh pr list --state all --search
//       "F108 in:title"` returns an open sibling, so a second F108 PR would repeat the
//       damage exactly.
//   (2) INVENTORY DRIFT (#163 §3.8). The hand-written inventory says "14 live +
//       3 purged-legacy" localStorage keys. Measured from source it is not 14: three
//       live surfaces are absent from it (`ghrdp.f57.opqueue`, the IndexedDB
//       `ghrdp-dvr`, and `ghrdp-dash-token`), and the last of those is read by two
//       files and written by nothing in the repo. A hand-counted inventory cannot be
//       trusted; a derived one can.
//
// So this core DERIVES both inventories from the tree and diffs them against a
// committed declaration. It is a pure core (repo convention: `*Core.js` + hand-written
// `.d.ts`, no DOM, no I/O, no Node fs) so `node --test tests/f111-ci-inventory.test.js`
// executes the SHIPPED functions rather than a copy of them, and so the same core can be
// reused by a PR workflow later without a rewrite.
//
// CONTRACT: no I/O of any kind - no fetch, no storage, no DOM, no Node fs. Callers pass
// file contents in as `{ path, text }` and get plain data back.
//
// A NOTE ON BRITTLENESS, because this gate is a count-and-citation lock and the repo has
// been burned by those before (see docs/CI-GATE-BRITTLENESS.md): if this gate fails after
// you ADD a storage key or FIX the dead `ghrdp-dash-token` read, the gate is not wrong and
// you should not weaken it - you should re-measure and update
// `src/lib/ci/storageInventory.json` in the SAME commit. That is the whole point: the
// declared inventory is the operator-readable answer to "what does this app persist?",
// and a change to persistence that does not touch it is exactly the drift F111 exists to
// catch. (Recorded in docs/CI-GATE-BRITTLENESS.md so the next session does not "fix" it.)
// [F111 §1] end

/**
 * Numbered feature ids: `F105` … `F111`, also inside `F107-h` gate names and
 * `steps 9/10`. Two-to-four digits so `F1`/`F12345` are not ids.
 *
 * The trailing negative lookahead is load-bearing and was found by running the gate, not
 * by reading it: `F109`'s own title is "Debug HUD overlay (F12-shift)", and `\bF(\d{2,4})\b`
 * happily extracts `F12` from the keyboard shortcut - which in THIS repo is also a real
 * historical feature id (`tests/f12-closeout.test.js`). So: a `F<digits>` immediately
 * followed by `-<word>` is a keyboard key or a compound, not a feature id, while
 * `-<single lowercase letter>` is the gate-name suffix form (`F107-h`, `F108-e1`) and must
 * still yield the id.
 *
 * [F109 §GATE-SELF-TEST] The lookahead covered `F12-shift` only. The step-8 spec's own
 * PR title writes the chord as `(F12+Shift)`, and the HUD's UI writes `Shift+F12`; both
 * still extracted a phantom `F12`, so ledgerTitleConsistency() would have failed the F109
 * ledger entry for declaring only F109. Key-chord forms are now rejected on BOTH sides:
 * `F<digits>+<Word>` (lookahead) and `<Word>+F<digits>` / `Shift-F<digits>`-style modifier
 * prefixes (lookbehind). `F105 + F106` (spaced) still yields both ids.
 */
const NUMBERED_FEATURE_RE = /(?<![A-Za-z]{2,}\+|(?:[Ss]hift|[Cc]trl|[Aa]lt|[Mm]eta|[Cc]md|[Mm]od)-)\bF(\d{2,4})\b(?!-[a-z]{2,})(?!\+[A-Za-z]{2,})/g;

/**
 * Named feature ids used by the early roadmap: `F-TESTID`, `F-I18N-SI-72`,
 * `F-DVR-LITE`, `F-DVR`. Deliberately NOT matched: `F-OBSERVATORY` (the orchestrator
 * prompt's own name, never a shipped feature) - see NAMED_FEATURE_DENYLIST.
 */
const NAMED_FEATURE_RE = /\bF-[A-Z][A-Z0-9-]*\b/g;

/**
 * Strings shaped like a feature id that are process artefacts, not shippable features.
 * Matching one of these in a PR title must never block a merge.
 */
export const NAMED_FEATURE_DENYLIST = ["F-OBSERVATORY", "F-INVENTORY"];

/** Storage call sites: `localStorage.getItem(...)`, and the alias form `ls.setItem(...)`. */
const STORAGE_CALL_RE = /\b([A-Za-z_$][A-Za-z0-9_$]*)\s*\.\s*(getItem|setItem|removeItem)\s*\(\s*([^,)]*)/g;

/**
 * `const X = "literal"` / `export const X: string = "literal"` - used to resolve key identifiers.
 *
 * [F109 §DERIVED-INVENTORY-DISCOVERY] The type annotation may NOT cross `;` or a newline.
 * It used to be `(?::[^=]+)?`, so a hand-written `.d.ts` line with no initializer -
 * `export declare const HUD_ENABLED_KEY: "f109:enabled";` - ran on to the NEXT `=` in the
 * file (`export type HudPanelId = "features" | ...`) and resolved the key to "features".
 * First definition wins, in readdir order, so the phantom key also depended on the file
 * system's directory ordering. Found by running F111-e against the F109 tree.
 */
const STRING_CONST_RE = /\b(?:export\s+)?const\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*(?::[^=;\n]+)?=\s*(['"`])([^'"`]*)\2/g;

/** `const alias = <something Storage-ish>` - `collectorAgent.ts` reads through `const ls = rawStorage()`. */
const ALIAS_RE = /\b(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*(?::[^=]+)?=\s*([^;\n]*)/g;

/** `factory.open(DVR_DB_NAME, DVR_DB_VERSION)` - the IndexedDB database name. */
const IDB_OPEN_RE = /\b([A-Za-z_$][A-Za-z0-9_$]*)\s*\.\s*open\s*\(\s*([^,)]+)/g;

/** zustand persist storage key: `persist(fn, { name: "ghrdp:theme" })`. */
const PERSIST_NAME_RE = /\bname:\s*([^,}\n)]+)/g;

/**
 * Key-shaped literals: things that LOOK like a storage key. Used to report the
 * near-misses the scanner correctly rejected, so a future scanner regression that
 * starts swallowing them is visible instead of silent. Deliberately EXCLUDES the
 * `f<NN>.` i18n namespace shape: three real keys use it (`f90.viewingMode`,
 * `f95.manualWebDesktop`, `f90.hintSeen`) but so do ~50 i18n strings, and a near-miss
 * report nobody can read is a report nobody reads.
 */
const KEY_SHAPED_RE = /^(?:ghrdp[:.]|__GHRDP|q:|files\.ops\.)/;

/**
 * Directories that are INVENTORY TOOLING, not storage surfaces. They are excluded from
 * the derived inventory by the gate, and the exclusion is pinned to exactly this list so
 * it cannot silently widen into a hiding place.
 *
 * WHY THIS IS NEEDED (found by running the scanner on itself, not by reasoning about it):
 * this very file documents the IndexedDB call site as prose -
 * "// `factory.open(DVR_DB_NAME, DVR_DB_VERSION)`" - and a scanner that resolves
 * identifiers across files happily turned that COMMENT into a derived key attributed to
 * `src/lib/ci/inventoryCore.js`. Prose must not be able to invent inventory. The gate
 * proves the exclusion hides nothing: every key derivable from the whole tree must also
 * be derivable from the tree minus these prefixes.
 */
export const INVENTORY_TOOLING_PREFIXES = ["src/lib/ci/"];

/** True when `path` is inventory tooling rather than a storage surface. */
export function isInventoryTooling(path) {
  const p = String(path == null ? "" : path).replace(/\\/g, "/");
  return INVENTORY_TOOLING_PREFIXES.some((prefix) => p.startsWith(prefix));
}

/** The classification vocabulary. Every derived key gets exactly one. */
export const STORAGE_CLASSIFICATIONS = ["live", "migration", "purged", "dead-read"];

/**
 * Extract feature ids from a PR title, a roadmap label or a session heading.
 * Returns deduplicated ids in order of first appearance, denylist filtered.
 */
export function extractFeatureIds(text) {
  const src = String(text == null ? "" : text);
  const out = [];
  for (const m of src.matchAll(NUMBERED_FEATURE_RE)) {
    const id = "F" + m[1];
    if (!out.includes(id)) out.push(id);
  }
  for (const m of src.matchAll(NAMED_FEATURE_RE)) {
    const id = m[0];
    if (NAMED_FEATURE_DENYLIST.includes(id)) continue;
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

/**
 * Ledger entry statuses. `merged*` counts as shipped; `-then-retired` means it was
 * merged and later superseded by a repair, which is the ONLY legal way for one feature
 * id to appear twice as shipped.
 */
export const LEDGER_STATUSES = [
  "merged",
  "merged-canonical",
  "merged-then-retired",
  "open",
  "closed",
  "planned",
];

/**
 * THE DOUBLE-SHIP DETECTOR (state file handoff #12).
 *
 * Given a candidate PR and the step ledger, decide whether shipping it would repeat a
 * step that is already merged, or duplicate one that is already in flight.
 *
 * @param {{title: string, number?: number|null, ledger: Array<object>}} input
 * @returns {{ids: string[], matches: Array<object>, verdict: string, blocking: boolean,
 *            label: string|null, reason: string}}
 *   verdict `duplicate-merged` - the feature already shipped; merging again is the #173/#174 damage class.
 *   verdict `sibling-open`     - another OPEN PR carries the same id: coordinate, do not duplicate.
 *   verdict `prior-retired`    - only retired/closed carriers: legal, but read their session log first.
 *   verdict `unique`           - no carrier at all.
 */
export function detectDuplicateStep(input) {
  const title = String((input && input.title) || "");
  const self = input && input.number != null ? Number(input.number) : null;
  const ledger = (input && Array.isArray(input.ledger) ? input.ledger : []).filter(
    (e) => e && e.number != null && Number(e.number) !== self
  );
  const ids = extractFeatureIds(title);
  const matches = [];
  for (const id of ids) {
    for (const entry of ledger) {
      // Match on the entry's DECLARED featureIds, not on its title prose: a halt record
      // (#168, "F-DVR-LITE is BLOCKED") names a feature it ships no implementation of, and
      // counting it would report a false double-ship. ledgerTitleConsistency() is the rule
      // that keeps the declaration honest against the title instead.
      const entryIds = Array.isArray(entry.featureIds) ? entry.featureIds.map(String) : [];
      if (entryIds.includes(id)) matches.push({ id, entry });
    }
  }
  const status = (e) => String(e.status || "");
  const merged = matches.filter((m) => /^merged/.test(status(m.entry)) && status(m.entry) !== "merged-then-retired");
  const open = matches.filter((m) => status(m.entry) === "open");
  const retired = matches.filter((m) => status(m.entry) === "merged-then-retired" || status(m.entry) === "closed");

  if (merged.length > 0) {
    return {
      ids,
      matches,
      verdict: "duplicate-merged",
      blocking: true,
      label: "duplicate-step",
      reason:
        "feature id(s) " +
        merged.map((m) => m.id + " already MERGED as #" + m.entry.number).join(", ") +
        " - this is the step-6 #173/#174 double-ship damage class; do not open a second implementation",
    };
  }
  if (open.length > 0) {
    return {
      ids,
      matches,
      verdict: "sibling-open",
      blocking: false,
      label: "duplicate-step",
      reason:
        "feature id(s) " +
        open.map((m) => m.id + " carried by OPEN #" + m.entry.number).join(", ") +
        " - coordinate with the sibling; a second implementation is how step 6 shipped twice",
    };
  }
  if (retired.length > 0) {
    return {
      ids,
      matches,
      verdict: "prior-retired",
      blocking: false,
      label: null,
      reason: "only retired/closed carriers (" + retired.map((m) => "#" + m.entry.number).join(", ") + ") - read their session logs first",
    };
  }
  return { ids, matches, verdict: "unique", blocking: false, label: null, reason: "no ledger carrier for " + (ids.join(", ") || "any extracted id") };
}

/**
 * Assert the ledger itself never records a double-ship. This is the rule that would
 * have failed on 2026-10-07 at the moment #174 merged while #173 was already merged.
 *
 * @param {Array<object>} ledger
 * @returns {Array<{rule: string, featureId?: string, detail: string}>} violations (empty = consistent)
 */
export function assertNoDoubleShip(ledger) {
  const entries = Array.isArray(ledger) ? ledger.filter(Boolean) : [];
  const violations = [];
  const byFeature = new Map();
  for (const e of entries) {
    for (const id of Array.isArray(e.featureIds) ? e.featureIds.map(String) : []) {
      if (!byFeature.has(id)) byFeature.set(id, []);
      byFeature.get(id).push(e);
    }
  }
  for (const [id, list] of byFeature) {
    const shipped = list.filter((e) => /^merged/.test(String(e.status || "")) && e.status !== "merged-then-retired");
    if (shipped.length > 1) {
      violations.push({
        rule: "no-double-ship",
        featureId: id,
        detail:
          id +
          " is recorded as shipped " +
          shipped.length +
          " times (#" +
          shipped.map((e) => e.number).join(", #") +
          "). Exactly one implementation may be canonical; the others must be merged-then-retired with a retiredBy repair.",
      });
    }
    for (const e of list) {
      if (e.status === "merged-then-retired") {
        const repair = entries.find((r) => r.number != null && Number(r.number) === Number(e.retiredBy));
        if (!repair) {
          violations.push({
            rule: "retirement-cites-its-repair",
            featureId: id,
            detail: "#" + e.number + " is retired but retiredBy=#" + e.retiredBy + " is not in the ledger",
          });
        } else if (repair.repair !== true) {
          violations.push({
            rule: "retirement-cites-its-repair",
            featureId: id,
            detail: "#" + e.number + " is retired by #" + repair.number + ", which is not marked repair:true",
          });
        }
      }
    }
  }
  for (const e of entries) {
    if (!LEDGER_STATUSES.includes(e.status)) {
      violations.push({ rule: "known-status", detail: "#" + e.number + " has unknown status '" + e.status + "'" });
    }
  }
  return violations;
}

/**
 * Keep the ledger's declared featureIds honest against each entry's own title.
 *
 * Every id the title names must either be declared (so it counts towards double-ship
 * detection) or be listed in `titleNamesButDoesNotShip` with the entry explaining itself.
 * That is what lets `#168` - titled "F-OBSERVATORY step 3 HALT: F-DVR-LITE is BLOCKED" -
 * sit in the ledger without claiming to be a second F-DVR-LITE implementation.
 *
 * @param {Array<object>} ledger
 * @returns {Array<{rule: string, detail: string}>} violations (empty = consistent)
 */
export function ledgerTitleConsistency(ledger) {
  const out = [];
  for (const e of Array.isArray(ledger) ? ledger.filter(Boolean) : []) {
    const declared = Array.isArray(e.featureIds) ? e.featureIds.map(String) : [];
    const fromTitle = extractFeatureIds(e.title || "");
    const waived = Array.isArray(e.titleNamesButDoesNotShip) ? e.titleNamesButDoesNotShip.map(String) : [];
    for (const id of fromTitle) {
      if (declared.includes(id) || waived.includes(id)) continue;
      out.push({
        rule: "title-id-declared-or-waived",
        detail:
          "#" + e.number + " is titled with " + id + " but declares neither featureIds nor titleNamesButDoesNotShip for it",
      });
    }
    for (const id of declared) {
      if (!fromTitle.includes(id)) {
        out.push({ rule: "declared-id-in-title", detail: "#" + e.number + " declares " + id + ", which its title does not name" });
      }
    }
    for (const id of waived) {
      if (!fromTitle.includes(id)) {
        out.push({ rule: "waiver-is-load-bearing", detail: "#" + e.number + " waives " + id + ", which its title does not even name" });
      } else if (!e.waiverWhy) {
        out.push({ rule: "waiver-explains-itself", detail: "#" + e.number + " waives " + id + " without a waiverWhy" });
      }
    }
  }
  return out;
}

/**
 * Parse the human roadmap checkboxes out of docs/OBSERVATORY-STATE.md so the machine
 * ledger can be held against the document operators actually read. Two documents that
 * disagree about what shipped is how a step gets scheduled twice.
 *
 * @param {string} markdown
 * @returns {Array<{step: number, repair: boolean, checked: boolean, label: string, ids: string[], prs: number[], branches: string[]}>}
 */
export function parseRoadmap(markdown) {
  const src = String(markdown == null ? "" : markdown);
  const out = [];
  const LINE_RE = /^- \[( |x)\] \*\*Step (\d+)( REPAIR)? — ([^*]+?)\*\*(.*)$/gm;
  for (const m of src.matchAll(LINE_RE)) {
    const tail = m[5] || "";
    // STRICT citation forms only. A naive /#(\d+)/ sweep over the tail picks up every
    // issue cross-reference in the prose (`#163 §3.6`, `#169 option (d)`, `#165`) and
    // reports them as PRs this step shipped, which is its own kind of inventory drift.
    const prs = [];
    for (const p of tail.matchAll(/\bPRs?\s*\*{0,2}\s*#(\d{2,4})/g)) {
      const n = Number(p[1]);
      if (!prs.includes(n)) prs.push(n);
    }
    // The FIRST `arena/...` on a line is that line's own head branch ("landed on
    // `arena/<slug>`, PR **#N**"). Later ones are prose about other PRs - the Step-6
    // repair line names both double-shipped branches while citing only its own PR - so
    // they must not be treated as this line's citations.
    const branchMatch = /`?(arena\/[A-Za-z0-9._-]+)`?/.exec(tail);
    const branch = branchMatch ? branchMatch[1] : null;
    out.push({
      step: Number(m[2]),
      repair: Boolean(m[3]),
      checked: m[1] === "x",
      label: m[4].trim(),
      ids: extractFeatureIds(m[4]),
      prs,
      branch,
    });
  }
  return out;
}

/**
 * Hold the ledger against the roadmap document.
 *
 * The branch rule is not decoration. The Step-6 roadmap line reads
 * "landed on `arena/fa27adb3-supreme-lamp`, PR **#173**" - but `arena/fa27adb3` is #174,
 * the canonical survivor, and #173 was `arena/66a13a8c`. The document that operators read
 * to decide what shipped mis-attributes the double-ship it is describing, which is exactly
 * the class of confusion that produced the double-ship. The mismatch is RECORDED (the
 * gate pins it in `knownRoadmapDrift`) rather than silently rewritten, because
 * §UI-ACCUMULATOR-FILES forbids rewriting another step's record.
 *
 * @returns {Array<{rule: string, detail: string}>} mismatches (empty = the two agree)
 */
export function ledgerVsRoadmap(ledger, markdown) {
  const all = Array.isArray(ledger) ? ledger.filter(Boolean) : [];
  const entries = all.filter((e) => e.inRoadmap !== false);
  const roadmap = parseRoadmap(markdown);
  const out = [];
  // Every checked roadmap line must have a shipped ledger entry citing the same PR.
  for (const line of roadmap) {
    if (!line.checked) continue;
    for (const pr of line.prs) {
      const e = entries.find((x) => Number(x.number) === pr);
      if (!e) {
        out.push({ rule: "roadmap-pr-in-ledger", detail: "roadmap Step " + line.step + " is checked and cites #" + pr + ", which the ledger does not carry" });
      } else if (e.status === "closed" || e.status === "planned") {
        // [x] means "a session landed this step on a PR", NOT "the PR is merged": Step 4
        // has been `[x] ... PR **#170** (in review, NOT merged)` since 2026-10-07. So an
        // open carrier is legal here; a closed or never-opened one is not.
        out.push({ rule: "roadmap-checked-is-not-abandoned", detail: "roadmap Step " + line.step + " is [x] but ledger #" + pr + " is '" + e.status + "'" });
      }
    }
    if (line.prs.length === 0) {
      out.push({ rule: "roadmap-checked-cites-a-pr", detail: "roadmap Step " + line.step + " (" + line.label + ") is [x] but cites no PR number" });
    }
    // The branch this line names as its own must belong to a PR the line also cites.
    if (line.branch) {
      const owner = all.find((x) => x.branch === line.branch);
      if (!owner) {
        out.push({ rule: "roadmap-branch-in-ledger", detail: "roadmap Step " + line.step + " names branch " + line.branch + ", which no ledger entry owns" });
      } else if (!line.prs.includes(Number(owner.number))) {
        out.push({
          rule: "roadmap-branch-matches-pr",
          detail:
            "roadmap Step " + line.step + " names branch " + line.branch + " (ledger: #" + owner.number + ") but cites " +
            (line.prs.length ? "#" + line.prs.join(", #") : "no PR") + " instead",
        });
      }
    }
  }
  // Every shipped ledger entry that claims a roadmap line must have one, checked, citing it.
  for (const e of entries) {
    if (!/^merged/.test(String(e.status || ""))) continue;
    const lines = roadmap.filter((r) => r.step === Number(e.step));
    if (lines.length === 0) {
      out.push({ rule: "ledger-step-in-roadmap", detail: "ledger #" + e.number + " claims step " + e.step + ", which has no roadmap line" });
      continue;
    }
    if (!lines.some((r) => r.checked)) {
      out.push({ rule: "ledger-merged-is-checked", detail: "ledger #" + e.number + " is '" + e.status + "' but no Step " + e.step + " roadmap line is [x]" });
    }
    if (!lines.some((r) => r.prs.includes(Number(e.number)))) {
      out.push({ rule: "ledger-pr-cited-in-roadmap", detail: "ledger #" + e.number + " (step " + e.step + ") is not cited by any Step " + e.step + " roadmap line" });
    }
  }
  return out;
}

/** Build the cross-file identifier -> string-literal map used to resolve key constants. */
export function collectStringConsts(sources) {
  const map = new Map();
  for (const s of sources || []) {
    const text = String((s && s.text) || "");
    for (const m of text.matchAll(STRING_CONST_RE)) {
      if (!map.has(m[1])) map.set(m[1], { value: m[3], path: s.path });
    }
  }
  return map;
}

/**
 * Classify a key from the operations the tree actually performs on it.
 *
 *   set present                    -> `live`       (something writes it)
 *   get + remove, never set        -> `migration`  (read-once-then-delete legacy upgrade)
 *   remove only                    -> `purged`     (deliberately erased, never read or written)
 *   get only                       -> `dead-read`  (read by us, written by NOTHING in the repo)
 *
 * `dead-read` is the interesting one: `ghrdp-dash-token` is read by
 * `src/api/fetch/index.ts` and `src/lib/f46.ts` and written by no file in the repo, so
 * both reads always fall through to the next source. That is a latent bug the hand-counted
 * inventory could not see, and it is why the classification is derived and not asserted.
 */
export function classifyStorageKey(ops) {
  // Accepts any iterable (an Array from the declaration, a Set from the scanner).
  const set = new Set([...(ops == null ? [] : ops)].map(String));
  if (set.has("setItem") || set.has("persist") || set.has("idb-open")) return "live";
  if (set.has("getItem") && set.has("removeItem")) return "migration";
  if (set.has("removeItem")) return "purged";
  if (set.has("getItem")) return "dead-read";
  return "live";
}

/**
 * DERIVE the storage inventory from source text. No fs, no DOM: the caller reads files.
 *
 * Precision rules, each of which exists because a naive scan produces a wrong answer:
 *   - key constants resolve across files (`DVR_DB_NAME` is exported by
 *     `src/lib/dvr/storageCore.js` and used by `src/lib/dvr/storage.ts`);
 *   - storage aliases are honoured (`collectorAgent.ts` reaches localStorage through
 *     `const ls = rawStorage()`), but an alias is only accepted when its initializer is
 *     Storage-shaped and is not itself a storage read;
 *   - zustand `name:` is only treated as a storage key in files that import
 *     `zustand/middleware`, so the server-side `persist()` method of
 *     `src/search/custom-source-store.ts` (F58, not localStorage) is not swallowed;
 *   - `window.open(...)` is not `indexedDB.open(...)`;
 *   - `*_KEY` constants that are i18n keys (`files.ops.preview.restricted` in
 *     `src/lib/explorer/preview.ts`) never count, because only identifiers actually
 *     passed to a storage API are resolved.
 *
 * @param {Array<{path: string, text: string}>} sources
 * @returns {{keys: Array<object>, lookalikes: Array<{value: string, paths: string[]}>, filesScanned: number}}
 */
export function scanSources(sources) {
  const list = Array.isArray(sources) ? sources.filter((s) => s && typeof s.text === "string") : [];
  const consts = collectStringConsts(list);
  const found = new Map(); // key -> {key, kind, ops:Set, paths:Set, evidence:[]}

  const touch = (key, kind, op, path, evidence) => {
    if (!key) return;
    if (!found.has(key)) found.set(key, { key, kind, ops: new Set(), paths: new Set(), evidence: [] });
    const rec = found.get(key);
    rec.ops.add(op);
    rec.paths.add(path);
    if (rec.evidence.length < 8) rec.evidence.push({ path, op, cite: evidence });
  };

  const resolve = (raw, path) => {
    const t = String(raw || "").trim();
    const lit = /^(['"`])([^'"`]*)\1$/.exec(t);
    if (lit) return lit[2];
    const ident = /^[A-Za-z_$][A-Za-z0-9_$]*$/.exec(t);
    if (ident && consts.has(ident[0])) return consts.get(ident[0]).value;
    return null; // dynamic (e.g. the `name` parameter of a StateStorage adapter) - not derivable
  };

  for (const s of list) {
    const text = s.text;
    const mentionsStorage = /localStorage|sessionStorage|StateStorage/.test(text);
    const mentionsIdb = /indexedDB|IDBFactory/.test(text);
    const importsZustandPersist = /from\s+(['"])zustand\/middleware\1/.test(text);

    // Storage aliases reachable in this file: `localStorage`, `sessionStorage`, plus locals.
    const handles = new Set(["localStorage", "sessionStorage"]);
    if (mentionsStorage) {
      for (const m of text.matchAll(ALIAS_RE)) {
        const rhs = m[2] || "";
        if (/\.(getItem|setItem|removeItem)\s*\(/.test(rhs)) continue; // a value, not a handle
        if (/Storage/.test(rhs)) handles.add(m[1]);
      }
    }

    if (mentionsStorage) {
      for (const m of text.matchAll(STORAGE_CALL_RE)) {
        if (!handles.has(m[1])) continue;
        const key = resolve(m[3], s.path);
        if (key) touch(key, "localStorage", m[2], s.path, m[1] + "." + m[2] + "(" + m[3].trim() + ")");
      }
    }

    if (importsZustandPersist) {
      for (const m of text.matchAll(PERSIST_NAME_RE)) {
        const key = resolve(m[1], s.path);
        if (key) touch(key, "localStorage", "persist", s.path, "persist({ name: " + m[1].trim() + " })");
      }
    }

    if (mentionsIdb) {
      for (const m of text.matchAll(IDB_OPEN_RE)) {
        if (m[1] === "window") continue; // window.open is a tab, not a database
        const key = resolve(m[2], s.path);
        if (key) touch(key, "indexedDB", "idb-open", s.path, m[1] + ".open(" + m[2].trim() + ")");
      }
    }
  }

  const keys = [...found.values()]
    .map((r) => ({
      key: r.key,
      kind: r.kind,
      ops: [...r.ops].sort(),
      paths: [...r.paths].sort(),
      evidence: r.evidence,
      classification: classifyStorageKey(r.ops),
    }))
    .sort((a, b) => a.key.localeCompare(b.key));

  // Near-misses: key-shaped literals in storage-bearing files that the scanner rejected.
  const derived = new Set(keys.map((k) => k.key));
  const look = new Map();
  for (const s of list) {
    if (!/localStorage|sessionStorage|indexedDB|IDBFactory|zustand\/middleware/.test(s.text)) continue;
    for (const m of s.text.matchAll(/(['"`])([^'"`\n]{3,80})\1/g)) {
      const v = m[2];
      if (derived.has(v)) continue;
      if (!KEY_SHAPED_RE.test(v)) continue;
      if (/^ghrdp:\/\//.test(v)) continue; // custom protocol URL, never a key
      if (!look.has(v)) look.set(v, new Set());
      look.get(v).add(s.path);
    }
  }
  const lookalikes = [...look.entries()]
    .map(([value, paths]) => ({ value, paths: [...paths].sort() }))
    .sort((a, b) => a.value.localeCompare(b.value));

  return { keys, lookalikes, filesScanned: list.length };
}

/**
 * Diff the derived inventory against the committed declaration.
 *
 * @param {{keys: Array<object>}} scan  output of scanSources
 * @param {{keys: Array<object>}} declared  src/lib/ci/storageInventory.json
 * @returns {{undeclared: Array<object>, stale: Array<object>, classificationMismatch: Array<object>,
 *            kindMismatch: Array<object>, citationMismatch: Array<object>, agreed: string[]}}
 */
export function diffStorageInventory(scan, declared) {
  const derived = (scan && scan.keys) || [];
  const decl = (declared && declared.keys) || [];
  const dByKey = new Map(derived.map((k) => [k.key, k]));
  const cByKey = new Map(decl.map((k) => [k.key, k]));

  const undeclared = derived.filter((k) => !cByKey.has(k.key)).map((k) => ({ key: k.key, classification: k.classification, paths: k.paths }));
  const stale = decl.filter((k) => !dByKey.has(k.key)).map((k) => ({ key: k.key, declaredIn: k.declaredIn }));

  const classificationMismatch = [];
  const kindMismatch = [];
  const citationMismatch = [];
  const agreed = [];
  for (const d of decl) {
    const real = dByKey.get(d.key);
    if (!real) continue;
    if (d.classification !== real.classification) {
      classificationMismatch.push({ key: d.key, declared: d.classification, derived: real.classification, ops: real.ops });
    }
    if (d.kind !== real.kind) {
      kindMismatch.push({ key: d.key, declared: d.kind, derived: real.kind });
    }
    // Every declaring file cited must really contain the key (or the constant that holds it).
    const cited = (d.declaredIn || []).filter((p) => !real.paths.includes(p));
    const missingFromTree = (d.declaredIn || []).filter((p) => !real.paths.includes(p) && !(real.evidence || []).some((e) => e.path === p));
    if (cited.length > 0) {
      citationMismatch.push({ key: d.key, citedButNotUsing: cited, derivedFrom: real.paths, unresolvable: missingFromTree });
    }
    if (cited.length === 0 && d.classification === real.classification && d.kind === real.kind) agreed.push(d.key);
  }
  return { undeclared, stale, classificationMismatch, kindMismatch, citationMismatch, agreed };
}
