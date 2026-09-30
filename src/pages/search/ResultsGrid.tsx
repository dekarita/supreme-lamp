// [F56-c v2] Result CARDS inside the frozen ARIA grid. Every F56-c row id and
// the roving-tabindex grid semantics are unchanged (react-window + role=row +
// gridcells); the v2 redesign only enriches each row into a card that surfaces
// the source badge, title, creator, the ACTUAL byte count, the direct HTTPS URL
// and a Fetch button.
//
// Fetch is the F56-c v2 stub (src/api/fetch): it performs NO network call, is
// refused by the frozen gate outside a comment, and answers with the localized
// "coming in F56-d" toast. A URL is only ever rendered/linked when it is a
// validated absolute https:// URL (locked rule: no unvalidated download URL
// reaches the client); otherwise the card says so.
import { forwardRef, useCallback, useEffect, useMemo, type HTMLAttributes, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { ExternalLink } from "lucide-react";
import { FixedSizeList, type ListChildComponentProps } from "react-window";
import { selectVisibleResults, useSearchStore } from "@/stores/searchStore";
import { useToastStore } from "@/stores/toastStore";
import { requestFetchStub } from "@/lib/fetchStub";
import { customSources, evaluateResultProvenance } from "@/search/custom-source-store";
import type { SearchResult } from "@/api/search";
import { camel, formatActualBytes, licenceStyle, validatedHttpsUrl } from "./tokens";

export const ROW_HEIGHT = 168; // v2 card: >= B11 44px floor (2.75rem) per control
export const CARD_HEIGHT = 156;

export function rowSuffix(r: SearchResult): string {
  return (r.adapterId + "." + r.resultId).replace(/[^A-Za-z0-9._-]/g, "-");
}

// Scroll container is presentational so the grid sees rowgroup > rows only.
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
  const submit = useSearchStore((s) => s.submit);
  const push = useToastStore((s) => s.push);

  const rows = useMemo(
    () => selectVisibleResults({ results, resultOrder: order, categories, licenceTags, maxSizeBytes, sort }),
    [results, order, categories, licenceTags, maxSizeBytes, sort]
  );

  // Focus restoration: refocus the active row whenever it re-mounts after
  // virtualization unmounts it (Plan §D "Focus is never lost...").
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
      // [F58 §3] PROVENANCE-6 verdict for CUSTOM-source rows: computed here, pure,
      // so a re-render never writes the store. External-roster rows are untouched.
      const prov = evaluateResultProvenance(customSources, r);
      const provRow = prov.custom && prov.applies;
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
          className="px-2 py-2"
        >
          <div
            id={"f56.search.v2.card." + sfx}
            data-testid="result-card"
            aria-label={t("search.v2.card.label")}
            className="h-full rounded-md border border-default bg-surface px-3 py-2 flex flex-col gap-1"
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
              <span id={"f56.search.resultLicence." + sfx} role="gridcell" className={"rounded px-2 py-0.5 text-xs font-medium " + licenceStyle(r.licenceTag)}>
                {t("search.filters.licence." + camel(r.licenceTag))}
              </span>
              <span id={"f56.search.resultDate." + sfx} role="gridcell" className="ml-auto text-xs font-mono text-tertiary">
                {r.date ? String(r.date).slice(0, 10) : t("search.results.unknownDate")}
              </span>
            </div>

            <div className="flex items-baseline gap-2 min-w-0">
              <span id={"f56.search.resultTitle." + sfx} role="gridcell" className="text-sm font-semibold text-primary truncate">
                {r.title}
              </span>
              <span id={"f56.search.resultCreator." + sfx} role="gridcell" className="text-xs text-secondary truncate">
                {r.creator || "—"}
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

            <div className="flex items-center gap-2 min-w-0 text-xs">
              <span className="text-tertiary shrink-0">{t("search.v2.card.directUrl")}</span>
              {direct ? (
                <a
                  id={"f56.search.v2.cardDirectUrl." + sfx}
                  data-testid="card-direct-url"
                  href={direct}
                  rel="noopener noreferrer nofollow"
                  target="_blank"
                  className="font-mono text-accent truncate underline-offset-2 hover:underline"
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

            <span id={"f56.search.resultActions." + sfx} role="gridcell" className="flex items-center gap-1">
              <button
                id={"f56.search.resultFetch." + sfx}
                data-testid="card-fetch"
                type="button"
                title={provRow && !prov.fetchEnabled ? prov.reason || t("search.actions.comingSoon") : t("search.actions.comingSoon")}
                disabled={provRow && !prov.fetchEnabled}
                data-provenance-block={provRow && !prov.fetchEnabled ? "true" : "false"}
                aria-label={t("search.actions.fetch")}
                onClick={() => {
                  // [F58 §3] PROVENANCE-6 refused it: no fetch row is recorded and
                  // no stub is even reached - the refusal is the whole behaviour.
                  if (provRow && !prov.fetchEnabled) return;
                  // Stub: no request is constructed, no byte is fetched. The
                  // card records a pending fetch row (the rail shows it) and
                  // says the honest thing: "coming in F56-d".
                  const out = requestFetchStub({ resultId: r.resultId, sourceUrl: r.sourceUrl });
                  stubFetch(r.resultId);
                  void out;
                  push(t("search.actions.comingSoon"));
                }}
                className="h-11 px-3 rounded-md border border-default text-xs text-secondary hover:bg-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
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
              <span className="ml-auto text-xs text-tertiary truncate">{t("search.v2.card.fetchStub")}</span>
            </span>
          </div>
        </div>
      );
    },
    [rows, adapters, activeRowIndex, selectedIds, setActiveRow, select, openPreview, stubFetch, submit, push, t]
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
