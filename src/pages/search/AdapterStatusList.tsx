// [F56-c] AdapterStatusList (Plan §A): one AdapterStatusRow per compiled
// adapter with source name, result count, running/complete/error state,
// retry-after information and search cancellation state. Compiled adapters
// arrive with the accepted list from the frozen registry (F56-b owns the
// registry + loader); a rate-limited adapter never hides other adapters' rows.
import { useTranslation } from "react-i18next";
import { useSearchStore } from "@/stores/searchStore";

export function AdapterStatusList() {
  const { t } = useTranslation();
  const adapters = useSearchStore((s) => s.adapters);
  const rows = Object.values(adapters).sort((a, b) => a.adapterId.localeCompare(b.adapterId));

  return (
    <ul
      id="f56.search.adapterStatusList"
      data-testid="adapter-status-list"
      aria-label={t("search.a11y.adapterStatusList")}
      className="flex flex-col gap-1"
    >
      {rows.map((a) => (
        <li
          key={a.adapterId}
          id={"f56.search.adapterStatusRow." + a.adapterId}
          data-testid={"adapter-row-" + a.adapterId}
          className="flex items-center gap-2 text-xs font-mono text-secondary bg-surface border border-default rounded px-2 py-1.5"
        >
          <span className="text-primary not-font-mono">{t(a.nameKey)}</span>
          <span>{t("search.adapter.resultCount", { count: a.resultCount })}</span>
          <span>{t("search.adapter.status." + statusKey(a.status))}</span>
          {a.retryAfter ? <span>{t("search.adapter.retryAfter", { time: String(a.retryAfter) })}</span> : null}
          {a.lastErrorCode ? <span className="text-warning">{a.lastErrorCode}</span> : null}
        </li>
      ))}
    </ul>
  );
}

export function statusKey(status: string): string {
  switch (status) {
    case "rate-limited":
      return "rateLimited";
    case "blocked-robots":
      return "blockedRobots";
    case "timed-out":
      return "timedOut";
    default:
      return status;
  }
}
