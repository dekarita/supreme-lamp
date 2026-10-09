// [F107 §4] storage.ts - the IndexedDB adapter behind Full DVR's session list.
//
// POSTURE. IndexedDB is browser-local: the same policy as the zustand persist
// store F102 ships. Nothing here touches the network, and a session only leaves
// the machine through the operator-clicked export (src/lib/dvr/export.ts). The
// ARITHMETIC (5 MB/session budget, 30-day retention, QuotaExceededError triage,
// oldest-shot-first eviction) lives in the pure core src/lib/dvr/storageCore.js -
// this adapter's job is to call those functions and obey the answer, so the Node
// gate proves the decisions the browser actually makes.
//
// HONEST-FAILURE CONTRACT. Every call resolves to a result object; nothing throws
// out of this module. A host without IndexedDB answers {ok:false,
// reason:"indexeddb-unavailable"} and the session keeps recording in memory -
// persistence is an enhancement, never a dependency.
import {
  DVR_DB_NAME,
  DVR_DB_VERSION,
  DVR_SESSION_BUDGET_BYTES,
  DVR_STORE_SESSIONS,
  DVR_STORE_SHOTS,
  classifyQuotaError,
  pruneByRetention,
  shrinkToFit,
  type DvrSessionMeta,
} from "./storageCore";
import type { ShotRecord } from "./screenshotCore";

export interface DvrDbHandle {
  db: IDBDatabase;
}

export interface StorageResult<T> {
  ok: boolean;
  reason: string;
  value?: T;
}

function idb(): IDBFactory | null {
  try {
    return typeof indexedDB !== "undefined" ? indexedDB : null;
  } catch {
    return null;
  }
}

