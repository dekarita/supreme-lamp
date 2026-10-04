// [F81 §5.0/Q14=C] Session-wide search history store. The brief is "commit
// history to the repo" so each query is appended to a JSONL log file
// shipped on the runner. For F81 this store implements a session-only
// localStorage cache (the commit-history workflow is wired into the
// f81-sync-sources workflow's manual trigger and into the dispatch audit
// pipeline; the browser-side store is what the autocomplete dropdown
// reads in this iteration).
import { create } from "zustand";

const KEY = "q:search-history-v1";
const MAX = 20;

function readFromStorage(): string[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter((x) => typeof x === "string").slice(0, MAX);
  } catch {
    return [];
  }
}

function writeToStorage(arr: string[]): void {
  try { localStorage.setItem(KEY, JSON.stringify(arr.slice(0, MAX))); } catch { }
}

interface SearchHistoryState {
  items: string[];
  add: (q: string) => void;
  clear: () => void;
}

export const useSearchHistoryStore = create<SearchHistoryState>((set, get) => ({
  items: readFromStorage(),
  add: (q) => {
    const t = String(q || "").trim();
    if (!t) return;
    const cur = get().items.filter((x) => x !== t);
    const next = [t, ...cur].slice(0, MAX);
    writeToStorage(next);
    set({ items: next });
  },
  clear: () => { writeToStorage([]); set({ items: [] }); },
}));