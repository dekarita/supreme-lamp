// [F108 §2] Public Replay Viewer CORE - the pure half of the `.mcrec` reader.
//
// WHY THIS FILE EXISTS (and why it is plain JS). The viewer half
// (docs/replay/app.js) touches document/File/DecompressionStream, so it can only
// run in a browser or jsdom. The half that decides WHAT A BUNDLE IS - which
// envelope it came in, whether it is v1 or v2, whether it may be trusted, how it
// is summarized, which rows a timeline renders - is pure data logic and must be
// provable by the CI job that runs `node --test tests/*.test.js` with no DOM at
// all, on the EXACT file the public page loads (docs/replay/vendor/replay/
// replayCore.js, a byte-identical copy - tests/f108-replay-core.test.js pins both
// the bytes and the behaviour).
//
// ONE READER, NO SECOND PARSER. The v1 ring (src/lib/dvr-core.js) and the v2
// bundle (src/lib/dvr/exportCore.js) already ship their own strict validators and
// envelope decoders; this module IMPORTS them rather than re-implementing them, so
// a writer change cannot desynchronize the public reader from the recorder.
//
// CONTRACT: no I/O of any kind - no fetch, no XHR, no WebSocket, no storage, no
// DOM, no Node fs, no clock. Nothing here reaches the network, and
// tests/f108-replay-core.test.js scans for that. Decompression is deliberately NOT
// done here: the caller inflates (browser DecompressionStream / test zlib) and
// hands the JSON text back, which keeps this file free of platform APIs.
//
// PRIVACY POSTURE. A `.mcrec` bundle is operator-supplied data and is therefore
// HOSTILE INPUT to this reader: every string is rendered as inert text, every
// route passes the F107 sanitizer, and the only URL this module will ever hand to
// an <img> is a `data:image/png;base64,` thumbnail that passes screenshotCore's
// byte/dimension fence. There is no code path here that produces an http(s) URL.

import { DVR_FORMAT, DVR_VERSION, decodeEnvelope, ringStats } from "../lib/dvr-core.js";
import {
  DVR_BUNDLE_V2_VERSION,
  DVR_V2_ENVELOPE,
  decodeEnvelopeV2,
  validateBundleV2,
} from "../lib/dvr/exportCore.js";
import { validShot } from "../lib/dvr/screenshotCore.js";
import { safeRoute } from "../lib/dvr/routeCore.js";

/** A bundle larger than this (characters) is refused: a diagnostic file that big
 *  is not a diagnostic file, and the reader must not try to JSON.parse it. */
export const REPLAY_MAX_CHARS = 8_000_000;
/** Rows the timeline renders at once. The bundle keeps everything; the DOM does
 *  not have to (a click storm is exactly what F107's cap is for). */
export const MAX_RENDERED_ROWS = 500;
/** How close (ms) a screenshot must be to a timeline entry to be shown with it. */
export const SHOT_ATTACH_MS = 3_000;
/** Longest single field the viewer will render before eliding it. */
export const SAFE_TEXT_MAX = 240;
/** The summary the operator pastes into Arena is bounded too. */
export const SUMMARY_MAX_CHARS = 20_000;

/** The input shapes the reader recognises. */
export const REPLAY_INPUT_KINDS = [
  "empty",
  "too-large",
  "v1-envelope",
  "v2-envelope",
  "json-text",
  "unrecognised",
];

function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Coerce ANY bundle value into inert display text.
 *
 * The viewer never uses innerHTML, and this is the second half of that rule: a
 * value that is an object, a symbol, or a 4 MB string becomes a bounded, control-
 * character-free string. Angle brackets survive as TEXT (they cannot become
 * markup in a textContent world) but control characters do not, because a bundle
 * that carries `\u0000` or an ANSI escape is trying to break a terminal or a log.
 */
export function safeText(value, max) {
  const cap = num(max, SAFE_TEXT_MAX);
  let s;
  if (value == null) return "";
  if (typeof value === "string") s = value;
  else if (typeof value === "number" || typeof value === "boolean") s = String(value);
  else {
    try {
      s = JSON.stringify(value);
    } catch {
      s = String(value);
    }
  }
  // eslint-disable-next-line no-control-regex
  s = String(s == null ? "" : s).replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
  return s.length > cap ? s.slice(0, cap) + "…" : s;
}

