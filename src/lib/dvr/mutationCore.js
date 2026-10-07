// [F107 §2] Mutation descriptors - the pure half of Full DVR's DOM observation.
//
// WHY THIS FILE EXISTS (and why it is plain JS). The observer half
// (src/lib/dvr/mutations.ts) touches window/document, so it can only be proven in
// jsdom. The half that decides WHAT a MutationRecord becomes - the descriptor
// shape, the privacy redaction, the batch bound, the wire format - is pure data
// logic and must be provable in the CI job that runs `node --test tests/*.test.js`
// with no DOM at all. Same convention as src/lib/dvr-core.js (step 3) and
// src/lib/lab/labCore.js (step 5): one rule file, two consumers, no re-implementation.
//
// PRIVACY CONTRACT (this file is where F107's deliberate content scope is fenced).
// Step 3's F-DVR-LITE only COUNTED mutations (F-DVR-g pins that). F107 is the step
// that was handed DOM observation as its own, separate, enumerated scope - and the
// scope is still narrow:
//   * a descriptor carries the target's TAG NAME and the ATTRIBUTE NAME that moved,
//     never an attribute VALUE, never characterData, never node text;
//   * childList movement is COUNTS (added/removed), never the nodes themselves;
//   * nothing here reads the DOM - it transforms MutationRecord objects it is
//     handed, so the gate can drive it with synthetic records in Node.
// The screenshot pipeline (screenshotCore) is the only pixel-level surface and is
// fenced the same way in its own file.

/** Descriptor kinds mirror MutationRecord.type; anything else is refused. */
export const MUTATION_KINDS = ["childList", "attributes", "characterData"];

/** One observer batch cannot add more descriptors than this; the surplus is
 *  folded into the last descriptor's `folded` counter, so a React commit storm
 *  cannot grow a session without bound. */
export const MUTATION_BATCH_CAP = 50;

/** How many descriptors one session buffer keeps (newest win). */
export const MUTATION_SESSION_CAP = 500;

/**
 * Tag name of a mutation target WITHOUT reading any content of the node.
 * `nodeName` is structural metadata (like `tag` in F104's click descriptors),
 * not content - the F-DVR-g class (innerHTML/textContent/getAttribute) stays
 * absent from this file and the gate scans for it.
 */
function targetName(node) {
  try {
    const n = node && typeof node.nodeName === "string" ? node.nodeName : "";
    // #text / #comment / #document-fragment are structural markers, lowercased
    // to keep descriptors greppable; an element reports its tag name lowercased.
    return n ? n.toLowerCase() : "?";
  } catch {
    return "?";
  }
}

function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * Turn one batch of MutationRecords into compact descriptors. `opts.now` is the
 * batch timestamp (injected, never read from a clock here). Returns a bounded
 * array; excess records fold into the last descriptor's `folded` count.
 */
export function recordMutations(records, opts) {
  const list = Array.isArray(records) ? records : [];
  const at = num(opts && opts.now, 0);
  const cap = num(opts && opts.batchCap, MUTATION_BATCH_CAP);
  /** @type {Array<Record<string, unknown>>} */
  const out = [];
  let folded = 0;
  for (const r of list) {
    const type = String((r && r.type) || "");
    if (MUTATION_KINDS.indexOf(type) < 0) continue; // never invent a descriptor
    if (out.length >= cap) {
      folded++;
      continue;
    }
    /** @type {Record<string, unknown>} */
    const d = { at: at, type: type, target: targetName(r && r.target) };
    if (type === "childList") {
      d.added = r && r.addedNodes ? r.addedNodes.length : 0;
      d.removed = r && r.removedNodes ? r.removedNodes.length : 0;
    } else if (type === "attributes") {
      // The NAME of the attribute that moved is diagnostic ("class", "aria-busy");
      // its VALUE would be content, and content is the screenshot pipeline's
      // fenced, pixel-only job. oldValue is deliberately never read.
      d.attr = String((r && r.attributeName) || "");
    }
    // characterData: type + target only. The record's `data` is never touched -
    // a text mutation is reported as "some text node changed", full stop.
    out.push(d);
  }
  if (folded > 0 && out.length > 0) out[out.length - 1].folded = folded;
  return out;
}

/** Append descriptors to a session buffer, newest-win, capped. Pure: returns the
 *  new buffer (never mutates its input). */
export function appendMutations(buffer, descriptors, opts) {
  const cur = Array.isArray(buffer) ? buffer : [];
  const add = Array.isArray(descriptors) ? descriptors : [];
  const cap = num(opts && opts.sessionCap, MUTATION_SESSION_CAP);
  const next = cur.concat(add);
  return next.length > cap ? next.slice(next.length - cap) : next;
}

/** The wire form inside a `.mcrec` v2 bundle: compact JSON. */
export function serializeMutations(list) {
  return JSON.stringify(Array.isArray(list) ? list : []);
}

/** Strict parse; null on anything malformed (a truncated export must read as
 *  "no mutations", never throw inside the reader). */
export function deserializeMutations(text) {
  try {
    const parsed = JSON.parse(String(text == null ? "" : text));
    if (!Array.isArray(parsed)) return null;
    for (const d of parsed) {
      if (!d || typeof d !== "object") return null;
      if (MUTATION_KINDS.indexOf(String(d.type)) < 0) return null;
      if (typeof d.target !== "string") return null;
      if (d.type === "attributes" && typeof d.attr !== "string") return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/** Count-by-type for panels and bundle summaries. */
export function mutationStats(list) {
  const l = Array.isArray(list) ? list : [];
  const byType = {};
  for (const d of l) {
    const k = String((d && d.type) || "unknown");
    byType[k] = (byType[k] || 0) + 1;
  }
  return { count: l.length, byType: byType };
}
