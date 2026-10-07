// [F107 §5] The `.mcrec` v2 bundle - the pure half of Full DVR's export.
//
// WHY A v2 NEXT TO v1. Step 3 shipped `mcrec1` (clicks only, clipboard-shaped,
// tests/f-dvr-lite.test.js pins it byte-for-byte and it must keep working: the
// FAB's Copy still emits v1 envelopes). F107's bundle is a SUPERSET assembled by a
// different writer: timeline + mutations + screenshots + stored-session index +
// feature registry snapshot. Same format tag (`mcrec`), version 2, and its own
// envelope codec tag (`mcrec2:`) so a reader can never confuse the two - and so a
// v1 decoder that meets a v2 line answers "not mine" instead of parsing half of it.
//
// PRIVACY POSTURE (unchanged from step 3): the bundle is assembled in the tab,
// shown to the operator, and only leaves the machine when the operator clicks
// Export (file download) - there is no network path in any F107 file
// (tests/f107-dvr-full.test.js scans for it).

import { DVR_FORMAT, toBase64, fromBase64 } from "../dvr-core.js";
import { validShot } from "./screenshotCore.js";

export const DVR_BUNDLE_V2_VERSION = 2;
/** The envelope head a v2 line carries. */
export const DVR_V2_ENVELOPE = DVR_FORMAT + DVR_BUNDLE_V2_VERSION;

function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * Assemble a v2 bundle. Inputs:
 *  - timeline: the DVR ring entries (click/settle/route), in seq order
 *  - mutations: descriptors from src/lib/dvr/mutationCore.js
 *  - shots: validated screenshot records (dataUrl may be stripped by the caller
 *    for an index-only export)
 *  - sessions: stored-session metas (the IndexedDB index)
 *  - features: registry snapshot [{id, route}] - the F105 registry, read-only
 *  - target: {route, buildSha, lang, ui} exactly like v1 (closed key set)
 */
export function buildBundleV2(inputs, opts) {
  const src = inputs || {};
  const timeline = Array.isArray(src.timeline) ? src.timeline.slice() : [];
  const mutations = Array.isArray(src.mutations) ? src.mutations.slice() : [];
  const shots = Array.isArray(src.shots) ? src.shots.slice() : [];
  const sessions = Array.isArray(src.sessions) ? src.sessions.slice() : [];
  const features = Array.isArray(src.features) ? src.features.slice() : [];
  const target = src.target || {};
  const now = num(opts && opts.now, 0);
  const storageBytes = sessions.reduce((acc, s) => acc + num(s && s.bytes, 0), 0);
  return {
    format: DVR_FORMAT,
    version: DVR_BUNDLE_V2_VERSION,
    createdAt: new Date(now).toISOString(),
    target: {
      route: String(target.route || ""),
      buildSha: String(target.buildSha || "dev"),
      lang: String(target.lang || "en"),
      ui: String(target.ui || "v2"),
    },
    timeline: timeline,
    mutations: mutations,
    shots: shots,
    storage: {
      sessions: sessions.map((s) => ({
        id: String((s && s.id) || ""),
        startedAt: num(s && s.startedAt, 0),
        endedAt: num(s && s.endedAt, 0),
        clicks: num(s && s.clicks, 0),
        mutations: num(s && s.mutations, 0),
        shots: num(s && s.shots, 0),
        bytes: num(s && s.bytes, 0),
      })),
      bytes: storageBytes,
    },
    features: features.map((f) => ({ id: String((f && f.id) || ""), route: String((f && f.route) || "") })),
  };
}

/** The exact bytes an export writes: compact JSON (file-shaped, not clipboard-shaped). */
export function bundleV2Text(bundle) {
  return JSON.stringify(bundle);
}

/**
 * Strict validation. Returns {ok, reason} and NEVER throws - an export the reader
 * cannot trust must read as invalid, not crash. The checks mirror buildBundleV2's
 * contract, so a mutated writer fails the gate (falsification M-see-the-suite).
 */
export function validateBundleV2(x) {
  if (!x || typeof x !== "object") return { ok: false, reason: "not-an-object" };
  if (x.format !== DVR_FORMAT) return { ok: false, reason: "bad-format" };
  if (x.version !== DVR_BUNDLE_V2_VERSION) return { ok: false, reason: "bad-version" };
  if (typeof x.createdAt !== "string" || !x.createdAt) return { ok: false, reason: "bad-createdAt" };
  const target = x.target;
  if (!target || typeof target !== "object") return { ok: false, reason: "bad-target" };
  const targetKeys = Object.keys(target).sort().join(",");
  if (targetKeys !== "buildSha,lang,route,ui") return { ok: false, reason: "target-keys-drifted" };
  for (const field of ["timeline", "mutations", "shots", "features"]) {
    if (!Array.isArray(x[field])) return { ok: false, reason: "missing-" + field };
  }
  if (!x.storage || typeof x.storage !== "object" || !Array.isArray(x.storage.sessions)) {
    return { ok: false, reason: "missing-storage" };
  }
  // Timeline must be seq-ordered and gap-free-ish (strictly non-decreasing).
  let lastSeq = -1;
  for (const e of x.timeline) {
    const seq = num(e && e.seq, -1);
    if (seq < lastSeq) return { ok: false, reason: "timeline-out-of-order" };
    lastSeq = seq;
  }
  // Every embedded shot must pass the screenshot fence.
  for (const s of x.shots) {
    const v = validShot(s);
    if (!v.ok) return { ok: false, reason: "bad-shot:" + v.reason };
  }
  // Storage index arithmetic must agree.
  const sum = x.storage.sessions.reduce((acc, s) => acc + num(s && s.bytes, 0), 0);
  if (Math.abs(sum - num(x.storage.bytes, -1)) > 1) return { ok: false, reason: "storage-bytes-drift" };
  return { ok: true, reason: "" };
}

/** v2 envelope: `mcrec2:<codec>:<base64>` - the codec set mirrors v1 (gzip|plain),
 *  the version tag is what keeps the two decoders from ever meeting. */
export function encodeEnvelopeV2(codec, base64) {
  return DVR_V2_ENVELOPE + ":" + String(codec || "plain") + ":" + String(base64 || "");
}

/** Strict parse; null when the line is not a v2 envelope (a v1 line included). */
export function decodeEnvelopeV2(text) {
  const s = String(text == null ? "" : text).trim();
  const head = DVR_V2_ENVELOPE + ":";
  if (!s.startsWith(head)) return null;
  const rest = s.slice(head.length);
  const at = rest.indexOf(":");
  if (at < 0) return null;
  const codec = rest.slice(0, at);
  if (codec !== "gzip" && codec !== "plain") return null;
  const payload = rest.slice(at + 1);
  const bytes = fromBase64(payload);
  if (!bytes) return null;
  return { codec: codec, base64: payload, bytes: bytes };
}

/** Re-export so the browser side has one import site for base64. */
export { toBase64, fromBase64 };
