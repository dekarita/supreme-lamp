// [F109 / Observatory step 8] debugHudCore.js - the PURE half of the Debug HUD.
//
// No imports, no DOM, no storage, no network: every decision the HUD makes is a
// function here, and tests/f109-debug-hud.test.js EXECUTES this file (the same
// "decide in the core, obey in the adapter" split as dvr-core.js / storageCore.js).
// The browser halves are src/lib/debugHud.ts (shortcut, rings, observers),
// src/lib/featureToggles.ts (the dev-time disable map) and
// src/components/DebugHUD.tsx (the overlay).
//
// PROD-SAFE DEFAULT-OFF. The HUD does nothing until the operator writes
// HUD_ENABLED_KEY = "true" (Settings ▸ Developer ▸ Debug HUD). Until then the
// shortcut is inert, no observer runs, no ring fills, and a feature toggle left in
// storage has NO effect (isToggledOff() requires enabled === true) - so a forgotten
// dev toggle can never hide a section from an operator who turned the HUD off.
//
// PRIVACY. The HUD shows traffic, so it inherits the repo's capture rules: URLs are
// cut at the first "?"/"#" (the F94 `?key=` leak class; the /ws URL itself carries
// `?key=<dash token>`), WebSocket frames are DESCRIBED (direction, type tag, byte
// count) and never stored - the outgoing `hello` frame carries the dash token - and
// the "Share with AI" text runs a final credential redaction pass on top of that.

/** [F109 §1] storage key: "true" = HUD available. Anything else = off (default). */
export const HUD_ENABLED_KEY = "f109:enabled";
/**
 * [F109 §4] storage key for the dev-time feature toggles: ONE JSON object
 * `{ "<featureId>": "off" }`. Deliberately not one key per feature
 * (`f109:toggles:<id>`): F111's derived inventory resolves only literal or
 * const-bound keys, so a `prefix + id` family would be invisible to F111-e - an
 * 11-key undercount of exactly the #163 §3.8 kind. One literal key stays derivable.
 */
export const HUD_TOGGLES_KEY = "f109:toggles";
/** [F109 §2] the only shortcut. Human form; isHudShortcut() is the matcher. */
export const HUD_SHORTCUT = "Shift+F12";
/** [F109 §3] the five panels, in tab order. Test ids derive from these. */
export const HUD_PANEL_IDS = ["features", "network", "websocket", "toggles", "actions"];
/** [F109 §5] bounded in-memory rings (network rows, WS frame descriptors). */
export const HUD_RING_MAX = 100;
/** [F109 §5] URL cap after query/fragment stripping (same cap as F104). */
export const HUD_URL_MAX = 200;
/** [F109 §5] the resource-timing initiators the Network panel lists. */
export const HUD_NET_INITIATORS = ["fetch", "xmlhttprequest", "beacon"];
/** [F109 §6] hard cap on the "Share with AI" text. */
export const HUD_SUMMARY_MAX = 4000;
/** [F109 §5] WS type tags must look like an identifier, or they are not shown. */
const WS_TYPE_RE = /^[A-Za-z0-9_.:-]{1,32}$/;

/**
 * [F109 §2] Shift+F12 and nothing else: no Ctrl/Alt/Meta (Ctrl+Shift+F12 and
 * friends stay with the browser), and auto-repeat is ignored so holding the keys
 * cannot flicker the overlay. tinykeys is NOT a dependency of this repo (verified
 * in package.json); F57's in-repo tinykeys-style binder is owned by the files
 * feature (src/pages/file-explorer/keymap.ts), so the HUD carries this matcher.
 */
export function isHudShortcut(ev) {
  if (!ev || typeof ev !== "object") return false;
  if (ev.repeat === true) return false;
  return ev.key === "F12" && ev.shiftKey === true && !ev.ctrlKey && !ev.altKey && !ev.metaKey;
}

/** [F109 §1] strict: only the exact string "true" enables the HUD. */
export function parseEnabled(raw) {
  return raw === "true";
}

