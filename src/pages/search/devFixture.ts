// [F56-c v3] DEV fixture fallback (§3). The 5-minute lab must VISIBLY progress
// even before F56-d's real transport exists: in dev mode only, when the live
// adapters settle empty, the rows in ./fixture.json stream one-by-one into the
// Results grid through the same normalized ingest path live partials will use.
// The prod build (no DEV flag) never imports this path's side effects and shows
// live results only (which may stay empty until F56-d). No fetch, no network.
import type { SearchResult } from "@/api/search";
import fixture from "./fixture.json";

export const DEV_FIXTURE_ROWS: SearchResult[] = fixture as unknown as SearchResult[];

/** One row streams in per tick so progressive states are visible. */
export const DEV_FIXTURE_TICK_MS = 250;

/** DEV detection per brief §3: import.meta.env.DEV or NODE_ENV=development. */
export function isDevMode(): boolean {
  const env = import.meta.env as { DEV?: boolean; MODE?: string };
  if (env.DEV === true || env.MODE === "development") return true;
  try {
    return typeof process !== "undefined" && process.env?.NODE_ENV === "development";
  } catch {
    return false;
  }
}

/** Should the DEV fixture stream start for this settled search? Only after a
 *  real submit (queryGeneration > 0), only when the live fan-out produced
 *  nothing, and only once per generation (devFixtureGen latch in the UI store). */
export function shouldStreamDevFixture(s: {
  phase: string;
  totalResults: number;
  queryGeneration: number;
  devFixtureGen: number;
}): boolean {
  if (!isDevMode()) return false;
  if (s.phase !== "complete" && s.phase !== "empty") return false;
  if (s.totalResults > 0 || s.queryGeneration === 0) return false;
  return s.devFixtureGen !== s.queryGeneration;
}
