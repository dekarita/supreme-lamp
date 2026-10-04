// [F72 §2.1] Fan-out coordinator: resolves the final adapter set for a search
// submission. When the user submits without selecting adapters, the default
// TLS-Radar 5-source pack fans out. F58.HARD caps at 8 adapters per search.
const FAN_OUT_CAP = 8;

/** [F72 §2.1] Default TLS-Radar fan-out set. Mirrors $script:DefaultFanOutAdapterIds
 *  in payloads/ghrdp-server.ps1 (F72 §1.3). */
export const DEFAULT_FANOUT_ADAPTER_IDS: readonly string[] = [
  "github-releases",
  "internet-archive",
  "arxiv-public",
  "wikipedia-public",
  "google-books-public",
];

/** Resolve the adapter IDs to submit. Empty selection → default fan-out.
 *  Deduplicates and caps at FAN_OUT_CAP (8, per F58 §2). */
export function resolveFanOutAdapters(selectedIds: string[]): string[] {
  const ids = selectedIds.length ? [...new Set(selectedIds)] : [...DEFAULT_FANOUT_ADAPTER_IDS];
  return ids.slice(0, FAN_OUT_CAP);
}