// [R-SEARCH / #216] The concise "why is this empty" line.
//
// Renders ONLY for a zero-result search whose sources did not all succeed, and
// only for the query generation currently on screen. It never shows a raw error
// string, an error code or a URL: those live behind the existing adapter-status
// surface (AdapterStatusList, id f56.search.adapterStatusList), and this line
// links to it - it does not duplicate the detail list.
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle } from "lucide-react";
import { useSearchStore } from "@/stores/searchStore";
import { summarizeZeroResult } from "@/lib/search/zeroResultSummary";

export const ADAPTER_STATUS_LIST_ID = "f56.search.adapterStatusList";

export function SearchFailureSummary() {
  const { t } = useTranslation();
  const adapters = useSearchStore((s) => s.adapters);
  const generation = useSearchStore((s) => s.queryGeneration);
  const phase = useSearchStore((s) => s.phase);
  const resultCount = useSearchStore((s) => s.resultOrder.length);
  const cancelling = useSearchStore((s) => s.cancelling);
  const setShowProgress = useSearchStore((s) => s.setShowProgress);

  const s = summarizeZeroResult(adapters, generation, phase, { resultCount, cancelling });

  const onViewSources = useCallback(() => {
    // The per-adapter rows live behind the session-only diagnostic disclosure.
    // Opening it is the navigation; the list is the existing surface, not a new
    // one, so nothing is duplicated here.
    setShowProgress(true);
    // The list mounts on the same commit, so wait a frame before scrolling.
    requestAnimationFrame(() => {
      const el = document.getElementById(ADAPTER_STATUS_LIST_ID);
      if (!el) return;
      el.scrollIntoView({ block: "nearest" });
      // Focus the list itself (it carries an aria-label) so keyboard and screen
      // reader users land on it, not just the sighted scroll position.
      el.setAttribute("tabindex", "-1");
      el.focus({ preventScroll: true });
    });
  }, [setShowProgress]);

  if (!s.visible) return null;

  const text =
    s.rateLimited.length > 0
      ? t("search.zero.summaryWithRateLimit", {
          failed: s.failed.length,
          total: s.total,
          rateLimited: s.rateLimited.length,
        })
      : t("search.zero.summary", { failed: s.failed.length, total: s.total });

  return (
    <div
      id="f56.search.zeroResultSummary"
      data-testid="zero-result-summary"
      data-generation={String(generation)}
      data-failed={String(s.failed.length)}
      data-rate-limited={String(s.rateLimited.length)}
      data-total={String(s.total)}
      role="status"
      aria-live="polite"
      className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-secondary"
    >
      <AlertTriangle className="size-4 shrink-0 text-warning" aria-hidden />
      <span className="min-w-0">{text}</span>
      <button
        type="button"
        id="f56.search.zeroResultViewSources"
        data-testid="zero-result-view-sources"
        onClick={onViewSources}
        className="ml-auto h-8 shrink-0 rounded-md border border-default px-2 text-xs text-secondary hover:bg-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        {t("search.zero.viewSources")}
      </button>
    </div>
  );
}
