// [F56-c] BottomProgressRail stub (Plan §A): the F56-d transport rail renders
// aria2c GIDs / qBittorrent handles, speeds, ETAs, retries and cancel actions.
// F56-c ships the shell + empty state + live region only; fetch records are
// always empty here and mirror opt-in stays OFF (locked default).
import { useTranslation } from "react-i18next";
import { useSearchStore } from "@/stores/searchStore";

export function BottomProgressRail() {
  const { t } = useTranslation();
  const fetches = useSearchStore((s) => s.fetches);
  const rows = Object.values(fetches);

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
          rows.map((f) => (
            <li key={f.fetchId} id={"f56.search.progressRow." + f.fetchId} className="text-xs font-mono text-secondary">
              {f.fetchId}
            </li>
          ))
        )}
      </ul>
      <div id="f56.search.progressLive" role="status" aria-live="polite" aria-label={t("search.a11y.liveStatus")} className="sr-only" />
    </section>
  );
}
