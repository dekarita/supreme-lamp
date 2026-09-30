// [F56-c] PreviewDialog (Plan §A/§D): metadata + a safe unavailable state for
// preview bytes ("coming in F56-d" - Preview cannot bypass the F46/F49 tail).
// Source link opens only where permitted; the purchase notice is navigation
// only and never starts a fetch. Escape closes; focus returns to the page.
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { ExternalLink } from "lucide-react";
import { useSearchStore } from "@/stores/searchStore";
import { camel, licenceStyle } from "./CommandBar";

export function PreviewDialog() {
  const { t } = useTranslation();
  const previewResultId = useSearchStore((s) => s.previewResultId);
  const result = useSearchStore((s) => (s.previewResultId ? s.results[s.previewResultId] : null));
  const closePreview = useSearchStore((s) => s.closePreview);
  const closeRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!previewResultId) return;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closePreview();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [previewResultId, closePreview]);

  if (!previewResultId || !result) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={closePreview}>
      <div
        id="f56.search.previewDialog"
        role="dialog"
        aria-modal="true"
        aria-label={t("search.actions.preview")}
        data-testid="preview-dialog"
        onClick={(e) => e.stopPropagation()}
        className="bg-surface border border-default rounded-md shadow-md max-w-lg w-full p-4 flex flex-col gap-2"
      >
        <h3 className="text-sm font-semibold text-primary">{result.title}</h3>
        <dl className="text-xs text-secondary grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
          <dt>{t("search.results.source")}</dt>
          <dd>{t(result.nameKey)}</dd>
          <dt>{t("search.results.licence")}</dt>
          <dd>
            <span className={"rounded px-2 py-0.5 text-xs font-medium " + licenceStyle(result.licenceTag)}>
              {t("search.filters.licence." + camel(result.licenceTag))}
            </span>
          </dd>
          <dt>{t("search.results.contentType")}</dt>
          <dd className="font-mono">{result.mimeType || "—"}</dd>
          <dt>{t("search.results.size")}</dt>
          <dd className="font-mono">{result.sizeBytes != null ? String(result.sizeBytes) : t("search.results.unknownSize")}</dd>
        </dl>
        <p className="text-xs text-tertiary bg-sunken rounded p-3" data-testid="preview-body">
          {t("search.results.previewUnavailable")} — {t("search.actions.comingSoon")}
        </p>
        <div className="flex items-center gap-2">
          <a
            href={result.sourceUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-accent inline-flex items-center gap-1"
          >
            {t("search.results.source")}
            <ExternalLink className="size-3" aria-hidden />
            <span className="sr-only">({t("search.a11y.externalLink")})</span>
          </a>
          {result.purchaseUrl ? (
            <p id="f56.search.purchaseNotice" className="text-xs text-tertiary ml-auto">
              {t("search.actions.externalPurchase")}
            </p>
          ) : null}
          <button
            ref={closeRef}
            type="button"
            onClick={closePreview}
            className="ml-auto h-11 px-3 rounded-md border border-default text-xs text-secondary hover:bg-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            {t("search.actions.cancel")}
          </button>
        </div>
      </div>
    </div>
  );
}
