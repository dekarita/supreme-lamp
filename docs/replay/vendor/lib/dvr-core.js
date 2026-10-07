// [F-DVR-LITE §2] DVR ring CORE - the pure half of the diagnostic DVR.
//
// WHY THIS FILE EXISTS (and why it is plain JS). The recorder half
// (src/lib/dvr.ts) touches window/document/CompressionStream, so it can only be
// proven in jsdom. The half that actually decides what survives - the time
// window, the entry cap, the bundle shape, the paste envelope - is pure data
// logic and must be provable in the CI job that runs `node --test tests/*.test.js`
// with no DOM at all. So it lives here, exactly like src/search/custom-source-core.js
// does for F58: one rule file, two consumers (the browser wiring and the Node gate),
// no re-implementation in either.
//
// CONTRACT: this module performs NO I/O of any kind. No fetch, no XHR, no
// WebSocket, no storage, no DOM read, no Node fs - the strings for those APIs do
// not appear in this file, and tests/f-dvr-lite.test.js scans for them. Option (d)
// of #169 is "no upload at all": the bundle is assembled in the tab, handed to the
// clipboard by the caller, and that is the whole story.
//
// [F-DVR-LITE §2.1] The window is 30 s - the DVR's own retention window. It is
// deliberately NOT F104's 10 s observation window (#168 re-derived the two: 10 s is
// how long F104 watches one click's fetch/popup, 30 s is how much click history the
// operator can hand over). Entry cap 200 is the other direction of eviction, so a
// click storm cannot grow the payload without bound.

/** The envelope/format tag every `.mcrec` carries. */
export const DVR_FORMAT = "mcrec";
/** Bumped whenever the bundle shape changes in a way a reader must notice. */
export const DVR_VERSION = 1;
/** How much click history the ring keeps. */
export const DVR_WINDOW_MS = 30_000;
/** Hard cap on retained entries (time window AND count, whichever binds first). */
export const DVR_MAX_ENTRIES = 200;
/** The entry kinds the ring understands. */
export const DVR_KINDS = ["click", "settle", "route"];

function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * Create the ring. `now` is always passed in (never read from a clock here) so the
 * Node gate can drive time deterministically and the browser can use Date.now().
 */
export function createRing(opts) {
  const windowMs = num(opts && opts.windowMs, DVR_WINDOW_MS);
  const maxEntries = num(opts && opts.maxEntries, DVR_MAX_ENTRIES);
  /** @type {Array<Record<string, unknown>>} */
  let entries = [];
  let seq = 0;

  const prune = (now) => {
    const t = num(now, 0);
    const cutoff = t - windowMs;
    if (entries.length) {
      let drop = 0;
      while (drop < entries.length && num(entries[drop].at, 0) < cutoff) drop++;
      if (drop) entries = entries.slice(drop);
    }
    if (entries.length > maxEntries) entries = entries.slice(entries.length - maxEntries);
    return entries.length;
  };

  return {
    windowMs,
    maxEntries,
    /** Append one entry; returns the stored entry (with its seq/time). */
    push(entry, now) {
      const at = num(now, 0);
      const stored = Object.assign({}, entry, { seq: ++seq, at: at });
      entries = entries.concat([stored]);
      prune(at);
      return stored;
    },
    prune: prune,
    list(now) {
      prune(now);
      return entries.slice();
    },
    size(now) {
      return prune(now);
    },
    /** Drop everything (the FAB's Clear). The seq keeps counting: an entry id is
     *  never reused, so a bundle can prove it is a strict suffix of a longer log. */
    clear() {
      entries = [];
      return 0;
    },
    get seq() {
      return seq;
    },
  };
}

