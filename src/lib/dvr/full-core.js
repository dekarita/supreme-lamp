// F107: pure policy/format core, shared by the browser and node --test.
export const FULL_VERSION = 2;
export const MAX_SESSION_BYTES = 5 * 1024 * 1024;
export const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const enc = new TextEncoder();
export const sizeOf = (value) => enc.encode(JSON.stringify(value)).length;

// HashRouter routes may contain ?token=...; persist only the route, never its
// query. Apply to both the v1 ring and the v2 long-lived session target.
export function safeRoute(value) {
  return String(value == null ? "" : value).split("?", 1)[0].slice(0, 256);
}

// A path is relative to #root, never a selector or page text. Paths of 16 bits
// per level, bounded depth; mutations to sensitive subtrees are excluded upstream.
export function mutationDiff(record, root) {
  const path = (node) => {
    const parts = [];
    let cur = node.nodeType === 3 ? node.parentNode : node;
    while (cur && cur !== root && parts.length < 32) {
      const parent = cur.parentNode;
      if (!parent) return null;
      const index = Array.prototype.indexOf.call(parent.childNodes, cur);
      if (index < 0) return null;
      parts.unshift(index);
      cur = parent;
    }
    return cur === root ? parts : null;
  };
  const where = path(record.target);
  if (!where) return null;
  const elements = (nodes) => Array.from(nodes).filter((n) => n.nodeType === 1).slice(0, 12)
    .map((n) => String(n.tagName || "").toLowerCase()).filter(Boolean);
  return {
    path: where, type: record.type,
    ...(record.type === "childList" ? { added: elements(record.addedNodes), removed: elements(record.removedNodes) } : {}),
    ...(record.type === "attributes" ? { attribute: String(record.attributeName || "").slice(0, 40) } : {}),
    // No oldValue, newValue, form value, free text, URLs or attribute values.
  };
}

export function validDiff(diff) {
  return !!diff && Array.isArray(diff.path) && diff.path.length <= 32 &&
    diff.path.every((n) => Number.isInteger(n) && n >= 0) &&
    ["childList", "attributes", "characterData"].includes(diff.type) &&
    (!diff.attribute || /^[a-zA-Z-]{1,40}$/.test(diff.attribute));
}

export function buildFullBundle(session) {
  if (!session || !Array.isArray(session.timeline)) throw new Error("Invalid session");
  return {
    format: "mcrec", version: FULL_VERSION, createdAt: new Date(session.createdAt).toISOString(),
    target: session.target, timeline: session.timeline,
    storage: { policy: "local-indexeddb", maxBytes: MAX_SESSION_BYTES, retentionMs: RETENTION_MS },
    features: session.features,
  };
}

export function appendBounded(session, entry) {
  const next = { ...session, timeline: [...session.timeline, entry] };
  // Reject an oversized individual frame rather than evicting the entire history.
  if (sizeOf({ ...next, timeline: [entry] }) > MAX_SESSION_BYTES) return { session, accepted: false };
  while (sizeOf(buildFullBundle(next)) > MAX_SESSION_BYTES && next.timeline.length > 1) next.timeline.shift();
  return { session: next, accepted: true };
}

export function isExpired(session, now) {
  return !Number.isFinite(session?.updatedAt) || now - session.updatedAt > RETENTION_MS;
}
