// [F107 §4] Types for the storage arithmetic core (src/lib/dvr/storageCore.js).

export declare const DVR_SESSION_BUDGET_BYTES: number;
export declare const DVR_RETENTION_DAYS: number;
export declare const DVR_RETENTION_MS: number;
export declare const DVR_DB_NAME: string;
export declare const DVR_DB_VERSION: number;
export declare const DVR_STORE_SESSIONS: string;
export declare const DVR_STORE_SHOTS: string;

export interface DvrSessionMeta {
  id: string;
  startedAt: number;
  endedAt: number;
  clicks: number;
  settles: number;
  routes: number;
  mutations: number;
  shots: number;
  bytes: number;
  label: string;
}

export declare function newSessionMeta(id: string, now: number, opts?: { label?: string }): DvrSessionMeta;
export declare function sessionBudgetOk(session: { bytes?: number } | null, addBytes: number): boolean;
export declare function pruneByRetention(sessions: DvrSessionMeta[], now: number): { keep: DvrSessionMeta[]; drop: DvrSessionMeta[] };
export declare function classifyQuotaError(err: unknown): "quota-exceeded" | "unavailable" | "unknown";
export declare function shrinkToFit(
  shots: Array<{ key?: string; bytes?: number }>,
  sessionBytes: number,
  plannedBytes: number,
  opts?: { budgetBytes?: number }
): { shots: Array<{ key?: string; bytes?: number }>; bytes: number; droppedKeys: string[]; fits: boolean };
export declare function sortSessionsNewestFirst(sessions: DvrSessionMeta[]): DvrSessionMeta[];
