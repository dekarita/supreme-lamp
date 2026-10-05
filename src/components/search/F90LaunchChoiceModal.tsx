// [F90 §C.2] The tailscale-local link modal.
//
// Shown only when BOTH are true:
//   1. the dashboard is running in the operator's OWN browser (tailscale-local),
//      so `window.open` would open the link on the wrong machine, and
//   2. the server's F86 launch ladder could not reach a desktop either.
//
// Nothing is opened implicitly. The operator picks one of four explicit
// outcomes, and the URL is shown in full so "copy" is never a trust exercise.
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ClipboardCopy, ExternalLink, Monitor, X } from "lucide-react";
import { useLaunchChoiceStore } from "@/stores/launchChoiceStore";

export function F90LaunchChoiceModal() {
  const { t } = useTranslation();
  const pendingUrl = useLaunchChoiceStore((s) => s.pendingUrl);
  const reason = useLaunchChoiceStore((s) => s.reason);
  const close = useLaunchChoiceStore((s) => s.close);
  const [copied, setCopied] = useState(false);
  const copyRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (pendingUrl) copyRef.current?.focus();
    else setCopied(false);
  }, [pendingUrl]);

  // Esc closes; the operator is never trapped behind the choice.
  useEffect(() => {
    if (!pendingUrl) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pendingUrl, close]);

  if (!pendingUrl) return null;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(pendingUrl);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div
      id="f90.launchChoice.overlay"
      data-testid="f90-launch-choice-modal"
      role="dialog"
      aria-modal="true"
      aria-label={t("viewingMode.choice.title")}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={close}
    >
      <div
        className="w-full max-w-lg rounded-md border border-default bg-surface p-4 flex flex-col gap-3 text-sm"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-2">
          <h2 className="text-base font-semibold text-primary flex-1">{t("viewingMode.choice.title")}</h2>
          <button
            id="f90.launchChoice.dismiss"
            data-testid="f90-launch-choice-dismiss"
            type="button"
            aria-label={t("viewingMode.choice.dismiss")}
            onClick={close}
            className="h-8 w-8 inline-flex items-center justify-center rounded-md border border-default text-secondary hover:bg-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            <X className="size-4" aria-hidden />
          </button>
        </div>

        <p className="text-xs text-secondary">{t("viewingMode.choice.body")}</p>
        {reason ? <p className="text-xs text-warning">{t(reason)}</p> : null}

        <code
          data-testid="f90-launch-choice-url"
          className="block break-all rounded border border-default bg-raised p-2 text-xs font-mono text-primary"
        >
          {pendingUrl}
        </code>

        <div className="flex flex-wrap gap-2">
          <button
            ref={copyRef}
            id="f90.launchChoice.copy"
            data-testid="f90-launch-choice-copy"
            type="button"
            onClick={() => void copy()}
            className="h-11 px-3 rounded-md border border-default text-xs text-primary bg-raised hover:bg-accent/10 inline-flex items-center gap-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            <ClipboardCopy className="size-3.5" aria-hidden />
            {copied ? t("viewingMode.choice.copied") : t("viewingMode.choice.copy")}
          </button>
          <a
            id="f90.launchChoice.switch"
            data-testid="f90-launch-choice-switch"
            href="/#/overview"
            onClick={close}
            className="h-11 px-3 rounded-md border border-default text-xs text-primary bg-raised hover:bg-accent/10 inline-flex items-center gap-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            <Monitor className="size-3.5" aria-hidden />
            {t("viewingMode.choice.switch")}
          </a>
          <a
            id="f90.launchChoice.openAnyway"
            data-testid="f90-launch-choice-open-anyway"
            href={pendingUrl}
            target="_blank"
            rel="noopener noreferrer"
            onClick={close}
            className="h-11 px-3 rounded-md border border-default text-xs text-secondary hover:bg-raised inline-flex items-center gap-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            <ExternalLink className="size-3.5" aria-hidden />
            {t("viewingMode.choice.openAnyway")}
          </a>
        </div>
      </div>
    </div>
  );
}

export default F90LaunchChoiceModal;
