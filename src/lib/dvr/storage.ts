import { isExpired, sizeOf, MAX_SESSION_BYTES, type FullSession } from "./full-core";
const DB = "ghrdp-dvr-v2";
const STORE = "sessions";
let dbPromise: Promise<IDBDatabase> | null = null;

function database(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === "undefined") { reject(new Error("IndexedDB unavailable")); return; }
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "id" });
    req.onsuccess = () => { req.result.onversionchange = () => req.result.close(); resolve(req.result); };
    req.onerror = () => reject(req.error);
  }).catch((err) => { dbPromise = null; throw err; });
  return dbPromise;
}

function transaction<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore, done: (value: T) => void) => void): Promise<T> {
  return database().then(db => new Promise<T>((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    let value: T;
    tx.oncomplete = () => resolve(value);
    tx.onabort = () => reject(tx.error || new Error("IndexedDB transaction aborted"));
    tx.onerror = () => reject(tx.error);
    action(tx.objectStore(STORE), (v) => { value = v; });
  }));
}

export async function listSessions(now = Date.now()): Promise<FullSession[]> {
  const rows = await transaction<FullSession[]>("readonly", (store, done) => {
    const req = store.getAll();
    req.onsuccess = () => done(req.result as FullSession[]);
  });
  const expired = rows.filter(s => isExpired(s, now));
  for (const s of expired) await deleteSession(s.id);
  return rows.filter(s => !isExpired(s, now)).sort((a, b) => b.updatedAt - a.updatedAt);
}
export function getSession(id: string): Promise<FullSession | undefined> {
  return transaction("readonly", (store, done) => {
    const req = store.get(id);
    req.onsuccess = () => done(req.result as FullSession | undefined);
  });
}
export function deleteSession(id: string): Promise<void> {
  return transaction("readwrite", (store) => { store.delete(id); });
}
export async function saveSession(session: FullSession): Promise<void> {
  if (sizeOf(session) > MAX_SESSION_BYTES) throw new Error("Session exceeds 5 MB");
  await transaction<void>("readwrite", (store) => { store.put(session); });
}
// Test isolation: close cached connection before replacing fake-indexeddb.
export async function closeDvrDatabase(): Promise<void> {
  if (dbPromise) { (await dbPromise).close(); dbPromise = null; }
}
