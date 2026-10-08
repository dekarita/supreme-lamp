// [F110 §4] audit.ts - the IndexedDB half of the patch audit log.
//
// POSTURE. Browser-local only, same policy as the DVR session database (F107) it
// deliberately does NOT share: a patch audit that lived inside `ghrdp-dvr` would be
// deleted by "clear my recordings" and would hide from the inventory as a second store
// in someone else's database. So: its own database, `ghrdp-patches`, one object store
// `audit`, keyPath `seq` autoIncrement, bounded to PATCH_AUDIT_MAX_ROWS by the PURE
// core's trimAuditRows(). Nothing here uploads, and nothing here holds a connection
// open: every operation opens, works, and closes in a `finally`. A module-level cached
// IDBDatabase is a leak with a nice name - F110-i pins its absence: the three public
// callers (listAudit / appendAuditRow / clearAudit) each `db.close()` in a `finally`,
// asserted by counting the calls in the file, not by hoping.
//
// HONEST-FAILURE CONTRACT, copied from src/lib/dvr/storage.ts: every call resolves to
// a result object and NOTHING throws out of this module. A host without IndexedDB (or
// with it blocked by site settings) answers {ok:false, reason:"…"} and the patch still
// applies in-memory - persistence of the audit is an enhancement, never a dependency of
// the decision. Silently dropping an audit row would be the worse failure: the row is
// how the operator learns a patch arrived at all, so channel.ts publishes the decision
// to its subscribers whether or not the write worked, and only the durable copy is lost.
import {
  PATCH_AUDIT_DB,
  PATCH_AUDIT_DB_VERSION,
  PATCH_AUDIT_MAX_ROWS,
  PATCH_AUDIT_STORE,
  trimAuditRows,
  type PatchAuditRow,
} from "./patchCore";

export interface AuditResult<T> {
  ok: boolean;
  reason: string;
  value?: T;
}

function fail(err: unknown): string {
  const name = err && typeof err === "object" && "name" in err ? String((err as { name?: unknown }).name) : "";
  if (name === "QuotaExceededError") return "quota";
  return name ? name.toLowerCase() : "unknown";
}

function idb(): IDBFactory | null {
  try {
    return typeof indexedDB !== "undefined" ? indexedDB : null;
  } catch {
    return null;
  }
}

/** Open (or create) the audit database. Never throws, never caches the handle. */
export function openPatchDb(): Promise<AuditResult<IDBDatabase>> {
  return new Promise((resolve) => {
    const factory = idb();
    if (!factory) {
      resolve({ ok: false, reason: "indexeddb-unavailable" });
      return;
    }
    try {
      const req = factory.open(PATCH_AUDIT_DB, PATCH_AUDIT_DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(PATCH_AUDIT_STORE)) {
          db.createObjectStore(PATCH_AUDIT_STORE, { keyPath: "seq", autoIncrement: true });
        }
      };
      req.onsuccess = () => resolve({ ok: true, reason: "", value: req.result });
      req.onerror = () => resolve({ ok: false, reason: "open-failed:" + fail(req.error) });
      req.onblocked = () => resolve({ ok: false, reason: "open-blocked" });
    } catch (err) {
      resolve({ ok: false, reason: "open-error:" + fail(err) });
    }
  });
}

function txDone(tx: IDBTransaction): Promise<AuditResult<null>> {
  return new Promise((resolve) => {
    tx.oncomplete = () => resolve({ ok: true, reason: "" });
    tx.onerror = () => resolve({ ok: false, reason: "tx-error:" + fail(tx.error) });
    tx.onabort = () => resolve({ ok: false, reason: "tx-aborted:" + fail(tx.error) });
  });
}

function reqResult<T>(req: IDBRequest): Promise<AuditResult<T>> {
  return new Promise((resolve) => {
    req.onsuccess = () => resolve({ ok: true, reason: "", value: req.result as T });
    req.onerror = () => resolve({ ok: false, reason: "req-error:" + fail(req.error) });
  });
}

