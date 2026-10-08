// [F110 / Observatory step 9 (FINAL STEP)] patchCore.js - the PURE half of the
// Live Patch Protocol.
//
// WHAT THIS IS. The dashboard's only way to change behaviour after a build is to
// rebuild and re-publish the single-file bundle (F59). That is correct for a
// production surface, and slow for an operator who is mid-incident and needs one
// section switched off, or one flag flipped, in the next few seconds. F110 adds the
// missing middle layer: a SIGNED patch frame that rides the transport the app
// already trusts, is verified locally, is applied to the toggle surface the app
// already has, is AUDITED in a database the operator can read, and can be ROLLED
// BACK with one click.
//
// NO NEW TRANSPORT, NO NEW SECRET. Patches arrive as `{"type":"patch", …}` frames on
// the EXISTING `/ws` bridge (src/hooks/useDashboardPolling.ts), which is already
// dash-token authenticated twice over (?key= and the `hello` frame). A dedicated
// `/ws/patch` route would have needed: a new server route in payloads/ghrdp-server.ps1,
// a second socket (a second keepalive/reconnect story next to F99/F101's), and a second
// credential. None of that is warranted to deliver a toggle. So the patch surface is a
// MESSAGE TYPE, not an endpoint - and the repo grows no new unauthenticated door.
//
// NO COMPONENT SWAP, ON PURPOSE (spec variant F110a). Applying a patch means moving a
// value in an allowlisted map, not importing code. `import()` of a remote module,
// `eval`, and `new Function` are therefore BANNED in the shipping files and
// tests/f110-live-patch.test.js pins their absence: an app that executes whatever the
// socket sends has no security boundary left to audit. F110b (dynamic import +
// React.lazy swap) is the follow-up, and it must arrive WITH a signature-of-origin
// story stronger than the one here (see §design-drifts in docs/OBSERVATORY-STATE.md).
//
// TRUST MODEL, stated honestly because it is weaker than "code signing":
// the MAC key IS the dashboard token, so "can author a patch" == "can already write to
// this dashboard". What per-frame signing buys is RELAY INTEGRITY: a component that can
// push bytes onto the socket but cannot read the token (a proxy, a misconfigured
// reverse-proxy, any other tab that managed to grab the socket handle) still cannot
// forge a patch, and a captured patch cannot be replayed after its expiry or applied
// twice. A shared MAC cannot prove authorship to a third party - that needs the
// asymmetric keypair F110b proposes. Never claim more than this in UI text.
//
// CONTRACT: no I/O, no DOM, no crypto provider, no imports. The core DECIDES, the
// adapters obey, and tests/f110-live-patch.test.js executes THIS file (the repo's
// standing `*Core.js` + hand-written `.d.ts` convention, as dvr-core.js,
// storageCore.js and debugHudCore.js do). Crypto is injected as an already-computed
// hex string so the core stays synchronous and the same decision table can be proven
// under Node with node:crypto and in the browser with WebCrypto.
"use strict";

/** [F110 §1] the frame discriminator. The hook forwards ONLY this type to us. */
export const PATCH_FRAME_TYPE = "patch";
/**
 * [F110 §1] the transport, pinned as a literal so "we did not add a route" is a
 * fact a gate can check rather than a claim in a comment. tests/f110-live-patch.test.js
 * F110-f asserts this string equals the socket path useDashboardPolling already builds
 * and that no `/ws/patch` appears anywhere in src/.
 */
export const PATCH_CHANNEL_URL = "/ws";
/** [F110 §2] the domain-separator prefix inside the MAC input. A patch MAC is not a MAC of any other message shape. */
export const PATCH_MAC_DOMAIN = "ghrdp-patch-v1";
/** [F110 §2] the only schema version this client understands. */
export const PATCH_SCHEMA_VERSION = 1;
/**
 * [F110 §2] the COMPLETE field set. Anything outside it is `unknown-field`, which is
 * the canonicalization hazard: a field the signer did not cover must never be obeyed.
 */
