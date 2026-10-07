// [F99 §3] Collector — live feature-probe dashboard.
// Runs POST /api/collector/run (1/5 min), renders ~15 feature probes + summary.
// Supports JSON + NDJSON (Accept: application/x-ndjson) download of last report.
// [F100 §3.3] Adds "Recent user actions" table - every button click is logged
// via collectorAgent.ts and can be replayed; "▶ Replay all" + "🗑 Clear" buttons.
// [F102 §2] "Click now" / "Click every button" / "Replay all" perform REAL DOM
// clicks on the button's host page (collectorAgent.clickKnownButton); rows come
// from the persisted zustand store, so they survive a refresh (issue #159).

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { apiBase, getDashToken } from "@/lib/api";
import { Card } from "@/components/primitives/Data";
import { Button } from "@/components/primitives/Button";
import { Chip } from "@/components/primitives/Chip";
import {
  getRecordedActions,
  clearActions,
  replayAllActions,
  installFetchObserver,
  clickKnownButton,
  clickAllKnownButtons,
  isHandlerWired,
  knownButtonOf,
  navigateTo,
  lastOutcomePerButton,
  useCollectorStore,
  KNOWN_BUTTONS,
  type ButtonAction,
} from "@/lib/collectorAgent";
import { GLOBAL_CLICK_SOURCE } from "@/lib/globalClickCapture";

// [F101 §3.3] the six tabs every action row expands into
const DEEP_TABS = ["preCheck", "request", "response", "postCheck", "services", "verdict"] as const;
type DeepTab = (typeof DEEP_TABS)[number];

