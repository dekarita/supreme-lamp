// [F57 §4] Bottom-dock operation rail: one row per durable queue job (label,
// progress bar, cancel / retry). Mirrors the F56-c BottomProgressRail pattern
// (live region + empty state) but reads the Explorer queue store, so a large
// async move/paste/delete stays visible while the operator keeps working.
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import { useExplorerQueueStore } from "@/lib/explorer/queueStore";
import { jobPercent } from "@/lib/explorer/queue";

export function ExplorerProgressRail() {
  const { t } = useTranslation();
  const jobs = useExplorerQueueStore((s) => s.jobs);
  const cancel = useExplorerQueueStore((s) => s.cancel);
  const retry = useExplorerQueueStore((s) => s.retry);

  return (
    <section
      id="f57.explorer.ops.queueRail"
      aria-label={t("files.ops.queue.title")}
      className="bg-surface border border-default rounded-md p-3 flex flex-col gap-2"
    >
      <h2 className="text-sm font-semibold text-primary">{t("files.ops.queue.title")}</h2>
      <ul data-testid="queue-jobs" className="flex flex-col gap-1 min-h-8">
        {jobs.length === 0 ? (
          <li className="text-xs text-tertiary">{t("files.ops.queue.empty")}</li>
        ) : (
          jobs.map((job) => {
            const pct = jobPercent(job);
            return (
              <li
                key={job.jobId}
                id={"f57.explorer.ops.queueJob." + job.jobId}
                data-testid="queue-job"
                data-status={job.status}
                className="flex items-center gap-2 text-xs font-mono text-secondary"
              >
                <span className="truncate w-32">{job.label}</span>
                <span
                  id={"f57.explorer.ops.queueProgress." + job.jobId}
                  data-testid="queue-progress"
                  role="progressbar"
                  aria-label={t("files.ops.queue.progressLabel", { label: job.label })}
                  aria-valuenow={pct}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  data-percent={pct}
                  className="h-1.5 flex-1 rounded bg-raised"
                >
                  <span className="block h-1.5 rounded bg-accent" style={{ width: pct + "%" }} />
                </span>
                <span data-testid="queue-percent">{String(pct)}%</span>
                <span data-testid="queue-status">{t("files.ops.queue.status." + job.status)}</span>
                {job.status === "failed" ? (
                  <button type="button" data-testid="queue-retry" onClick={() => retry(job.jobId)} className="h-8 px-1 rounded border border-default">
                    {t("files.ops.queue.retry")}
                  </button>
                ) : null}
                {job.status === "queued" || job.status === "running" ? (
                  <button
                    id={"f57.explorer.ops.queueCancel." + job.jobId}
                    type="button"
                    data-testid="queue-cancel"
                    aria-label={t("files.ops.queue.cancel")}
                    onClick={() => cancel(job.jobId)}
                    className="h-8 px-1 rounded border border-default"
                  >
                    <X className="size-3" aria-hidden />
                  </button>
                ) : null}
              </li>
            );
          })
        )}
      </ul>
      <div role="status" aria-live="polite" aria-label={t("files.ops.queue.title")} className="sr-only" />
    </section>
  );
}
