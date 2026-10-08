// [F110b / maintenance step M1] signatureCore.js - the PURE half of the Ed25519
// patch-signature layer.
//
// WHAT F110a SHIPPED, and what this adds. F110a authenticates a patch frame with
// HMAC-SHA256 keyed by the dashboard token itself (patchCore.js). That proves
// *relay* integrity, not authorship: whoever can read the token can mint a frame,
// and the client cannot tell two token-holders apart. F110b's ask (#179) is the
// asymmetric upgrade - the dashboard verifies a per-frame Ed25519 signature
// against ONE public key the operator pinned at build time, so "can author a
// patch" stops being identical to "can already write to this dashboard".
//
// WHY THIS IS A SCAFFOLD, AND WHY IT IS FAIL-CLOSED. Two production facts were
// measured before a line was written, and both are re-checked by
// tests/f110b-signing.test.js:
//   1. there is no pinned public key anywhere in this tree (grep: no `Ed25519`,
//      no `PATCH_PUBLIC_KEY`, no SPKI/raw key material in src/), and inventing one
//      would mean inventing a trust anchor that matches no private key;
//   2. there is no patch EMITTER. The `/ws` server is payloads/ghrdp-server.ps1
//      (F99's RFC6455 lane, which pushes diag + ping frames and nothing else -
//      zero occurrences of a `"type":"patch"` frame, of `patchFrame`, or of
//      `SendPatch`), and payloads/ghrdp-handler/ is a .NET console app for the
//      Windows `ghrdp:connect?rid=` protocol handler, not a server at all.
// So this step ships the VERIFIER and refuses to claim end-to-end signing. The
// refusal is the design, expressed as one matrix:
//
//   pin ABSENT (today's build)   v1 HMAC frame  -> the F110a path, byte-identical
//                                v2 Ed25519     -> rejected `no-signer-pin`
//   pin PRESENT (operator sets)  v1 HMAC frame  -> rejected `legacy-mac-refused`
//                                v2 Ed25519     -> verified against the pin
//   either                       anything else  -> rejected `unknown-sig-alg`
//
// Every cell refuses by default. There is no cell in which an unpinned build
// accepts an asymmetric frame (a future emitter cannot be trusted before the
// operator pins its key), and no cell in which pinning a key leaves the weaker
// shared-secret path open (pinning IS the upgrade switch, not a comment).
//
// WHAT IS DELIBERATELY NOT HERE: no private key of any kind in src/ (the operator
// signs off-box - see docs/F110B-SIGNING.md and scripts/f110b-sign-patch.mjs), no
// key generation at runtime, no key fetch (a pin fetched over the network is not
// a pin), no new transport, no new storage key, no dependency.
//
// CONTRACT: no I/O, no DOM, no crypto provider, no imports - the same convention as
// patchCore.js and the other `*Core.js` files, so tests/f110b-signing.test.js can
// EXECUTE this file under `node --test`. The two constants it shares with patchCore
// (the replay window and the skew allowance) are duplicated rather than imported
// because a core must stay standalone; tests/f110b-signing.test.js imports BOTH
// cores and asserts they agree, so the duplication is pinned instead of trusted.
"use strict";

/** [F110b §1] the signature algorithm the only supported v2 scheme uses. */
export const PATCH_SIG_ALG = "ed25519";
/** [F110b §1] the field that names it. Signed (see PATCH_V2_SIGNED_FIELDS), so it cannot be swapped. */
export const PATCH_SIG_ALG_FIELD = "sigAlg";
/** [F110b §1] the schema version an Ed25519 frame carries. 1 stays F110a's, untouched. */
export const PATCH_SCHEMA_VERSION_V2 = 2;
/**
 * [F110b §1] domain separator, distinct from `ghrdp-patch-v1`. A v1 HMAC and a v2
 * signature therefore can never be the same bytes over the same payload, which is
 * what stops a captured v1 MAC being presented as a v2 signature (and vice versa).
 */
export const PATCH_SIG_DOMAIN_V2 = "ghrdp-patch-v2";
/** [F110b §1] the COMPLETE v2 field set. Anything outside it is `unknown-field`. */
export const PATCH_V2_FIELD_ORDER = ["v", "sigAlg", "type", "id", "op", "feature", "ts", "exp", "sig"];
/** [F110b §1] the fields the signature covers: everything but the signature itself. */
export const PATCH_V2_SIGNED_FIELDS = ["v", "sigAlg", "type", "id", "op", "feature", "ts", "exp"];
/** [F110b §2] an Ed25519 public key is 32 raw bytes (RFC 8032), pinned as standard base64. */
export const PATCH_ED25519_PUBLIC_KEY_BYTES = 32;
/** [F110b §2] an Ed25519 signature is 64 bytes. */
export const PATCH_ED25519_SIGNATURE_BYTES = 64;
/** [F110b §2] base64 lengths, pinned because a wrong-length decode is a silent no-op otherwise. */
export const PATCH_ED25519_PUBLIC_KEY_B64_LEN = 44;
export const PATCH_ED25519_SIGNATURE_B64_LEN = 88;
/**
 * [F110b §3] replay window and skew allowance, deliberately IDENTICAL to F110a's
 * (patchCore.PATCH_MAX_AGE_MS / PATCH_MAX_SKEW_MS - the gate imports both cores and
 * asserts equality). Widening the window for the "new" scheme would be a downgrade
 * nobody would notice in review.
 */
