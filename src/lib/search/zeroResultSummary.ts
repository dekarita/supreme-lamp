// [R-SEARCH / #216] Zero-result explanation.
//
// PROBLEM. A search that returns nothing looks identical whether every source
// answered "no matches" or every source fell over. The empty state says
// "No results for X - try broader terms", which sends the operator to rewrite a
// query that was never the problem.
//
// CONTRACT.
//   * A clean zero (all sources answered, none matched) keeps the normal empty
//     state and this module reports nothing to show.
//   * A zero WITH source failures shows a concise, counted summary.
//   * Rate-limited, failed, pending and cancelled adapters are MUTUALLY
//     EXCLUSIVE buckets: a rate-limited adapter is never also counted as a
//     failure, so the numbers can never double-count.
//   * A search still in flight is NOT a completed zero-result failure.
//   * Only the CURRENT query generation counts, so a previous query's failures
//     never leak into this one.
//   * No raw error strings, error codes or URLs leave this module: the summary
//     is counts plus already-translated status labels, and the detail lives
//     behind the existing adapter-status surface.
import type { AdapterState } from "@/api/search";

/** Statuses that mean "this source did not answer usably". */
const FAILED_STATUSES = new Set(["failed", "timed-out", "blocked-robots"]);
/** Statuses that mean "this source has not answered yet". */
const PENDING_STATUSES = new Set(["idle", "queued", "running"]);

export interface ZeroResultSummary {
  /** adapter ids in a failure state (failed | timed-out | blocked-robots). */
  failed: string[];
  /** adapter ids that answered "rate limited" - NOT included in `failed`. */
  rateLimited: string[];
  /** adapter ids that have not answered yet. */
  pending: string[];
  /** adapter ids the operator (or a new query) cancelled. */
  cancelled: string[];
  /** every adapter considered for this generation. */
  total: number;
  /** true when at least one adapter actually failed. */
  hasFailures: boolean;
  /** true while any adapter (or the search itself) is still working. */
  inProgress: boolean;
  /** true when the summary is worth rendering. */
  visible: boolean;
}

const EMPTY: ZeroResultSummary = {
  failed: [],
  rateLimited: [],
  pending: [],
  cancelled: [],
  total: 0,
  hasFailures: false,
  inProgress: false,
  visible: false,
};

/**
 * Classify the adapter surface for one query generation.
 *
 * @param adapters     the per-adapter state map from the search store
 * @param generation   the current queryGeneration
 * @param phase        the search phase (a live phase alone means "in progress")
 */
export function summarizeZeroResult(
  adapters: Record<string, AdapterState> | null | undefined,
  generation: number,
  phase: string,
  opts: { resultCount?: number; cancelling?: boolean } = {},
): ZeroResultSummary {
  const live = phase === "queued" || phase === "running" || phase === "partial";
  const resultCount = opts.resultCount == null ? 0 : opts.resultCount;
  // Only explain a ZERO result. Rows on screen already tell the story.
  if (resultCount > 0) return { ...EMPTY, inProgress: live };

  const failed: string[] = [];
  const rateLimited: string[] = [];
  const pending: string[] = [];
  const cancelled: string[] = [];
  let total = 0;

  for (const a of Object.values(adapters || {})) {
    if (!a || !a.adapterId) continue;
    // Generation filter: an adapter row that belongs to an older query must not
    // be blamed on this one. Rows with no generation stamp are treated as
    // current (the compiled-adapter list ships them before the first poll).
    if (typeof a.requestGeneration === "number" && a.requestGeneration !== generation) continue;
    total += 1;
    const status = String(a.status || "");
    if (FAILED_STATUSES.has(status)) failed.push(a.adapterId);
    else if (status === "rate-limited") rateLimited.push(a.adapterId);
    else if (PENDING_STATUSES.has(status)) pending.push(a.adapterId);
    else if (status === "cancelled") cancelled.push(a.adapterId);
  }

  const inProgress = live || pending.length > 0 || opts.cancelling === true;
  const hasFailures = failed.length > 0;
  return {
    failed,
    rateLimited,
    pending,
    cancelled,
    total,
    hasFailures,
    inProgress,
    // A live search is never summarised as a completed zero-result failure, and
    // a clean zero keeps the normal empty state. Rate limits alone are shown:
    // they explain the zero without claiming a failure.
    visible: !inProgress && !live && (hasFailures || rateLimited.length > 0 || cancelled.length > 0),
  };
}