/** readAll, given an open handle - shared by listAudit() and the trim inside append. */
async function readAll(db: IDBDatabase): Promise<AuditResult<PatchAuditRow[]>> {
  try {
    const tx = db.transaction(PATCH_AUDIT_STORE, "readonly");
    const res = await reqResult<PatchAuditRow[]>(tx.objectStore(PATCH_AUDIT_STORE).getAll());
    if (!res.ok) return { ok: false, reason: res.reason };
    const rows = (res.value || []).slice().sort((a, b) => Number(a.seq || 0) - Number(b.seq || 0));
    return { ok: true, reason: "", value: rows };
  } catch (err) {
    return { ok: false, reason: "getall-error:" + fail(err) };
  }
}

/** All audit rows, oldest-first (the order the trim rule assumes). */
export async function listAudit(): Promise<AuditResult<PatchAuditRow[]>> {
  const opened = await openPatchDb();
  if (!opened.ok || !opened.value) return { ok: false, reason: opened.reason };
  const db = opened.value;
  try {
    return await readAll(db);
  } finally {
    try {
      db.close();
    } catch {
      /* the host owns the connection if it will not close */
    }
  }
}

/**
 * Append one decision row, then trim to PATCH_AUDIT_MAX_ROWS (oldest out).
 *
 * The write and the trim are SEPARATE transactions on purpose. The first attempt had
 * `put` -> await getAllKeys -> delete, all in one transaction; it survived a handful of
 * rows and fell over at the 201st, when the trim branch ran for the first time, because
 * an IndexedDB transaction that has no pending request is finished - so the deletes threw
 * TransactionInactiveError and the row that HAD been written was reported as a failure.
 * A bound that only breaks when it starts working is the definition of an untested
 * branch: the DOM gate writes PATCH_AUDIT_MAX_ROWS + 12 rows and asserts every append
 * reported ok (and that the durable count landed exactly on the bound).
 */
export async function appendAuditRow(row: PatchAuditRow): Promise<AuditResult<string>> {
  const opened = await openPatchDb();
  if (!opened.ok || !opened.value) return { ok: false, reason: opened.reason };
  const db = opened.value;
  try {
    const tx = db.transaction(PATCH_AUDIT_STORE, "readwrite");
    tx.objectStore(PATCH_AUDIT_STORE).put(row);
    const done = await txDone(tx);
    if (!done.ok) return { ok: false, reason: done.reason };
    const all = await readAll(db);
    if (all.ok && Array.isArray(all.value) && all.value.length > PATCH_AUDIT_MAX_ROWS) {
      // The bound is the CORE's rule (trimAuditRows keeps the newest N), re-applied to the
      // durable list, so "which rows survive" has exactly one definition in this repo and
      // the browser cannot quietly disagree with the table the Node gate proves.
      const keep = new Set(trimAuditRows(all.value, PATCH_AUDIT_MAX_ROWS).map((r) => Number(r.seq)));
      const doomed = all.value.map((r) => Number(r.seq)).filter((seq) => Number.isFinite(seq) && !keep.has(seq));
      const trim = db.transaction(PATCH_AUDIT_STORE, "readwrite");
      const store = trim.objectStore(PATCH_AUDIT_STORE);
      for (const seq of doomed) if (Number.isFinite(seq)) store.delete(seq);
      const trimmed = await txDone(trim);
      if (!trimmed.ok) return { ok: false, reason: "trim-error:" + trimmed.reason };
    }
    return { ok: true, reason: "", value: String(row.id || "") };
  } catch (err) {
    return { ok: false, reason: "put-error:" + fail(err) };
  } finally {
    try {
      db.close();
    } catch {
      /* ignore */
    }
  }
}

/** Forget the durable audit log. The in-memory view is cleared by channel.ts. */
export async function clearAudit(): Promise<AuditResult<null>> {
  const opened = await openPatchDb();
  if (!opened.ok || !opened.value) return { ok: false, reason: opened.reason };
  const db = opened.value;
  try {
    const tx = db.transaction(PATCH_AUDIT_STORE, "readwrite");
    tx.objectStore(PATCH_AUDIT_STORE).clear();
    const done = await txDone(tx);
    return done.ok ? { ok: true, reason: "" } : { ok: false, reason: done.reason };
  } catch (err) {
    return { ok: false, reason: "clear-error:" + fail(err) };
  } finally {
    try {
      db.close();
    } catch {
      /* ignore */
    }
  }
}
