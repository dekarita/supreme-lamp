// [F77] Search navigation is unconditional. /diag may still report a dispatch
// flag for diagnostics, but neither browser globals nor storage can hide Search.
export function isSearchLaneEnabled(): boolean {
  return true;
}

/** Compatibility helper for callers that previously subscribed to the lane flag. */
export function useSearchLaneEnabled(): boolean {
  return true;
}
