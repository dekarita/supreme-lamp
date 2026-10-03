// [F56-c v3] Progressive 5-minute lab (VISIBLE progression): 0-30s classifier
// with a ticking category-detection message stream, 30s-4min federated probes
// streaming per-adapter rows with real dispatch/settle timestamps, 4-5min
// consolidation with result count + an informational timed-out note. The clock is the ONLY stub here: F56-d
// replaces `labNowMs` with real adapter events; every state transition itself
// is computed by the pure module src/lib/search/progressiveLab.ts.
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { selectVisibleResults, useSearchStore } from "@/stores/searchStore";
import { useSearchUiStore } from "@/stores/searchUiStore";
import { validatedHttpsUrl } from "@/pages/search/tokens";
import { ADAPTER_ROSTER } from "./adapters";
import {
  LAB_STAGES,
  labClassifierStream,
  labPartialCount,
  labProgress,
  labRail,
  labStamp,
  labTimedOut,
  labWindows,
  type LabStage,
} from "@/lib/search/progressiveLab";

export const LAB_TICK_MS = 1000;

/** Ticking clock (1 Hz) for the live lab. `nowMs` (tests) freezes it. */
export function useLabNow(startedAt: number, frozen?: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (frozen != null || !startedAt) return;
    const id = window.setInterval(() => setNow(Date.now()), LAB_TICK_MS);
    return () => window.clearInterval(id);
  }, [startedAt, frozen]);
  if (frozen != null) return frozen;
  return startedAt ? Math.max(0, now - startedAt) : 0;
}

function stageTestId(stage: LabStage): string {
  return "lab-stage-" + stage;
}