export const PATCH_FIELD_ORDER = ["v", "type", "id", "op", "feature", "ts", "exp", "sig"];
/** [F110 §2] the fields covered by the MAC (everything but the signature itself). */
export const PATCH_SIGNED_FIELDS = ["v", "type", "id", "op", "feature", "ts", "exp"];
/** [F110 §2] the ops F110a can perform. Two, both reversible, both on the toggle surface. */
export const PATCH_OPS = ["toggle-off", "toggle-on"];
/** [F110 §2] an id must be safe to put in a test id / a log line and must not carry the separator. */
const PATCH_ID_RE = /^[A-Za-z0-9._:-]{1,64}$/;
/** [F110 §2] 64 lowercase hex chars = one SHA-256 HMAC, hex-encoded. Lowercase only: the compare is byte-exact, not fold-case. */
const PATCH_SIG_RE = /^[0-9a-f]{64}$/;
/** [F110 §2] a channel key shorter than this cannot carry an HMAC-SHA256 - refuse rather than verify weakly. */
export const PATCH_MAC_KEY_MIN = 16;
/** [F110 §2] how much of the MAC the AUDIT ROW keeps. The full MAC is authenticator-adjacent: it never lands in a log. */
export const PATCH_SIG_DISPLAY_CHARS = 8;
/** [F110 §4] audit bounds: newest-first list of at most this many rows, trimmed by the core, not by the UI. */
export const PATCH_AUDIT_MAX_ROWS = 200;
/** [F110 §4] the database and store. One literal key, one literal db - so F111's derived inventory can see it. */
export const PATCH_AUDIT_DB = "ghrdp-patches";
export const PATCH_AUDIT_DB_VERSION = 1;
export const PATCH_AUDIT_STORE = "audit";
/** [F110 §1] localStorage arm switch. "true" = armed. Off REMOVES the key (no residue), exactly like f109:enabled. */
export const PATCH_ARM_KEY = "f110:armed";
/** [F110 §3] expiry: a patch older than this is `expired` (replay window), and one further than this into the future is `future-skew`. */
export const PATCH_MAX_AGE_MS = 120000;
export const PATCH_MAX_SKEW_MS = 5000;
/** [F110 §3] the verdict vocabulary. A UI or a gate may never invent a sixth one. */
export const PATCH_VERDICTS = ["applied", "rejected", "duplicate", "ignored-not-patch", "ignored-disarmed"];
/** [F110 §3] every reason `rejected` can carry. Enumeration is the point: an unlisted reason is a bug, not a string. */
export const PATCH_REJECT_REASONS = [
  "bad-json",
  "not-an-object",
  "bad-version",
  "unknown-field",
  "missing-field",
  "bad-id",
  "unknown-op",
  "unknown-feature",
  "bad-timestamp",
  "expired",
  "future-skew",
  "bad-signature-shape",
  "no-channel-key",
  "bad-signature",
];

/** Strict arm semantics, identical to F109's parseEnabled: only the exact string "true". */
export function parseArmed(raw) {
  return raw === "true";
}

/** Is this frame one of ours? Cheap, total, and called by the socket BEFORE progress handling. */
export function isPatchFrame(obj) {
  return !!obj && typeof obj === "object" && obj.type === PATCH_FRAME_TYPE;
}

/**
 * [F110 §2] The canonical message: the bytes the MAC covers, rebuilt from validated
 * fields in a FIXED order with a FIXED separator, prefixed by the domain string.
 *
 * Why not `JSON.stringify(obj)`: key order is whatever the parser saw, whitespace is
 * whatever the sender sent, and an extra field would be included here but not there.
 * The separator `|` is safe because every string field is regex-validated (ids may not
 * contain it) and the numeric fields are finite integers rendered by us.
 */
export function canonicalPatch(msg) {
  if (!msg || typeof msg !== "object") return "";
  const parts = [PATCH_MAC_DOMAIN];
  for (const f of PATCH_SIGNED_FIELDS) {
    const v = msg[f];
    parts.push(f + "=" + (typeof v === "number" ? String(v) : String(v == null ? "" : v)));
  }
  return parts.join("|");
}

/**
 * [F110 §3] Structure BEFORE crypto: a malformed frame must never reach a MAC
 * computation, so the ordering of these checks is itself a security property
 * (channel.ts is pinned to call verifyPatchFrame first).
 *
 * @param {unknown} obj  parsed frame
 * @param {{now?: number, knownFeatures?: string[]}} opts
 * @returns {{ok: boolean, reason: string, msg?: object}}
 */