/** Count entries and time span - what the FAB renders as "what you are about to copy". */
export function ringStats(entries) {
  const list = Array.isArray(entries) ? entries : [];
  const byKind = {};
  for (const e of list) {
    const k = String((e && e.kind) || "unknown");
    byKind[k] = (byKind[k] || 0) + 1;
  }
  const first = list.length ? num(list[0].at, 0) : 0;
  const last = list.length ? num(list[list.length - 1].at, 0) : 0;
  return {
    count: list.length,
    byKind: byKind,
    firstAt: first,
    lastAt: last,
    spanMs: list.length > 1 ? last - first : 0,
  };
}

/**
 * Assemble the `.mcrec` bundle. `target` describes WHERE the recording happened
 * (route, build sha, language, ui flavour). It is intentionally NOT the user agent,
 * the screen size, or anything else that identifies the machine: the operator is
 * pasting this into a chat, and the only fields a reader needs to reproduce the
 * bug are the ones here.
 */
export function buildBundle(entries, target, opts) {
  const list = Array.isArray(entries) ? entries.slice() : [];
  const stats = ringStats(list);
  return {
    format: DVR_FORMAT,
    version: DVR_VERSION,
    createdAt: new Date(num(opts && opts.now, Date.now())).toISOString(),
    windowMs: num(opts && opts.windowMs, DVR_WINDOW_MS),
    maxEntries: num(opts && opts.maxEntries, DVR_MAX_ENTRIES),
    target: {
      route: String((target && target.route) || ""),
      buildSha: String((target && target.buildSha) || "dev"),
      lang: String((target && target.lang) || "en"),
      ui: String((target && target.ui) || "v2"),
    },
    counts: stats,
    entries: list,
  };
}

/** The exact bytes a reader parses: compact JSON, no indentation (clipboard-shaped). */
export function bundleText(bundle) {
  return JSON.stringify(bundle);
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Base64 of a byte array. Hand-rolled so the same code runs in Node and the
 *  browser without Buffer/Promise tricks; chunked so a large bundle cannot blow
 *  the argument limit of String.fromCharCode. */
export function toBase64(bytes) {
  const b = bytes || new Uint8Array(0);
  let out = "";
  let chunk = "";
  for (let i = 0; i < b.length; i += 3) {
    const b0 = b[i];
    const b1 = i + 1 < b.length ? b[i + 1] : 0;
    const b2 = i + 2 < b.length ? b[i + 2] : 0;
    chunk += B64[b0 >> 2] + B64[((b0 & 3) << 4) | (b1 >> 4)] + (i + 1 < b.length ? B64[((b1 & 15) << 2) | (b2 >> 6)] : "=") + (i + 2 < b.length ? B64[b2 & 63] : "=");
    if (chunk.length >= 8192) {
      out += chunk;
      chunk = "";
    }
  }
  return out + chunk;
}

/** Inverse of toBase64; returns null on anything malformed (never throws - a
 *  corrupt paste must read as "not a bundle", not as a crash in the reader). */
export function fromBase64(text) {
  const s = String(text == null ? "" : text).replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(s) || s.length % 4 !== 0) return null;
  const clean = s.replace(/=+$/, "");
  const out = new Uint8Array((clean.length * 3) >> 2);
  let acc = 0;
  let bits = 0;
  let o = 0;
  for (const ch of clean) {
    const v = B64.indexOf(ch);
    if (v < 0) return null;
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 0xff;
    }
  }
  return out.slice(0, o);
}

/** UTF-8 byte length of the bundle, for the "{{chars}} chars" line. */
export function byteLength(text) {
  return new TextEncoder().encode(String(text == null ? "" : text)).length;
}

/** The paste envelope: one line, greppable, codec-tagged.
 *  `mcrec1:gzip:<base64>` / `mcrec1:plain:<base64>` */
export function encodeEnvelope(codec, base64) {
  return DVR_FORMAT + DVR_VERSION + ":" + String(codec || "plain") + ":" + String(base64 || "");
}

/** Strict parse of the envelope; null when the text is not a `.mcrec` line. */
export function decodeEnvelope(text) {
  const s = String(text == null ? "" : text).trim();
  const head = DVR_FORMAT + DVR_VERSION + ":";
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
