// [F-DVR-LITE §4] DvrFab - the operator's handle on the DVR.
//
// A FAB (bottom-left, so a toast in the bottom-right corner can never cover the one
// control that answers "something just broke") that opens a panel showing EXACTLY
// what is about to be copied: the entry counts, the codec, the character count, and
// the first characters of the real envelope. Copy puts it on the clipboard through
// `copyText` (src/lib/clipboard.ts) - the only egress the DVR has, and an operator
// action rather than a background one.
//
// Why the panel shows the payload instead of summarising it: after #169 chose
// option (d), the ONLY privacy guarantee left is the one the operator can see. The
// preview is the same string the Copy button writes, byte for byte.
import { useEffect, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { Radio } from "lucide-react";
import { Modal } from "@/components/primitives/Feedback";
import { copyText } from "@/lib/clipboard";
import { cn } from "@/lib/cn";
import {
  DVR_ENVELOPE_FORMAT,
  clearDvr,
  dvrLastActivityAt,
  dvrReport,
  dvrSnapshot,
  isDvrRecording,
  setDvrRecording,
  subscribeDvr,
  type DvrReport,
} from "@/lib/dvr";

/** How much of the envelope the panel prints before it says "…" - enough to prove
 *  the payload is the real thing, short enough to keep the modal readable. */
export const DVR_PREVIEW_CHARS = 600;

export function DvrFab() {
  const { t } = useTranslation();
  const snap = useSyncExternalStore(subscribeDvr, dvrSnapshot, dvrSnapshot);
  const [open, setOpen] = useState(false);
  const [report, setReport] = useState<DvrReport | null>(null);
  const [copied, setCopied] = useState("");
  const [recording, setRecording] = useState(isDvrRecording());

  // Assemble the bundle when the panel opens, and re-assemble after every change
  // that happened while it was open (the count is the dependency that moves).
  useEffect(() => {
    if (!open) return;
    let alive = true;
    void dvrReport().then(
      (r) => {
        if (alive) setReport(r);
      },
      () => {
        if (alive) setReport(null);
      }
    );
    return () => {
      alive = false;
    };
  }, [open, snap.count, snap.recording]);

  useEffect(() => {
    setRecording(snap.recording);
  }, [snap.recording]);

  const payload = report ? report.text : "";
  const preview = payload.length > DVR_PREVIEW_CHARS ? payload.slice(0, DVR_PREVIEW_CHARS) + "…" : payload;

  // WYSIWYG: Copy hands over the assembly the panel is CURRENTLY showing, so the
  // preview is not an approximation of the payload - it is the payload. (Before this,
  // the panel previewed assembly #1 and copied assembly #2; the two differ from their
  // first timestamp character on, which is both a UX lie and a racy thing to assert.
  // The effect above re-assembles whenever the ring moves, so this stays fresh.)
  const onCopy = async (): Promise<void> => {
    const r = report ?? (await dvrReport());
    if (!report) setReport(r);
    const ok = await copyText(r.text, t("dvr.copyLabel"));
    setCopied(ok ? t("dvr.copied", { chars: String(r.chars), codec: r.codec }) : t("dvr.copyFailed"));
  };

  const onClear = (): void => {
    clearDvr();
    setReport(null);
    setCopied("");
  };

  const onToggleRecording = (): void => {
    const next = !recording;
    setDvrRecording(next);
    setRecording(next);
  };

  const lastAt = dvrLastActivityAt();
  const seconds = snap.spanMs > 0 ? Math.round(snap.spanMs / 1000) : 0;

  return (
    <>
      <button
        type="button"
        data-testid="dvr-fab"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={t("dvr.open")}
        title={t("dvr.open")}
        onClick={() => setOpen(true)}
        className={cn(
          "fixed left-3 bottom-12 z-50 inline-flex items-center gap-2 rounded-full border shadow-md px-3 py-2 text-xs font-medium",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
          "bg-surface border-default text-primary hover:bg-raised"
        )}
      >
        <span
          aria-hidden
          className={cn("inline-block size-2 rounded-full", recording ? "bg-danger" : "bg-secondary")}
        />
        <Radio className="size-4" aria-hidden />
        <span>DVR</span>
        <span data-testid="dvr-fab-count" className="font-mono text-[10px] text-secondary">
          {snap.count}
        </span>
      </button>

      <Modal
        open={open}
        title={t("dvr.title")}
        description={
          <div data-testid="dvr-panel" className="space-y-2">
            <p data-testid="dvr-privacy" className="text-xs text-secondary">
              {t("dvr.privacy", { format: DVR_ENVELOPE_FORMAT })}
            </p>
            <ul className="text-xs text-secondary font-mono space-y-0.5">
              <li data-testid="dvr-stat-count">{t("dvr.statEvents", { n: String(snap.count) })}</li>
              <li data-testid="dvr-stat-clicks">{t("dvr.statClicks", { n: String(snap.clicks) })}</li>
              <li data-testid="dvr-stat-settled">{t("dvr.statSettled", { n: String(snap.settled) })}</li>
              <li data-testid="dvr-stat-route">{t("dvr.statRoute", { route: snap.route || "/" })}</li>
              <li data-testid="dvr-stat-span">{t("dvr.statSpan", { seconds: String(seconds) })}</li>
              <li data-testid="dvr-stat-mutations">{t("dvr.statMutations", { n: String(snap.mutations) })}</li>
              <li data-testid="dvr-stat-codec">
                {t("dvr.statPayload", {
                  codec: report ? report.codec : "--",
                  chars: report ? String(report.chars) : "0",
                })}
              </li>
            </ul>
            {snap.count === 0 ? (
              <p data-testid="dvr-empty" className="text-xs text-tertiary">
                {t("dvr.empty")}
              </p>
            ) : null}
            <pre
              data-testid="dvr-preview"
              data-codec={report ? report.codec : ""}
              data-chars={report ? String(report.chars) : "0"}
              className="max-h-40 overflow-auto rounded border border-default bg-sunken p-2 text-[10px] font-mono text-secondary whitespace-pre-wrap break-all"
            >
              {preview || t("dvr.loading")}
            </pre>
            <div className="flex items-center justify-between gap-2">
              <button
                type="button"
                data-testid="dvr-record-toggle"
                aria-pressed={recording}
                onClick={onToggleRecording}
                className="text-xs text-secondary hover:text-primary underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded"
              >
                {recording ? t("dvr.pause") : t("dvr.resume")}
              </button>
              <span data-testid="dvr-last" className="text-[10px] text-tertiary">
                {lastAt ? t("dvr.lastActivity") : ""}
              </span>
            </div>
            {copied ? (
              <p data-testid="dvr-copied" className="text-xs text-success">
                {copied}
              </p>
            ) : null}
          </div>
        }
        onClose={() => setOpen(false)}
        secondary={{ label: t("dvr.clear"), onClick: onClear }}
        primary={{ label: t("dvr.copy"), onClick: () => void onCopy() }}
      />
    </>
  );
}

export default DvrFab;
