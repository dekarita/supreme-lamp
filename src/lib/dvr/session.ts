// [F107 §3] session.ts - Full DVR's session lifecycle: the glue between the
// step-3 ring (via the onDvrEntry seam), the mutation recorder, the screenshot
// pipeline and the IndexedDB adapter.
//
// ONE SESSION PER PAGE LOAD. It starts when main.tsx installs Full DVR and is
// persisted (meta + shots) as it grows, so a reload of the app still lists it in
// the Collector's "DVR sessions" section. The timeline itself (click/settle/route
// entries + mutation descriptors) is kept in bounded memory buffers; Export
// merges them with the stored index (src/lib/dvr/export.ts).
//
// PRIVACY POSTURE (same as every F107 file): nothing here touches the network;
// persistence is browser-local IndexedDB; the only egress is the operator-clicked
// export. tests/f107-dvr-full.test.js scans this file for the banned class.
import { onDvrEntry } from "../dvr";
import { FEATURES } from "../featureRegistry";
import { installMutationRecorder, type MutationRecorder } from "./mutations";
import { appendShots, SHOT_SESSION_CAP, type ShotRecord } from "./screenshotCore";
import { captureShot, shotsConsented } from "./screenshots";
import {
  appendMutations,
  MUTATION_SESSION_CAP,
  type MutationDescriptor,
} from "./mutationCore";
import {
  DVR_SESSION_BUDGET_BYTES,
  newSessionMeta,
  sessionBudgetOk,
  type DvrSessionMeta,
} from "./storageCore";
import {
  deleteSession,
  getSession,
  listSessions,
  listShots,
  migratePurgeLegacyShots,
  openDvrDb,
  pruneOldSessions,
  saveSession,
  saveShots,
} from "./storage";
import type { DvrCoreEntry } from "../dvr-core";

/** Timeline entries kept per session (bounded; newest win). */
export const SESSION_TIMELINE_CAP = 500;

export interface DvrFullHandle {
  sessionId(): string;
  meta(): DvrSessionMeta;
  timeline(): DvrCoreEntry[];
  mutations(): MutationDescriptor[];
  shots(): ShotRecord[];
  /** Persist meta (+ pending shots) now; resolves with the storage outcome. */
  persistNow(): Promise<{ ok: boolean; reason: string }>;
  uninstall(): void;
}

let handle: DvrFullHandle | null = null;

function newSessionId(now: number): string {
  const rand = Math.random().toString(36).slice(2, 8);
  return "dvr-" + String(now) + "-" + rand;
}

/**
 * Start (or return) the Full DVR session. Idempotent: a second call returns the
 * live handle. `deps` exists so the DOM gate can drive the same lifecycle against
 * fake-indexeddb without touching the singleton.
 */
