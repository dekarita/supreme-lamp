// [F56-d] Result CARDS - Fetch button now real: calls POST /api/fetch via aria2c lane.
// Provenance-6 gate server-side + client-side disable. Existing ARIA grid semantics unchanged.
import { forwardRef, useCallback, useEffect, useMemo, type HTMLAttributes, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ExternalLink, FlaskConical } from "lucide-react";
import { FixedSizeList, type ListChildComponentProps } from "react-window";
import { selectVisibleResults, useSearchStore } from "@/stores/searchStore";
import { useToastStore } from "@/stores/toastStore";
import { requestFetchStub, requestFetch, isProvenanceBlocked } from "@/lib/fetchStub";
import { customSources, evaluateResultProvenance } from "@/search/custom-source-store";
import type { SearchResult } from "@/api/search";
import { camel, fileExtension, formatActualBytes, licenceStyle, validatedHttpsUrl } from "./tokens";
import { launchUrl } from "@/lib/launchUrl";

// [F79 D5/D7] 16px card padding + a 24px inter-result gutter.
export const CARD_HEIGHT = 216;
export const ROW_HEIGHT = CARD_HEIGHT + 24;

export function rowSuffix(r: SearchResult): string {
  return (r.adapterId + "." + r.resultId).replace(/[^A-Za-z0-9._-]/g, "-");
}

const OuterElement = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(function Outer(props, ref) {
  return <div {...props} ref={ref} role="presentation" />;
});
const InnerElement = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(function Inner(props, ref) {
  return <div {...props} ref={ref} role="rowgroup" />;
});

