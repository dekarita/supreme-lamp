// [F56-c] Search page (Plan §A SearchView): CommandBar, status region +
// AdapterStatusList + cancel, result states and the virtualized ResultsGrid,
// PreviewDialog, and the BottomProgressRail stub. State lives in searchStore;
// /api/search{,/status,/cancel} are wired through src/api/search/. Ctrl+K
// palette prefills this page via ?q= (prefill only - never auto-submits).
import { useEffect, useRef } from "react";
import { useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useSearchStore, selectVisibleResults, selectFilterSelectionCount } from "@/stores/searchStore";
import { CommandBar } from "./search/CommandBar";
import { AdapterStatusList } from "./search/AdapterStatusList";
import { ResultsGrid } from "./search/ResultsGrid";
import { PreviewDialog } from "./search/PreviewDialog";
import { BottomProgressRail } from "./search/BottomProgressRail";

const POLL_MS = 2000;

export default function Search() {
  const { t } = useTranslation();
  const [params] = useSearchParams();
  const phase = useSearchStore((s) => s.phase);
  const lastErrorCode = useSearchStore((s) => s.lastErrorCode);
  const queryGeneration = useSearchStore((s) => s.queryGeneration);
  const hasQuery = useSearchStore((s) => s.normalizedQuery.length > 0 || s.lastSubmittedQuery.length > 0);
  const totalResults = useSearchStore((s) => s.resultOrder.length);
  const visibleCount = useSearchStore(selectVisibleResults).length;
  const filterCount = useSearchStore(selectFilterSelectionCount);
  const adapters = useSearchStore((s) => s.adapters);
  const cancelling = useSearchStore((s) => s.cancelling);
  const cancelSearch = useSearchStore((s) => s.cancelSearch);
  const submit = useSearchStore((s) => s.submit);
  const queryRef = useRef<string | null>(null);

  // Palette prefill (?q=...): apply once per value, never auto-submit (Plan §D).
  const q = params.get("q");
  useEffect(() => {
    if (q != null && queryRef.current !== q) {
      queryRef.current = q;
      useSearchStore.getState().applyPrefill(q);
      document.getElementById("f56.search.query")?.focus();
    }
  }, [q]);

  // Incremental status polling while the search is live (Plan §F).
  useEffect(() => {
    const id = window.setInterval(() => {
      const s = useSearchStore.getState();
      if (s.phase === "queued" || s.phase === "running" || s.phase === "partial") void s.pollOnce();
    }, POLL_MS);
    return () => window.clearInterval(id);
  }, []);

  const busy = phase === "queued" || phase === "running" || phase === "partial";
  const rateLimited = Object.values(adapters).some((a) => a.status === "rate-limited");

  return (
    <div id="f56.search.view" data-testid="search-page" className="flex flex-col gap-4">
      <h1 className="text-lg font-semibold text-primary">{t("search.page.title")}</h1>
      <p className="text-sm text-secondary">{t("search.page.description")}</p>

      <CommandBar />

      <section className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold text-primary">{t("search.results.label")}</h2>
          <span id="f56.search.ownStorageResults" data-testid="own-storage-results" className="text-xs text-tertiary">
            {t("search.scope.ownStorage")}: {String(totalResults)}
          </span>
          <button
            id="f56.search.cancelSearch"
            type="button"
            data-testid="cancel-search"
            disabled={!busy || cancelling}
            onClick={() => void cancelSearch()}
            className="ml-auto h-11 px-3 rounded-md border border-default text-xs text-secondary hover:bg-raised disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            {t("search.actions.cancelSearch")}
          </button>
        </div>
        <div id="f56.search.statusLive" role="status" aria-live="polite" aria-label={t("search.a11y.liveStatus")} data-testid="status-live" className="text-xs font-mono text-secondary">
          {t("search.filters.label")}: {String(filterCount)} — {phase} — gen {String(queryGeneration)}
          {visibleCount !== totalResults ? " — " + t("search.results.noFilterMatch") : ""}
        </div>
        <AdapterStatusList />
      </section>

      <section className="flex flex-col gap-2">
        <h2 id="f56.search.resultsHeader" className="text-sm font-semibold text-primary">
          {t("search.results.label")}
        </h2>
        {phase === "failed" ? (
          <div id="f56.search.resultsError" role="alert" data-testid="results-error" className="text-sm text-danger bg-danger/10 rounded p-3 flex items-center gap-3">
            <span>
              {lastErrorCode === "RATE_LIMITED"
                ? t("search.errors.rateLimited")
                : lastErrorCode === "CLASSIFIER_BLOCKED"
                  ? t("search.errors.classifierBlocked")
                  : lastErrorCode === "SNAPSHOT_MISMATCH"
                    ? t("search.errors.snapshotMismatch")
                    : lastErrorCode === "CONTENT_LENGTH_REQUIRED" || lastErrorCode === "WIRE_LENGTH_MISMATCH"
                      ? t("search.errors.contentLengthRequired")
                      : t("search.errors.generic")}
            </span>
            <button
              type="button"
              data-testid="error-retry"
              onClick={() => void submit()}
              className="h-11 px-3 rounded-md border border-default text-xs hover:bg-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              {t("search.actions.retry")}
            </button>
          </div>
        ) : null}
        {phase === "failed" && lastErrorCode === "CLASSIFIER_BLOCKED" ? (
          <p id="f56.search.classifierBlock" className="text-xs text-warning">
            {t("search.errors.classifierBlocked")}
          </p>
        ) : null}
        {phase === "failed" && (lastErrorCode === "CONTENT_LENGTH_REQUIRED" || lastErrorCode === "WIRE_LENGTH_MISMATCH") ? (
          <p id="f56.search.contentLengthFailure" className="text-xs text-warning">
            {t("search.errors.contentLengthRequired")}
          </p>
        ) : null}
        {phase === "failed" && lastErrorCode === "SNAPSHOT_MISMATCH" ? (
          <p id="f56.search.snapshotFailure" className="text-xs text-warning">
            {t("search.errors.snapshotMismatch")}
          </p>
        ) : null}
        {busy ? (
          <p id="f56.search.resultsLoading" data-testid="results-loading" className="text-sm text-secondary">
            {t("search.results.loading")}
          </p>
        ) : null}
        {(phase === "complete" || phase === "empty") && totalResults === 0 ? (
          <p id="f56.search.resultsEmpty" data-testid="results-empty" className="text-sm text-secondary">
            {t("search.results.empty")}
          </p>
        ) : null}
        {!hasQuery && phase === "idle" ? (
          <p id="f56.search.resultsEmpty" data-testid="results-noquery" className="text-sm text-secondary">
            {t("search.results.noQuery")}
          </p>
        ) : null}
        {rateLimited ? (
          <p id="f56.search.resultsRateLimited" data-testid="results-rate-limited" className="text-sm text-warning">
            {t("search.errors.rateLimited")}
          </p>
        ) : null}
        {totalResults > 0 && visibleCount === 0 ? (
          <p data-testid="results-no-filter-match" className="text-sm text-secondary">
            {t("search.results.noFilterMatch")}
          </p>
        ) : null}
        {totalResults > 0 ? <ResultsGrid /> : null}
      </section>

      <BottomProgressRail />
      <PreviewDialog />
    </div>
  );
}
