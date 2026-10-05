// [F56-c] PreviewDialog (Plan §A/§D): metadata + a safe preview of the
// first ~500 chars of text from the source URL.
//
// [F81 §3.2/Q8] When the dialog opens it POSTs to /api/preview with
// {url, maxBytes: 2048} and shows the returned summary inside a fade-out
// gradient box. The "Open source" button below opens the full URL in the
// RDP session via the launch-url route (Q1=B). Escape closes; focus
// returns to the page. The previous "coming in F56-d" placeholder is gone.
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ExternalLink } from "lucide-react";
import { useSearchStore } from "@/stores/searchStore";
import { camel } from "./CommandBar";
import { licenceStyle } from "@/pages/search/tokens";
import { getKey } from "@/lib/api";
// [F91 §B.2] the preview dialog open button joins mirror mode.
import { openMirrored } from "@/lib/launchUrl";
import { useToastStore } from "@/stores/toastStore";

interface PreviewState {
  status: "idle" | "loading" | "ok" | "error";
  summary: string;
  reason?: string;
}

export function PreviewDialog() {
  const { t } = useTranslation();
  const previewResultId = useSearchStore((s) => s.previewResultId);
  const result = useSearchStore((s) => (s.previewResultId ? s.results[s.previewResultId] : null));
  const closePreview = useSearchStore((s) => s.closePreview);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const push = useToastStore((s) => s.push);
  const [state, setState] = useState<PreviewState>({ status: "idle", summary: "" });

  useEffect(() => {
    if (!previewResultId) return;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closePreview();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [previewResultId, closePreview]);

  useEffect(() => {
    if (!previewResultId || !result) {
      setState({ status: "idle", summary: "" });
      return;
    }
    let cancelled = false;
    setState({ status: "loading", summary: "" });
    const url = result.sourceUrl;
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    const key = getKey();
    if (key) headers["X-Dash-Token"] = key;
    fetch("/api/preview", {
      method: "POST",
      cache: "no-store",
      headers,
      body: JSON.stringify({ url, maxBytes: 2048, adapterId: result.adapterId }),
    })
      .then(async (r) => {
        const body = (await r.json().catch(() => null)) as { ok?: boolean; summary?: string; code?: string; messageKey?: string } | null;
        if (cancelled) return;
        if (body && body.ok && typeof body.summary === "string") {
          setState({ status: "ok", summary: body.summary });
        } else {
          setState({ status: "error", summary: "", reason: (body && (body.code || body.messageKey)) || "preview-unavailable" });
        }
      })
      .catch(() => {
        if (cancelled) return;
        setState({ status: "error", summary: "", reason: "transport" });
      });
    return () => {
      cancelled = true;
    };
  }, [previewResultId, result]);

  if (!previewResultId || !result) return null;

  const direct = result.sourceUrl;
  // [F91 §B.1] Mirror Mode supersedes the F84 §2.3 no-fallback rule FOR THIS
  // BUTTON (operator decision F91-2): the local tab is the DESIGN, the RDP
  // queue is the bonus - a failed queue is an info line, never an error.
  const openRdp = async () => {
    if (!direct) return;
    await openMirrored(direct, { push, t });
  };

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
        <div
          id="f56.search.previewBody"
          data-testid="preview-body"
          className="relative text-xs text-secondary bg-sunken rounded p-3 min-h-[6em] max-h-40 overflow-auto"
        >
          {state.status === "loading" ? (
            <span data-testid="preview-loading">{t("search.preview.loading")}</span>
          ) : state.status === "ok" ? (
            <span data-testid="preview-text">{state.summary}</span>
          ) : state.status === "error" ? (
            <span data-testid="preview-error" className="text-warning">{t("search.preview.unavailable")} — {state.reason || ""}</span>
          ) : null}
          <span aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-6 bg-gradient-to-t from-[var(--surface-sunken,theme(colors.sunken.500))] to-transparent" />
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            id="f56.search.previewOpen"
            data-testid="preview-open-source"
            onClick={() => void openRdp()}
            className="text-xs text-accent inline-flex items-center gap-1 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded px-1"
          >
            {t("search.preview.openSource")}
            <ExternalLink className="size-3" aria-hidden />
            <span className="sr-only">({t("search.a11y.externalLink")})</span>
          </button>
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