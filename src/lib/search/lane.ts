// [F69 §1.4] Search lane flag (F68 audit §H.5). /diag echoes the dispatch input
// search_enable as `searchEnabled`; the pollers write it to
// window.__GHRDP_SEARCH_ENABLED (F56-d §3 contract, kept verbatim) and then call
// announceSearchLane() so React surfaces (sidebar entry, /search route) can
// subscribe instead of reading a dead window property once at mount.
//
// Semantics: only an EXPLICIT `false` hides the lane. `undefined` (flag not read
// yet, tests, static preview) keeps Search available so boot never flashes the
// entry away and the locked 9-entry sidebar stays intact by default.
import { useSyncExternalStore } from "react";

export const SEARCH_LANE_EVENT = "ghrdp:search-lane";

type LaneWindow = Window & { __GHRDP_SEARCH_ENABLED?: unknown };

export function isSearchLaneEnabled(): boolean {
  if (typeof window === "undefined") return true;
  return (window as LaneWindow).__GHRDP_SEARCH_ENABLED !== false;
}

/** Notify subscribers after a poller updated window.__GHRDP_SEARCH_ENABLED. */
export function announceSearchLane(): void {
  if (typeof window === "undefined") return;
  try {
    window.dispatchEvent(new Event(SEARCH_LANE_EVENT));
  } catch {
    /* non-DOM host: nothing to notify */
  }
}

function subscribe(onChange: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(SEARCH_LANE_EVENT, onChange);
  return () => window.removeEventListener(SEARCH_LANE_EVENT, onChange);
}

/** Reactive view of the lane flag; re-renders when a poller announces a change. */
export function useSearchLaneEnabled(): boolean {
  return useSyncExternalStore(subscribe, isSearchLaneEnabled, () => true);
}
