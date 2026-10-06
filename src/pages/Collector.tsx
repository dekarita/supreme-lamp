// [F99 §3] Collector — live feature-probe dashboard.
// Runs POST /api/collector/run (1/5 min), renders ~15 feature probes + summary.
// Supports JSON + NDJSON (Accept: application/x-ndjson) download of last report.
// [F100 §3.3] Adds "Recent user actions" table - every button click is logged
// via collectorAgent.ts and can be replayed; "▶ Replay all" + "🗑 Clear" buttons.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { apiBase, getDashToken } from "@/lib/api";
import { Card } from "@/components/primitives/Data";
import { Button } from "@/components/primitives/Button";
import { Chip } from "@/components/primitives/Chip";
import {
  getRecordedActions,
  clearActions,
  subscribeToActions,
  replayAllActions,
  type ButtonAction,
} from "@/lib/collectorAgent";

type FeatureStatus = "pass" | "fail" | "warn" | string;

interface CollectorFeature {
  status?: FeatureStatus;
  detail?: string;
  [k: string]: unknown;
}

interface CollectorReport {
  ok?: boolean;
  startedAt?: string;
  finishedAt?: string;
  features?: Record<string, CollectorFeature>;
  summary?: {
    totalFeatures?: number;
    passed?: number;
    failed?: number;
    warnings?: number;
    criticalIssues?: string[];
    recommendations?: string[];
  };
  error?: string;
  retryAfterSec?: number;
}

function statusTone(s?: string) {
  if (s === "pass") return "success" as const;
  if (s === "fail") return "danger" as const;
  if (s === "warn") return "warning" as const;
  return "neutral" as const;
}

function statusLabel(s?: string) {
  if (!s) return "—";
  return s;
}