export const PATCH_V2_MAX_AGE_MS = 120000;
export const PATCH_V2_MAX_SKEW_MS = 5000;
/** [F110b §1] what a frame can be. `unknown` is refused by every cell of the matrix. */
export const PATCH_SIG_SCHEMES = ["hmac-v1", "ed25519", "unknown"];
/** [F110b §2] why a pin was not usable. Enumerated: an unlisted reason is a bug. */
export const SIGNER_PIN_REASONS = ["", "empty", "bad-base64", "bad-length"];
/**
 * [F110b §3] the four reasons THIS layer adds. Every structural reason it can also
 * produce (`bad-version`, `unknown-field`, `missing-field`, `bad-id`, `unknown-op`,
 * `unknown-feature`, `bad-timestamp`, `expired`, `future-skew`,
 * `bad-signature-shape`, `bad-signature`) is spelled the same way patchCore spells
 * it, so the audit log keeps ONE vocabulary and the panel needs no second table.
 * `sig-crypto-unavailable` is not cosmetic: it separates "this runtime cannot run
 * Ed25519 verify at all" (a browser/Node support gap, see the header) from "the
 * signature does not match the pinned key" (an attacker or a wrong key).
 */
export const PATCH_V2_ONLY_REJECT_REASONS = ["no-signer-pin", "legacy-mac-refused", "unknown-sig-alg", "sig-crypto-unavailable"];

const PATCH_V2_ID_RE = /^[A-Za-z0-9._:-]{1,64}$/;
/** Standard-alphabet base64 with correct padding. URL-safe (`-_`) is refused on purpose: one alphabet, one command in the docs. */
const B64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const B64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Is this frame a v2 patch frame? Total, cheap, no allocation. */
export function isV2PatchFrame(obj) {
  return !!obj && typeof obj === "object" && obj.v === PATCH_SCHEMA_VERSION_V2 && obj.type === "patch";
}

/**
 * [F110b §1] Which scheme a frame claims. The discriminator is `v` plus `sigAlg`,
 * and it is deliberately read from OUTSIDE the signed field set's protection here:
 * flipping `sigAlg` off an ed25519 frame yields a v1 frame that then needs a valid
 * HMAC the attacker cannot produce, and flipping it on yields a frame that needs a
 * pin this build may not have - both directions fail closed, which is why the
 * router can be this cheap. (`sigAlg` IS signed, so a *valid* frame cannot be
 * re-labelled at all; this is about unauthenticated frames only.)
 */
export function frameSignatureScheme(obj) {
  if (!obj || typeof obj !== "object") return "unknown";
  if (obj.v === PATCH_SCHEMA_VERSION_V2) return obj.sigAlg === PATCH_SIG_ALG ? "ed25519" : "unknown";
  if (obj.v === 1) return obj.sigAlg === undefined ? "hmac-v1" : "unknown";
  return "unknown";
}

/**
 * [F110b §2] Strict base64 -> bytes, with no host API: a core may not reach for
 * `atob` (browser) or `Buffer` (Node) and stay executable in both. Padding bits
 * must be zero, so a canonical encoder's output round-trips and a hand-edited
 * string that merely "looks like" base64 does not.
 */
export function base64ToBytes(b64) {
  if (typeof b64 !== "string" || b64.length === 0) return { ok: false, reason: "empty", bytes: null };
  if (!B64_RE.test(b64)) return { ok: false, reason: "bad-base64", bytes: null };
  const clean = b64.replace(/=+$/, "");
  const out = [];
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < clean.length; i += 1) {
    const v = B64_CHARS.indexOf(clean.charAt(i));
    if (v < 0) return { ok: false, reason: "bad-base64", bytes: null };
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 0xff);
    }
  }
  // the leftover bits are padding and must be zero (canonical encoders always emit
  // them that way; a non-zero tail means the string was edited by hand)
  if (bits > 0 && (acc & ((1 << bits) - 1)) !== 0) return { ok: false, reason: "bad-base64", bytes: null };
  return { ok: true, reason: "", bytes: out };
}