/** Normalise a raw toggles value into `{ id: "off" }` for KNOWN ids only. */
export function parseToggles(raw, knownIds) {
  const out = {};
  if (typeof raw !== "string" || !raw) return out;
  let obj = null;
  try {
    obj = JSON.parse(raw);
  } catch {
    return out;
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return out;
  const known = Array.isArray(knownIds) ? knownIds : [];
  for (const id of known) {
    if (obj[id] === "off") out[id] = "off";
  }
  return out;
}

/** Stable serialisation (sorted ids, only "off" entries); "" when nothing is off. */
export function serializeToggles(map) {
  const ids = Object.keys(map || {}).filter((k) => map[k] === "off").sort();
  if (ids.length === 0) return "";
  const o = {};
  for (const id of ids) o[id] = "off";
  return JSON.stringify(o);
}

/** Return a NEW map with `id` switched off (off=true) or back on (off=false). */
export function setToggle(map, id, off) {
  const next = Object.assign({}, map || {});
  if (off) next[id] = "off";
  else delete next[id];
  return next;
}

/** [F109 §4] a toggle only bites while the HUD is enabled. */
export function isToggledOff(map, id, enabled) {
  return enabled === true && !!map && map[id] === "off";
}

/** Cut at the first "?" or "#", cap the length. No query string can survive. */
export function stripUrl(raw) {
  const cut = String(raw == null ? "" : raw).split(/[?#]/, 1)[0] || "";
  return cut.length > HUD_URL_MAX ? cut.slice(0, HUD_URL_MAX) + "…" : cut;
}

/** Append to a bounded ring (mutates and returns it; oldest entries fall off). */
export function pushRing(ring, item, max) {
  const cap = Math.max(1, Number(max) || HUD_RING_MAX);
  ring.push(item);
  while (ring.length > cap) ring.shift();
  return ring;
}

/**
 * [F109 §5] A PerformanceResourceTiming-shaped entry -> one Network row, or null
 * when the initiator is not network traffic the HUD lists (images, css, scripts).
 * Passive by construction: the HUD never wraps window.fetch (see debugHud.ts).
 */
export function resourceToNetRow(entry, now) {
  if (!entry || typeof entry !== "object") return null;
  const kind = String(entry.initiatorType || "");
  if (HUD_NET_INITIATORS.indexOf(kind) < 0) return null;
  const status = Number(entry.responseStatus);
  return {
    ts: Number.isFinite(Number(now)) ? Number(now) : 0,
    kind,
    url: stripUrl(entry.name),
    ms: Math.max(0, Math.round(Number(entry.duration) || 0)),
    status: Number.isFinite(status) && status > 0 ? status : null,
    bytes: Math.max(0, Number(entry.transferSize) || 0),
  };
}

/**
 * [F109 §5] Describe one WebSocket event. NEVER returns the payload: only the
 * direction, a type tag (when the frame is JSON with an identifier-like `type`),
 * and the byte size. `open`/`close` carry an optional close code instead.
 */
export function wsFrameDescriptor(dir, raw, now) {
  const d = ["in", "out", "open", "close"].indexOf(dir) >= 0 ? dir : "in";
  const ts = Number.isFinite(Number(now)) ? Number(now) : 0;
  if (d === "open") return { dir: d, type: "open", bytes: 0, ts };
  if (d === "close") {
    const code = raw == null || raw === "" ? "" : String(raw).replace(/[^0-9]/g, "").slice(0, 4);
    return { dir: d, type: code ? "close:" + code : "close", bytes: 0, ts };
  }
  let type = "(text)";
  let bytes = 0;
  if (typeof raw === "string") {
    bytes = raw.length;
    try {
      const obj = JSON.parse(raw);
      type = "(json)";
      if (obj && typeof obj === "object" && typeof obj.type === "string" && WS_TYPE_RE.test(obj.type)) type = obj.type;
    } catch {
      // A bare type tag (the adapter passes "hello"/"pong" for OUR frames, so the
      // dash token in the hello body is never even handed to this function).
      if (WS_TYPE_RE.test(raw)) type = raw;
    }
  } else if (raw && typeof raw === "object") {
    type = typeof raw.type === "string" && WS_TYPE_RE.test(raw.type) ? raw.type : "(json)";
  } else if (raw != null) {
    type = "(binary)";
  }
  return { dir: d, type, bytes, ts };
}

/**
 * [F109 §3] One Features card's state. `disabled` wins (the operator asked for
 * it), then a caught crash, then mounted-ness.
 */
export function featureCardState(input) {
  const i = input || {};
  if (i.disabled) return "disabled";
  if (i.lastError) return "crashed";
  return i.mounted ? "healthy" : "idle";
}

/** Defence in depth for anything that leaves the tab as text. */
export function redactSecrets(text) {
  return String(text == null ? "" : text)
    .replace(/([?&;\s"']|^)(key|token|access_token|password|passwd|secret|auth|authorization)=([^&\s"';]+)/gi, "$1$2=[redacted]")
    .replace(/\b(bearer|token)\s+[A-Za-z0-9._~+/=-]{12,}/gi, "$1 [redacted]")
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, "[redacted-gh-token]");
}

/**
 * [F109 §6] The "Share with AI" text: a compact, paste-able account of what the
 * HUD sees right now. Built ONLY from already-sanitised HUD state (stripped URLs,
 * frame descriptors, truncated boundary messages), then redacted again and capped.
 */
export function buildHudSummary(snap) {
  const s = snap || {};
  const lines = [];
  lines.push("Mission Control Debug HUD (F109) - " + String(s.when || ""));
  lines.push("route: " + stripUrl(s.route || "/"));
  const feats = Array.isArray(s.features) ? s.features : [];
  const bad = feats.filter((f) => f && f.state !== "healthy" && f.state !== "idle");
  lines.push("features: " + feats.length + " registered, " + feats.filter((f) => f && f.state === "healthy").length + " healthy, " + bad.length + " need attention");
  for (const f of bad) {
    lines.push("  - " + f.id + ": " + f.state + (f.lastError ? " (" + String(f.lastError).slice(0, 160) + ")" : ""));
  }
  const net = Array.isArray(s.network) ? s.network : [];
  const failed = net.filter((r) => r && r.status != null && (r.status === 0 || r.status >= 400));
  lines.push("network: " + net.length + " observed, " + failed.length + " failed");
  for (const r of failed.slice(-10)) lines.push("  - " + r.kind + " " + stripUrl(r.url) + " -> " + r.status + " (" + r.ms + " ms)");
  const ws = s.ws || {};
  const frames = Array.isArray(ws.frames) ? ws.frames : [];
  lines.push("websocket: " + (ws.live ? "live" : "down") + ", attempts " + Number(ws.attempts || 0) + ", " + frames.length + " frames seen");
  const off = Array.isArray(s.togglesOff) ? s.togglesOff : [];
  lines.push("dev toggles off: " + (off.length ? off.join(", ") : "none"));
  lines.push("dvr: " + (s.dvrRecording ? "recording" : "paused") + ", full capture " + (s.fullDvr ? "on" : "off"));
  const text = redactSecrets(lines.join("\n"));
  return text.length > HUD_SUMMARY_MAX ? text.slice(0, HUD_SUMMARY_MAX) + "\n…(truncated)" : text;
}
