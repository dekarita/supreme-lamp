// [F99 §3.2] /#/collector - THE DIAGNOSIS COLLECTOR.
//
// WHY THIS PAGE EXISTS: every F93-F98 diagnosis began with the operator
// screenshotting one red pill at a time. POST /api/collector/run exercises the
// WHOLE dashboard end to end from INSIDE the box (17 real probes: the launcher,
// the watcher task, the RFC6455 upgrade lane, the logon verdict, the search
// fan-out, download-to-RDP, the lab inspector, mirror auth, the file explorer,
// telemetry, the viewing mode, the autologon pair, dash-token rotation, every
// sidebar route, /health, the self-test and the server echo), and this page
// renders the verdict per feature: pass / fail / warn / skip, the diagnostic
// payload behind it, and - for a red row - the Issue the fix belongs to.
//
// The page NEVER invents a result: before the first run it shows the
// never-run state, while a run is live it polls /api/collector/status, and the
// downloads are the exact bytes the server wrote to disk. A run takes 60-120s
// and the button says so; the collector runs as a CHILD process so the
// dashboard this page talks to stays responsive for the whole run.
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { apiBase, getKey } from "@/lib/api";

export type CollectorFeature = {
  name: string;
  status: "pass" | "fail" | "warn" | "skip" | string;
  detail?: string;
  issue?: string;
  ms?: number;
  at?: string;
  data?: unknown;
};

export type CollectorStatus = {
  ok?: boolean;
  state?: "never-run" | "running" | "done" | "stalled" | string;
  stale?: boolean;
  runId?: string;
  startedAt?: string;
  updatedAt?: string;
  durationSec?: number;
  base?: string;
  order?: string[];
  features?: Record<string, CollectorFeature>;
  summary?: {
    totalFeatures?: number;
    passed?: number;
    failed?: number;
    warnings?: number;
    skipped?: number;
    criticalIssues?: { feature: string; detail: string; issue?: string }[];
    recommendations?: string[];
  } | null;
  advisories?: string[];
  reportReady?: boolean;
  markdownReady?: boolean;
  messageKey?: string;
  code?: string;
  error?: string;
};

const ISSUE_BASE = "https://github.com/dekarita/supreme-lamp/issues/";

const rowCls = (s: string) =>
  s === "pass"
    ? "bg-green-100 text-black"
    : s === "warn"
      ? "bg-amber-100 text-black"
      : s === "skip"
        ? "bg-gray-200 text-black"
        : "bg-red-200 text-black";

/** '#153' -> https://github.com/dekarita/supreme-lamp/issues/153 (null when absent). */
export function issueUrl(issue: string | undefined): string | null {
  if (!issue) return null;
  const m = /^#?(\d+)$/.exec(String(issue).trim());
  return m ? ISSUE_BASE + m[1] : null;
}

function authHeaders(): Record<string, string> {
  const key = getKey();
  return key ? { "X-Dash-Token": key } : {};
}

