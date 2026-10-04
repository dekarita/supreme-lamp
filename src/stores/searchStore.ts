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
// [F56-c v2] decisions.md A1 in-place overwrite (operator brief §2): the size
// slider's initial position is 0 = "no maximum-size cap" (Google-style landing
// shows no cap at all), while positive slider values stay inclusive maximum
// sizes and 0 keeps its frozen A1 "no cap" meaning for the wire contract. The
// planned 10 GB default is retained only as a named constant for the history
// note; nothing reads it as a default any more.
export const DEFAULT_MAX_SIZE_BYTES = 0;
export const A1_PLANNED_DEFAULT_MAX_SIZE_BYTES = 10 * GB;
export const MAX_SIZE_BYTES = 100 * GB;

// [F70] Retained legacy single-source ID for explicit selections and callers.
// [F79] It is NOT pre-selected: [] delegates the default pack to the backend.
export const DEFAULT_ADAPTER_ID = "google-books-public";

// [F72 §2.1] Fan-out helper import
import { resolveFanOutAdapters } from "@/lib/search/fanOut";
import { scoreResult } from "@/lib/search/relevance";
// [F81 §2.3/Q7=B] Intent-aware adapter ranking
import { classifyIntent, rankAdaptersByIntent } from "@/lib/search/intent";
// [F81 §5.0/Q14=C] Search history → localStorage cache
import { useSearchHistoryStore } from "@/stores/searchHistoryStore";

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
  // [F69 §2.5] FetchAccepted projection (F68 Extension Rank 7). Optional so the
  // F56-c compat rows (stubFetch: fetchId === resultId, no gid) keep rendering;
  // the cancel action only appears once a real gid exists.
  resultId?: string;
  gid?: string;
  transport?: "aria2c" | "torrent";
  status?: string;
  sourceSnapshotId?: string;
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
  // [F79] Empty selection delegates to the backend's locked five defaults.
  // Explicit Advanced selections retain the F72 capped fan-out helper.
  adapterIds: string[];
  // [F79] Session-only diagnostic disclosure; OFF until explicitly enabled.
  showProgress: boolean;
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
  // [F72 §2.2] Extended filter state: file-type chips, year range, language, group-by
  fileExtensions: string[];
  yearFrom: number | null;
  yearTo: number | null;
  language: string;
  groupBySource: boolean;
  // Actions
  setQuery: (raw: string) => void;
  applyPrefill: (raw: string) => void;
  clearQuery: () => void;
  toggleCategory: (c: Category | "all") => void;
  toggleLicence: (l: LicenceTag) => void;
  toggleAdapter: (adapterId: string) => void;
  setShowProgress: (show: boolean) => void;
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
  /** [F56-c v2] Fetch stub bookkeeping: records a pending fetch row for the
   *  rail without starting any transfer (F56-d replaces the body). */
  stubFetch: (resultId: string) => void;
  /** [F69 §2.5] Record an accepted F56-d fetch for a result (keyed by resultId). */
  recordFetch: (resultId: string, rec: Omit<FetchRecord, "resultId">) => void;
  /** [F69 §2.5] Update the status pill of a recorded fetch (cancel lifecycle). */
  setFetchStatus: (resultId: string, status: string) => void;
  /** [F56-c v3] Merge rows into the normalized result maps (deduped by
   *  resultId). Used by the DEV fixture stream; F56-d's live partials take
   *  the same path through pollOnce, which always wins (see Search.tsx). */
  ingestResults: (rows: SearchResult[]) => void;
  // [F72 §2.2] Extended filter actions
  toggleFileExtension: (ext: string) => void;
  setYearRange: (from: number | null, to: number | null) => void;
  setLanguage: (lang: string) => void;
  toggleGroupBySource: () => void;
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
  adapterIds: [],
  showProgress: false,
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
  // [F72 §2.2] Extended filter defaults
  fileExtensions: [],
  yearFrom: null,
  yearTo: null,
  language: "",
  groupBySource: false,

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
  toggleAdapter: (adapterId) => {
    const cur = get().adapterIds;
    set({ adapterIds: cur.includes(adapterId) ? cur.filter((x) => x !== adapterId) : [...cur, adapterId] });
  },
  setShowProgress: (showProgress) => set({ showProgress }),
  resetFilters: () =>
    set({ categories: [], licenceTags: [], maxSizeBytes: DEFAULT_MAX_SIZE_BYTES, sort: "relevance", adapterIds: [] }),
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
    // [F81 §2.2/Q6] Query-length minimum: reject <3 chars after trim. The
    // operator sees an inline hint via the `lastErrorCode` / `phase: idle`
    // pair; the search bar re-renders the existing validation text. Empty
    // URL imports already short-circuit above via inputKind.
    const trimmed = st.rawQuery.trim();
    if (trimmed.length < 3) {
      set({ phase: "idle", lastErrorCode: "search.errors.queryTooShort" });
      return;
    }
    const generation = st.queryGeneration + 1;
    const requestId = newRequestId();
    const query = trimmed;
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
    // [F81 §5.0/Q14=C] Record this query for autocomplete + history.
    try { useSearchHistoryStore.getState().add(query); } catch { }
    // [F79] The backend is the source of truth for the automatic five-source
    // pack. Send [] rather than silently selecting one or the whole registry.
    // Preserve F72 deduplication + eight-source cap for explicit selections.
    // [F81 §2.3/Q7=B] When the operator does NOT explicitly pick adapters,
    // the intent classifier lifts the relevant sources to the top of the
    // default fan-out. Empty selection still defaults to the backend's
    // five-source pack; we only re-rank if the operator pre-selected.
    let resolvedAdapters: string[];
    if (st.adapterIds.length) {
      const intent = classifyIntent(query);
      resolvedAdapters = rankAdaptersByIntent(resolveFanOutAdapters(st.adapterIds), intent);
    } else {
      resolvedAdapters = [];
    }
    const res = await createSearch({
      requestId,
      query,
      scope: st.scope,
      categories: st.categories.length ? st.categories : undefined,
      licenceTags: st.licenceTags.length ? st.licenceTags : undefined,
      adapterIds: resolvedAdapters,
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
  stubFetch: (resultId) => {
    // F56-d fills FetchRecord; F56-c records the pending row only. No bytes,
    // no URL request, no mirror opt-in (mirror stays default-OFF).
    if (get().fetches[resultId]) return;
    set({ fetches: { ...get().fetches, [resultId]: { fetchId: resultId } } });
  },

  recordFetch: (resultId, rec) => {
    set({ fetches: { ...get().fetches, [resultId]: { ...rec, resultId } } });
  },

  setFetchStatus: (resultId, status) => {
    const cur = get().fetches[resultId];
    if (!cur) return;
    set({ fetches: { ...get().fetches, [resultId]: { ...cur, status } } });
  },

  ingestResults: (rows) => {
    if (!rows.length) return;
    const results = { ...get().results };
    const resultOrder = [...get().resultOrder];
    for (const r of rows) {
      if (!results[r.resultId]) resultOrder.push(r.resultId);
      results[r.resultId] = r;
    }
    set({ results, resultOrder });
  },

  // [F72 §2.2] Extended filter actions
  toggleFileExtension: (ext) => {
    const cur = get().fileExtensions;
    set({ fileExtensions: cur.includes(ext) ? cur.filter((x) => x !== ext) : [...cur, ext] });
  },
  setYearRange: (from, to) => set({ yearFrom: from, yearTo: to }),
  setLanguage: (lang) => set({ language: lang }),
  toggleGroupBySource: () => set({ groupBySource: !get().groupBySource }),
}));