/**
 * The ONLY image source this reader will return. Delegates to the shipped
 * screenshot fence (data:image/png;base64, + byte ceiling + thumbnail box), so a
 * bundle carrying `https://attacker/x.png`, `data:text/html,<script>`, or an
 * oversized payload yields "" - the caller then renders a placeholder instead.
 */
export function safeImageSrc(shot) {
  if (!shot || typeof shot !== "object") return "";
  const v = validShot(shot);
  if (!v.ok) return "";
  return String(shot.dataUrl || "");
}

/** A recorded route, sanitized again at DISPLAY time (defence in depth: the
 *  recorder strips `?token=`, and a hand-edited bundle is not trusted either). */
export function routeOf(value) {
  return safeRoute(value);
}

/** Decode bytes to text without touching a BOM or a platform decoder quirk. */
export function decodeUtf8(bytes) {
  try {
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes || new Uint8Array(0));
  } catch {
    return "";
  }
}

/**
 * Classify one operator input (pasted clipboard line, or a whole exported file).
 *
 * Returns `{ok, kind, reason, codec?, bytes?, jsonText?}`:
 *  - `json-text`    - the text already IS the bundle JSON (F107's file export)
 *  - `v1-envelope`  - `mcrec1:<codec>:<base64>`; `jsonText` set for `plain`
 *  - `v2-envelope`  - `mcrec2:<codec>:<base64>`; `jsonText` set for `plain`
 *  - `empty` / `too-large` / `unrecognised` - nothing is parsed, and `reason` says
 *    which of the three it was, in words an operator can act on.
 *
 * `gzip` envelopes come back with `bytes` (the raw compressed payload) and
 * `jsonText === null`: inflating is the caller's job, on purpose (see the contract
 * note at the top of this file).
 */
export function classifyInput(text) {
  const raw = text == null ? "" : String(text);
  const s = raw.trim();
  if (!s) return { ok: false, kind: "empty", reason: "nothing-was-supplied", jsonText: null };
  if (s.length > REPLAY_MAX_CHARS) {
    return { ok: false, kind: "too-large", reason: "input-exceeds-" + REPLAY_MAX_CHARS + "-chars", jsonText: null };
  }
  // A JSON document (the exported `.mcrec` file shape) - decided by the first
  // character, not by a parse attempt, so the reason stays honest for a truncated
  // paste: "looks like JSON but does not parse" is `json-text`, not "unknown".
  if (s[0] === "{" || s[0] === "[") return { ok: true, kind: "json-text", reason: "", jsonText: s };
  for (const [kind, envelope] of [["v1-envelope", decodeEnvelope], ["v2-envelope", decodeEnvelopeV2]]) {
    const env = envelope(s);
    if (!env) continue;
    if (env.codec === "gzip") {
      return { ok: true, kind: kind, reason: "", codec: "gzip", bytes: env.bytes, jsonText: null };
    }
    return { ok: true, kind: kind, reason: "", codec: "plain", bytes: env.bytes, jsonText: decodeUtf8(env.bytes) };
  }
  return { ok: false, kind: "unrecognised", reason: "not-json-and-not-a-mcrec-envelope", jsonText: null };
}

/** Local wrapper so this file names the v2 tag exactly once (and out loud). */
export function v2EnvelopeTag() {
  return DVR_V2_ENVELOPE;
}

/**
 * Parse + validate the bundle JSON. v2 goes through exportCore's strict
 * `validateBundleV2` (the SAME function the recorder runs before it writes), so
 * "the viewer accepted it" and "the exporter produced it" cannot drift. v1 is
 * validated against the ring's published shape.
 */
export function parseBundle(jsonText) {
  const text = jsonText == null ? "" : String(jsonText);
  if (!text.trim()) return { ok: false, version: 0, reason: "empty-json", bundle: null };
  if (text.length > REPLAY_MAX_CHARS) {
    return { ok: false, version: 0, reason: "json-exceeds-" + REPLAY_MAX_CHARS + "-chars", bundle: null };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { ok: false, version: 0, reason: "not-json:" + safeText(err && err.name, 40), bundle: null };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, version: 0, reason: "not-an-object", bundle: null };
  }
  if (parsed.format !== DVR_FORMAT) return { ok: false, version: 0, reason: "bad-format", bundle: null };
  if (parsed.version === DVR_BUNDLE_V2_VERSION) {
    const v = validateBundleV2(parsed);
    if (!v.ok) return { ok: false, version: 2, reason: v.reason, bundle: null };
    return { ok: true, version: 2, reason: "", bundle: parsed };
  }
  if (parsed.version === DVR_VERSION) {
    if (!Array.isArray(parsed.entries)) return { ok: false, version: 1, reason: "missing-entries", bundle: null };
    if (!parsed.target || typeof parsed.target !== "object") {
      return { ok: false, version: 1, reason: "missing-target", bundle: null };
    }
    return { ok: true, version: 1, reason: "", bundle: parsed };
  }
  return { ok: false, version: num(parsed.version, 0), reason: "unsupported-version", bundle: null };
}

