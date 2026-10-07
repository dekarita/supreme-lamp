// [F107 §3] Screenshot geometry + validation - the pure half of Full DVR's
// click screenshots.
//
// WHY PLAIN JS. The capture half (src/lib/dvr/screenshots.ts) needs a real
// document + canvas; the half that decides the thumbnail box, the byte budget and
// what counts as a valid shot is pure arithmetic and must run under
// `node --test tests/*.test.js` (the §GATE-EXECUTES-SHIPPED-CODE rule).
//
// PRIVACY/WEIGHT CONTRACT. A shot is a DOWNSCALED thumbnail (never full
// resolution), a data URL (never a network upload), and it carries a byte ceiling
// so a pathological page cannot blow the session budget. The ONLY pixels a DVR
// session ever holds come out of this fenced pipeline; mutation descriptors carry
// structure, never content (src/lib/dvr/mutationCore.js).

/** The thumbnail box every shot is fitted into. */
export const THUMB_W = 320;
export const THUMB_H = 240;
/** A single shot larger than this (bytes of the data URL payload) is refused. */
export const SHOT_MAX_BYTES = 200_000;
/** Shots per session, newest-win (one per recorded click, bounded). */
export const SHOT_SESSION_CAP = 100;

function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * devicePixelRatio-aware thumbnail geometry. The SOURCE of a screenshot is
 * `view * dpr` device pixels; the thumbnail preserves the aspect ratio inside the
 * 320x240 box. Returns integer dims >= 1x1, plus the scale actually applied, so a
 * reader can tell a 1x capture from a 2x one.
 */
export function fitThumb(viewW, viewH, dpr) {
  const d = Math.max(num(dpr, 1), 0.25);
  const sw = Math.max(Math.round(num(viewW, 0) * d), 1);
  const sh = Math.max(Math.round(num(viewH, 0) * d), 1);
  const scale = Math.min(THUMB_W / sw, THUMB_H / sh, 1);
  return {
    sourceW: sw,
    sourceH: sh,
    w: Math.max(Math.round(sw * scale), 1),
    h: Math.max(Math.round(sh * scale), 1),
    scale: scale,
    dpr: d,
  };
}

/** Byte size of a data URL's payload, without any decoding. */
export function dataUrlBytes(dataUrl) {
  const s = String(dataUrl == null ? "" : dataUrl);
  const at = s.indexOf(",");
  if (at < 0) return 0;
  const b64 = s.slice(at + 1);
  // base64 encodes 3 bytes per 4 chars; padding is not data.
  const pad = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return Math.floor((b64.length * 3) / 4) - pad;
}

/** The mime prefix a valid shot must carry (PNG only: one decoder everywhere). */
export const SHOT_MIME_PREFIX = "data:image/png;base64,";

/** Strict validation of one shot record. Returns {ok, reason}. */
export function validShot(shot) {
  if (!shot || typeof shot !== "object") return { ok: false, reason: "not-an-object" };
  const url = String(shot.dataUrl || "");
  if (!url.startsWith(SHOT_MIME_PREFIX)) return { ok: false, reason: "not-a-png-data-url" };
  const bytes = dataUrlBytes(url);
  if (bytes <= 0) return { ok: false, reason: "empty-payload" };
  if (bytes > SHOT_MAX_BYTES) return { ok: false, reason: "over-byte-budget" };
  const w = num(shot.w, 0);
  const h = num(shot.h, 0);
  if (w < 1 || h < 1) return { ok: false, reason: "bad-dims" };
  if (w > THUMB_W || h > THUMB_H) return { ok: false, reason: "not-downscaled" };
  return { ok: true, reason: "", bytes: bytes };
}

/** Append shots to a session, newest-win, capped (pure). */
export function appendShots(buffer, shots, opts) {
  const cur = Array.isArray(buffer) ? buffer : [];
  const add = Array.isArray(shots) ? shots : [];
  const cap = num(opts && opts.sessionCap, SHOT_SESSION_CAP);
  const next = cur.concat(add);
  return next.length > cap ? next.slice(next.length - cap) : next;
}
