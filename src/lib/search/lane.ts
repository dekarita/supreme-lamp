// [F77 §2.2] The Search lane is HARDCODED ENABLED. History: F56-d §3 read the
// /diag echo once at boot, F69 §1.4 made it reactive through
// window.__GHRDP_SEARCH_ENABLED and F76 §1.2 narrowed the hide to an EXPLICIT
// false. Every one of those could still flash the entry away - a stale bundle,
// an old cached false, or a /diag served before the dispatch input landed. From
// F77 on, NOTHING in the UI may hide Search: no window read, no
// localStorage/sessionStorage read, no store field. window
// .__GHRDP_SEARCH_ENABLED stays a pure /diag mirror for the diagnostics drawer
// and the labs (main.yml's F56-d gate pins its presence at
// src/stores/sessionStore.ts + src/hooks/useDashboardPolling.ts); it is
// informational and has no consumer here.
import { useSyncExternalStore } from "react";

/** Kept for source compatibility: the pollers still announce the diag mirror. */
export const SEARCH_LANE_EVENT = "ghrdp:search-lane";

/** [F77] Constant true. A function (not a const) so call sites stay typed. */
export function isSearchLaneEnabled(): boolean {
  return true;
}

/** [F77 §2.3] No-op: the lane cannot change, so there is nothing to announce. */
export function announceSearchLane(): void {
  /* intentionally empty - the flag no longer drives any UI decision */
}

function subscribeSearchLane(_onChange: () => void): () => void {
  return () => {};
}

/** [F77] Reactive signature kept (labs + drawer subscribe to it); value is true. */
export function useSearchLaneEnabled(): boolean {
  return useSyncExternalStore(subscribeSearchLane, isSearchLaneEnabled, isSearchLaneEnabled);
}