/**
 * The reader's verdict on a parsed bundle: what it is, what it holds, and every
 * reason an operator should look twice before believing it. Warnings never block a
 * render (an honest empty session is valid), they travel with the summary.
 */
export function verdict(bundle) {
  if (!bundle || typeof bundle !== "object") {
    return { ok: false, version: 0, reason: "no-bundle", warnings: ["nothing-to-read"], counts: {}, stats: null };
  }
  const warnings = [];
  if (bundle.version === 2) {
    const timeline = Array.isArray(bundle.timeline) ? bundle.timeline : [];
    const shots = Array.isArray(bundle.shots) ? bundle.shots : [];
    const mutations = Array.isArray(bundle.mutations) ? bundle.mutations : [];
    const features = Array.isArray(bundle.features) ? bundle.features : [];
    const sessions = bundle.storage && Array.isArray(bundle.storage.sessions) ? bundle.storage.sessions : [];
    let refusedShots = 0;
    for (const s of shots) if (!safeImageSrc(s)) refusedShots++;
    if (refusedShots) warnings.push(refusedShots + "-shot(s)-refused-by-the-thumbnail-fence");
    if (!timeline.length) warnings.push("timeline-empty");
    if (!shots.length && !mutations.length && timeline.length) {
      warnings.push("no-mutations-or-screenshots-recorded");
    }
    if (!sessions.length) warnings.push("storage-index-empty");
    if (!features.length) warnings.push("feature-snapshot-empty");
    const ages = timeline.map((e) => num(e && e.at, 0)).filter((t) => t > 0);
    if (ages.length > 1) {
      const span = Math.max(...ages) - Math.min(...ages);
      if (span > 10 * 60_000) warnings.push("timeline-span-exceeds-10min");
    }
    const createdAt = Date.parse(String(bundle.createdAt || ""));
    if (!Number.isFinite(createdAt)) warnings.push("createdAt-not-a-timestamp");
    return {
      ok: true,
      version: 2,
      kind: "full",
      reason: "",
      warnings: warnings,
      counts: {
        timeline: timeline.length,
        mutations: mutations.length,
        shots: shots.length,
        sessions: sessions.length,
        features: features.length,
        refusedShots: refusedShots,
        bytes: num(bundle.storage && bundle.storage.bytes, 0),
      },
      stats: ringStats(timeline),
    };
  }
  const entries = Array.isArray(bundle.entries) ? bundle.entries : [];
  if (!entries.length) warnings.push("entries-empty");
  const createdAt = Date.parse(String(bundle.createdAt || ""));
  if (!Number.isFinite(createdAt)) warnings.push("createdAt-not-a-timestamp");
  return {
    ok: true,
    version: 1,
    kind: "lite",
    reason: "",
    warnings: warnings,
    counts: {
      timeline: entries.length,
      mutations: 0,
      shots: 0,
      sessions: 0,
      features: 0,
      refusedShots: 0,
      bytes: 0,
    },
    stats: ringStats(entries),
  };
}