/** [F110b §2] bytes -> standard base64. Used by the signer fixture and the pin fingerprint. */
export function bytesToBase64(bytes) {
  const list = Array.isArray(bytes) ? bytes : [];
  let out = "";
  let i = 0;
  while (i < list.length) {
    const b0 = list[i] & 0xff;
    const b1 = i + 1 < list.length ? list[i + 1] & 0xff : 0;
    const b2 = i + 2 < list.length ? list[i + 2] & 0xff : 0;
    const n = list.length - i;
    out += B64_CHARS.charAt(b0 >> 2);
    out += B64_CHARS.charAt(((b0 & 0x03) << 4) | (b1 >> 4));
    out += n > 1 ? B64_CHARS.charAt(((b1 & 0x0f) << 2) | (b2 >> 6)) : "=";
    out += n > 2 ? B64_CHARS.charAt(b2 & 0x3f) : "=";
    i += 3;
  }
  return out;
}

/**
 * [F110b §2] Parse the operator's pinned public key. Returns the NORMALISED base64
 * (trimmed) so the string the verifier decodes is the string the gate pinned.
 * A 32-byte raw key is the pin, not SPKI: `openssl pkey -pubout -outform DER`
 * minus its 12-byte RFC 8410 header, which is exactly what
 * `scripts/f110b-sign-patch.mjs --genkey` prints.
 */
export function parsePinnedPublicKey(raw) {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (text.length === 0) return { ok: false, reason: "empty", b64: "" };
  if (!B64_RE.test(text)) return { ok: false, reason: "bad-base64", b64: "" };
  if (text.length !== PATCH_ED25519_PUBLIC_KEY_B64_LEN) {
    return { ok: false, reason: "bad-length", b64: "" };
  }
  const dec = base64ToBytes(text);
  if (!dec.ok || !dec.bytes || dec.bytes.length !== PATCH_ED25519_PUBLIC_KEY_BYTES) {
    return { ok: false, reason: dec.ok ? "bad-length" : "bad-base64", b64: "" };
  }
  return { ok: true, reason: "", b64: text };
}

/**
 * [F110b §2] The correlation slice of the pin - 8 characters, the same discipline
 * as patchCore.PATCH_SIG_DISPLAY_CHARS: enough for an operator to tell two keys
 * apart in the UI and the audit log, and a public key is public anyway, so this is
 * presentation, not secrecy.
 */
export function pinFingerprint(b64) {
  return typeof b64 === "string" ? b64.slice(0, 8) : "";
}

/**
 * [F110b §1] The canonical v2 message: the bytes the signature covers. Same
 * construction as patchCore.canonicalPatch (fixed field order, `|` separator,
 * domain prefix, numbers rendered by us) with the v2 domain and the v2 field list,
 * so a signer and a verifier that agree on nothing else still agree on these bytes.
 */
export function canonicalPatchV2(msg) {
  if (!msg || typeof msg !== "object") return "";
  const parts = [PATCH_SIG_DOMAIN_V2];
  for (const f of PATCH_V2_SIGNED_FIELDS) {
    const v = msg[f];
    parts.push(f + "=" + (typeof v === "number" ? String(v) : String(v == null ? "" : v)));
  }
  return parts.join("|");
}

/**
 * [F110b §3] Structure BEFORE crypto, mirroring verifyPatchFrame's ordering (which
 * F110-i pins for v1): a malformed frame must never cost an Ed25519 verification,
 * and the reason it was refused must be the structural one, not `bad-signature`.
 *
 * @param {unknown} obj parsed frame
 * @param {{now?: number, knownFeatures?: string[]}} opts
 * @returns {{ok: boolean, reason: string, msg?: object}}
 */
