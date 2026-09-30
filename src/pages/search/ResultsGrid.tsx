// [F56-c] ResultsGrid (Plan §A): react-window virtualized rows with ARIA grid
// semantics, roving tabindex and focus restoration after virtualization.
// Row/cell ids are deterministic templates (`<template>.<adapterId>.<resultId>`)
// - never derived from an unsanitized title or URL (Plan §I). RowActions:
// Fetch and Preview BYTES are "coming in F56-d" stubs; Open Purchase opens the
// validated adapter URL in a new tab (navigation only, never a fetch).
import { forwardRef, useCallback, useEffect, useMemo, type HTMLAttributes, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { ExternalLink } from "lucide-react";
import { FixedSizeList, type ListChildComponentProps } from "react-window";
import { selectVisibleResults, useSearchStore } from "@/stores/searchStore";
import type { SearchResult } from "@/api/search";
import { camel, licenceStyle } from "./CommandBar";

export const ROW_HEIGHT = 56; // >= B11 44px floor (2.75rem)

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

function formatBytes(n: number): string {
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return Math.round(n / 1024) + " KB";
  if (n < 1024 * 1024 * 1024) return Math.round((n / (1024 * 1024)) * 10) / 10 + " MB";
  return Math.round((n / (1024 * 1024 * 1024)) * 10) / 10 + " GB";
}

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
  const submit = useSearchStore((s) => s.submit);

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
          className="flex items-center gap-3 px-3 border-b border-default text-sm"
        >
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
            className="shrink-0 w-28 truncate text-xs text-secondary"
          >
            {t(r.nameKey)}
          </span>
          <span
            id={"f56.search.resultCategoryGlyph." + sfx}
            role="gridcell"
            aria-label={t("search.a11y.categoryGlyph")}
            className="shrink-0 w-20 truncate text-xs text-tertiary"
          >
            {t("search.filters.category." + camel(r.category))}
          </span>
          <span id={"f56.search.resultTitle." + sfx} role="gridcell" className="flex-1 min-w-0 truncate text-primary">
            {r.title}
          </span>
          <span id={"f56.search.resultCreator." + sfx} role="gridcell" className="w-36 truncate text-xs text-secondary">
            {r.creator || "—"}
          </span>
          <span id={"f56.search.resultSize." + sfx} role="gridcell" className="w-20 shrink-0 text-xs font-mono text-secondary">
            {r.sizeBytes != null ? formatBytes(r.sizeBytes) : t("search.results.unknownSize")}
          </span>
          <span id={"f56.search.resultDate." + sfx} role="gridcell" className="w-24 shrink-0 text-xs font-mono text-secondary">
            {r.date ? String(r.date).slice(0, 10) : t("search.results.unknownDate")}
          </span>
          <span
            id={"f56.search.resultLicence." + sfx}
            role="gridcell"
            className={"shrink-0 rounded px-2 py-0.5 text-xs font-medium " + licenceStyle(r.licenceTag)}
          >
            {t("search.filters.licence." + camel(r.licenceTag))}
          </span>
          <span id={"f56.search.resultActions." + sfx} role="gridcell" className="shrink-0 flex items-center gap-1">
            <button
              id={"f56.search.resultFetch." + sfx}
              type="button"
              disabled
              title={t("search.actions.comingSoon")}
              aria-label={t("search.actions.fetch")}
              className="h-11 px-2 rounded-md border border-default text-xs text-secondary disabled:opacity-50"
            >
              {t("search.actions.fetch")}
            </button>
            <button
              id={"f56.search.resultPreview." + sfx}
              type="button"
              title={t("search.actions.comingSoon")}
              aria-label={t("search.actions.preview")}
              onClick={() => openPreview(r.resultId)}
              className="h-11 px-2 rounded-md border border-default text-xs text-secondary hover:bg-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
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
                className="h-11 px-2 rounded-md border border-default text-xs text-secondary hover:bg-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent inline-flex items-center gap-1"
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
                className="h-11 px-2 rounded-md border border-default text-xs text-secondary hover:bg-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                {t("search.actions.retry")}
              </button>
            ) : null}
          </span>
        </div>
      );
    },
    [rows, adapters, activeRowIndex, selectedIds, setActiveRow, select, openPreview, submit, t]
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
        height={420}
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
