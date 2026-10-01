// [F56-d §3/§4] ONE reader for the file-arrival notify leg.
//
// Producer: payloads/ghrdp-watcher.ps1 publishes `fetchedFiles` (bounded,
// newest-first: id/name/sizeBytes/modified) inside progress.json.
// Transport: payloads/main.rs build_snapshot forwards progress.json verbatim in
// the /ws frame under `.progress`.
// Consumer: useDashboardPolling dispatches 'ghrdp-fetched-arrival' with this
// array, which is the only thing that replaces the FileExplorer Fetched-root
// empty state - the shipped UI never calls the F45 file API (S3 gate).
//
// Accepting both shapes (nested `.progress.fetchedFiles` and a top-level
// `fetchedFiles`) keeps the event alive if the frame is ever flattened, and the
// pure function is unit-testable without a WebSocket.

export interface FetchedArrival {
  id?: string;
  name?: string;
  path?: string;
  sizeBytes?: number | string | null;
  size?: number | string | null;
  modified?: string;
}

export function extractFetchedArrivals(data: unknown): FetchedArrival[] | null {
  if (!data || typeof data !== "object") return null;
  const frame = data as { fetchedFiles?: unknown; progress?: { fetchedFiles?: unknown } | null };
  const nested = frame.progress && typeof frame.progress === "object" ? frame.progress.fetchedFiles : undefined;
  const raw = Array.isArray(nested) ? nested : Array.isArray(frame.fetchedFiles) ? frame.fetchedFiles : null;
  if (!raw || raw.length === 0) return null;
  return raw.filter((e): e is FetchedArrival => !!e && typeof e === "object");
}