export type ResultFilters = Pick<SearchState, "results" | "resultOrder" | "categories" | "licenceTags" | "maxSizeBytes" | "sort"> & {
  fileExtensions?: string[];
  yearFrom?: number | null;
  yearTo?: number | null;
  language?: string;
  query?: string;
};

/** Local filters + stable sort (Plan §B/§D). Applied to received results first;
 *  equal values retain adapter order and result identity order. maxSizeBytes 0
 *  means no cap (decisions.md A1); unknown sizes are never filtered out.
 *  [F72 §2.2] Extended with file-extension chips, year range, language filter,
 *  and relevance scoring (via scoreResult). */
export function selectVisibleResults(s: ResultFilters): SearchResult[] {
  const out: SearchResult[] = [];
  for (const id of s.resultOrder) {
    const r = s.results[id];
    if (!r) continue;
    if (s.categories.length && !s.categories.includes(r.category)) continue;
    if (s.licenceTags.length && !s.licenceTags.includes(r.licenceTag)) continue;
    if (s.maxSizeBytes > 0 && r.sizeBytes != null && r.sizeBytes > s.maxSizeBytes) continue;
    // [F72 §2.2] File extension filter
    if (s.fileExtensions && s.fileExtensions.length) {
      const mime = String(r.mimeType || "").toLowerCase();
      const hasExt = s.fileExtensions.some((ext) => mime.includes(ext) || mime.includes(ext.replace(".", "")));
      if (!hasExt) continue;
    }
    // [F72 §2.2] Year range filter
    if ((s.yearFrom != null || s.yearTo != null) && r.date) {
      const year = parseInt(String(r.date).slice(0, 4), 10);
      if (!isNaN(year)) {
        if (s.yearFrom != null && year < s.yearFrom) continue;
        if (s.yearTo != null && year > s.yearTo) continue;
      }
    }
    out.push(r);
  }
  if (s.sort === "size") {
    out.sort((a, b) => (b.sizeBytes ?? -1) - (a.sizeBytes ?? -1));
  } else if (s.sort === "date") {
    out.sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));
  } else if (s.sort === "relevance" && s.query) {
    // [F72 §2.1 + F81 §2.1/Q5=D] Deterministic relevance sort: score desc,
    // then original order. The score function takes the full corpus so BM25
    // IDF stays calibrated across this search's results.
    const orderMap = new Map(s.resultOrder.map((id, i) => [id, i]));
    out.sort((a, b) => {
      const sa = scoreResult(s.query!, a, out);
      const sb = scoreResult(s.query!, b, out);
      if (sb !== sa) return sb - sa;
      return (orderMap.get(a.resultId) ?? 0) - (orderMap.get(b.resultId) ?? 0);
    });
  }
  return out;
}

export function selectFilterSelectionCount(s: SearchState): number {
  // [F56-c v2] 0 = no cap = NOT a filter, so the untouched default counts 0.
  const sizeFiltered = s.maxSizeBytes > 0 && s.maxSizeBytes < MAX_SIZE_BYTES ? 1 : 0;
  return s.categories.length + s.licenceTags.length + s.adapterIds.length + sizeFiltered;
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
