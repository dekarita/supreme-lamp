// [F57 §3] Preview panel - FULL WIRE. MIME dispatch through the renderer
// registry (image / video / audio / pdf / markdown / code / unsupported), a
// spinner while the bytes buffer, the labeled "Preview restricted by external
// host" fallback for a CORS-refused fetch, and a Download control that streams
// the same /api/fx/preview?id= URL the panel reads.
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, Download, FileQuestion } from "lucide-react";
import {
  highlightCode,
  initialPreviewState,
  loadPreview,
  renderMarkdown,
  type PreviewEntry,
  type PreviewState,
} from "@/lib/explorer/preview";
import { previewUrl } from "@/lib/explorer/transport";

export function ExplorerPreview({ entry }: { entry: PreviewEntry | null }) {
  const { t } = useTranslation();
  const [state, setState] = useState<PreviewState>(() => initialPreviewState(entry));

  useEffect(() => {
    let alive = true;
    setState(initialPreviewState(entry));
    if (!entry) return () => {
      alive = false;
    };
    const initial = initialPreviewState(entry);
    if (initial.status === "unsupported") return () => {
      alive = false;
    };
    void loadPreview(entry).then((next) => {
      if (alive) setState(next);
    });
    return () => {
      alive = false;
    };
  }, [entry]);

  const sizeText = entry && entry.sizeBytes != null ? String(entry.sizeBytes) + " B" : "";

  return (
    <aside
      id="f57.explorer.preview"
      data-testid="explorer-preview"
      aria-label={t("files.preview.label")}
      data-renderer={state.renderer}
      data-status={state.status}
      className="w-72 shrink-0 bg-surface border border-default rounded-md p-3 self-start flex flex-col gap-2"
    >
      <h2 className="text-sm font-semibold text-primary">{t("files.preview.label")}</h2>
      <p className="text-sm text-secondary truncate" data-testid="preview-selected">
        {entry ? entry.name : t("files.preview.empty")}
      </p>

      {state.status === "loading" ? (
        <p id="f57.explorer.ops.previewSpinner" data-testid="preview-spinner" role="status" className="text-xs text-tertiary">
          {t("files.ops.preview.loading")}
        </p>
      ) : null}

      {state.status === "ready" && state.renderer === "image" ? (
        <img
          id="f57.explorer.ops.previewImage"
          data-testid="preview-image"
          src={state.url}
          alt={entry ? entry.name : ""}
          style={{ maxWidth: "100%" }}
          className="rounded border border-default"
        />
      ) : null}

      {state.status === "ready" && state.renderer === "video" ? (
        <video id="f57.explorer.ops.previewVideo" data-testid="preview-video" src={state.url} controls preload="metadata" className="w-full rounded border border-default" />
      ) : null}

      {state.status === "ready" && state.renderer === "audio" ? (
        <audio id="f57.explorer.ops.previewAudio" data-testid="preview-audio" src={state.url} controls className="w-full" />
      ) : null}

      {state.status === "ready" && state.renderer === "pdf" ? (
        <iframe
          id="f57.explorer.ops.previewPdf"
          data-testid="preview-pdf"
          title={entry ? entry.name : "pdf"}
          src={state.url}
          sandbox="allow-scripts"
          className="w-full h-64 rounded border border-default"
        />
      ) : null}

      {state.status === "ready" && state.renderer === "markdown" ? (
        <div
          id="f57.explorer.ops.previewMarkdown"
          data-testid="preview-markdown"
          className="text-xs text-secondary [&_h1]:text-sm [&_h1]:font-semibold [&_pre]:overflow-auto"
          dangerouslySetInnerHTML={{ __html: renderMarkdown(state.text) }}
        />
      ) : null}

      {state.status === "ready" && state.renderer === "code" ? (
        <pre id="f57.explorer.ops.previewCode" data-testid="preview-code" data-lang={state.lang} className="text-[11px] overflow-auto max-h-64 rounded border border-default p-2">
          <code dangerouslySetInnerHTML={{ __html: highlightCode(state.text, state.lang) }} />
        </pre>
      ) : null}

      {state.status === "unsupported" ? (
        <div id="f57.explorer.ops.previewUnsupported" data-testid="preview-unsupported" className="flex flex-col items-center gap-1 rounded border border-dashed border-default p-3">
          <FileQuestion className="size-8 text-tertiary" aria-hidden />
          <p className="text-xs text-tertiary">{t("files.ops.preview.unsupportedTitle")}</p>
          <p className="text-xs font-mono text-secondary">{sizeText}</p>
          <p className="text-[10px] text-tertiary">{t("files.ops.preview.unsupportedNote")}</p>
        </div>
      ) : null}

      {state.status === "restricted" || state.status === "error" ? (
        <p id="f57.explorer.ops.previewNote" data-testid="preview-note" data-kind={state.status} className="text-xs text-tertiary inline-flex items-start gap-1">
          <AlertTriangle className="size-3.5 shrink-0 mt-0.5" aria-hidden />
          <span>{state.status === "restricted" ? t("files.ops.preview.restricted") : t("files.ops.preview.error")}</span>
        </p>
      ) : null}

      {entry && (state.status === "ready" || state.status === "unsupported") ? (
        <a
          id="f57.explorer.ops.previewDownload"
          data-testid="preview-download"
          href={previewUrl(entry.id)}
          download={entry.name}
          className="h-9 px-2 rounded-md border border-default text-xs text-secondary inline-flex items-center justify-center gap-1"
        >
          <Download className="size-3.5" aria-hidden />
          {t("files.ops.preview.download")}
        </a>
      ) : null}

      {state.bytes != null && state.status === "ready" ? (
        <p className="text-[10px] font-mono text-tertiary" data-testid="preview-bytes">
          {String(state.bytes) + " B"}
        </p>
      ) : null}
    </aside>
  );
}