export function ResultsGrid() {
  const { t } = useTranslation();
  const results = useSearchStore((s) => s.results);
  const order = useSearchStore((s) => s.resultOrder);
  const categories = useSearchStore((s) => s.categories);
  const licenceTags = useSearchStore((s) => s.licenceTags);
  const maxSizeBytes = useSearchStore((s) => s.maxSizeBytes);
  const sort = useSearchStore((s) => s.sort);
  const adapters = useSearchStore((s) => s.adapters);
  const activeRowIndex = useSearchStore((s) => s.activeRowIndex);
  const selectedIds = useSearchStore((s) => s.selectedIds);
  const setActiveRow = useSearchStore((s) => s.setActiveRow);
  const select = useSearchStore((s) => s.select);
  const openPreview = useSearchStore((s) => s.openPreview);
  const stubFetch = useSearchStore((s) => s.stubFetch);
  const recordFetch = useSearchStore((s) => s.recordFetch);
  const fetches = useSearchStore((s) => s.fetches);
  const submit = useSearchStore((s) => s.submit);
  const push = useToastStore((s) => s.push);
  const navigate = useNavigate();

  const fileExtensions = useSearchStore((s) => s.fileExtensions);
  const yearFrom = useSearchStore((s) => s.yearFrom);
  const yearTo = useSearchStore((s) => s.yearTo);
  const lastSubmittedQuery = useSearchStore((s) => s.lastSubmittedQuery);

  const rows = useMemo(
    () => selectVisibleResults({ results, resultOrder: order, categories, licenceTags, maxSizeBytes, sort, fileExtensions, yearFrom, yearTo, query: lastSubmittedQuery }),
    [results, order, categories, licenceTags, maxSizeBytes, sort, fileExtensions, yearFrom, yearTo, lastSubmittedQuery]
  );

  useEffect(() => {
    if (activeRowIndex < 0 || !rows.length) return;
    const r = rows[Math.min(activeRowIndex, rows.length - 1)];
    const el = document.getElementById("f56.search.resultRow." + rowSuffix(r));
    if (el && document.activeElement !== el && document.activeElement && document.activeElement.closest("#f56\\.search\\.results")) {
      el.focus();
    }
  }, [activeRowIndex, rows]);

  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      const last = rows.length - 1;
      if (last < 0) return;
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          setActiveRow(Math.min(activeRowIndex + 1, last));
          break;
        case "ArrowUp":
          e.preventDefault();
          setActiveRow(Math.max(activeRowIndex - 1, 0));
          break;
        case "Home":
          e.preventDefault();
          setActiveRow(0);
          break;
        case "End":
          e.preventDefault();
          setActiveRow(last);
          break;
        case "Enter": {
          e.preventDefault();
          const r = rows[Math.max(0, activeRowIndex)];
          if (r) openPreview(r.resultId);
          break;
        }
        case " ":
        case "Spacebar": {
          e.preventDefault();
          const r = rows[Math.max(0, activeRowIndex)];
          if (r) select(r.resultId, !selectedIds.includes(r.resultId));
          break;
        }
        default:
          break;
      }
    },
    [rows, activeRowIndex, setActiveRow, openPreview, select, selectedIds]
  );

  const Row = useCallback(
    ({ index, style }: ListChildComponentProps) => {
      const r = rows[index] as SearchResult;
      const sfx = rowSuffix(r);
      const ad = adapters[r.adapterId];
      const retryable = Boolean(ad && (ad.status === "failed" || ad.status === "timed-out" || ad.status === "rate-limited"));
      const selected = selectedIds.includes(r.resultId);
      const direct = validatedHttpsUrl(r.sourceUrl);
      const fetchRec = fetches[r.resultId];
      const ext = fileExtension(r); // [F69 §2.2]
      const prov = evaluateResultProvenance(customSources, r);
      const provRow = prov.custom && prov.applies;
      // Client-side provenance-6 check (mirrors server gate) for exe/msi/dmg/iso/zip
      // F58 preserved: external-roster (custom=false, no provenance) must NOT be blocked by client check alone.
      // Custom registry provenance is stored in customSources store, not in result.provenance, so only block via client if result actually carries provenance.
      const hasProv = !!(r as any).provenance;
      const provClient = isProvenanceBlocked(r.title, (r as any).provenance);
      const clientBlockApplies = hasProv && provClient.blocked;
      const isBlocked = (provRow && !prov.fetchEnabled) || clientBlockApplies;
      const blockReason = provRow && !prov.fetchEnabled ? (prov.reason || t("search.errors.classifierBlocked")) : (clientBlockApplies && provClient.missing.length ? t("search.errors.classifierBlocked") + ": " + provClient.missing.join(",") : "");
      return (
        <div
          id={"f56.search.resultRow." + sfx}
          role="row"
          aria-rowindex={index + 1}
          aria-selected={selected}
          tabIndex={activeRowIndex >= 0 && index === activeRowIndex ? 0 : -1}
          data-testid="result-row"
          data-result-id={r.resultId}
          style={style}
          onFocus={() => setActiveRow(index)}
          className="pb-6"
        >
          <div
            id={"f56.search.v2.card." + sfx}
            data-testid="result-card"
            aria-label={t("search.v2.card.label")}
            className="h-full rounded-md border border-default bg-surface p-4 flex flex-col gap-2 hover:shadow-md transition-shadow motion-reduce:transition-none"
          >
            <div className="flex items-center gap-2 text-xs">
              <input
                id={"f56.search.resultSelection." + sfx}
                type="checkbox"
                aria-label={t("search.results.selected") + ": " + (selected ? t("search.a11y.selected") : t("search.a11y.notSelected"))}
                checked={selected}
                onChange={(e) => select(r.resultId, e.target.checked)}
                className="shrink-0"
              />
              <span
                id={"f56.search.resultSourceBadge." + sfx}
                role="gridcell"
                aria-label={t("search.a11y.sourceBadge")}
                data-testid="card-source-badge"
                className="rounded bg-raised px-2 py-0.5 text-xs text-secondary max-w-40 truncate"
              >
                {t(r.nameKey)}
              </span>
              <span
                id={"f56.search.resultCategoryGlyph." + sfx}
                role="gridcell"
                aria-label={t("search.a11y.categoryGlyph")}
                className="text-xs text-tertiary"
              >
                {t("search.filters.category." + camel(r.category))}
              </span>
              {ext ? (
                <span data-testid="card-file-ext" title={r.mimeType || undefined} className="rounded bg-raised px-1.5 py-0.5 font-mono text-xs text-tertiary">
                  .{ext}
                </span>
              ) : null}
              <span id={"f56.search.resultLicence." + sfx} role="gridcell" className={"rounded px-2 py-0.5 text-xs font-medium " + licenceStyle(r.licenceTag)}>
                {t("search.filters.licence." + camel(r.licenceTag))}
              </span>
              <span id={"f56.search.resultDate." + sfx} role="gridcell" className="ml-auto text-xs font-mono text-tertiary">
                {r.date ? String(r.date).slice(0, 10) : t("search.results.unknownDate")}
              </span>
            </div>

            <div className="flex items-baseline gap-2 min-w-0">
              <span id={"f56.search.resultTitle." + sfx} role="gridcell" className="text-lg font-semibold text-primary truncate">
                {r.title}
              </span>
              <span
                id={"f56.search.resultSize." + sfx}
                role="gridcell"
                data-testid="card-bytes"
                title={t("search.v2.card.bytes")}
                className="ml-auto shrink-0 text-xs font-mono text-secondary"
              >
                {r.sizeBytes != null ? formatActualBytes(r.sizeBytes) : t("search.results.unknownSize")}
              </span>
            </div>

            <p id={"f56.search.resultCreator." + sfx} role="gridcell" data-testid="card-snippet" className="text-sm text-secondary truncate">
              {r.snippet || r.creator || "—"}
            </p>
            <div className="flex items-center gap-2 min-w-0 text-xs">
              <span className="text-tertiary shrink-0">{t("search.v2.card.directUrl")}</span>
              {direct ? (
                <a
                  id={"f56.search.v2.cardDirectUrl." + sfx}
                  data-testid="card-direct-url"
                  href={direct}
                  rel="noopener noreferrer nofollow"
                  target="_blank"
                  onClick={(e) => {
                    e.preventDefault();
                    void launchUrl(direct);
                  }}
                  className="text-xs text-success truncate underline-offset-2 hover:underline"
                >
                  {direct}
                </a>
              ) : (
                <span id={"f56.search.v2.cardUrlWithheld." + sfx} data-testid="card-url-withheld" className="text-warning truncate">
                  {t("search.v2.card.urlWithheld")}
                </span>
              )}
            </div>

            {provRow ? (
              <span
                id={"f56.search.v2.cardProvenance." + sfx}
                role="gridcell"
                data-testid="card-provenance"
                data-fetch-enabled={prov.fetchEnabled ? "true" : "false"}
                title={prov.reason || t("search.registry.provenance.ok")}
                className={"block truncate text-[10px] leading-none " + (prov.fetchEnabled ? "text-tertiary" : "text-danger")}
              >
                {prov.fetchEnabled ? t("search.registry.provenance.ok") : t("search.registry.provenance.blocked", { reason: prov.reason || "provenance-incomplete" })}
              </span>
            ) : null}
            {isBlocked && blockReason ? (
              <span data-testid="provenance-block-reason" className="text-[10px] text-danger truncate">{blockReason}</span>
            ) : null}

            <span id={"f56.search.resultActions." + sfx} role="gridcell" className="flex items-center gap-1">
              <button
                id={"f56.search.resultFetch." + sfx}
                data-testid="card-fetch"
                type="button"
                title={isBlocked ? blockReason : t("search.actions.fetch")}
                disabled={!!isBlocked}
                data-provenance-block={isBlocked ? "true" : "false"}
                aria-label={t("search.actions.fetch")}
                onClick={async () => {
                  if (isBlocked) return;
                  try {
                    // Real fetch: POST /api/fetch aria2c lane
                    const out = await requestFetch({
                      operation: 'start',
                      requestId: Math.random().toString(36).slice(2, 12),
                      idempotencyKey: Math.random().toString(36).slice(2, 12),
                      resultId: r.resultId,
                      adapterId: r.adapterId,
                      sourceSnapshotId: (r as any).sourceSnapshotId || 'snap-' + Date.now(),
                      intent: 'download',
                      transport: 'aria2c',
                      mirrorOptIn: false,
                      provenance: (r as any).provenance,
                      expectedContentLength: (r as any).sizeBytes,
                    } as any);
                    if (out.ok) {
                      // [F69 §2.5] keep the accepted record (fetchId/gid/status) for the progress rail
                      recordFetch(r.resultId, {
                        fetchId: out.data?.fetchId || r.resultId,
                        gid: out.data?.gid || undefined,
                        transport: 'aria2c',
                        status: out.data?.status || 'queued',
                        sourceSnapshotId: out.data?.sourceSnapshotId || undefined,
                      });
                      push(t("search.fetch.started", { fetchId: out.data?.fetchId || '' }));
                    } else {
                      // If transport unavailable, fallback to stub toast for offline dev
                      if (out.error?.code === 'TRANSPORT_UNAVAILABLE') {
                        const stub = requestFetchStub({ resultId: r.resultId, sourceUrl: r.sourceUrl });
                        stubFetch(r.resultId);
                        void stub;
                        push(t("search.v2.toast.fetchStub"));
                      } else {
                        push(t(out.error?.messageKey || "search.errors.generic"));
                      }
                    }
                  } catch {
                    const stub = requestFetchStub({ resultId: r.resultId, sourceUrl: r.sourceUrl });
                    stubFetch(r.resultId);
                    void stub;
                    push(t("search.v2.toast.fetchStub"));
                  }
                }}
                className="h-11 px-3 rounded-md border border-default text-xs text-secondary hover:bg-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {t("search.actions.fetch")}
              </button>
              <button
                id={"f56.search.resultPreview." + sfx}
                type="button"
                title={t("search.actions.comingSoon")}
                aria-label={t("search.actions.preview")}
                onClick={() => openPreview(r.resultId)}
                className="h-11 px-3 rounded-md border border-default text-xs text-secondary hover:bg-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                {t("search.actions.preview")}
              </button>
              {/* [F72 §2.4] "⋯ Open in Lab" button (Q3: dedicated sub-route, Q4: explicit click only) */}
              <button
                id={"f56.search.resultLab." + sfx}
                data-testid="card-open-lab"
                type="button"
                title={t("search.lab.openInLab")}
                aria-label={t("search.lab.openInLab")}
                onClick={() => navigate("/search/lab/" + encodeURIComponent(r.resultId))}
                className="h-11 px-3 rounded-md border border-default text-xs text-secondary hover:bg-raised inline-flex items-center gap-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                <FlaskConical className="size-3" aria-hidden />
                {t("search.lab.openInLab")}
              </button>
              {r.purchaseUrl ? (
                <button
                  id={"f56.search.resultPurchase." + sfx}
                  type="button"
                  title={t("search.actions.externalPurchase")}
                  aria-label={t("search.actions.openPurchase")}
                  data-testid="open-purchase"
                  onClick={() => window.open(r.purchaseUrl as string, "_blank", "noopener,noreferrer")}
                  className="h-11 px-3 rounded-md border border-default text-xs text-secondary hover:bg-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent inline-flex items-center gap-1"
                >
                  {t("search.actions.openPurchase")}
                  <ExternalLink className="size-3" aria-hidden />
                </button>
              ) : null}
              {retryable ? (
                <button
                  id={"f56.search.resultRetry." + sfx}
                  type="button"
                  aria-label={t("search.actions.retry")}
                  onClick={() => void submit()}
                  className="h-11 px-3 rounded-md border border-default text-xs text-secondary hover:bg-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                >
                  {t("search.actions.retry")}
                </button>
              ) : null}
              {fetchRec ? (
                // [F69 §1.5] only after a fetch was accepted for this card (F68 §H.6)
                <span data-testid="card-fetch-started" className="ml-auto text-xs text-tertiary truncate">
                  {t("search.fetch.started", { fetchId: fetchRec.fetchId })}
                </span>
              ) : null}
            </span>
          </div>
        </div>
      );
    },
    [rows, adapters, activeRowIndex, selectedIds, fetches, setActiveRow, select, openPreview, stubFetch, recordFetch, submit, push, t]
  );

  return (
    <div
      id="f56.search.results"
        role="grid"
        aria-label={t("search.a11y.resultsGrid")}
        aria-rowcount={rows.length}
        data-testid="results-grid"
        tabIndex={-1}
        onKeyDown={onKeyDown}
    >
      <FixedSizeList
        height={Math.max(ROW_HEIGHT, Math.min(rows.length, 8) * ROW_HEIGHT)}
        width="100%"
        itemCount={rows.length}
        itemSize={ROW_HEIGHT}
        overscanCount={4}
        outerElementType={OuterElement}
        innerElementType={InnerElement}
      >
        {Row}
      </FixedSizeList>
    </div>
  );
}
