// [F56-c] Federated-search feature store (Plan §B, normalized). Query,
// filter, per-adapter, request, result and selection/focus state live here -
// never component-local. Typing only updates local state; fan-out happens on
// explicit submit (Plan §D / decisions.md A2). Fetch records exist as an empty
// F56-d stub: nothing in F56-c starts a download or a preview byte fetch.
// Stale responses are rejected with the monotonic queryGeneration.
import { create } from "zustand";
import {
  cancelSearch as apiCancelSearch,
  createSearch,
  getSearchStatus,
  newRequestId,
  type AdapterState,
  type Category,
  type LicenceTag,
  type Scope,
  type SearchPhase,
  type SearchResult,
  type SortKey,
} from "@/api/search";

export type InputKind = "text" | "https-url" | "unsupported-url" | "empty";

const GB = 1024 * 1024 * 1024;
export const DEFAULT_MAX_SIZE_BYTES = 10 * GB; // decisions.md A1
export const MAX_SIZE_BYTES = 100 * GB;

export function classifyQuery(raw: string): InputKind {
  const q = raw.trim();
  if (!q) return "empty";
  if (/^https:\/\//i.test(q)) {
    try {
      const u = new URL(q);
      const host = u.hostname;
      const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":") || host.startsWith("[");
      return isIp ? "unsupported-url" : "https-url";
    } catch {
      return "unsupported-url";
    }
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(q)) return "unsupported-url";
  return "text";
}

export interface FetchRecord {
  // F56-d fills this contract (Plan §B fetch state); empty in F56-c.
  fetchId: string;
}

export interface SearchState {
  // Query state
  rawQuery: string;
  normalizedQuery: string;
  inputKind: InputKind;
  lastSubmittedQuery: string;
  queryGeneration: number;
  autofocusPending: boolean;
  // Filter state
  categories: Category[];
  licenceTags: LicenceTag[];
  maxSizeBytes: number;
  sort: SortKey;
  scope: Scope;
  // Per-adapter state (compiled adapters arrive with the accepted list)
  adapters: Record<string, AdapterState>;
  // Search request state
  searchId: string;
  requestId: string;
  phase: SearchPhase;
  cursor: string;
  hasMore: boolean;
  cancelling: boolean;
  lastStatusAt: string;
  lastErrorCode: string;
  // Result state (normalized by stable resultId)
  results: Record<string, SearchResult>;
  resultOrder: string[];
  // Selection and focus state
  selectedIds: string[];
  activeResultId: string;
  activeRowIndex: number;
  previewResultId: string;
  // Fetch state - F56-d stub, always defaulting mirror opt-in to false
  fetches: Record<string, FetchRecord>;
  // Actions
  setQuery: (raw: string) => void;
  applyPrefill: (raw: string) => void;
  clearQuery: () => void;
  toggleCategory: (c: Category | "all") => void;
  toggleLicence: (l: LicenceTag) => void;
  resetFilters: () => void;
  setMaxSizeBytes: (n: number) => void;
  setSort: (s: SortKey) => void;
  setScope: (s: Scope) => void;
  submit: () => Promise<void>;
  pollOnce: () => Promise<void>;
  cancelSearch: () => Promise<void>;
  select: (resultId: string, on: boolean) => void;
  setActiveRow: (index: number) => void;
  openPreview: (resultId: string) => void;
  closePreview: () => void;
}