function verdictTone(v?: ButtonAction["verdict"]) {
  if (!v) return "neutral" as const;
  if (v.status === "ok") return "success" as const;
  if (v.status === "fail") return "danger" as const;
  return "warning" as const;
}

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
  // [F102 §2.2] rows come straight from the persisted store: it hydrated from
  // localStorage synchronously, before this component's first paint.
  const actions = useCollectorStore((s) => s.actions);
  // [F104 §3.4] two provenances, two sections: the instrumented F100/F101/F102
  // rows keep the "Recent user actions" table (and its F102 e2e counts)
  // byte-identical; the auto-captured rows render below under "Global clicks".
  const recordedActions = useMemo(() => actions.filter((a) => a.source !== GLOBAL_CLICK_SOURCE), [actions]);
  const globalActions = useMemo(() => actions.filter((a) => a.source === GLOBAL_CLICK_SOURCE), [actions]);
  const hydration = useCollectorStore((s) => s.hydration);
  const persistError = useCollectorStore((s) => s.persistError);
  const notice = useCollectorStore((s) => s.notice);
  const clickRun = useCollectorStore((s) => s.running);
  // [F101 §3.3] which row is expanded and which of its six tabs is showing.
  // [F102] a click that navigated away re-mounts this page: re-open its row.
  const [expandedId, setExpandedId] = useState<string | null>(() => useCollectorStore.getState().focusId);
  const [deepTab, setDeepTab] = useState<DeepTab>("verdict");
  const [batchRunning, setBatchRunning] = useState(false);
  // [F102] the runner is global (it survives the route changes it causes), so
  // "busy" is read from the store, not from this page's local state.
  const clickingNow: string | null = clickRun ? (batchRunning || clickRun.total ? "__all__" : clickRun.buttonId) : batchRunning ? "__all__" : null;

  const focusId = useCollectorStore((s) => s.focusId);
  useEffect(() => {
    if (focusId) {
      setExpandedId(focusId);
      setDeepTab("verdict");
    }
  }, [focusId]);

  useEffect(() => {
    // [F101 §3.2] arm the fetch observer on mount so every button click on
    // every page - not just the ones driven from this table - is recorded with
    // its real request/response.
    installFetchObserver();
  }, []);

  const handleClearActions = useCallback(() => {
    clearActions();
  }, []);

  /** [F102 §2.1] "Click now": a REAL DOM click on the button's host page
   *  (navigate → preconditions → click → observe → verdict), then back here. */
  const handleClickNow = useCallback(async (btnId: string) => {
    const btn = KNOWN_BUTTONS.find((b) => b.id === btnId);
    if (!btn || !isHandlerWired(btn)) return;
    setError(null);
    try {
      const rec = await clickKnownButton(btn);
      useCollectorStore.setState({ focusId: rec.id });
      setExpandedId(rec.id);
      setDeepTab("verdict");
    } catch (e) {
      setError(String((e as Error)?.message || e));
    }
  }, []);

  /** [F102 §2.3] exercise EVERY wired button once (real clicks), aborting
   *  after 5 identical errors; unwired buttons are skipped, never recorded. */
  const handleClickAll = useCallback(async () => {
    setBatchRunning(true);
    setError(null);
    try {
      // clickAllKnownButtons() records one deeply-instrumented row per click,
      // so this handler must NOT wrap it again (that would double-record).
      const out = await clickAllKnownButtons();
      const last = out.records[out.records.length - 1];
      if (last) useCollectorStore.setState({ focusId: last.id });
    } catch (e) {
      setError(String((e as Error)?.message || e));
    } finally {
      setBatchRunning(false);
    }
  }, []);

  /** [F102] Replay = real clicks of each distinct button in the history. */
  const handleReplayAll = useCallback(async () => {
    setReplaying(true);
    setError(null);
    try {
      await replayAllActions();
    } catch (e) {
      setError(String((e as Error)?.message || e));
    } finally {
      setReplaying(false);
    }
  }, []);

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

  // [F102] last outcome per known-button id (rows carry params.knownButton)
  const lastByButton = useMemo(() => {
    const out: Record<string, ButtonAction> = {};
    for (const a of actions) {
      const b = knownButtonOf(a);
      if (b) out[b.id] = a;
    }
    return out;
  }, [actions]);

  const features = report?.features || {};
  const summary = report?.summary;

  return (
    <div data-testid="collector-page" data-collector-ignore className="flex flex-col gap-4">
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
            disabled={replaying || recordedActions.length === 0}
            data-testid="collector-replay-all"
          >
            {replaying ? "▶ Replaying…" : "▶ Replay all"}
          </Button>
          <Button variant="secondary" size="sm" onClick={handleClearActions} disabled={actions.length === 0} data-testid="collector-clear-actions">
            🗑 {t("collector.clear", { defaultValue: "Clear" })}
          </Button>
          <span className="text-xs text-tertiary" data-testid="collector-actions-count">
            {recordedActions.length} action{recordedActions.length === 1 ? "" : "s"} recorded
          </span>
          {/* [F102 §2.2] proof the rows came back from localStorage on load */}
          {hydration ? (
            <span data-testid="collector-rehydrated" title={"onRehydrateStorage fired at " + hydration.at + " (source: " + hydration.source + ")"}>
              <Chip tone={hydration.source === "empty" ? "neutral" : "success"}>
                Rehydrated from localStorage · {hydration.count} action{hydration.count === 1 ? "" : "s"}
              </Chip>
            </span>
          ) : null}
        </div>
        {persistError ? (
          <div data-testid="collector-persist-error" className="mb-2 p-2 rounded bg-warning/10 text-warning text-xs font-mono">
            {persistError}
          </div>
        ) : null}
        {clickRun ? (
          <div data-testid="collector-running" className="mb-2 p-2 rounded bg-accent/10 text-primary text-xs font-mono">
            ▶ {clickRun.total ? "[" + clickRun.index + "/" + clickRun.total + "] " : ""}clicking “{clickRun.label}” — {clickRun.step}
          </div>
        ) : null}
        {notice ? (
          <div data-testid="collector-notice" className="mb-2 p-2 rounded bg-warning/10 text-warning text-xs font-mono">
            {notice}
          </div>
        ) : null}
        {recordedActions.length === 0 ? (
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
                  <th className="py-1 pr-2">{t("collector.verdict", { defaultValue: "Verdict" })}</th>
                  <th className="py-1"></th>
                </tr>
              </thead>
              <tbody>
                {recordedActions.slice(-50).reverse().map((a) => {
                  const open = expandedId === a.id;
                  return (
                    <Fragment key={a.id}>
                      {/* [F101 §3.3] the row itself is the affordance: click it
                          for the full breakdown instead of "add-site save -> ERR". */}
                      <tr
                        className={"border-b border-default/50 cursor-pointer " + (open ? "bg-raised/60" : "hover:bg-raised/40")}
                        data-testid="collector-action-row"
                        data-action-id={a.id}
                        data-button-id={knownButtonOf(a)?.id ?? ""}
                        data-via={String((a.result as { via?: unknown } | undefined)?.via ?? "")}
                        onClick={() => { setExpandedId(open ? null : a.id); setDeepTab("verdict"); }}
                        aria-expanded={open}
                      >
                        <td className="py-1 pr-2 font-mono text-tertiary" title={a.ts}>{new Date(a.ts).toLocaleTimeString()}</td>
                        <td className="py-1 pr-2 font-mono">{a.feature}</td>
                        <td className="py-1 pr-2 font-mono">{a.action}</td>
                        <td className="py-1 pr-2 font-mono truncate max-w-[20ch]" title={a.params ? JSON.stringify(a.params) : ""}>{a.params ? JSON.stringify(a.params).slice(0, 80) : "—"}</td>
                        <td className={"py-1 pr-2 font-mono truncate max-w-[30ch] " + (a.error ? "text-danger" : "")} title={a.error ? a.error : a.result ? JSON.stringify(a.result) : ""}>
                          {a.error ? ("ERR: " + a.error).slice(0, 80) : a.result ? JSON.stringify(a.result).slice(0, 80) : "—"}
                        </td>
                        <td className="py-1 pr-2 font-mono" data-testid="elapsed-ms">{a.elapsedMs ?? "—"}</td>
                        <td className="py-1 pr-2">
                          <Chip tone={verdictTone(a.verdict)}>
                            <span data-testid="verdict">{a.verdict ? a.verdict.status : "n/a"}</span>
                          </Chip>
                        </td>
                        <td className="py-1">
                          <span className="text-[10px] text-tertiary">{open ? "▾ hide" : "▸ expand"}</span>
                        </td>
                      </tr>
                      {open ? (
                        <tr className="border-b border-default" data-testid={"collector-action-detail-" + a.id}>
                          <td colSpan={8} className="p-0">
                            <div className="p-2 bg-sunken/40">
                              <div className="flex flex-wrap gap-1 mb-2" role="tablist" aria-label="action breakdown">
                                {DEEP_TABS.map((tb) => (
                                  <button
                                    key={tb}
                                    type="button"
                                    role="tab"
                                    aria-selected={deepTab === tb}
                                    data-testid={"collector-tab-" + tb}
                                    onClick={() => setDeepTab(tb)}
                                    className={
                                      "px-2 py-0.5 rounded text-[11px] font-mono border " +
                                      (deepTab === tb ? "border-accent text-primary bg-raised" : "border-default text-tertiary hover:text-secondary")
                                    }
                                  >
                                    {tb}
                                  </button>
                                ))}
                              </div>
                              {deepTab === "verdict" ? (
                                <div
                                  data-testid="collector-verdict"
                                  className={
                                    "rounded border p-2 text-xs " +
                                    (a.verdict?.status === "ok"
                                      ? "border-success/40 bg-success/10 text-primary"
                                      : a.verdict?.status === "fail"
                                      ? "border-danger/50 bg-danger/10 text-primary"
                                      : a.verdict?.status === "warn"
                                      ? "border-warning/50 bg-warning/10 text-primary"
                                      : "border-default bg-raised/60 text-secondary")
                                  }
                                >
                                  <div className="font-semibold">
                                    {a.verdict ? a.verdict.status.toUpperCase() : "NO VERDICT"}
                                    {a.verdict ? " — " + a.verdict.reason : " (this row predates F101 deep logging: click the button again to capture it)"}
                                  </div>
                                  {a.verdict ? (
                                    <>
                                      <div className="mt-1 font-mono text-[11px] text-secondary">Suggested fix: {a.verdict.suggestedFix}</div>
                                      {a.verdict.relatedIssue ? (
                                        <div className="mt-1 text-[11px]">
                                          Related issue:{" "}
                                          <a className="text-accent underline" href={"https://github.com/dekarita/supreme-lamp/issues/" + a.verdict.relatedIssue.replace("#", "")} target="_blank" rel="noreferrer">
                                            {a.verdict.relatedIssue}
                                          </a>
                                        </div>
                                      ) : null}
                                    </>
                                  ) : null}
                                </div>
                              ) : deepTab === "services" ? (
                                <div className="overflow-x-auto">
                                  <table className="w-full text-[11px] font-mono border-collapse" data-testid="collector-services">
                                    <thead>
                                      <tr className="text-left text-tertiary border-b border-default/50">
                                        <th className="py-1 pr-3">service</th>
                                        <th className="py-1 pr-3">pre</th>
                                        <th className="py-1 pr-3">post</th>
                                        <th className="py-1 pr-3">latencyMs</th>
                                        <th className="py-1">lastCheck</th>
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {(a.serviceDependencies || []).map((d) => (
                                        <tr key={d.name} className="border-b border-default/30">
                                          <td className="py-1 pr-3">{d.name}</td>
                                          <td className="py-1 pr-3">{a.preCheck ? (a.preCheck.serviceStates as unknown as Record<string, string>)[d.name] ?? "—" : "—"}</td>
                                          <td className="py-1 pr-3">{a.postCheck ? (a.postCheck.newServiceStates as unknown as Record<string, string>)[d.name] ?? "—" : "—"}</td>
                                          <td className="py-1 pr-3">{d.latencyMs ?? "—"}</td>
                                          <td className="py-1 text-tertiary">{d.lastCheckTs}</td>
                                        </tr>
                                      ))}
                                      {(a.serviceDependencies || []).length === 0 ? (
                                        <tr><td colSpan={5} className="py-1 text-tertiary">no service dependencies captured</td></tr>
                                      ) : null}
                                    </tbody>
                                  </table>
                                </div>
                              ) : (
                                <pre
                                  data-testid={"collector-deep-" + deepTab}
                                  className="p-2 bg-raised rounded text-[11px] font-mono overflow-auto max-h-[40vh] whitespace-pre-wrap break-all"
                                >
                                  {JSON.stringify(a[deepTab] ?? null, null, 2)}
                                </pre>
                              )}
                            </div>
                          </td>
                        </tr>
                      ) : null}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* [F104 §3.4] Global clicks (auto-captured): every REAL button click
          anywhere in Mission Control lands here with what it did on the wire
          (fetch round trips) and on screen (popups). Rows persist like every
          other collector row (F102) and survive a refresh. This Card's own
          controls are data-collector-ignore'd (page root), so reading this
          table never writes to it. */}
      <Card title={t("collector.globalTitle", { defaultValue: "Global clicks (auto-captured)" })}>
        <div className="flex flex-wrap items-center gap-2 mb-3">
          <span className="text-xs text-tertiary" data-testid="collector-global-count">
            {globalActions.length} click{globalActions.length === 1 ? "" : "s"} auto-captured
          </span>
        </div>
        {globalActions.length === 0 ? (
          <div className="text-sm text-tertiary" data-testid="collector-global-empty">
            {t("collector.globalEmpty", { defaultValue: "No clicks captured yet. Click any button anywhere in the dashboard (not on this page), then come back here." })}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs border-collapse" data-testid="collector-global-table">
              <thead>
                <tr className="text-left border-b border-default">
                  <th className="py-1 pr-2">{t("collector.when", { defaultValue: "When" })}</th>
                  <th className="py-1 pr-2">{t("collector.control", { defaultValue: "Control" })}</th>
                  <th className="py-1 pr-2">{t("collector.route", { defaultValue: "Route" })}</th>
                  <th className="py-1 pr-2">{t("collector.wire", { defaultValue: "Wire" })}</th>
                  <th className="py-1 pr-2">{t("collector.elapsed", { defaultValue: "ms" })}</th>
                  <th className="py-1 pr-2">{t("collector.verdict", { defaultValue: "Verdict" })}</th>
                </tr>
              </thead>
              <tbody>
                {globalActions.slice(-50).reverse().map((a) => {
                  const params = (a.params || {}) as { testId?: string; label?: string; text?: string; tag?: string; route?: string; path?: string };
                  const res = (a.result || {}) as { capturing?: boolean; fetch?: Array<{ url?: string; method?: string; status?: number; elapsedMs?: number }>; opened?: Array<{ url?: string; blocked?: boolean }> };
                  const fetches = Array.isArray(res.fetch) ? res.fetch : [];
                  const opens = Array.isArray(res.opened) ? res.opened : [];
                  const control = params.testId || params.label || params.text || params.tag || a.action;
                  return (
                    <tr
                      key={a.id}
                      className="border-b border-default/50"
                      data-testid="collector-global-row"
                      data-action-id={a.id}
                      title={params.path || ""}
                    >
                      <td className="py-1 pr-2 font-mono text-tertiary" title={a.ts}>{new Date(a.ts).toLocaleTimeString()}</td>
                      <td className="py-1 pr-2 font-mono truncate max-w-[28ch]" title={control}>{control}</td>
                      <td className="py-1 pr-2 font-mono truncate max-w-[20ch]" title={params.route || ""}>{params.route || "—"}</td>
                      <td className="py-1 pr-2 font-mono" title={JSON.stringify({ fetch: fetches, opened: opens }).slice(0, 500)}>
                        {res.capturing ? "capturing…" : fetches.length + " fetch · " + opens.length + " popup"}
                      </td>
                      <td className="py-1 pr-2 font-mono" data-testid="elapsed-ms">{a.elapsedMs ?? "—"}</td>
                      <td className="py-1 pr-2">
                        <Chip tone={verdictTone(a.verdict)}>
                          <span data-testid="verdict">{a.verdict ? a.verdict.status : "…"}</span>
                        </Chip>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* [F101 §3.4 → F102 §2.1] EVERY button in the dashboard. Click now
          navigates to the button's host page, runs its preconditions and
          performs a REAL DOM click (no route-probe fallback); Open page shows
          the button in context. Each click records the full row above. */}
      <Card title={t("collector.allButtons", { defaultValue: "All known buttons" })}>
        <div className="flex flex-wrap items-center gap-2 mb-3">
          <Button
            variant="primary"
            size="sm"
            onClick={handleClickAll}
            disabled={clickingNow !== null}
            data-testid="collector-click-all"
          >
            {clickingNow === "__all__" ? "▶ Clicking all…" : "▶ Click every button"}
          </Button>
          <span className="text-xs text-tertiary">
            {KNOWN_BUTTONS.length} buttons registered · {KNOWN_BUTTONS.filter(isHandlerWired).length} wired for real DOM clicks · each click opens the button's page, clicks it, and comes back here
          </span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs border-collapse" data-testid="collector-known-buttons">
            <thead>
              <tr className="text-left border-b border-default">
                <th className="py-1 pr-2">{t("collector.feature", { defaultValue: "Feature" })}</th>
                <th className="py-1 pr-2">{t("collector.button", { defaultValue: "Button" })}</th>
                <th className="py-1 pr-2">{t("collector.hostPage", { defaultValue: "Host page" })}</th>
                <th className="py-1 pr-2">{t("collector.lastClicked", { defaultValue: "Last clicked" })}</th>
                <th className="py-1 pr-2">{t("collector.lastResult", { defaultValue: "Last result" })}</th>
                <th className="py-1 pr-2">{t("collector.handler", { defaultValue: "Status" })}</th>
                <th className="py-1"></th>
              </tr>
            </thead>
            <tbody>
              {KNOWN_BUTTONS.map((btn) => {
                const last = lastByButton[btn.id] ?? lastOutcomePerButton(actions)[btn.feature + ":" + btn.action];
                const wired = isHandlerWired(btn);
                const lastVia = last ? String((last.result as { via?: unknown } | undefined)?.via ?? "") : "";
                return (
                  <tr key={btn.id} className="border-b border-default/50" data-testid={"collector-known-row-" + btn.id} data-wired={wired ? "1" : "0"}>
                    <td className="py-1 pr-2 font-mono">{btn.feature}</td>
                    <td className="py-1 pr-2">
                      <span className="font-mono">{btn.label}</span>
                      <span className="ml-1 text-[10px] text-tertiary font-mono">{btn.testId}</span>
                    </td>
                    <td className="py-1 pr-2 font-mono text-[10px] text-tertiary">{btn.hostRoute ?? "—"}</td>
                    <td className="py-1 pr-2 font-mono text-tertiary">{last ? new Date(last.ts).toLocaleTimeString() : "—"}</td>
                    <td className="py-1 pr-2" title={last?.verdict?.reason ?? ""}>
                      {last ? (
                        <Chip tone={verdictTone(last.verdict)}>
                          {(last.verdict ? last.verdict.status : "n/a") + (last.response ? " · " + last.response.status : "") + (last.elapsedMs != null ? " · " + last.elapsedMs + "ms" : "")}
                        </Chip>
                      ) : (
                        <span className="text-tertiary">never clicked</span>
                      )}
                    </td>
                    <td className="py-1 pr-2 font-mono text-[10px]" data-testid={"collector-handler-" + btn.id}>
                      {/* [F102 §2.3] an unwired button is never clicked or recorded */}
                      {!wired ? (
                        <span className="text-warning">⚠️ Handler pending</span>
                      ) : lastVia === "not-rendered" ? (
                        <span className="text-warning" title={last?.verdict?.reason ?? ""}>not rendered last time</span>
                      ) : lastVia === "disabled" ? (
                        <span className="text-warning" title={last?.verdict?.reason ?? ""}>disabled last time</span>
                      ) : (
                        <span className="text-secondary">real DOM click</span>
                      )}
                      {btn.mutating ? <span className="ml-1 text-warning" title="this click changes state on the runner">mutating</span> : null}
                    </td>
                    <td className="py-1 whitespace-nowrap">
                      <span className="inline-flex" data-testid={"click-now-" + btn.id}>
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => void handleClickNow(btn.id)}
                          disabled={clickingNow !== null || !wired}
                          title={wired ? "Open " + (btn.hostRoute ?? "") + ", click [data-testid=" + btn.testId + "] for real, record the result" : "Handler pending - not clickable yet"}
                          data-testid={"collector-click-now-" + btn.id}
                        >
                          {clickingNow === btn.id ? "…" : "Click now"}
                        </Button>
                      </span>
                      {/* [F102 §2.4] see the button in context */}
                      <Button
                        variant="ghost"
                        size="sm"
                        className="ml-1"
                        onClick={() => void navigateTo(btn.hostRoute ?? "/#/")}
                        disabled={!btn.hostRoute || clickingNow !== null}
                        data-testid={"collector-open-page-" + btn.id}
                        title={"Navigate to " + (btn.hostRoute ?? "")}
                      >
                        Open page
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
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
