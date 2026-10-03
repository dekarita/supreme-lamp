// [F71 §D#1 / F72.2 / F73.1] Default search pack plus the shared F58 cap.
import type { CustomSourceStore } from "@/search/custom-source-store";

export const FAN_OUT_CAP = 8;
export const DEFAULT_FANOUT_ADAPTER_IDS = [
  "github-releases",
  "internet-archive",
  "arxiv-public",
  "wikipedia-public",
  "google-books-public",
] as const;

/**
 * Resolve the operator's source selection before dispatch. An empty selection
 * means the default pack; duplicate/blank IDs are removed and no request may
 * exceed the shared eight-adapter ceiling. Paused/unregistered custom sources
 * are filtered using the same compiled store used by AdvancedPanel.
 */
export function resolveFanOutAdapters(selectedIds: string[], customStore?: CustomSourceStore): string[] {
  const requested = selectedIds.map((id) => String(id || "").trim()).filter(Boolean);
  const candidate = requested.length ? requested : [...DEFAULT_FANOUT_ADAPTER_IDS];
  const customPlan = customStore?.planForSearch();
  const activeCustom = customPlan ? new Set(customPlan.selected) : null;
  const unique = [...new Set(candidate)].filter((id) => {
    if (!customStore?.isCustomSource(id)) return true;
    return Boolean(activeCustom?.has(id));
  });
  return unique.slice(0, FAN_OUT_CAP);
}