export const useSearchStore = create<SearchState>((set, get) => ({
  rawQuery: "",
  normalizedQuery: "",
  inputKind: "empty",
  lastSubmittedQuery: "",
  queryGeneration: 0,
  autofocusPending: true,
  categories: [],
  licenceTags: [],
  maxSizeBytes: DEFAULT_MAX_SIZE_BYTES,
  sort: "relevance",
  scope: "federated",
  adapters: {},
  searchId: "",
  requestId: "",
  phase: "idle",
  cursor: "",
  hasMore: false,
  cancelling: false,
  lastStatusAt: "",
  lastErrorCode: "",
  results: {},
  resultOrder: [],
  selectedIds: [],
  activeResultId: "",
  activeRowIndex: -1,
  previewResultId: "",
  fetches: {},

  setQuery: (raw) =>
    set({ rawQuery: raw, normalizedQuery: raw.trim(), inputKind: classifyQuery(raw) }),
  applyPrefill: (raw) =>
    set({ rawQuery: raw, normalizedQuery: raw.trim(), inputKind: classifyQuery(raw), autofocusPending: true }),
  clearQuery: () =>
    set({ rawQuery: "", normalizedQuery: "", inputKind: "empty", autofocusPending: true }),

  toggleCategory: (c) => {
    if (c === "all") return set({ categories: [] });
    const cur = get().categories;
    set({ categories: cur.includes(c) ? cur.filter((x) => x !== c) : [...cur, c] });
  },
  toggleLicence: (l) => {
    const cur = get().licenceTags;
    set({ licenceTags: cur.includes(l) ? cur.filter((x) => x !== l) : [...cur, l] });
  },
  resetFilters: () => set({ categories: [], licenceTags: [], maxSizeBytes: DEFAULT_MAX_SIZE_BYTES, sort: "relevance" }),
  setMaxSizeBytes: (n) => set({ maxSizeBytes: Math.max(0, Math.min(n, MAX_SIZE_BYTES)) }),
  setSort: (s) => set({ sort: s }),
  setScope: (s) => set({ scope: s }),

  submit: async () => {
    const st = get();
    const inputKind = classifyQuery(st.rawQuery);
    if (inputKind === "empty" || inputKind === "unsupported-url") {
      set({ inputKind });
      return;
    }
    const generation = st.queryGeneration + 1;
    const requestId = newRequestId();
    const query = st.rawQuery.trim();
    set({
      inputKind,
      normalizedQuery: query,
      lastSubmittedQuery: query,
      queryGeneration: generation,
      requestId,
      searchId: "",
      phase: "queued",
      adapters: {},
      results: {},
      resultOrder: [],
      selectedIds: [],
      activeResultId: "",
      activeRowIndex: -1,
      cursor: "",
      hasMore: false,
      cancelling: false,
      lastErrorCode: "",
    });
    const res = await createSearch({
      requestId,
      query,
      scope: st.scope,
      categories: st.categories.length ? st.categories : undefined,
      licenceTags: st.licenceTags.length ? st.licenceTags : undefined,
      maxSizeBytes: st.maxSizeBytes,
      sort: st.sort,
      limit: 50,
    });
    if (get().queryGeneration !== generation) return; // stale
    if (!res.ok) {
      set({ phase: "failed", lastErrorCode: res.error.code });
      return;
    }
    const adapters: Record<string, AdapterState> = {};
    for (const a of res.data.adapterStatuses || []) adapters[a.adapterId] = a;
    set({
      searchId: res.data.searchId,
      phase: res.data.phase,
      adapters,
      lastStatusAt: new Date().toISOString(),
    });
    await get().pollOnce();
  },

  pollOnce: async () => {
    const st = get();
    if (!st.searchId || st.cancelling || st.phase === "cancelled") return;
    const generation = st.queryGeneration;
    const res = await getSearchStatus(st.searchId, st.cursor || undefined);
    if (get().queryGeneration !== generation) return; // stale
    if (!res.ok) {
      set({ phase: "failed", lastErrorCode: res.error.code });
      return;
    }
    const d = res.data;
    const adapters = { ...get().adapters };
    for (const a of d.adapterStatuses || []) adapters[a.adapterId] = { ...adapters[a.adapterId], ...a };
    const results = { ...get().results };
    const resultOrder = [...get().resultOrder];
    for (const r of d.results || []) {
      if (!results[r.resultId]) resultOrder.push(r.resultId);
      results[r.resultId] = r;
    }
    set({
      phase: d.phase,
      adapters,
      results,
      resultOrder,
      cursor: d.cursor || "",
      hasMore: Boolean(d.hasMore),
      lastStatusAt: d.serverTs,
    });
  },

  cancelSearch: async () => {
    const st = get();
    if (!st.searchId || st.cancelling) return;
    set({ cancelling: true });
    const res = await apiCancelSearch({
      requestId: newRequestId(),
      searchId: st.searchId,
      reason: "user-cancel",
    });
    if (!res.ok) {
      set({ cancelling: false, lastErrorCode: res.error.code });
      return;
    }
    set({ phase: "cancelled", cancelling: false });
  },

  select: (resultId, on) => {
    const cur = get().selectedIds;
    set({
      selectedIds: on ? (cur.includes(resultId) ? cur : [...cur, resultId]) : cur.filter((x) => x !== resultId),
    });
  },
  setActiveRow: (index) => {
    const order = get().resultOrder;
    const clamped = Math.max(-1, Math.min(index, order.length - 1));
    set({ activeRowIndex: clamped, activeResultId: clamped >= 0 ? order[clamped] : "" });
  },
  openPreview: (resultId) => set({ previewResultId: resultId }),
  closePreview: () => set({ previewResultId: "" }),
}));

export type ResultFilters = Pick<SearchState, "results" | "resultOrder" | "categories" | "licenceTags" | "maxSizeBytes" | "sort">;

/** Local filters + stable sort (Plan §B/§D). Applied to received results first;
 *  equal values retain adapter order and result identity order. maxSizeBytes 0
 *  means no cap (decisions.md A1); unknown sizes are never filtered out. */
export function selectVisibleResults(s: ResultFilters): SearchResult[] {
  const out: SearchResult[] = [];
  for (const id of s.resultOrder) {
    const r = s.results[id];
    if (!r) continue;
    if (s.categories.length && !s.categories.includes(r.category)) continue;
    if (s.licenceTags.length && !s.licenceTags.includes(r.licenceTag)) continue;
    if (s.maxSizeBytes > 0 && r.sizeBytes != null && r.sizeBytes > s.maxSizeBytes) continue;
    out.push(r);
  }
  if (s.sort === "size") {
    out.sort((a, b) => (b.sizeBytes ?? -1) - (a.sizeBytes ?? -1));
  } else if (s.sort === "date") {
    out.sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));
  }
  return out;
}

export function selectFilterSelectionCount(s: SearchState): number {
  return s.categories.length + s.licenceTags.length + (s.maxSizeBytes < MAX_SIZE_BYTES ? 1 : 0);
}

export function logToSizeBytes(position: number): number {
  // Logarithmic 0-100 slider mapping (Plan §D): 0 = no cap, >0 maps log-scale
  // between 1 MB and 100 GB so small files stay selectable.
  const p = Math.max(0, Math.min(100, position));
  if (p === 0) return 0;
  const min = Math.log(1024 * 1024);
  const max = Math.log(MAX_SIZE_BYTES);
  return Math.round(Math.exp(min + ((max - min) * p) / 100));
}

export function sizeBytesToLog(sizeBytes: number): number {
  if (sizeBytes <= 0) return 0;
  const min = Math.log(1024 * 1024);
  const max = Math.log(MAX_SIZE_BYTES);
  const v = Math.log(Math.max(1024 * 1024, Math.min(MAX_SIZE_BYTES, sizeBytes)));
  return Math.round(((v - min) / (max - min)) * 100);
}
