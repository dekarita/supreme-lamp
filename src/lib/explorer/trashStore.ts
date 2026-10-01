// [F57 §4] Soft-delete store. The Explorer drops entries here (never unlinks
// them), the Trash view restores or permanently confirms, Settings empties, and
// the 30-day sweep marks anything past retention. Persisted, guarded, and the
// only destructive surface in this phase - every removal is operator-driven.
import { create } from "zustand";
import {
  TRASH_RETENTION_DAYS,
  type TrashEntry,
  makeTrashEntry,
  expiredIds,
  daysLeft,
  summarizeTrash,
  type TrashSummary,
} from "./trash";

export const TRASH_STORAGE_KEY = "ghrdp.f57.trash";

interface TrashStoreState {
  entries: TrashEntry[];
  softDelete: (
    items: Array<{ id: string; name: string; kind: "folder" | "file"; sizeBytes: number | null; modified: string }>,
    originalDir: string,
    at?: number
  ) => TrashEntry[];
  /** The last soft delete, so Undo can move it straight back out again. */
  popLast: (ids: string[]) => TrashEntry[];
  restore: (ids: string[]) => TrashEntry[];
  /** Permanent removal for the operator-confirmed path / empty-trash. */
  purge: (ids: string[]) => number;
  sweep: (now?: number) => TrashEntry[];
  summary: (now?: number) => TrashSummary;
  daysLeft: (entry: TrashEntry, now?: number) => number;
}

function read(): TrashEntry[] {
  try {
    if (typeof localStorage === "undefined") return [];
    const raw = localStorage.getItem(TRASH_STORAGE_KEY);
    const list = raw ? (JSON.parse(raw) as TrashEntry[]) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function write(entries: TrashEntry[]): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(TRASH_STORAGE_KEY, JSON.stringify(entries));
  } catch {
    /* quota / private mode: the in-memory store still works */
  }
}

export const useTrashStore = create<TrashStoreState>((set, get) => ({
  entries: read(),
  softDelete: (items, originalDir, at = Date.now()) => {
    const made = items.map((it) => makeTrashEntry(it, originalDir, at));
    const entries = [...made, ...get().entries];
    write(entries);
    set({ entries });
    return made;
  },
  popLast: (ids) => {
    const picked = get().entries.filter((e) => ids.indexOf(e.id) >= 0);
    const entries = get().entries.filter((e) => ids.indexOf(e.id) < 0);
    write(entries);
    set({ entries });
    return picked;
  },
  restore: (ids) => {
    const picked = get().entries.filter((e) => ids.indexOf(e.id) >= 0);
    const entries = get().entries.filter((e) => ids.indexOf(e.id) < 0);
    write(entries);
    set({ entries });
    return picked;
  },
  purge: (ids) => {
    const before = get().entries.length;
    const entries = get().entries.filter((e) => ids.indexOf(e.id) < 0);
    write(entries);
    set({ entries });
    return before - entries.length;
  },
  sweep: (now = Date.now()) => {
    const gone = expiredIds(get().entries, now);
    if (!gone.length) return [];
    const removed = get().entries.filter((e) => gone.indexOf(e.id) >= 0);
    const entries = get().entries.filter((e) => gone.indexOf(e.id) < 0);
    write(entries);
    set({ entries });
    return removed;
  },
  summary: (now = Date.now()) => summarizeTrash(get().entries, now),
  daysLeft: (entry, now = Date.now()) => daysLeft(entry.trashedAt, now),
}));

export const TRASH_RETENTION = TRASH_RETENTION_DAYS;
