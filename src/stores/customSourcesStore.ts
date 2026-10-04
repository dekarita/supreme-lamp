// [F78 §1.2] Zustand store for the OPERATOR-ADDED custom sources (F58 registry)
// as seen by the UI. Two consumers only:
//   * "Your sites" (src/components/search/CustomSitesRow.tsx) reads `labSources`;
//   * the Lab inspector (src/pages/search/Lab.tsx) resolves a route sourceId.
// Loaded on CommandBar mount and re-loaded after every add/edit/delete, so the
// row is never stale. A failed load leaves the row hidden (empty list) instead
// of throwing: this store is a shortcut surface, never a hard dependency of the
// search lane. No credentials are read or stored here - auth is the shared
// X-Dash-Token header applied in src/api/lab/index.ts.
import { create } from "zustand";
import {
  createCustomSource,
  listCustomSources,
  validateNewSite,
  type CustomSourceRow,
  type NewSiteError,
} from "@/api/lab";

export interface AddSiteOutcome {
  ok: boolean;
  error: NewSiteError | string | null;
  source: CustomSourceRow | null;
}

interface CustomSourcesState {
  /** Every non-lab source is filtered out; this IS the Lab Mode subset. */
  labSources: CustomSourceRow[];
  loading: boolean;
  error: string | null;
  lastLoadedAt: string | null;
  refresh: () => Promise<void>;
  addSite: (name: string, baseUrl: string) => Promise<AddSiteOutcome>;
  byId: (sourceId: string) => CustomSourceRow | undefined;
}

export const useCustomSourcesStore = create<CustomSourcesState>((set, get) => ({
  labSources: [],
  loading: false,
  error: null,
  lastLoadedAt: null,

  refresh: async () => {
    set({ loading: true });
    const res = await listCustomSources();
    if (res.ok) set({ labSources: res.data, loading: false, error: null, lastLoadedAt: new Date().toISOString() });
    else set({ loading: false, error: res.error.code });
  },

  addSite: async (name, baseUrl) => {
    const invalid = validateNewSite(name, baseUrl);
    if (invalid) return { ok: false, error: invalid, source: null };
    const res = await createCustomSource(name, baseUrl);
    if (!res.ok) return { ok: false, error: res.error.messageKey, source: null };
    // §1.2: a successful save re-loads the list, so the new card appears even if
    // the server derived the id/hostname itself.
    await get().refresh();
    return { ok: true, error: null, source: res.data };
  },

  byId: (sourceId) => get().labSources.find((s) => s.id === sourceId),
}));

/** Test/SSR helper: the store is module-level state shared by every mount. */
export function resetCustomSourcesStore(): void {
  useCustomSourcesStore.setState({ labSources: [], loading: false, error: null, lastLoadedAt: null });
}