/** One timeline entry, normalised for display. Nothing here is raw HTML. */
export function timelineRows(bundle, opts) {
  const cap = num(opts && opts.maxRows, MAX_RENDERED_ROWS);
  const source = bundle && bundle.version === 2 ? bundle.timeline : bundle && bundle.entries;
  const list = Array.isArray(source) ? source : [];
  const rows = [];
  for (let i = 0; i < list.length; i++) {
    const e = list[i] && typeof list[i] === "object" ? list[i] : {};
    const kind = safeText(e.kind || "unknown", 24);
    const row = {
      index: i,
      seq: num(e.seq, i + 1),
      at: num(e.at, 0),
      kind: kind,
      route: routeOf(e.route || e.to || ""),
      detail: "",
    };
    if (kind === "click") {
      row.detail = [safeText(e.feature, 60), safeText(e.testId || e.label || e.action, 80)]
        .filter(Boolean)
        .join(" · ");
    } else if (kind === "settle") {
      row.detail =
        safeText(e.verdict, 40) +
        (num(e.fetch, 0) ? " · fetch " + num(e.fetch, 0) : "") +
        (num(e.opened, 0) ? " · opened " + num(e.opened, 0) : "") +
        (num(e.failed, 0) ? " · failed " + num(e.failed, 0) : "") +
        (num(e.elapsedMs, 0) ? " · " + num(e.elapsedMs, 0) + " ms" : "");
    } else if (kind === "route") {
      row.detail = "route → " + row.route;
    } else {
      row.detail = safeText(Object.keys(e).sort().join(","), 120);
    }
    rows.push(row);
    if (rows.length >= cap) return { rows: rows, truncated: Math.max(list.length - cap, 0) };
  }
  return { rows: rows, truncated: 0 };
}

/** The screenshot nearest to a timeline entry, inside SHOT_ATTACH_MS. */
export function attachShot(bundle, at) {
  const shots = bundle && Array.isArray(bundle.shots) ? bundle.shots : [];
  const t = num(at, 0);
  let best = null;
  let bestDelta = Infinity;
  for (const s of shots) {
    if (!safeImageSrc(s)) continue;
    const delta = Math.abs(num(s && s.at, 0) - t);
    if (delta <= SHOT_ATTACH_MS && delta < bestDelta) {
      bestDelta = delta;
      best = s;
    }
  }
  return best;
}

/** Mutations collapsed to `type target attr ×count` lines (structure, never content). */
export function mutationLines(bundle, opts) {
  const cap = num(opts && opts.maxRows, MAX_RENDERED_ROWS);
  const list = bundle && Array.isArray(bundle.mutations) ? bundle.mutations : [];
  const groups = new Map();
  for (const m of list) {
    const key = [safeText(m && m.type, 20), safeText(m && m.target, 30), safeText(m && m.attr, 30)].join("|");
    const seen = groups.get(key);
    if (seen) seen.count++;
    else {
      groups.set(key, {
        type: safeText(m && m.type, 20),
        target: safeText(m && m.target, 30),
        attr: safeText(m && m.attr, 30),
        added: num(m && m.added, 0),
        removed: num(m && m.removed, 0),
        folded: num(m && m.folded, 0),
        at: num(m && m.at, 0),
        count: 1,
      });
    }
  }
  const rows = Array.from(groups.values());
  return { rows: rows.slice(0, cap), truncated: Math.max(rows.length - cap, 0), total: list.length };
}

/** Storage-index rows (the recorded sessions), newest first. */
export function sessionRows(bundle) {
  const list = bundle && bundle.storage && Array.isArray(bundle.storage.sessions) ? bundle.storage.sessions : [];
  return list
    .map((s) => ({
      id: safeText(s && s.id, 80),
      startedAt: num(s && s.startedAt, 0),
      endedAt: num(s && s.endedAt, 0),
      clicks: num(s && s.clicks, 0),
      mutations: num(s && s.mutations, 0),
      shots: num(s && s.shots, 0),
      bytes: num(s && s.bytes, 0),
    }))
    .sort((a, b) => b.startedAt - a.startedAt);
}

/** Feature-registry rows (the F105 snapshot), with display-sanitized routes. */
export function featureRows(bundle) {
  const list = bundle && Array.isArray(bundle.features) ? bundle.features : [];
  return list.map((f) => ({ id: safeText(f && f.id, 80), route: routeOf(f && f.route) }));
}

/** ms -> "12.3 s" / "1 m 04 s" (display only; never used for arithmetic). */
export function formatDuration(ms) {
  const v = Math.max(num(ms, 0), 0);
  if (v < 1000) return v + " ms";
  if (v < 60_000) return (v / 1000).toFixed(1) + " s";
  const m = Math.floor(v / 60_000);
  const s = Math.round((v % 60_000) / 1000);
  return m + " m " + String(s).padStart(2, "0") + " s";
}