/** Download one of the collector's own artefacts (JSON or Markdown). */
async function download(path: string, filename: string): Promise<string | null> {
  try {
    const r = await fetch(apiBase() + path, { cache: "no-store", headers: authHeaders() });
    if (!r.ok) return "HTTP " + r.status;
    const body = await r.text();
    const url = URL.createObjectURL(new Blob([body], { type: "application/octet-stream" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    return null;
  } catch (e) {
    return String(e);
  }
}

export function CollectorPage() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<CollectorStatus | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [downloading, setDownloading] = useState<string | null>(null);
  const timer = useRef<number | null>(null);

  const fetchStatus = useCallback(async () => {
    try {
      const r = await fetch(apiBase() + "/api/collector/status", { cache: "no-store", headers: authHeaders() });
      const j = (await r.json()) as CollectorStatus;
      setStatus(j);
      setErr(null);
      return j;
    } catch (e) {
      setErr(String(e));
      return null;
    }
  }, []);

  // Poll while a run is live, and stop the moment it lands. One timer at a
  // time: a second one would double every tick against a 60-120s workload.
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      if (!alive) return;
      const j = await fetchStatus();
      if (!alive) return;
      const running = j?.state === "running";
      timer.current = window.setTimeout(tick, running ? 2000 : 10000) as unknown as number;
    };
    void tick();
    return () => {
      alive = false;
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, [fetchStatus]);

  const run = useCallback(async () => {
    setStarting(true);
    setErr(null);
    let runErr: string | null = null;
    try {
      const r = await fetch(apiBase() + "/api/collector/run", { method: "POST", cache: "no-store", headers: authHeaders() });
      const j = (await r.json()) as CollectorStatus;
      if (!r.ok && j?.code) {
        // The server names the reason (COLLECTOR_MISSING / RUN_IN_PROGRESS /
        // RATE_LIMITED / auth) - surface it instead of a bare "failed".
        const key = "collector.errors." + String(j.code).toLowerCase();
        const msg = t(key);
        runErr = msg === key ? String(j.error ?? j.code) : msg + (j.error ? " - " + j.error : "");
      }
      // Refresh FIRST: fetchStatus() clears the transport error on success, so
      // setting the run error before this await would erase the very reason the
      // operator needs to see (a 503 COLLECTOR_MISSING must survive the refresh).
      await fetchStatus();
    } catch (e) {
      runErr = String(e);
    } finally {
      setStarting(false);
      if (runErr) setErr(runErr);
    }
  }, [fetchStatus, t]);

  const grab = useCallback(
    async (path: string, filename: string) => {
      setDownloading(path);
      const e = await download(path, filename);
      setErr(e ? t("collector.errors.download") + " " + e : null);
      setDownloading(null);
    },
    [t],
  );

  const s = status;
  const features = s?.features ?? {};
  const order = (s?.order ?? []).filter((n) => features[n]);
  const unknown = Object.keys(features).filter((n) => !order.includes(n));
  const rows = [...order, ...unknown];
  const sum = s?.summary ?? null;
  const state = s?.state ?? "never-run";
  const running = state === "running";
  const never = state === "never-run";

  return (
    <div className="p-4 font-mono" data-testid="collector-page" data-state={state}>
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          data-testid="collector-run"
          disabled={starting || running}
          onClick={run}
          className="px-4 py-2 bg-black text-white disabled:opacity-50"
        >
          {running ? t("collector.running") : starting ? t("collector.starting") : t("collector.run")}
        </button>
        <span data-testid="collector-state" className="text-sm">
          {t("collector.state." + (state === "stalled" ? "stalled" : state))}
          {s?.durationSec ? " · " + s.durationSec + "s" : ""}
          {s?.runId ? " · " + s.runId : ""}
        </span>
        <button
          type="button"
          data-testid="collector-download-json"
          className="px-3 py-1 border"
          disabled={!s?.reportReady || downloading === "/api/collector/report"}
          onClick={() => void grab("/api/collector/report", "collector-report.json")}
        >
          {t("collector.downloadJson")}
        </button>
        <button
          type="button"
          data-testid="collector-download-md"
          className="px-3 py-1 border"
          disabled={!s?.markdownReady || downloading === "/api/collector/report.md"}
          onClick={() => void grab("/api/collector/report.md", "collector-report.md")}
        >
          {t("collector.downloadMd")}
        </button>
      </div>
      <p className="mt-2 text-sm">{t("collector.hint")}</p>

      {err ? (
        <div data-testid="collector-error" className="mt-3 p-2 bg-red-600 text-white">
          {err}
        </div>
      ) : null}
      {s?.stale ? <div className="mt-3 p-2 bg-amber-100 text-black">{t("collector.stale")}</div> : null}
      {never ? <div className="mt-3 p-2 bg-gray-200 text-black">{t("collector.neverRun")}</div> : null}

      {sum ? (
        <div className="mt-4 flex flex-wrap gap-2" data-testid="collector-summary">
          {[
            ["total", sum.totalFeatures],
            ["passed", sum.passed],
            ["failed", sum.failed],
            ["warnings", sum.warnings],
            ["skipped", sum.skipped],
          ].map(([k, v]) => (
            <div key={String(k)} className="border px-3 py-2" data-testid={"collector-summary-" + k}>
              <div className="text-xs uppercase">{t("collector.card." + k)}</div>
              <div className="text-xl">{String(v ?? 0)}</div>
            </div>
          ))}
        </div>
      ) : null}

      {sum?.criticalIssues && sum.criticalIssues.length > 0 ? (
        <div className="mt-4 p-2 bg-red-200 text-black" data-testid="collector-critical">
          <div className="font-bold">{t("collector.critical")}</div>
          <ul className="list-disc ml-6">
            {sum.criticalIssues.map((c, i) => (
              <li key={c.feature + i}>
                <b>{c.feature}</b>: {c.detail}{" "}
                {issueUrl(c.issue) ? (
                  <a className="underline" href={issueUrl(c.issue) as string} target="_blank" rel="noreferrer">
                    {t("collector.issue")} {c.issue}
                  </a>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {sum?.recommendations && sum.recommendations.length > 0 ? (
        <div className="mt-4" data-testid="collector-recommendations">
          <div className="font-bold">{t("collector.recommendations")}</div>
          <ul className="list-disc ml-6">
            {sum.recommendations.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {rows.length > 0 ? (
        <table className="mt-4 w-full border" data-testid="collector-features">
          <thead>
            <tr>
              <th className="text-left">{t("collector.table.feature")}</th>
              <th className="text-left">{t("collector.table.status")}</th>
              <th className="text-left">{t("collector.table.detail")}</th>
              <th className="text-left">{t("collector.table.ms")}</th>
              <th className="text-left">{t("collector.table.issue")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((name) => {
              const f = features[name];
              const url = issueUrl(f.issue);
              return (
                <tr key={name} className={rowCls(f.status)} data-testid={"collector-row-" + name} data-status={f.status}>
                  <td>{t("collector.feature." + name, name)}</td>
                  <td>{f.status}</td>
                  <td>
                    <details>
                      <summary>{f.detail || t("collector.table.expand")}</summary>
                      <pre className="whitespace-pre-wrap text-sm">{JSON.stringify(f.data ?? null, null, 2)}</pre>
                    </details>
                  </td>
                  <td>{typeof f.ms === "number" && f.ms >= 0 ? f.ms + "ms" : ""}</td>
                  <td>
                    {url ? (
                      <a className="underline" href={url} target="_blank" rel="noreferrer">
                        {f.issue}
                      </a>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : null}

      {s?.advisories && s.advisories.length > 0 ? (
        <div className="mt-4 text-sm" data-testid="collector-advisories">
          {s.advisories.map((a, i) => (
            <div key={i}>· {a}</div>
          ))}
        </div>
      ) : null}
      <p className="mt-4 text-xs">
        {t("collector.footer", { issues: "#145, #148, #153" })}
      </p>
    </div>
  );
}

export default CollectorPage;