/** Open (or create) the DVR database. Never throws. */
export function openDvrDb(): Promise<StorageResult<IDBDatabase>> {
  return new Promise((resolve) => {
    const factory = idb();
    if (!factory) {
      resolve({ ok: false, reason: "indexeddb-unavailable" });
      return;
    }
    try {
      const req = factory.open(DVR_DB_NAME, DVR_DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(DVR_STORE_SESSIONS)) {
          db.createObjectStore(DVR_STORE_SESSIONS, { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains(DVR_STORE_SHOTS)) {
          db.createObjectStore(DVR_STORE_SHOTS, { keyPath: "key" });
        }
      };
      req.onsuccess = () => resolve({ ok: true, reason: "", value: req.result });
      req.onerror = () => resolve({ ok: false, reason: "open-failed:" + classifyQuotaError(req.error) });
      req.onblocked = () => resolve({ ok: false, reason: "open-blocked" });
    } catch (err) {
      resolve({ ok: false, reason: "open-error:" + classifyQuotaError(err) });
    }
  });
}

function txDone(tx: IDBTransaction): Promise<{ ok: boolean; reason: string }> {
  return new Promise((resolve) => {
    tx.oncomplete = () => resolve({ ok: true, reason: "" });
    tx.onerror = () => resolve({ ok: false, reason: "tx-error:" + classifyQuotaError(tx.error) });
    tx.onabort = () => resolve({ ok: false, reason: "tx-aborted:" + classifyQuotaError(tx.error) });
  });
}

function reqResult<T>(req: IDBRequest): Promise<{ ok: boolean; reason: string; value?: T }> {
  return new Promise((resolve) => {
    req.onsuccess = () => resolve({ ok: true, reason: "", value: req.result as T });
    req.onerror = () => resolve({ ok: false, reason: "req-error:" + classifyQuotaError(req.error) });
  });
}

/** Upsert one session meta. */
export async function saveSession(db: IDBDatabase, meta: DvrSessionMeta): Promise<StorageResult<DvrSessionMeta>> {
  try {
    const tx = db.transaction(DVR_STORE_SESSIONS, "readwrite");
    tx.objectStore(DVR_STORE_SESSIONS).put(meta);
    const done = await txDone(tx);
    return done.ok ? { ok: true, reason: "", value: meta } : { ok: false, reason: done.reason };
  } catch (err) {
    return { ok: false, reason: "put-error:" + classifyQuotaError(err) };
  }
}

/** All stored session metas (unordered; the caller sorts via storageCore). */
export async function listSessions(db: IDBDatabase): Promise<StorageResult<DvrSessionMeta[]>> {
  try {
    const tx = db.transaction(DVR_STORE_SESSIONS, "readonly");
    const res = await reqResult<DvrSessionMeta[]>(tx.objectStore(DVR_STORE_SESSIONS).getAll());
    return res.ok ? { ok: true, reason: "", value: res.value || [] } : { ok: false, reason: res.reason };
  } catch (err) {
    return { ok: false, reason: "getall-error:" + classifyQuotaError(err) };
  }
}

/** One session meta by id. */
export async function getSession(db: IDBDatabase, id: string): Promise<StorageResult<DvrSessionMeta>> {
  try {
    const tx = db.transaction(DVR_STORE_SESSIONS, "readonly");
    const res = await reqResult<DvrSessionMeta>(tx.objectStore(DVR_STORE_SESSIONS).get(id));
    return res.ok && res.value ? { ok: true, reason: "", value: res.value } : { ok: false, reason: res.ok ? "not-found" : res.reason };
  } catch (err) {
    return { ok: false, reason: "get-error:" + classifyQuotaError(err) };
  }
}

/** Delete a session AND its shots. */
export async function deleteSession(db: IDBDatabase, id: string): Promise<StorageResult<string>> {
  try {
    const shots = await listShots(db, id);
    const tx = db.transaction([DVR_STORE_SESSIONS, DVR_STORE_SHOTS], "readwrite");
    tx.objectStore(DVR_STORE_SESSIONS).delete(id);
    if (shots.ok && shots.value) {
      const store = tx.objectStore(DVR_STORE_SHOTS);
      for (const s of shots.value) store.delete(s.key);
    }
    const done = await txDone(tx);
    return done.ok ? { ok: true, reason: "", value: id } : { ok: false, reason: done.reason };
  } catch (err) {
    return { ok: false, reason: "delete-error:" + classifyQuotaError(err) };
  }
}

/** Shots of one session (keys are `sessionId/seq`). */
export async function listShots(db: IDBDatabase, sessionId: string): Promise<StorageResult<ShotRecord[]>> {
  try {
    const tx = db.transaction(DVR_STORE_SHOTS, "readonly");
    const res = await reqResult<ShotRecord[]>(tx.objectStore(DVR_STORE_SHOTS).getAll());
    if (!res.ok) return { ok: false, reason: res.reason };
    const prefix = sessionId + "/";
    return { ok: true, reason: "", value: (res.value || []).filter((s) => String(s.key).startsWith(prefix)) };
  } catch (err) {
    return { ok: false, reason: "shots-error:" + classifyQuotaError(err) };
  }
}

/** Every shot record in the store, unfiltered (the migration's read). */
export async function listAllShotRecords(db: IDBDatabase): Promise<StorageResult<ShotRecord[]>> {
  try {
    const tx = db.transaction(DVR_STORE_SHOTS, "readonly");
    const res = await reqResult<ShotRecord[]>(tx.objectStore(DVR_STORE_SHOTS).getAll());
    return res.ok ? { ok: true, reason: "", value: res.value || [] } : { ok: false, reason: res.reason };
  } catch (err) {
    return { ok: false, reason: "shots-error:" + classifyQuotaError(err) };
  }
}

/**
 * Marker record written into the shots store once the purge has run. It lives
 * in the shots store (keyed `migration/…`, never a `sessionId/seq` shape), so
 * listShots' prefix filter never surfaces it and no export can reach it.
 */
const SHOTS_PURGE_MARKER_KEY = "migration/shots-purged-v1";

/**
 * [WP-13b / MC-P24] One-time privacy migration: shots recorded BEFORE the
 * capture fence existed (consent + exclusion pass) may contain credential
 * pixels — XMLSerializer serializes text and attribute values, so a revealed
 * password or a reflected input value could be rasterized into a PNG. Pixels
 * cannot be redacted, so the records are DELETED (never copied, never backed
 * up) and every session meta is zeroed (shots/bytes counted shot bytes only).
 *
 * Idempotent: the marker record makes the second and later runs a no-op, and
 * the purge runs at DB-open time — before any post-consent shot can be saved —
 * so legitimately consented shots are never touched. Best-effort like every
 * other call here: a failure resolves to {ok:false, reason} and the next open
 * retries; the session itself never depends on the outcome.
 */
export async function migratePurgeLegacyShots(
  db: IDBDatabase
): Promise<StorageResult<{ purgedShots: number; sessionsRewritten: number }>> {
  const empty = { purgedShots: 0, sessionsRewritten: 0 };
  try {
    const shotsRes = await listAllShotRecords(db);
    if (!shotsRes.ok) return { ok: false, reason: shotsRes.reason, value: empty };
    const allShots = shotsRes.value || [];
    if (allShots.some((s) => String(s.key) === SHOTS_PURGE_MARKER_KEY)) {
      return { ok: true, reason: "already-migrated", value: empty };
    }
    const sessionsRes = await listSessions(db);
    if (!sessionsRes.ok || !sessionsRes.value) {
      return { ok: false, reason: sessionsRes.reason || "list-failed", value: empty };
    }
    // One readwrite transaction, every request issued synchronously (no await
    // between requests — an IndexedDB transaction dies otherwise).
    const tx = db.transaction([DVR_STORE_SESSIONS, DVR_STORE_SHOTS], "readwrite");
    const shotStore = tx.objectStore(DVR_STORE_SHOTS);
    for (const s of allShots) shotStore.delete(s.key);
    shotStore.put({ key: SHOTS_PURGE_MARKER_KEY, at: Date.now() } as unknown as ShotRecord);
    const sessionStore = tx.objectStore(DVR_STORE_SESSIONS);
    let rewritten = 0;
    for (const m of sessionsRes.value) {
      if (Number(m.shots) !== 0 || Number(m.bytes) !== 0) {
        sessionStore.put({ ...m, shots: 0, bytes: 0 });
        rewritten++;
      }
    }
    const done = await txDone(tx);
    if (!done.ok) return { ok: false, reason: done.reason, value: empty };
    return { ok: true, reason: "", value: { purgedShots: allShots.length, sessionsRewritten: rewritten } };
  } catch (err) {
    return { ok: false, reason: "migrate-error:" + classifyQuotaError(err), value: empty };
  }
}

/**
 * Persist shots under the session budget. On QuotaExceededError the adapter asks
 * the pure core for an eviction plan (oldest shots first), drops them, and retries
 * ONCE; if that still fails the shots are abandoned with a named reason - the
 * session meta itself is never lost to a screenshot.
 */
export async function saveShots(
  db: IDBDatabase,
  sessionId: string,
  shots: ShotRecord[],
  sessionBytes: number
): Promise<StorageResult<{ stored: number; droppedKeys: string[]; bytes: number }>> {
  const plan = async (
    list: ShotRecord[]
  ): Promise<StorageResult<{ stored: number; droppedKeys: string[]; bytes: number }>> => {
    if (list.length === 0) return { ok: true, reason: "", value: { stored: 0, droppedKeys: [], bytes: 0 } };
    try {
      const tx = db.transaction(DVR_STORE_SHOTS, "readwrite");
      const store = tx.objectStore(DVR_STORE_SHOTS);
      for (const s of list) store.put({ ...s, key: sessionId + "/" + String(s.key) });
      const done = await txDone(tx);
      if (done.ok) {
        const bytes = list.reduce((acc, s) => acc + Number(s.bytes || 0), 0);
        return { ok: true, reason: "", value: { stored: list.length, droppedKeys: [], bytes: bytes } };
      }
      if (!done.reason.startsWith("tx-error:quota-exceeded") && !done.reason.startsWith("tx-aborted:quota-exceeded")) {
        return { ok: false, reason: done.reason };
      }
        // Quota path: ask the pure core for the eviction plan, drop, retry once.
        const planned = list.reduce((acc, s) => acc + Number(s.bytes || 0), 0);
        const shrink = shrinkToFit(list, sessionBytes, planned, { budgetBytes: DVR_SESSION_BUDGET_BYTES });
        if (shrink.droppedKeys.length === 0 || !shrink.fits) {
          return { ok: false, reason: "quota-exceeded:unshrinkable" };
        }
        const delTx = db.transaction(DVR_STORE_SHOTS, "readwrite");
        const delStore = delTx.objectStore(DVR_STORE_SHOTS);
        for (const key of shrink.droppedKeys) delStore.delete(sessionId + "/" + key);
        const delDone = await txDone(delTx);
        if (!delDone.ok) return { ok: false, reason: "quota-cleanup-failed" };
        try {
          const tx2 = db.transaction(DVR_STORE_SHOTS, "readwrite");
          const store2 = tx2.objectStore(DVR_STORE_SHOTS);
          for (const s of shrink.shots) store2.put({ ...s, key: sessionId + "/" + String(s.key) });
          const done2 = await txDone(tx2);
          if (!done2.ok) return { ok: false, reason: "quota-retry-failed" };
          const storedBytes = shrink.shots.reduce((acc, s) => acc + Number(s.bytes || 0), 0);
          return {
            ok: true,
            reason: "quota-shrunk",
            value: { stored: shrink.shots.length, droppedKeys: shrink.droppedKeys, bytes: storedBytes },
          };
        } catch (err2) {
          return { ok: false, reason: "quota-retry-error:" + classifyQuotaError(err2) };
        }
      } catch (err) {
        return { ok: false, reason: "save-error:" + classifyQuotaError(err) };
      }
  };
  return plan(shots);
}

/** Retention sweep: delete sessions the pure core says are past 30 days. The
 *  decision comes from pruneByRetention - the adapter never re-derives it. */
export async function pruneOldSessions(db: IDBDatabase, now: number): Promise<StorageResult<{ pruned: number }>> {
  const all = await listSessions(db);
  if (!all.ok || !all.value) return { ok: false, reason: all.reason || "list-failed" };
  const { drop } = pruneByRetention(all.value, now);
  let pruned = 0;
  for (const s of drop) {
    const res = await deleteSession(db, s.id);
    if (res.ok) pruned++;
  }
  return { ok: true, reason: "", value: { pruned: pruned } };
}
