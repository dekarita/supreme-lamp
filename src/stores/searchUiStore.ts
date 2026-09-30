// [F56-c v2] Search UI-only store: landing/results view, the submit
// animation latch, the collapsed Advanced disclosure, URL-import mode, the
// session-only recent list and the 5-minute lab clock origin. Nothing here is
// a search contract field (that is searchStore) and nothing here is ever
// persisted: credentials are wiped on close ("F46 per-run key, never
// persisted, session-end wipe") and no localStorage key is written.
import { create } from "zustand";

export type SearchView = "landing" | "results";

export interface CredDraft {
  host: string;
  user: string;
  password: string;
}

export interface SearchUiState {
  view: SearchView;
  /** True while the bar is animating center -> top (cleared on transition end). */
  animating: boolean;
  advancedOpen: boolean;
  importMode: boolean;
  recentQueries: string[];
  /** Epoch ms of the submit that started the 5-minute lab; 0 = not started. */
  labStartedAt: number;
  /** [F56-c v3] queryGeneration the DEV fixture stream already served (0 = none). */
  devFixtureGen: number;
  credModalOpen: boolean;
  cred: CredDraft;
  credError: string;
  enterResults: (query: string) => void;
  endAnimation: () => void;
  backToLanding: () => void;
  setAdvanced: (open: boolean) => void;
  toggleAdvanced: () => void;
  setImportMode: (on: boolean) => void;
  rememberQuery: (query: string) => void;
  startLab: (at?: number) => void;
  resetLab: () => void;
  /** [F56-c v3] Latch the DEV fixture stream to a query generation. */
  setDevFixtureGen: (gen: number) => void;
  openCredModal: (host: string) => void;
  closeCredModal: () => void;
  setCredUser: (v: string) => void;
  setCredPassword: (v: string) => void;
  setCredError: (v: string) => void;
}

const EMPTY_CRED: CredDraft = { host: "", user: "", password: "" };
export const RECENT_LIMIT = 5;

/** URL host for the credential modal title - never a full URL (a path or a
 *  query string could carry a token; only the host is allowed on screen). */
export function hostOf(value: string): string {
  try {
    return new URL(value.trim()).hostname;
  } catch {
    return "";
  }
}

export const useSearchUiStore = create<SearchUiState>((set, get) => ({
  view: "landing",
  animating: false,
  advancedOpen: false,
  importMode: false,
  recentQueries: [],
  labStartedAt: 0,
  devFixtureGen: 0,
  credModalOpen: false,
  cred: EMPTY_CRED,
  credError: "",

  enterResults: (query) => {
    get().rememberQuery(query);
    set({ view: "results", animating: true, importMode: false, labStartedAt: Date.now() });
  },
  endAnimation: () => set({ animating: false }),
  backToLanding: () => set({ view: "landing", animating: false, advancedOpen: false }),
  setAdvanced: (open) => set({ advancedOpen: open }),
  toggleAdvanced: () => set({ advancedOpen: !get().advancedOpen }),
  setImportMode: (on) => set({ importMode: on, view: on ? "results" : get().view }),
  rememberQuery: (query) => {
    const q = query.trim();
    if (!q) return;
    set({ recentQueries: [q, ...get().recentQueries.filter((x) => x !== q)].slice(0, RECENT_LIMIT) });
  },
  startLab: (at) => set({ labStartedAt: at ?? Date.now() }),
  resetLab: () => set({ labStartedAt: 0 }),
  setDevFixtureGen: (gen) => set({ devFixtureGen: gen }),
  openCredModal: (host) => set({ credModalOpen: true, credError: "", cred: { host, user: "", password: "" } }),
  // Session-end wipe: closing the modal clears user AND password. There is no
  // persistence layer for either field anywhere in this store.
  closeCredModal: () => set({ credModalOpen: false, credError: "", cred: EMPTY_CRED }),
  setCredUser: (v) => set({ cred: { ...get().cred, user: v } }),
  setCredPassword: (v) => set({ cred: { ...get().cred, password: v } }),
  setCredError: (v) => set({ credError: v }),
}));

export function selectCredFilled(s: SearchUiState): boolean {
  return s.cred.user.trim().length > 0 && s.cred.password.length > 0;
}