export function installDvrFull(opts?: { now?: number; persistDelayMs?: number }): DvrFullHandle {
  if (handle) return handle;
  const startedAt = opts?.now ?? Date.now();
  const id = newSessionId(startedAt);
  let meta = newSessionMeta(id, startedAt);
  let timeline: DvrCoreEntry[] = [];
  let mutationBuffer: MutationDescriptor[] = [];
  let shots: ShotRecord[] = [];
  let seq = 0;
  let db: IDBDatabase | null = null;
  let persistTimer: ReturnType<typeof setTimeout> | null = null;
  const persistDelay = opts?.persistDelayMs ?? 2000;

  // Storage is best-effort: open the DB in the background, prune retention, and
  // degrade to memory-only when the host has no IndexedDB (jsdom tests inject the
  // real implementation via fake-indexeddb before calling this).
  void openDvrDb().then((res) => {
    if (res.ok && res.value) {
      db = res.value;
      void pruneOldSessions(db, Date.now());
      // [WP-13b / MC-P24] one-time privacy migration: shots stored before the
      // capture fence existed may contain credential pixels, and pixels cannot
      // be redacted — the records are purged (never copied), the session metas
      // are zeroed. Idempotent via a marker record; runs before any new shot
      // can be saved, so post-consent shots are never touched.
      void migratePurgeLegacyShots(db);
      void persistMeta();
    }
  });

  async function persistMeta(): Promise<{ ok: boolean; reason: string }> {
    if (!db) return { ok: false, reason: "db-not-open" };
    const res = await saveSession(db, meta);
    return { ok: res.ok, reason: res.reason };
  }

  function schedulePersist(): void {
    if (persistTimer) return;
    persistTimer = setTimeout(() => {
      persistTimer = null;
      void persistMeta();
    }, persistDelay);
  }

  // The mutation recorder feeds both the buffer (for export) and the meta count
  // (for persistence). Batches arrive already privacy-fenced by mutationCore.
  const recorder: MutationRecorder = installMutationRecorder((batch) => {
    mutationBuffer = appendMutations(mutationBuffer, batch, { sessionCap: MUTATION_SESSION_CAP });
    meta = { ...meta, mutations: meta.mutations + batch.length };
    schedulePersist();
  });

  async function takeShot(): Promise<void> {
    try {
      // [WP-13b / MC-P24] screenshots are an OPTIONAL capture path and are OFF
      // by default: the operator opts in per session (DvrFab panel). With
      // consent off, the click's timeline entry + mutation descriptors are
      // still recorded — only the pixel capture is skipped. If safe capture
      // cannot be established, the path stays disabled; it is never silently
      // re-enabled.
      if (!shotsConsented()) return;
      const res = await captureShot({
        viewW: typeof window !== "undefined" ? window.innerWidth : 1280,
        viewH: typeof window !== "undefined" ? window.innerHeight : 800,
        dpr: typeof window !== "undefined" && window.devicePixelRatio ? window.devicePixelRatio : 1,
      });
      if (!res.ok) return; // honest failure: the click entry still exists
      const key = String(++seq);
      const shot: ShotRecord = { key: key, at: Date.now(), w: res.w, h: res.h, bytes: res.bytes, dataUrl: res.dataUrl };
      if (!sessionBudgetOk(meta, shot.bytes)) return; // soft budget: skip, never fail
      shots = appendShots(shots, [shot], { sessionCap: SHOT_SESSION_CAP });
      meta = { ...meta, shots: shots.length, bytes: meta.bytes + shot.bytes };
      schedulePersist();
      if (db) {
        void saveShots(db, id, [shot], meta.bytes).then((r) => {
          if (r.ok && r.value) meta = { ...meta, bytes: Math.min(meta.bytes, DVR_SESSION_BUDGET_BYTES) };
        });
      }
    } catch {
      /* a screenshot must never break the click it documents */
    }
  }

  // The production subscriber to the step-3 ring: every click/settle/route lands
  // here exactly once, through the seam dvr.ts exposes (no second click listener).
  const offEntry = onDvrEntry((entry) => {
    try {
      timeline = timeline.length >= SESSION_TIMELINE_CAP ? timeline.slice(timeline.length - SESSION_TIMELINE_CAP + 1) : timeline;
      timeline = timeline.concat([entry]);
      const kind = String(entry.kind);
      if (kind === "click") {
        meta = { ...meta, clicks: meta.clicks + 1 };
        void takeShot();
      } else if (kind === "settle") {
        meta = { ...meta, settles: meta.settles + 1 };
      } else if (kind === "route") {
        meta = { ...meta, routes: meta.routes + 1 };
      }
      schedulePersist();
    } catch {
      /* see above */
    }
  });

  const onVisibility = (): void => {
    if (typeof document !== "undefined" && document.visibilityState === "hidden") void persistMeta();
  };
  const onPageHide = (): void => {
    meta = { ...meta, endedAt: Date.now() };
    void persistMeta();
  };
  try {
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisibility);
    if (typeof window !== "undefined") window.addEventListener("pagehide", onPageHide);
  } catch {
    /* persistence stays best-effort */
  }

  handle = {
    sessionId: () => id,
    meta: () => meta,
    timeline: () => timeline.slice(),
    mutations: () => mutationBuffer.slice(),
    shots: () => shots.slice(),
    persistNow: async () => {
      const res = await persistMeta();
      if (!res.ok && res.reason !== "db-not-open") return res;
      if (db && shots.length > 0) {
        const r = await saveShots(db, id, shots, meta.bytes);
        if (!r.ok) return { ok: false, reason: r.reason };
      }
      return { ok: true, reason: res.reason };
    },
    uninstall: () => {
      offEntry();
      recorder.uninstall();
      if (persistTimer) {
        clearTimeout(persistTimer);
        persistTimer = null;
      }
      try {
        if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisibility);
        if (typeof window !== "undefined") window.removeEventListener("pagehide", onPageHide);
      } catch {
        /* ignore */
      }
      if (db) {
        try {
          db.close();
        } catch {
          /* ignore */
        }
        db = null;
      }
      handle = null;
    },
  };
  return handle;
}

/** The live session (null before install / after uninstall). */
export function dvrFullHandle(): DvrFullHandle | null {
  return handle;
}

/** Test-only: forget the singleton between mounts. */
export function __resetDvrFullForTests(): void {
  if (handle) {
    try {
      handle.uninstall();
    } catch {
      /* ignore */
    }
  }
  handle = null;
}

/** Read-only registry snapshot for exports (id + route; nothing else leaves). */
export function registrySnapshot(): Array<{ id: string; route: string }> {
  return FEATURES.map((f) => ({ id: String(f.id), route: String(f.route) }));
}

/** Delete one stored session (+ its shots) through a short-lived db handle. */
export async function deleteStoredSession(id: string): Promise<{ ok: boolean; reason: string }> {
  const dbRes = await openDvrDb();
  if (!dbRes.ok || !dbRes.value) return { ok: false, reason: dbRes.reason };
  const res = await deleteSession(dbRes.value, id);
  try {
    dbRes.value.close();
  } catch {
    /* ignore */
  }
  return { ok: res.ok, reason: res.reason };
}

/** One stored session with its shots, for the per-session Export button. */
export async function storedSessionDetail(id: string): Promise<{
  ok: boolean;
  reason: string;
  meta: DvrSessionMeta | null;
  shots: import("./screenshotCore").ShotRecord[];
}> {
  const dbRes = await openDvrDb();
  if (!dbRes.ok || !dbRes.value) return { ok: false, reason: dbRes.reason, meta: null, shots: [] };
  const metaRes = await getSession(dbRes.value, id);
  const shotsRes = await listShots(dbRes.value, id);
  try {
    dbRes.value.close();
  } catch {
    /* ignore */
  }
  if (!metaRes.ok || !metaRes.value) return { ok: false, reason: metaRes.reason, meta: null, shots: [] };
  return { ok: true, reason: "", meta: metaRes.value, shots: shotsRes.value || [] };
}

/** Stored-session list for the UI: storage only, newest first. */
export async function storedSessions(): Promise<{ ok: boolean; reason: string; value: DvrSessionMeta[] }> {
  const dbRes = await openDvrDb();
  if (!dbRes.ok || !dbRes.value) return { ok: false, reason: dbRes.reason, value: [] };
  const res = await listSessions(dbRes.value);
  try {
    dbRes.value.close();
  } catch {
    /* ignore */
  }
  if (!res.ok || !res.value) return { ok: false, reason: res.reason, value: [] };
  const sorted = res.value.slice().sort((a, b) => Number(b.startedAt || 0) - Number(a.startedAt || 0));
  return { ok: true, reason: "", value: sorted };
}
