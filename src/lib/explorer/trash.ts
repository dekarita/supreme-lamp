// [F57 §4] Trash policy: NOTHING in the Explorer hard-deletes in place. A soft
// delete routes the entry into D:\RDP-Storage\.trash\<original-path>\<ts> and
// keeps it for 30 days (plan §11 "no hard delete anywhere"); the trash view /
// Settings empty-trash control are the only paths that clear it, and the
// permanent (Shift+Delete) path is the operator-confirmed one.
export const TRASH_ROOT = "D:\\RDP-Storage\\.trash";
export const TRASH_RETENTION_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Folder-safe UTC stamp, e.g. 20261001T101530Z. */
export function trashStamp(at: Date | string | number = Date.now()): string {
  const d = at instanceof Date ? at : new Date(at);
  const iso = isNaN(d.getTime()) ? new Date(0).toISOString() : d.toISOString();
  return iso.slice(0, 19).replace(/[-:]/g, "") + "Z";
}

/**
 * The trash destination for one entry:
 *   D:\RDP-Storage\.trash\C\Users\RDP\Desktop\notes.txt\20261001T101530Z
 * The original path is preserved in the tree (plan §11) so restore is a pure
 * move back - no sidecar index is required to find it again.
 */
export function trashTargetFor(originalPath: string, at: Date | string | number = Date.now()): string {
  const rel = String(originalPath || "")
    .replace(/^[A-Za-z]:\\?/, (m) => m.slice(0, 1) + "\\") // C:\Users -> C\Users
    .replace(/[/:]+/g, "\\")
    .replace(/^\\+/, "")
    .replace(/\\+$/, "");
  return TRASH_ROOT + "\\" + rel + "\\" + trashStamp(at);
}

export function expiryFor(trashedAt: Date | string | number, days = TRASH_RETENTION_DAYS): string {
  const t = new Date(trashedAt).getTime();
  return new Date((isNaN(t) ? 0 : t) + days * DAY_MS).toISOString();
}

export function daysLeft(trashedAt: Date | string | number, now: Date | number = Date.now(), days = TRASH_RETENTION_DAYS): number {
  const exp = new Date(expiryFor(trashedAt, days)).getTime();
  const n = now instanceof Date ? now.getTime() : now;
  return Math.max(0, Math.ceil((exp - n) / DAY_MS));
}

export function isExpired(trashedAt: Date | string | number, now: Date | number = Date.now(), days = TRASH_RETENTION_DAYS): boolean {
  return new Date(expiryFor(trashedAt, days)).getTime() <= (now instanceof Date ? now.getTime() : now);
}

export interface TrashEntry {
  id: string;
  name: string;
  kind: "folder" | "file";
  sizeBytes: number | null;
  modified: string;
  /** Where it lived before the soft delete. */
  originalPath: string;
  /** The .trash\<original-path>\<ts> destination. */
  trashPath: string;
  trashedAt: string;
  expiresAt: string;
}

export function makeTrashEntry(
  entry: { id: string; name: string; kind: "folder" | "file"; sizeBytes: number | null; modified: string },
  originalDir: string,
  at: Date | string | number = Date.now()
): TrashEntry {
  const atIso = new Date(at instanceof Date ? at.getTime() : at).toISOString();
  const originalPath = String(originalDir || "").replace(/\\+$/, "") + "\\" + entry.name;
  return {
    id: "trash-" + entry.id + "-" + trashStamp(atIso),
    name: entry.name,
    kind: entry.kind,
    sizeBytes: entry.sizeBytes,
    modified: entry.modified,
    originalPath,
    trashPath: trashTargetFor(originalPath, atIso),
    trashedAt: atIso,
    expiresAt: expiryFor(atIso),
  };
}

export interface TrashSummary {
  count: number;
  bytes: number;
  expiringSoon: number;
}

export function summarizeTrash(entries: TrashEntry[], now: Date | number = Date.now()): TrashSummary {
  return {
    count: entries.length,
    bytes: entries.reduce((n, e) => n + (e.sizeBytes || 0), 0),
    expiringSoon: entries.filter((e) => daysLeft(e.trashedAt, now) <= 7).length,
  };
}

/** Entries past the 30-day retention - the sweep target (plan §11). */
export function expiredIds(entries: TrashEntry[], now: Date | number = Date.now()): string[] {
  return entries.filter((e) => isExpired(e.trashedAt, now)).map((e) => e.id);
}

export function retentionNoteKey(): string {
  return "files.ops.trash.retentionNote";
}
