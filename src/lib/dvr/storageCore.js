// [F107 §4] Session storage arithmetic - the pure half of Full DVR's IndexedDB
// session management.
//
// WHY PLAIN JS. The IndexedDB adapter (src/lib/dvr/storage.ts) is browser-only;
// the half that decides budgets, retention and quota triage is pure arithmetic and
// runs under `node --test tests/*.test.js`. The adapter's job is to call THESE
// functions and obey the answer - a quota decision made here cannot drift from the
// one the gate proves.
//
// STORAGE POSTURE. IndexedDB is browser-local: the same policy as the zustand
// persist store (localStorage) F102 ships - nothing leaves the machine by itself,
// the operator exports a session explicitly (src/lib/dvr/export.ts). That is why
// this file may name IndexedDB while step 3's LITE files still may not
// (tests/f-dvr-lite.test.js F-DVR-f pins the LITE posture; tests/f107-dvr-full.test.js
// pins this one).

/** One session may occupy at most this many bytes of IndexedDB (soft budget). */
export const DVR_SESSION_BUDGET_BYTES = 5_000_000;
/** Sessions older than this are pruned on open/export (30-day retention). */
export const DVR_RETENTION_DAYS = 30;
export const DVR_RETENTION_MS = DVR_RETENTION_DAYS * 24 * 60 * 60 * 1000;
/** The IndexedDB database the adapter opens. */
export const DVR_DB_NAME = "ghrdp-dvr";
export const DVR_DB_VERSION = 1;
export const DVR_STORE_SESSIONS = "sessions";
export const DVR_STORE_SHOTS = "shots";

function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** A session meta the adapter stores in the `sessions` store. */
export function newSessionMeta(id, now, opts) {
  return {
    id: String(id || ""),
    startedAt: num(now, 0),
    endedAt: 0,
    clicks: 0,
    settles: 0,
    routes: 0,
    mutations: 0,
    shots: 0,
    bytes: 0,
    label: String((opts && opts.label) || ""),
  };
}

/** Budget check for adding `addBytes` to a session. The budget is SOFT: a shot
 *  that crosses it is skipped, never a reason to fail the click. */
export function sessionBudgetOk(session, addBytes) {
  const used = num(session && session.bytes, 0);
  const add = num(addBytes, 0);
  return used + add <= DVR_SESSION_BUDGET_BYTES;
}

/** Retention pruning: split sessions into keep/drop at the 30-day line.
 *  A session with endedAt=0 (still recording) is ALWAYS kept - the reference
 *  point for a FINISHED session is when it ended, not when it started. */
export function pruneByRetention(sessions, now) {
  const list = Array.isArray(sessions) ? sessions : [];
  const t = num(now, 0);
  const cutoff = t - DVR_RETENTION_MS;
  const keep = [];
  const drop = [];
  for (const s of list) {
    const started = num(s && s.startedAt, 0);
    const ended = num(s && s.endedAt, 0);
    if (ended === 0) {
      keep.push(s); // still recording: retention never deletes a live session
      continue;
    }
    const reference = ended > 0 ? ended : started;
    if (reference > 0 && reference < cutoff) drop.push(s);
    else keep.push(s);
  }
  return { keep: keep, drop: drop };
}

/** Classify an IDB write failure WITHOUT throwing. The adapter passes the error's
 *  observable fields; this decides the recovery path. */
export function classifyQuotaError(err) {
  const name = String((err && err.name) || "");
  const code = num(err && err.code, -1);
  const message = String((err && err.message) || "").toLowerCase();
  if (name === "QuotaExceededError" || code === 22 || message.indexOf("quota") >= 0) return "quota-exceeded";
  if (name === "NotFoundError" || name === "InvalidStateError" || message.indexOf("not allowed") >= 0) return "unavailable";
  return "unknown";
}

/**
 * Eviction plan when a session crossed its budget: drop the OLDEST shots first
 * (they are also the least useful next to the click that broke) until the planned
 * write fits. Pure and deterministic - given the same inputs the same plan comes
 * out, which is what lets the gate falsify a wrong eviction order.
 */
export function shrinkToFit(shots, sessionBytes, plannedBytes, opts) {
  const list = Array.isArray(shots) ? shots.slice() : [];
  const budget = num(opts && opts.budgetBytes, DVR_SESSION_BUDGET_BYTES);
  let bytes = num(sessionBytes, 0);
  const plan = num(plannedBytes, 0);
  const dropped = [];
  while (list.length > 0 && bytes + plan > budget) {
    const oldest = list.shift();
    dropped.push(oldest);
    bytes = Math.max(0, bytes - num(oldest && oldest.bytes, 0));
  }
  return {
    shots: list,
    bytes: bytes,
    droppedKeys: dropped.map((s) => String((s && s.key) || "")),
    fits: bytes + plan <= budget,
  };
}

/** Order sessions for the list UI: newest first, stable by startedAt. */
export function sortSessionsNewestFirst(sessions) {
  const list = Array.isArray(sessions) ? sessions.slice() : [];
  return list.sort((a, b) => num(b && b.startedAt, 0) - num(a && a.startedAt, 0));
}