export function verifyPatchFrame(obj, opts) {
  const now = opts && typeof opts.now === "number" ? opts.now : Date.now();
  const known = (opts && opts.knownFeatures) || [];
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return { ok: false, reason: "not-an-object" };
  if (obj.v !== PATCH_SCHEMA_VERSION) return { ok: false, reason: "bad-version" };
  if (obj.type !== PATCH_FRAME_TYPE) return { ok: false, reason: "bad-version" };
  for (const k of Object.keys(obj)) {
    if (PATCH_FIELD_ORDER.indexOf(k) < 0) return { ok: false, reason: "unknown-field" };
  }
  for (const f of PATCH_FIELD_ORDER) {
    if (obj[f] === undefined || obj[f] === null) return { ok: false, reason: "missing-field" };
  }
  if (typeof obj.id !== "string" || !PATCH_ID_RE.test(obj.id)) return { ok: false, reason: "bad-id" };
  if (PATCH_OPS.indexOf(obj.op) < 0) return { ok: false, reason: "unknown-op" };
  if (known.indexOf(obj.feature) < 0) return { ok: false, reason: "unknown-feature" };
  if (typeof obj.ts !== "number" || !Number.isFinite(obj.ts) || obj.ts <= 0) return { ok: false, reason: "bad-timestamp" };
  if (typeof obj.exp !== "number" || !Number.isFinite(obj.exp)) return { ok: false, reason: "bad-timestamp" };
  if (obj.exp <= obj.ts) return { ok: false, reason: "bad-timestamp" };
  if (obj.exp < now) return { ok: false, reason: "expired" };
  if (obj.ts - now > PATCH_MAX_SKEW_MS) return { ok: false, reason: "future-skew" };
  if (now - obj.ts > PATCH_MAX_AGE_MS) return { ok: false, reason: "expired" };
  if (typeof obj.sig !== "string" || !PATCH_SIG_RE.test(obj.sig)) return { ok: false, reason: "bad-signature-shape" };
  return { ok: true, reason: "", msg: obj };
}

/**
 * [F110 §3] Constant-time-ish hex compare (both sides must be valid hex of the same
 * length, and every byte is examined - a short-circuit `===` leaks the prefix length
 * to anyone who can time a rejection, and this repo's F101 already replaced the
 * server's literal token compares with a constant-time one for the same reason).
 */
export function verifyPatchSignature(msg, macHex) {
  if (!msg || typeof msg.sig !== "string") return { ok: false, reason: "bad-signature" };
  if (typeof macHex !== "string" || !PATCH_SIG_RE.test(macHex)) return { ok: false, reason: "bad-signature" };
  const a = msg.sig;
  const b = macHex.toLowerCase();
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0 ? { ok: true, reason: "" } : { ok: false, reason: "bad-signature" };
}

/** The audit-visible slice of the MAC: enough to correlate, never enough to replay. */
export function redactSignature(sig) {
  if (typeof sig !== "string") return "";
  return sig.slice(0, PATCH_SIG_DISPLAY_CHARS);
}

/**
 * [F110 §4] One audit row, fixed shape. `prev` is the state the CLIENT had before this
 * patch applied, recorded so rollback can invert exactly what happened instead of
 * clearing every toggle in the app (which would also wipe the operator's own
 * HUD switches - a real hazard found while designing this).
 */
export function buildAuditRow(msg, verdict, reason, opts) {
  const o = opts || {};
  return {
    kind: "patch",
    id: msg && msg.id != null ? String(msg.id) : "",
    op: msg && msg.op != null ? String(msg.op) : "",
    feature: msg && msg.feature != null ? String(msg.feature) : "",
    verdict: PATCH_VERDICTS.indexOf(verdict) < 0 ? "rejected" : verdict,
    reason: reason || "",
    sentAt: msg && typeof msg.ts === "number" ? msg.ts : 0,
    seenAt: typeof o.now === "number" ? new Date(o.now).toISOString() : "",
    sig8: redactSignature(msg && msg.sig),
    prev: o.prev === "off" ? "off" : o.prev === "on" ? "on" : "",
  };
}

/** A rollback marker: a row that says "everything before this line was undone". */
export function buildRollbackRow(count, opts) {
  const o = opts || {};
  return {
    kind: "rollback",
    id: "rollback-" + (typeof o.now === "number" ? o.now : Date.now()),
    op: "rollback",
    feature: "",
    verdict: "applied",
    reason: count > 0 ? "rolled-back-" + count : "nothing-to-roll-back",
    sentAt: typeof o.now === "number" ? o.now : 0,
    seenAt: o.now ? new Date(o.now).toISOString() : "",
    sig8: "",
    prev: "",
  };
}

/**
 * [F110 §3] The decision table, as one pure function both halves obey.
 * `appliedIds` is the id set of already-applied patches (from the audit log), so a
 * re-delivered frame is a `duplicate`, never a second application - the same
 * single-install discipline F106's interceptor learned the hard way.
 *
 * @param {{frame: object, now: number, knownFeatures: string[], secretLength: number,
 *          macHex?: string, appliedIds?: string[]}} input
 */