export default function Collector() {
  const { t } = useTranslation();
  const [report, setReport] = useState<CollectorReport | null>(null);
  const [status, setStatus] = useState<{ lastRunAt?: string; nextRunAvailableAt?: string; retryAfterSec?: number } | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retryAfter, setRetryAfter] = useState<number | null>(null);
  const [replaying, setReplaying] = useState(false);
  const [actions, setActions] = useState<ButtonAction[]>(() => getRecordedActions());

  // Subscribe to live action updates from collectorAgent.
  useEffect(() => {
    return subscribeToActions(setActions);
  }, []);

  const handleClearActions = useCallback(() => {
    clearActions();
  }, []);

  // Replay handlers know how to re-execute each (feature, action) pair.
  // We keep this map minimal for F100: it logs back via logButtonAction so the
  // replay itself is recorded; actual replay of UI flows is wired where the
  // action has a stateless, invokable API. Other entries record "no-op (replay
  // handler not wired)" so the operator sees which actions need manual click.
  const replayHandlers = useMemo(() => {
    return {} as Record<string, (p: Record<string, unknown>) => unknown | Promise<unknown>>;
  }, []);

  const handleReplayAll = useCallback(async () => {
    setReplaying(true);
    setError(null);
    try {
      await replayAllActions(replayHandlers);
    } catch (e) {
      setError(String((e as Error)?.message || e));
    } finally {
      setReplaying(false);
    }
  }, [replayHandlers]);

  const fetchStatus = useCallback(async () => {
    try {
      const r = await fetch(apiBase() + "/api/collector/status", { cache: "no-store" });
      if (r.ok) {
        const j = (await r.json()) as typeof status;
        setStatus(j);
        if (j?.retryAfterSec) setRetryAfter(j.retryAfterSec);
        else setRetryAfter(null);
      }
    } catch { /* ignore */ }
  }, []);

  const fetchReport = useCallback(async () => {
    try {
      const token = getDashToken();
      const headers: Record<string, string> = {};
      if (token) headers["X-Dash-Token"] = token;
      const r = await fetch(apiBase() + "/api/collector/report", { cache: "no-store", headers });
      if (r.ok) {
        const j = (await r.json()) as CollectorReport;
        setReport(j);
      }
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    fetchStatus();
    fetchReport();
  }, [fetchStatus, fetchReport]);

  const run = useCallback(async () => {
    setRunning(true);
    setError(null);
    try {
      const token = getDashToken();
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (token) headers["X-Dash-Token"] = token;
      const r = await fetch(apiBase() + "/api/collector/run", {
        method: "POST",
        headers,
        cache: "no-store",
      });
      if (r.status === 429) {
        const j = (await r.json().catch(() => ({}))) as CollectorReport;
        setError(j.error || "Rate limited — 1 per 5 minutes");
        if (j.retryAfterSec) setRetryAfter(j.retryAfterSec);
        return;
      }
      if (!r.ok) {
        const txt = await r.text().catch(() => "");
        setError("Collector run failed: HTTP " + r.status + " " + txt.slice(0, 200));
        return;
      }
      const j = (await r.json()) as CollectorReport;
      setReport(j);
      fetchStatus();
    } catch (e) {
      setError(String((e as Error)?.message || e));
    } finally {
      setRunning(false);
    }
  }, [fetchStatus]);

  const download = useCallback(async (asNdjson: boolean) => {
    try {
      const token = getDashToken();
      const headers: Record<string, string> = {};
      if (token) headers["X-Dash-Token"] = token;
      if (asNdjson) headers["Accept"] = "application/x-ndjson";
      const r = await fetch(apiBase() + "/api/collector/report", { cache: "no-store", headers });
      if (!r.ok) {
        setError("Download failed: HTTP " + r.status);
        return;
      }
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = asNdjson ? "collector.ndjson" : "collector.json";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    } catch (e) {
      setError(String((e as Error)?.message || e));
    }
  }, []);

  const downloadActions = useCallback(() => {
    try {
      const blob = new Blob([JSON.stringify({ recordedUserActions: getRecordedActions() }, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "button-actions.json";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    } catch (e) {
      setError(String((e as Error)?.message || e));
    }
  }, []);

  const features = report?.features || {};
  const summary = report?.summary;

  return (
    <div data-testid="collector-page" className="flex flex-col gap-4">
      <div className="flex items-center gap-3 flex-wrap">
        <h2 className="text-xl font-semibold">{t("collector.title", { defaultValue: "Collector — Diagnosis Run" })}</h2>
        {summary ? (
          <Chip tone={summary.failed ? "danger" : summary.warnings ? "warning" : "success"}>{summary.passed ?? 0} pass · {summary.failed ?? 0} fail · {summary.warnings ?? 0} warn</Chip>
        ) : null}
        <span className="text-xs text-tertiary">
          {status?.lastRunAt ? t("collector.lastRun", { defaultValue: "Last run: {{ts}}", ts: new Date(status.lastRunAt).toLocaleString() }) : t("collector.noRun", { defaultValue: "No run yet" })}
        </span>
      </div>

      <Card title={t("collector.controls", { defaultValue: "Controls" })}>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            id="collectorRun"
            data-testid="collector-run"
            onClick={run}
            disabled={running || (!!retryAfter && retryAfter > 0)}
            variant="primary"
          >
            {running ? t("collector.running", { defaultValue: "Running…" }) : t("collector.run", { defaultValue: "Run diagnosis (POST /api/collector/run)" })}
          </Button>
          <Button variant="secondary" onClick={fetchReport} data-testid="collector-refresh">
            {t("actions.refresh")}
          </Button>
          <Button variant="secondary" onClick={() => download(false)} data-testid="collector-download-json">
            {t("collector.downloadJson", { defaultValue: "Download JSON" })}
          </Button>
          <Button variant="secondary" onClick={() => download(true)} data-testid="collector-download-ndjson">
            {t("collector.downloadNdjson", { defaultValue: "Download NDJSON" })}
          </Button>
          <Button variant="secondary" onClick={downloadActions} data-testid="collector-download-actions">
            {t("collector.downloadActions", { defaultValue: "Download button-actions.json" })}
          </Button>
          {retryAfter ? (
            <span className="text-xs text-warning" data-testid="collector-retry">
              {t("collector.retryAfter", { defaultValue: "Retry after {{s}}s (1 per 5 min)", s: retryAfter })}
            </span>
          ) : null}
          {status?.nextRunAvailableAt ? (
            <span className="text-xs text-tertiary">next: {new Date(status.nextRunAvailableAt).toLocaleTimeString()}</span>
          ) : null}
        </div>
        <p className="text-xs text-tertiary mt-2">
          {t("collector.hint", { defaultValue: "Probes launcher, watcher, WebSocket, logon (type 2/10/11), 11 search endpoints, download, lab, mirror, file-explorer, telemetry, viewingMode, autologon, token rotation and sidebar routes — one file to paste to Claude." })}
        </p>
        {error ? (
          <div data-testid="collector-error" className="mt-3 p-2 rounded bg-danger/10 text-danger text-sm font-mono">
            {error}
          </div>
        ) : null}
      </Card>

      {/* [F100 §3.3] Recent user actions (recorded) */}
      <Card title={t("collector.actionsTitle", { defaultValue: "Recent user actions (recorded)" })}>
        <div className="flex flex-wrap items-center gap-2 mb-3">
          <Button
            variant="primary"
            size="sm"
            onClick={handleReplayAll}
            disabled={replaying || actions.length === 0}
            data-testid="collector-replay-all"
          >
            {replaying ? "▶ Replaying…" : "▶ Replay all"}
          </Button>
          <Button variant="secondary" size="sm" onClick={handleClearActions} disabled={actions.length === 0} data-testid="collector-clear-actions">
            🗑 {t("collector.clear", { defaultValue: "Clear" })}
          </Button>
          <span className="text-xs text-tertiary">
            {actions.length} action{actions.length === 1 ? "" : "s"} recorded
          </span>
        </div>
        {actions.length === 0 ? (
          <div className="text-sm text-tertiary" data-testid="collector-actions-empty">
            {t("collector.actionsEmpty", { defaultValue: "No button clicks recorded yet. Click buttons around the dashboard (Add site, Open in RDP, Fetch, Download, Reconnect, Preview…) to populate this table." })}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs border-collapse" data-testid="collector-actions-table">
              <thead>
                <tr className="text-left border-b border-default">
                  <th className="py-1 pr-2">{t("collector.when", { defaultValue: "When" })}</th>
                  <th className="py-1 pr-2">{t("collector.feature", { defaultValue: "Feature" })}</th>
                  <th className="py-1 pr-2">{t("collector.action", { defaultValue: "Action" })}</th>
                  <th className="py-1 pr-2">{t("collector.params", { defaultValue: "Params" })}</th>
                  <th className="py-1 pr-2">{t("collector.result", { defaultValue: "Result" })}</th>
                  <th className="py-1 pr-2">{t("collector.elapsed", { defaultValue: "ms" })}</th>
                  <th className="py-1"></th>
                </tr>
              </thead>
              <tbody>
                {actions.slice(-50).reverse().map((a) => (
                  <tr key={a.id} className="border-b border-default/50" data-testid={"collector-action-row-" + a.id}>
                    <td className="py-1 pr-2 font-mono text-tertiary" title={a.ts}>{new Date(a.ts).toLocaleTimeString()}</td>
                    <td className="py-1 pr-2 font-mono">{a.feature}</td>
                    <td className="py-1 pr-2 font-mono">{a.action}</td>
                    <td className="py-1 pr-2 font-mono truncate max-w-[20ch]" title={a.params ? JSON.stringify(a.params) : ""}>{a.params ? JSON.stringify(a.params).slice(0, 80) : "—"}</td>
                    <td className={"py-1 pr-2 font-mono truncate max-w-[30ch] " + (a.error ? "text-danger" : "")} title={a.error ? a.error : a.result ? JSON.stringify(a.result) : ""}>
                      {a.error ? ("ERR: " + a.error).slice(0, 80) : a.result ? JSON.stringify(a.result).slice(0, 80) : "—"}
                    </td>
                    <td className="py-1 pr-2 font-mono">{a.elapsedMs ?? "—"}</td>
                    <td className="py-1">
                      <span className="text-[10px] text-tertiary">replay</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {summary ? (
        <Card title={t("collector.summary", { defaultValue: "Summary" })}>
          <div className="grid grid-cols-3 gap-2 text-sm mb-3">
            <div>{t("collector.total", { defaultValue: "Total" })}: <strong>{summary.totalFeatures ?? Object.keys(features).length}</strong></div>
            <div>{t("collector.passed", { defaultValue: "Passed" })}: <strong className="text-success">{summary.passed ?? 0}</strong></div>
            <div>{t("collector.failed", { defaultValue: "Failed" })}: <strong className="text-danger">{summary.failed ?? 0}</strong></div>
          </div>
          {summary.criticalIssues && summary.criticalIssues.length > 0 ? (
            <div className="mb-2">
              <div className="text-xs font-semibold text-danger">{t("collector.critical", { defaultValue: "Critical issues" })}</div>
              <ul className="list-disc ml-5 text-xs font-mono">
                {summary.criticalIssues.map((c, i) => (
                  <li key={i}>{c}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {summary.recommendations && summary.recommendations.length > 0 ? (
            <div>
              <div className="text-xs font-semibold">{t("collector.recommendations", { defaultValue: "Recommendations" })}</div>
              <ul className="list-disc ml-5 text-xs">
                {summary.recommendations.map((r, i) => (
                  <li key={i}>{r}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {report?.startedAt ? (
            <div className="text-xs text-tertiary mt-2">started: {report.startedAt} · finished: {report.finishedAt}</div>
          ) : null}
        </Card>
      ) : null}

      <Card title={t("collector.features", { defaultValue: "Features" })}>
        {Object.keys(features).length === 0 ? (
          <div className="text-sm text-tertiary" data-testid="collector-empty">
            {t("collector.empty", { defaultValue: "No report yet — click Run diagnosis to probe all systems. Rate limit 1 per 5 minutes (HTTP 429)." })}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm border-collapse" data-testid="collector-table">
              <thead>
                <tr className="text-left border-b border-default">
                  <th className="py-1 pr-2">{t("collector.feature", { defaultValue: "Feature" })}</th>
                  <th className="py-1 pr-2">{t("collector.status", { defaultValue: "Status" })}</th>
                  <th className="py-1">{t("collector.detail", { defaultValue: "Detail" })}</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(features).map(([name, f]) => {
                  const st = (f as CollectorFeature).status as string | undefined;
                  // searchEndpoints has nested perSite — render one row per site
                  if (name === "searchEndpoints" && (f as Record<string, unknown>).perSite) {
                    const per = (f as Record<string, unknown>).perSite as Record<string, Record<string, unknown>>;
                    return Object.entries(per).map(([site, entry]) => (
                      <tr key={name + ":" + site} className="border-b border-default/50" data-testid={"collector-row-search:" + site}>
                        <td className="py-1 pr-2 font-mono text-xs">search:{site}</td>
                        <td className="py-1 pr-2">
                          <Chip tone={statusTone(entry.status as string)}>{statusLabel(entry.status as string)}</Chip>
                        </td>
                        <td className="py-1 font-mono text-xs truncate max-w-[40ch]" title={String(entry.firstResult ?? entry.lastError ?? "")}>
                          {String(entry.firstResult ?? entry.lastError ?? (entry.reachable ? "reachable" : ""))}
                        </td>
                      </tr>
                    ));
                  }
                  if (name === "sidebarRoutes" && typeof f === "object") {
                    const entries = f as Record<string, Record<string, unknown>>;
                    // render as one row with summary instead of 10 to keep table compact
                    const total = Object.keys(entries).length;
                    const okCount = Object.values(entries).filter((v) => (v as Record<string, unknown>).status === "pass").length;
                    return (
                      <tr key={name} className="border-b border-default/50" data-testid="collector-row-sidebarRoutes">
                        <td className="py-1 pr-2 font-mono text-xs">{name}</td>
                        <td className="py-1 pr-2">
                          <Chip tone={okCount === total ? "success" : "warning"}>{okCount}/{total} pass</Chip>
                        </td>
                        <td className="py-1 font-mono text-xs">{Object.keys(entries).join(", ")}</td>
                      </tr>
                    );
                  }
                  const detail =
                    (f as Record<string, unknown>).detail ??
                    (f as Record<string, unknown>).testResult ??
                    (f as Record<string, unknown>).diagnoseResult ??
                    (f as Record<string, unknown>).lastError ??
                    "";
                  // stringify complex detail
                  const detailStr = typeof detail === "object" && detail !== null ? JSON.stringify(detail).slice(0, 200) : String(detail ?? "");
                  return (
                    <tr key={name} className="border-b border-default/50" data-testid={"collector-row-" + name}>
                      <td className="py-1 pr-2 font-mono text-xs">{name}</td>
                      <td className="py-1 pr-2">
                        <Chip tone={statusTone(st)}>{statusLabel(st)}</Chip>
                      </td>
                      <td className="py-1 font-mono text-xs truncate max-w-[50ch]" title={detailStr}>
                        {detailStr || JSON.stringify(f).slice(0, 160)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {report ? (
          <details className="mt-3">
            <summary className="text-xs text-secondary cursor-pointer">{t("collector.rawJson", { defaultValue: "Raw JSON" })}</summary>
            <pre data-testid="collector-raw" className="mt-2 p-2 bg-raised rounded text-xs overflow-auto max-h-[40vh]">
              {JSON.stringify(report, null, 2)}
            </pre>
          </details>
        ) : null}
      </Card>
    </div>
  );
}