export function verifyPatchV2Frame(obj, opts) {
  const now = opts && typeof opts.now === "number" ? opts.now : Date.now();
  const known = (opts && opts.knownFeatures) || [];
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return { ok: false, reason: "not-an-object" };
  if (obj.v !== PATCH_SCHEMA_VERSION_V2) return { ok: false, reason: "bad-version" };
  if (obj.type !== "patch") return { ok: false, reason: "bad-version" };
  for (const k of Object.keys(obj)) {
    if (PATCH_V2_FIELD_ORDER.indexOf(k) < 0) return { ok: false, reason: "unknown-field" };
  }
  for (const f of PATCH_V2_FIELD_ORDER) {
    if (obj[f] === undefined || obj[f] === null) return { ok: false, reason: "missing-field" };
  }
  if (obj.sigAlg !== PATCH_SIG_ALG) return { ok: false, reason: "unknown-sig-alg" };
  if (typeof obj.id !== "string" || !PATCH_V2_ID_RE.test(obj.id)) return { ok: false, reason: "bad-id" };
  if (["toggle-off", "toggle-on"].indexOf(obj.op) < 0) return { ok: false, reason: "unknown-op" };
  if (known.indexOf(obj.feature) < 0) return { ok: false, reason: "unknown-feature" };
  if (typeof obj.ts !== "number" || !Number.isFinite(obj.ts) || obj.ts <= 0) return { ok: false, reason: "bad-timestamp" };
  if (typeof obj.exp !== "number" || !Number.isFinite(obj.exp)) return { ok: false, reason: "bad-timestamp" };
  if (obj.exp <= obj.ts) return { ok: false, reason: "bad-timestamp" };
  if (obj.exp < now) return { ok: false, reason: "expired" };
  if (obj.ts - now > PATCH_V2_MAX_SKEW_MS) return { ok: false, reason: "future-skew" };
  if (now - obj.ts > PATCH_V2_MAX_AGE_MS) return { ok: false, reason: "expired" };
  if (typeof obj.sig !== "string" || obj.sig.length !== PATCH_ED25519_SIGNATURE_B64_LEN) {
    return { ok: false, reason: "bad-signature-shape" };
  }
  const dec = base64ToBytes(obj.sig);
  if (!dec.ok || !dec.bytes || dec.bytes.length !== PATCH_ED25519_SIGNATURE_BYTES) {
    return { ok: false, reason: "bad-signature-shape" };
  }
  return { ok: true, reason: "", msg: obj };
}

/**
 * [F110b §1] THE FAIL-CLOSED MATRIX, as one pure function. This is the whole
 * security decision of this step, so it is a table a gate can enumerate rather
 * than an `if` scattered through the adapter.
 *
 * @param {{frame: object, pinOk: boolean}} input
 * @returns {{action: "v1"|"v2"|"refuse", scheme: string, reason: string}}
 */
export function signatureGate(input) {
  const frame = input && input.frame;
  const pinOk = !!(input && input.pinOk);
  const scheme = frameSignatureScheme(frame);
  if (scheme === "unknown") return { action: "refuse", scheme, reason: "unknown-sig-alg" };
  if (!pinOk) {
    // No pin: the shared-secret path is all this build can verify. An asymmetric
    // frame is refused rather than falling back to the MAC, because "verify it if
    // you can, else accept the weaker one" is exactly the downgrade an attacker
    // would ask for.
    if (scheme === "ed25519") return { action: "refuse", scheme, reason: "no-signer-pin" };
    return { action: "v1", scheme, reason: "" };
  }
  // Pinned: the pin is the upgrade switch, so the shared-secret path closes the
  // moment it lands. Leaving v1 open would mean the strongest key in the repo
  // protects nothing, since anyone holding the token could still send v1 frames.
  if (scheme === "hmac-v1") return { action: "refuse", scheme, reason: "legacy-mac-refused" };
  return { action: "v2", scheme, reason: "" };
}

/**
 * [F110b §3] The v2 decision table. Same shape as patchCore.decidePatch (verdict +
 * reason + the message it decided on), with ONE difference worth stating: it does
 * NOT build the audit row. The row shape is patchCore.buildAuditRow's, and a second
 * row builder would be a second place for the log's columns to drift - the channel
 * calls buildAuditRow for both schemes, and tests/f110b-signing.test.js pins that.
 *
 * Order is a security property and the adapter is pinned to match it:
 *   pin (fail closed before any work) -> structure (before any crypto) ->
 *   signature (already computed by the adapter) -> dedupe -> apply.
 *
 * @param {{frame: object, now: number, knownFeatures: string[], pinOk: boolean,
 *          sigVerified?: {ok: boolean, reason: string}|null, appliedIds?: string[]}} input
 * @returns {{verdict: string, reason: string, msg?: object}}
 */
export function decidePatchV2(input) {
  const frame = input && input.frame;
  const now = Number(input && input.now);
  if (!input || input.pinOk !== true) return { verdict: "rejected", reason: "no-signer-pin" };
  const v = verifyPatchV2Frame(frame, { now, knownFeatures: (input && input.knownFeatures) || [] });
  if (!v.ok) return { verdict: "rejected", reason: v.reason };
  const msg = v.msg;
  const s = input.sigVerified;
  if (!s || s.ok !== true) {
    return {
      verdict: "rejected",
      reason: s && s.reason === "crypto-unavailable" ? "sig-crypto-unavailable" : "bad-signature",
    };
  }
  if (((input && input.appliedIds) || []).indexOf(msg.id) >= 0) {
    return { verdict: "duplicate", reason: "already-applied", msg };
  }
  return { verdict: "applied", reason: "", msg };
}
