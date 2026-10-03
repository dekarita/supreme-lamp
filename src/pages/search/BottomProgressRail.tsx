// [F56-c] BottomProgressRail (Plan §A): the F56-d transport rail renders
// aria2c GIDs / qBittorrent handles, speeds, ETAs, retries and cancel actions.
// [F69 §2.5] Live wiring (F68 Extension Rank 7): rows come from the accepted
// FetchAccepted records in searchStore.fetches (fetchId, gid, transport,
// status) and the cancel action calls the F56-d client lane (cancelFetch).
// Speed / ETA / sparkline stay reserved (template ids unused) until the
// /api/progress feed lands. Mirror opt-in stays OFF (locked default).
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useSearchStore, type FetchRecord } from "@/stores/searchStore";
import { useToastStore } from "@/stores/toastStore";
import { cancelFetch } from "@/lib/fetchStub";

const STATUS_KEYS: Record<string, string> = {
  queued: "queued",
  active: "downloading",
  downloading: "downloading",
  verifying: "verifying",
  encrypting: "encrypting",
  "post-fetch": "postFetch",
  postfetch: "postFetch",
  complete: "completed",
  completed: "completed",
  retrying: "retrying",
  error: "failed",
  failed: "failed",
  "cancel-requested": "cancelRequested",
  cancelled: "cancelled",
  removed: "cancelled",
};

const TERMINAL = new Set(["completed", "complete", "failed", "error", "cancelled", "removed", "cancel-requested"]);

export function BottomProgressRail() {
  const { t } = useTranslation();
  const fetches = useSearchStore((s) => s.fetches);
  const setFetchStatus = useSearchStore((s) => s.setFetchStatus);
  const push = useToastStore((s) => s.push);
  const rows = Object.values(fetches);

  const statusLabel = (status: string | undefined): string => {
    const raw = String(status || "queued").toLowerCase();
    const key = STATUS_KEYS[raw];
    return key ? t("search.progress." + key) : raw;
  };

  const onCancel = useCallback(
    async (f: FetchRecord) => {
      const key = f.resultId || f.fetchId;
      if (!f.gid) return;
      setFetchStatus(key, "cancel-requested");
      try {
        const out = await cancelFetch(f.fetchId, f.gid);
        if (out.ok) {
          setFetchStatus(key, "cancelled");
          push(t("search.fetch.cancelled"));
        } else {
          setFetchStatus(key, f.status || "queued");
          push(t(out.error?.messageKey || "search.errors.generic"));
        }
      } catch {
        setFetchStatus(key, f.status || "queued");
        push(t("search.errors.generic"));
      }
    },
    [setFetchStatus, push, t]
  );

  const latest = rows.length ? rows[rows.length - 1] : null;

  return (
    <section
      id="f56.search.progressRail"
      aria-label={t("search.a11y.progressRail")}
      className="bg-surface border border-default rounded-md p-3 flex flex-col gap-2"
    >
      <div id="f56.search.progressHeader" className="flex items-center gap-2 text-xs">
        <h2 className="text-sm font-semibold text-primary">{t("search.progress.title")}</h2>
        <span id="f56.search.postFetchPipeline" className="rounded bg-raised px-2 py-0.5 text-tertiary">
          {t("search.progress.postFetch")}
        </span>
        <span id="f56.search.torrentLane" className="rounded bg-raised px-2 py-0.5 text-tertiary">
          {t("search.progress.transportTorrent")}
        </span>
        <span id="f56.search.mirrorOff" data-testid="mirror-off" className="rounded bg-raised px-2 py-0.5 text-tertiary font-mono">
          {t("search.progress.mirrorOff")}
        </span>
        <span className="ml-auto text-tertiary">{t("search.actions.comingSoon")}</span>
      </div>
      <ul id="f56.search.progressList" data-testid="progress-list" className="flex flex-col gap-1 min-h-10">
        {rows.length === 0 ? (
          <li id="f56.search.progressEmpty" className="text-xs text-tertiary">
            {t("search.progress.empty")}
          </li>
        ) : (
          rows.map((f) => {
            const status = String(f.status || "queued").toLowerCase();
            const cancellable = Boolean(f.gid) && !TERMINAL.has(status);
            return (
              <li
                key={f.fetchId}
                id={"f56.search.progressRow." + f.fetchId}
                data-testid="progress-row"
                data-fetch-status={status}
                className="text-xs font-mono text-secondary flex items-center gap-2 min-w-0"
              >
                <span className="truncate max-w-32 shrink-0" title={f.fetchId}>
                  {f.fetchId}
                </span>
                <span id={"f56.search.progressTransport." + f.fetchId} data-testid="progress-transport" className="rounded bg-raised px-2 py-0.5 text-tertiary shrink-0">
                  {f.transport === "torrent" ? t("search.progress.transportTorrent") : t("search.progress.transportAria2")}
                </span>
                {f.gid ? (
                  <span id={"f56.search.progressGid." + f.fetchId} data-testid="progress-gid" className="text-tertiary truncate max-w-40">
                    {t("search.progress.gid", { gid: f.gid })}
                  </span>
                ) : null}
                <span
                  id={"f56.search.progressStage." + f.fetchId}
                  data-testid="progress-status"
                  className={
                    "rounded px-2 py-0.5 shrink-0 " +
                    (status === "failed" || status === "error" ? "bg-danger/10 text-danger" : status === "cancelled" || status === "removed" ? "bg-raised text-tertiary" : "bg-accent/10 text-accent")
                  }
                >
                  {statusLabel(f.status)}
                </span>
                {cancellable ? (
                  <button
                    id={"f56.search.progressCancel." + f.fetchId}
                    data-testid="progress-cancel"
                    type="button"
                    aria-label={t("search.progress.cancel") + " " + f.fetchId}
                    onClick={() => void onCancel(f)}
                    className="ml-auto h-8 px-2 rounded-md border border-default text-xs text-secondary hover:bg-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                  >
                    {t("search.progress.cancel")}
                  </button>
                ) : null}
              </li>
            );
          })
        )}
      </ul>
      <div id="f56.search.progressLive" role="status" aria-live="polite" aria-label={t("search.a11y.liveStatus")} className="sr-only">
        {latest ? latest.fetchId + ": " + statusLabel(latest.status) : ""}
      </div>
    </section>
  );
}