export function ProgressiveLab({ nowMs }: { nowMs?: number } = {}) {
  const { t } = useTranslation();
  const startedAt = useSearchUiStore((s) => s.labStartedAt);
  const adapters = useSearchStore((s) => s.adapters);
  const results = useSearchStore((s) => s.results);
  const order = useSearchStore((s) => s.resultOrder);
  const categories = useSearchStore((s) => s.categories);
  const licenceTags = useSearchStore((s) => s.licenceTags);
  const maxSizeBytes = useSearchStore((s) => s.maxSizeBytes);
  const sort = useSearchStore((s) => s.sort);
  const normalizedQuery = useSearchStore((s) => s.normalizedQuery);
  const fileExtensions = useSearchStore((s) => s.fileExtensions);
  const yearFrom = useSearchStore((s) => s.yearFrom);
  const yearTo = useSearchStore((s) => s.yearTo);
  const language = useSearchStore((s) => s.language);
  const elapsed = useLabNow(startedAt, nowMs);

  const p = labProgress(elapsed);
  const roster = Object.keys(adapters).length
    ? Object.values(adapters).map((a) => ({ adapterId: a.adapterId, status: a.status, resultCount: a.resultCount }))
    : ADAPTER_ROSTER.map((a) => ({ adapterId: a.adapterId, status: "idle", resultCount: 0 }));
  const rows = labRail(roster, elapsed);
  const visible = selectVisibleResults({ results, resultOrder: order, categories, licenceTags, maxSizeBytes, sort, normalizedQuery, fileExtensions, yearFrom, yearTo, language });
  const links = visible.filter((r) => validatedHttpsUrl(r.sourceUrl) !== "").length;
  const percent = Math.round(p.totalFraction * 100);

  return (
    <section
      id="f56.search.v2.lab"
      data-testid="progressive-lab"
      data-stage={p.stage}
      data-elapsed-ms={String(p.ms)}
      aria-label={t("search.v2.lab.title")}
      className="bg-surface border border-default rounded-md p-3 flex flex-col gap-3"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-semibold text-primary">{t("search.v2.lab.title")}</h2>
        <span
          id="f56.search.v2.labStage"
          data-testid="lab-stage"
          data-animating={p.stage === "classifier" ? "true" : "false"}
          className={
            "rounded bg-raised px-2 py-0.5 text-xs text-secondary" +
            (p.stage === "classifier" ? " animate-pulse text-accent" : "")
          }
        >
          {t("search.v2.lab.stage." + p.stage)}
        </span>
        <span id="f56.search.v2.labPartialCount" data-testid="lab-partial-count" className="text-xs font-mono text-tertiary">
          {String(labPartialCount(rows))}
        </span>
        <span className="ml-auto text-xs font-mono text-tertiary">{t("search.v2.lab.percent", { percent: String(percent) })}</span>
      </div>

      <p id="f56.search.v2.labWindow" className="text-xs text-tertiary">
        {t("search.v2.lab.windows")}
      </p>
      <p data-testid="lab-hint" className="text-xs text-secondary">
        {t("search.v2.lab.hint." + p.stage)}
      </p>

      {/* §3 0-30s: the category-detection message stream ticks visibly. */}
      {p.stage === "classifier" ? (
        <ul id="f56.search.v2.labClassifierStream" data-testid="lab-classifier-stream" aria-live="polite" className="flex flex-col gap-1 text-xs font-mono text-secondary">
          {labClassifierStream(elapsed).map((m) => (
            <li key={m.id} id={"f56.search.v2.labClassifierMsg." + m.id} data-testid="lab-classifier-msg" className="flex items-center gap-2">
              <span className="size-1.5 rounded-full bg-accent animate-pulse" aria-hidden />
              {t(m.i18nKey)}
            </li>
          ))}
        </ul>
      ) : null}

      <ol id="f56.search.v2.labTimeline" data-testid="lab-timeline" className="flex flex-wrap items-center gap-2 text-xs">
        {labWindows().map((w) => {
          const idx = LAB_STAGES.indexOf(w.stage);
          const state = p.stageIndex > idx ? "done" : p.stageIndex === idx ? "active" : "pending";
          return (
            <li
              key={w.stage}
              id={"f56.search.v2.labStageRow." + w.stage}
              data-testid={stageTestId(w.stage)}
              data-state={state}
              aria-current={state === "active" ? "step" : undefined}
              className={
                "rounded px-2 py-1 border " +
                (state === "active"
                  ? "border-accent text-accent bg-accent/10"
                  : state === "done"
                    ? "border-default text-secondary bg-raised"
                    : "border-default text-tertiary")
              }
            >
              {t("search.v2.lab.stage." + w.stage)}
            </li>
          );
        })}
      </ol>

      <div>
        <h3 className="text-xs font-semibold text-tertiary mb-1">{t("search.v2.lab.rail.label")}</h3>
        <ul id="f56.search.v2.labAdapterRail" data-testid="lab-adapter-rail" className="flex flex-col gap-1">
          {rows.map((r) => (
            <li
              key={r.adapterId}
              id={"f56.search.v2.labAdapterRow." + r.adapterId}
              data-testid="lab-adapter-row"
              data-adapter-id={r.adapterId}
              data-state={r.state}
              className="flex items-center gap-2 text-xs font-mono text-secondary"
            >
              <span className="w-40 truncate text-primary">{r.adapterId}</span>
              <span
                id={"f56.search.v2.labAdapterBar." + r.adapterId}
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(r.fraction * 100)}
                aria-label={r.adapterId}
                className="h-1.5 w-40 rounded bg-raised overflow-hidden"
              >
                <span className="block h-full bg-accent" style={{ width: Math.round(r.fraction * 100) + "%" }} />
              </span>
              <span data-testid="lab-adapter-state" className="w-20">
                {t("search.v2.lab.rail." + r.state)}
              </span>
              {/* §3 30s-4min: real timestamps for dispatch -> settle. */}
              <span data-testid="lab-adapter-stamp" className="text-tertiary">
                {labStamp(startedAt, r.state === "queued" ? r.dispatchMs : r.state === "settled" ? r.settleMs : elapsed) || "—"}
              </span>
              <span>
                {t("search.adapter.resultCount", { count: r.resultCount })}
              </span>
            </li>
          ))}
        </ul>
      </div>

      {/* §3 4-5min: consolidation summary; the timed-out note is
          informational (muted), never a red banner. */}
      {p.stageIndex >= 2 ? (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span id="f56.search.v2.labConsolidated" data-testid="lab-consolidated" className="text-secondary">
            {t("search.v3.lab.consolidated", { count: order.length })}
          </span>
          {labTimedOut(rows, elapsed) > 0 ? (
            <span id="f56.search.v2.labTimedOut" data-testid="lab-timed-out" className="text-tertiary">
              {t("search.v3.lab.timedOut", { count: labTimedOut(rows, elapsed) })}
            </span>
          ) : null}
        </div>
      ) : null}

      <p id="f56.search.v2.labLinks" data-testid="lab-links" className="text-xs text-secondary">
        {p.linksExtracted ? t("search.v2.lab.links", { count: links }) : t("search.v2.lab.hint." + p.stage)}
      </p>
    </section>
  );
}