export function decidePatch(input) {
  const now = Number(input && input.now);
  const frame = input && input.frame;
  const v = verifyPatchFrame(frame, { now, knownFeatures: (input && input.knownFeatures) || [] });
  if (!v.ok) return { verdict: "rejected", reason: v.reason, row: buildAuditRow(frame, "rejected", v.reason, { now }) };
  const msg = v.msg;
  if (!(Number(input.secretLength) >= PATCH_MAC_KEY_MIN)) {
    return { verdict: "rejected", reason: "no-channel-key", row: buildAuditRow(msg, "rejected", "no-channel-key", { now }) };
  }
  const s = verifyPatchSignature(msg, input.macHex);
  if (!s.ok) return { verdict: "rejected", reason: s.reason, row: buildAuditRow(msg, "rejected", s.reason, { now }) };
  const applied = (input.appliedIds || []).indexOf(msg.id) >= 0;
  if (applied) return { verdict: "duplicate", reason: "already-applied", row: buildAuditRow(msg, "duplicate", "already-applied", { now }) };
  return {
    verdict: "applied",
    reason: "",
    row: buildAuditRow(msg, "applied", "", { now, prev: input.prev }),
    msg,
  };
}

/** [F110 §4] Keep the newest `max` rows (rows are stored oldest-first). */
export function trimAuditRows(rows, max) {
  const cap = Math.max(1, Number(max) || PATCH_AUDIT_MAX_ROWS);
  const list = Array.isArray(rows) ? rows.slice() : [];
  while (list.length > cap) list.shift();
  return list;
}

/** The id set of applied patches, oldest-first. Deduplicated by id (first wins). */
export function appliedPatchIds(rows) {
  const out = [];
  for (const r of rows || []) {
    if (r && r.kind === "patch" && r.verdict === "applied" && r.id && out.indexOf(r.id) < 0) out.push(r.id);
  }
  return out;
}

/**
 * [F110 §5] The inverse plan. Rules, all of them behaviour a gate pins:
 *   - only rows AFTER the newest rollback marker are undone (rollback is not undoable
 *     twice, and a marker is the record that it happened);
 *   - only `applied` patch rows, never `duplicate`/`rejected` - a rejected patch
 *     changed nothing, so "rolling it back" would corrupt state;
 *   - last-write-wins per feature: one entry per feature, restoring the `prev` of the
 *     newest applied patch for that feature.
 */
export function rollbackPlan(rows) {
  const list = Array.isArray(rows) ? rows.slice() : [];
  let cut = 0;
  for (let i = 0; i < list.length; i += 1) {
    if (list[i] && list[i].kind === "rollback") cut = i + 1;
  }
  const byFeature = {};
  for (const r of list.slice(cut)) {
    if (!r || r.kind !== "patch" || r.verdict !== "applied" || !r.feature) continue;
    byFeature[r.feature] = r.prev === "off"; // restore: was it off before? then switch off again
  }
  return Object.keys(byFeature)
    .sort()
    .map((feature) => ({ feature, off: byFeature[feature] }));
}

/** [F110 §6] What the audit view's header line says. Derived, so it cannot lie. */
export function summarizeAudit(rows) {
  const out = { applied: 0, rejected: 0, duplicate: 0, ignored: 0, total: 0, lastSeenAt: "" };
  for (const r of rows || []) {
    if (!r) continue;
    out.total += 1;
    if (r.verdict === "applied" && r.kind === "patch") out.applied += 1;
    else if (r.verdict === "rejected") out.rejected += 1;
    else if (r.verdict === "duplicate") out.duplicate += 1;
    else if (String(r.verdict).indexOf("ignored") === 0) out.ignored += 1;
    if (r.seenAt && r.seenAt > out.lastSeenAt) out.lastSeenAt = r.seenAt;
  }
  return out;
}

/**
 * [F110 §4] Whether the toggle surface should currently honour a stored "off" entry.
 * `enabled` here is `hudEnabled OR patchArmed`: a patch is an explicit, signed,
 * audited opt-in, so it does not need the HUD to be open to bite - but with NEITHER
 * armed, every stored "off" is inert and the whole dashboard renders. That is the
 * prod-safety rule F109 established for dev toggles, kept and extended, not relaxed.
 */
export function toggleSurfaceActive(hudEnabled, patchArmed) {
  return hudEnabled === true || patchArmed === true;
}
