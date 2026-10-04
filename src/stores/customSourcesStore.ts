// [F78 §1.2] Zustand store for the OPERATOR-ADDED custom sources (F58 registry)
// as seen by the UI. Two consumers only:
//   * "Your sites" (src/components/search/CustomSitesRow.tsx) reads `labSources`;
//   * the Lab inspector (src/pages/search/Lab.tsx) resolves a route sourceId.
// Loaded on CommandBar mount and re-loaded after every add/edit/delete, so the
// row is never stale. A failed load leaves the row hidden (empty list) instead
// of throwing: this store is a shortcut surface, never a hard dependency of the
// search lane. No credentials are read or stored here - auth is the shared
// X-Dash-Token header applied in src/api/lab/index.ts.
//
// [F81 §1.2/A.2 + §3.1/Q3] `removeSite(id)` fires DELETE /api/f58/sources/<id>
// and applies the result optimistically; a failure restores the prior list.
// [F81 §5.0/Q10] `addSite` enforces the 50-site cap with a client-side guard
// mirroring the server's 409 + `MAX_SITES` response, so the modal can disable
// the save button + show the hint before the request fires.
import { create } from "zustand";
import {
  createCustomSource,
  deleteCustomSource,
  listCustomSources,
  validateNewSite,
  type CustomSourceRow,
  type NewSiteError,
} from "@/api/lab";

export const MAX_CUSTOM_SITES = 50;

export interface AddSiteOutcome {
  ok: boolean;
  error: NewSiteError | string | null;
  source: CustomSourceRow | null;
}

export interface DeleteSiteOutcome {
  ok: boolean;
  error: string | null;
  id: string;
}

interface CustomSourcesState {
  /** Every non-lab source is filtered out; this IS the Lab Mode subset. */
  labSources: CustomSourceRow[];
  loading: boolean;
  error: string | null;
  lastLoadedAt: string | null;
  refresh: () => Promise<void>;
  addSite: (name: string, baseUrl: string) => Promise<AddSiteOutcome>;
  removeSite: (sourceId: string) => Promise<DeleteSiteOutcome>;
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
    // [F81 §5.0/Q10] Client-side cap mirror. The server enforces this too
    // (409 + MAX_SITES), but the modal disables Save before the request
    // ever fires so the operator sees the cap immediately.
    if (get().labSources.length >= MAX_CUSTOM_SITES) {
      return { ok: false, error: "newSiteMaxReached", source: null };
    }
    const res = await createCustomSource(name, baseUrl);
    if (!res.ok) return { ok: false, error: res.error.messageKey, source: null };
    // §1.2: a successful save re-loads the list, so the new card appears even if
    // the server derived the id/hostname itself.
    await get().refresh();
    return { ok: true, error: null, source: res.data };
  },

  removeSite: async (sourceId) => {
    // Optimistic removal: drop the row first, restore on failure.
    const prior = get().labSources;
    set({ labSources: prior.filter((s) => s.id !== sourceId) });
    const res = await deleteCustomSource(sourceId);
    if (!res.ok) {
      set({ labSources: prior });
      return { ok: false, error: res.error.messageKey || res.error.code, id: sourceId };
    }
    return { ok: true, error: null, id: sourceId };
  },

  byId: (sourceId) => get().labSources.find((s) => s.id === sourceId),
}));

/** Test/SSR helper: the store is module-level state shared by every mount. */
export function resetCustomSourcesStore(): void {
  useCustomSourcesStore.setState({ labSources: [], loading: false, error: null, lastLoadedAt: null });
}