/** Epoch ms -> "HH:MM:SS.mmm" in LOCAL time, or "" when there is no timestamp. */
export function formatStamp(ms) {
  const t = num(ms, 0);
  if (!t) return "";
  const d = new Date(t);
  if (!Number.isFinite(d.getTime())) return "";
  const p = (n, w) => String(n).padStart(w, "0");
  return (
    p(d.getHours(), 2) + ":" + p(d.getMinutes(), 2) + ":" + p(d.getSeconds(), 2) + "." + p(d.getMilliseconds(), 3)
  );
}

/** Human byte count for the storage index. */
export function formatBytes(n) {
  const v = Math.max(num(n, 0), 0);
  if (v < 1024) return v + " B";
  if (v < 1024 * 1024) return (v / 1024).toFixed(1) + " kB";
  return (v / (1024 * 1024)).toFixed(2) + " MB";
}

/**
 * Arena mode: the plain-text summary an operator pastes into a chat. Bounded,
 * one field per line, no markup, and every operator-visible field sanitized the
 * same way the DOM renderer sanitizes it.
 */
export function summarize(bundle) {
  const v = verdict(bundle);
  if (!v.ok) return "No readable .mcrec bundle.\nreason: " + safeText(v.reason, 80);
  const target = (bundle && bundle.target) || {};
  const lines = [];
  lines.push("GHRDP .mcrec summary (mcrec v" + v.version + (v.version === 1 ? ", lite" : ", full") + ")");
  lines.push("created: " + safeText(bundle.createdAt, 40));
  lines.push(
    "target: route=" +
      (routeOf(target.route) || "(none)") +
      " build=" +
      safeText(target.buildSha, 40) +
      " lang=" +
      safeText(target.lang, 8) +
      " ui=" +
      safeText(target.ui, 8)
  );
  lines.push(
    "counts: timeline=" +
      v.counts.timeline +
      " mutations=" +
      v.counts.mutations +
      " shots=" +
      v.counts.shots +
      " sessions=" +
      v.counts.sessions +
      " features=" +
      v.counts.features
  );
  const stats = v.stats;
  if (stats && stats.count) {
    lines.push(
      "span: " +
        formatDuration(stats.spanMs) +
        " first=" +
        formatStamp(stats.firstAt) +
        " last=" +
        formatStamp(stats.lastAt) +
        " kinds=" +
        Object.keys(stats.byKind)
          .sort()
          .map((k) => k + ":" + stats.byKind[k])
          .join(",")
    );
  }
  const rows = timelineRows(bundle, { maxRows: 40 });
  lines.push("timeline (first " + rows.rows.length + " of " + v.counts.timeline + "):");
  for (const r of rows.rows) {
    lines.push(
      "  #" + r.seq + " " + formatStamp(r.at) + " " + r.kind + (r.detail ? " — " + r.detail : "") + (r.route ? " [" + r.route + "]" : "")
    );
  }
  if (rows.truncated) lines.push("  … " + rows.truncated + " more entr(ies) not shown");
  if (v.version === 2) {
    const m = mutationLines(bundle, { maxRows: 20 });
    if (m.total) {
      lines.push("dom mutations: " + m.total + " records, " + m.rows.length + " distinct kinds");
      for (const row of m.rows) {
        lines.push(
          "  " + row.type + " <" + row.target + ">" + (row.attr ? " @" + row.attr : "") + " ×" + row.count + (row.added ? " +" + row.added : "") + (row.removed ? " -" + row.removed : "")
        );
      }
    }
    const sessions = sessionRows(bundle);
    if (sessions.length) {
      lines.push("stored sessions (this device): " + sessions.length);
      for (const s of sessions.slice(0, 5)) {
        lines.push(
          "  " + s.id + " clicks=" + s.clicks + " muts=" + s.mutations + " shots=" + s.shots + " bytes=" + formatBytes(s.bytes)
        );
      }
    }
    const shots = Array.isArray(bundle.shots) ? bundle.shots : [];
    if (shots.length) {
      lines.push("screenshots: " + shots.length + " thumbnail(s) " + safeText(shots[0].w, 6) + "×" + safeText(shots[0].h, 6) + " (not included in text)");
    }
  }
  if (v.warnings.length) lines.push("warnings: " + v.warnings.join(", "));
  lines.push("note: no network was used to read this file; nothing was uploaded.");
  const text = lines.join("\n");
  return text.length > SUMMARY_MAX_CHARS ? text.slice(0, SUMMARY_MAX_CHARS) + "\n…(truncated)" : text;
}
