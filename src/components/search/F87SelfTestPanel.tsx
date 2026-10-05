// [F87 §C.2] Eleven-site production self-test - "/#/search?selftest=1" only.
//
// WHY: after a dispatch the operator used to click-test eleven sites by hand
// to learn whether the new runner can reach them, read their sitemaps, open a
// window in the RDP session and write to Desktop\RDP-Downloads. One button
// now POSTs /api/f87-selftest with the operator fixture and renders one row
// per site: HTTPS? | Sitemap URLs | Launch tier | Download dir. A red mark on
// any cell carries the server's error text as its tooltip, so "which site,
// which step" is visible without the diag banner or a log file.
//
// The route is expensive (eleven real fetches + eleven launches) and rate
// limited to one call per minute per token; a 429 renders as a visible
// countdown line, never as a silent no-op. Hidden unless ?selftest=1, so the
// normal Search surface (and every existing screenshot) is untouched.
import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { apiBase, getKey } from "@/lib/api";

/** The operator fixture, verbatim (payloads/data/f86-site-hints.json keys and
 *  tests/e2e/fixtures/f85-sites.json `sites` carry the same eleven). */
export const F87_SITES: readonly string[] = [
  "openculture.com",
  "archive.org",
  "openverse.org",
  "awesome.re",
  "gutenberg.org",
  "standardebooks.org",
  "librivox.org",
  "openlibrary.org",
  "tubitv.com",
  "pluto.tv",
  "freemusicarchive.org",
];

export interface SelfTestRow {
  site: string;
  probeOk?: boolean;
  sitemapUrls?: number;
  sitemapMode?: string;
  launchTier?: number;
  launchOk?: boolean;
  launchDetail?: string;
  pdfFound?: boolean;
  downloadDirOk?: boolean;
  downloadDir?: string;
  /** [F90 §D] per-site search proof: strategy, whether it ran, item count. */
  searchStrategy?: string;
  searchOk?: boolean;
  searchItems?: number;
  /** [F90 §D] awesome.re's operator-visible column: items under the
   *  Networking H2 of the resolved sindresorhus/awesome README. 0 = no proof. */
  networkingItemCount?: number;
  /** [F91 §E.1] launcherQueueTest: the noop job survived route -> file ->
   *  service -> log. 'launcher-offline' | 'job-unconsumed' | 'consumed'. */
  launcherQueueOk?: boolean;
  launcherQueueNote?: string;
  /** [F91 §E.1] downloadTest (F88) re-exported as a first-class column. */
  downloadOk?: boolean;
  downloadPath?: string;
  downloadBytes?: number;
  /** [F91 §E.1] streamProxyTest: HEAD through the /api/stream fences. */
  streamProxyOk?: boolean;
  streamProxyStatus?: number;
  errors?: string[];
}

/** [F91 §E.1] the GLOBAL launcher lines the extended selftest answers beside
 *  the per-site rows (the same payload /api/launcher/health serves). */
export interface SelfTestLauncher {
  serviceRunning?: boolean;
  heartbeatAge?: number;
  queueDepth?: number;
  taskExists?: boolean;
}

export interface SelfTestResponse {
  ok?: boolean;
  ranAt?: string;
  total?: number;
  passed?: number;
  results?: SelfTestRow[];
  /** [F91 §E.1] global launcher service state (taskExists = taskSchedulerHealth). */
  launcher?: SelfTestLauncher;
  launcherServiceRunning?: boolean;
  taskSchedulerHealth?: boolean;
}

export type SelfTestState =
  | { phase: "idle" }
  | { phase: "running"; startedAt: number }
  | { phase: "done"; body: SelfTestResponse }
  | { phase: "rate-limited"; retryAfterSeconds: number }
  | { phase: "error"; code: string };

/** The expected wall time of a full run (eleven sites x fetch + launch); the
 *  progress bar is a time estimate, the server answers once, at the end. */
export const SELF_TEST_EXPECTED_MS = 60_000;

export async function runSelfTest(sites: readonly string[] = F87_SITES): Promise<SelfTestState> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const key = getKey();
  if (key) headers["X-Dash-Token"] = key;
  try {
    const r = await fetch(apiBase() + "/api/f87-selftest", {
      method: "POST",
      cache: "no-store",
      headers,
      body: JSON.stringify({ sites: [...sites] }),
    });
    const body = (await r.json().catch(() => null)) as (SelfTestResponse & { code?: string; retryAfterSeconds?: number }) | null;
    if (r.status === 429) return { phase: "rate-limited", retryAfterSeconds: Number(body?.retryAfterSeconds || 60) };
    if (!r.ok || !body) return { phase: "error", code: String(body?.code || r.status) };
    return { phase: "done", body };
  } catch {
    return { phase: "error", code: "transport" };
  }
}

/** A cell's pass/fail, read ONLY from server data (an absent field is a fail). */
export function cellOk(row: SelfTestRow, col: "https" | "sitemapUrls" | "launchTier" | "downloadDir" | "awesomeItems" | "search" | "launcherQueue" | "download" | "streamProxy"): boolean {
  if (col === "search") return row.searchOk === true;
  if (col === "launcherQueue") return row.launcherQueueOk === true;
  if (col === "download") return row.downloadOk === true;
  if (col === "streamProxy") return row.streamProxyOk === true;
  if (col === "https") return row.probeOk === true;
  if (col === "sitemapUrls") return typeof row.sitemapUrls === "number" && row.sitemapUrls > 0;
  if (col === "launchTier") return row.launchOk === true && typeof row.launchTier === "number" && row.launchTier >= 1 && row.launchTier <= 3;
  if (col === "awesomeItems") {
    // Only awesome.re's markdown-section strategy is asked for this proof; the
    // other ten sites are not judged on a column that does not apply to them.
    if (row.site !== "awesome.re") return true;
    return typeof row.networkingItemCount === "number" && row.networkingItemCount > 0;
  }
  return row.downloadDirOk === true;
}

/** F88's five columns keep their exact verdicts; the F91 columns (Search
 *  Endpoint | Launcher Queue | Download | Stream Proxy) join the row mark so
 *  "all 11 sites green across all columns" IS the operator's merge gate. */
export function rowOk(row: SelfTestRow): boolean {
  return cellOk(row, "https") && cellOk(row, "sitemapUrls") && cellOk(row, "launchTier") && cellOk(row, "downloadDir") && cellOk(row, "awesomeItems")
    && cellOk(row, "search") && cellOk(row, "launcherQueue") && cellOk(row, "download") && cellOk(row, "streamProxy");
}

/** A cell renderer shared by the four F91 columns: mark + optional extra. */
function F91Mark({ ok, extra }: { ok: boolean; extra?: string | number }) {
  return (
    <span className={ok ? "text-primary" : "text-danger"}>
      {ok ? "\u2713" : "\u2717"}
      {extra !== undefined && extra !== "" ? " " + String(extra) : ""}
    </span>
  );
}

export function F87SelfTestPanel() {
  const { t } = useTranslation();
  const [params] = useSearchParams();
  const enabled = params.get("selftest") === "1";
  const [state, setState] = useState<SelfTestState>({ phase: "idle" });
  const [elapsed, setElapsed] = useState(0);
  const [open, setOpen] = useState<string | null>(null);

  // The progress bar: elapsed / expected, capped at 95% until the answer lands.
  useEffect(() => {
    if (state.phase !== "running") return;
    const started = state.startedAt;
    const id = window.setInterval(() => setElapsed(Date.now() - started), 500);
    return () => window.clearInterval(id);
  }, [state]);

  if (!enabled) return null;

  const start = async () => {
    setElapsed(0);
    setState({ phase: "running", startedAt: Date.now() });
    const out = await runSelfTest(F87_SITES);
    setState(out);
  };

  const pct = state.phase === "running" ? Math.min(95, Math.round((elapsed / SELF_TEST_EXPECTED_MS) * 100)) : state.phase === "done" ? 100 : 0;
  const rows: SelfTestRow[] = state.phase === "done" ? state.body.results || [] : [];
  const passed = rows.filter(rowOk).length;
  const mark = (ok: boolean) => (ok ? "\u2713" : "\u2717");
  const errText = (row: SelfTestRow) => (row.errors || []).join("; ");

  return (
    <section
      id="f87.selftest.panel"
      data-testid="f87-selftest-panel"
      data-phase={state.phase}
      className="rounded-md border border-default bg-surface p-4 flex flex-col gap-3 text-sm"
      aria-live="polite"
    >
      <div className="flex items-center gap-3 flex-wrap">
        <h2 className="text-base font-semibold text-primary">{t("selfTest.title")}</h2>
        <button
          id="f87.selftest.run"
          data-testid="f87-selftest-run"
          type="button"
          disabled={state.phase === "running"}
          onClick={() => void start()}
          className="h-11 px-4 rounded-md border border-default text-xs text-primary bg-raised hover:bg-accent/10 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          {state.phase === "running" ? t("selfTest.inProgress") : t("selfTest.runButton")}
        </button>
        {state.phase === "done" ? (
          <span data-testid="f87-selftest-summary" data-passed={passed} data-total={rows.length} className="text-xs font-mono text-secondary">
            {t("selfTest.summary", { passed, total: rows.length })}
          </span>
        ) : null}
        {/* [F91 §E.1] the global launcherServiceRunning + taskSchedulerHealth line. */}
        {state.phase === "done" && state.body.launcher ? (
          <span
            data-testid="f91-selftest-launcher-note"
            data-ok={state.body.launcher.serviceRunning && state.body.launcher.taskExists ? "1" : "0"}
            className={"text-xs font-mono " + (state.body.launcher.serviceRunning ? "text-primary" : "text-warning")}
          >
            {t("selfTest.column.launcherNote", {
              state: state.body.launcher.serviceRunning ? "running \u2713" : state.body.launcher.taskExists ? "stale heartbeat" : "service missing",
              age: typeof state.body.launcher.heartbeatAge === "number" && state.body.launcher.heartbeatAge >= 0 ? Math.round(state.body.launcher.heartbeatAge / 1000) : "-",
              depth: state.body.launcher.queueDepth ?? "-",
            })}
          </span>
        ) : null}
      </div>

      {state.phase === "running" ? (
        <div
          data-testid="f87-selftest-progress"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct}
          className="h-2 w-full rounded bg-raised overflow-hidden"
        >
          <div className="h-full bg-accent transition-all" style={{ width: pct + "%" }} />
        </div>
      ) : null}

      {state.phase === "rate-limited" ? (
        <p data-testid="f87-selftest-rate-limited" role="status" className="text-xs text-warning">
          {t("selfTest.rateLimited", { seconds: state.retryAfterSeconds })}
        </p>
      ) : null}
      {state.phase === "error" ? (
        <p data-testid="f87-selftest-error" role="alert" className="text-xs text-danger">
          {t("selfTest.failed", { code: state.code })}
        </p>
      ) : null}

      {state.phase === "done" ? (
        <table data-testid="f87-selftest-table" className="w-full text-xs font-mono border-collapse">
          <thead>
            <tr className="text-left text-tertiary">
              <th className="py-1 pr-2">{t("selfTest.column.site")}</th>
              <th className="py-1 pr-2">{t("selfTest.column.https")}</th>
              <th className="py-1 pr-2">{t("selfTest.column.sitemapUrls")}</th>
              <th className="py-1 pr-2">{t("selfTest.column.launchTier")}</th>
              <th className="py-1 pr-2">{t("selfTest.column.downloadDir")}</th>
              <th className="py-1 pr-2">{t("selfTest.column.awesomeItems")}</th>
              {/* [F91 §E.2] the operator-requested columns. */}
              <th className="py-1 pr-2">{t("selfTest.column.search")}</th>
              <th className="py-1 pr-2">{t("selfTest.column.launcherQueue")}</th>
              <th className="py-1 pr-2">{t("selfTest.column.download")}</th>
              <th className="py-1 pr-2">{t("selfTest.column.streamProxy")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const ok = rowOk(row);
              const err = errText(row);
              return (
                <tr
                  key={row.site}
                  data-testid={"f87-selftest-row-" + row.site.replace(/[^a-z0-9]+/g, "-")}
                  data-ok={ok ? "1" : "0"}
                  title={err || undefined}
                  onClick={() => setOpen(open === row.site ? null : row.site)}
                  className={"border-t border-default cursor-pointer " + (ok ? "" : "bg-danger/10")}
                >
                  <td className="py-1 pr-2 text-primary">{row.site}</td>
                  <td className="py-1 pr-2" data-ok={cellOk(row, "https") ? "1" : "0"} title={cellOk(row, "https") ? undefined : err}>
                    <span className={cellOk(row, "https") ? "text-primary" : "text-danger"}>{mark(cellOk(row, "https"))}</span>
                  </td>
                  <td className="py-1 pr-2" data-ok={cellOk(row, "sitemapUrls") ? "1" : "0"} title={cellOk(row, "sitemapUrls") ? undefined : err}>
                    <span className={cellOk(row, "sitemapUrls") ? "text-primary" : "text-danger"}>
                      {cellOk(row, "sitemapUrls") ? row.sitemapUrls : mark(false) + " " + (row.sitemapUrls ?? 0)}
                    </span>
                  </td>
                  <td className="py-1 pr-2" data-ok={cellOk(row, "launchTier") ? "1" : "0"} title={cellOk(row, "launchTier") ? row.launchDetail : err}>
                    <span className={cellOk(row, "launchTier") ? "text-primary" : "text-danger"}>
                      {cellOk(row, "launchTier") ? row.launchTier : mark(false)}
                    </span>
                  </td>
                  <td className="py-1 pr-2" data-ok={cellOk(row, "downloadDir") ? "1" : "0"} title={cellOk(row, "downloadDir") ? row.downloadDir : err}>
                    <span className={cellOk(row, "downloadDir") ? "text-primary" : "text-danger"}>{mark(cellOk(row, "downloadDir"))}</span>
                  </td>
                  <td
                    className="py-1 pr-2"
                    data-testid={"f87-selftest-awesome-" + row.site.replace(/[^a-z0-9]+/g, "-")}
                    data-ok={cellOk(row, "awesomeItems") ? "1" : "0"}
                    title={row.site === "awesome.re" ? row.searchStrategy || err : undefined}
                  >
                    {row.site === "awesome.re" ? (
                      <span className={cellOk(row, "awesomeItems") ? "text-primary" : "text-danger"}>
                        {cellOk(row, "awesomeItems") ? row.networkingItemCount : mark(false) + " " + (row.networkingItemCount ?? 0)}
                      </span>
                    ) : (
                      <span className="text-tertiary" aria-hidden>—</span>
                    )}
                  </td>
                  <td className="py-1 pr-2" data-testid={"f91-selftest-search-" + row.site.replace(/[^a-z0-9]+/g, "-")} data-ok={cellOk(row, "search") ? "1" : "0"} title={row.searchStrategy || err}>
                    <F91Mark ok={cellOk(row, "search")} extra={typeof row.searchItems === "number" && row.searchItems > 0 ? row.searchItems : undefined} />
                  </td>
                  <td className="py-1 pr-2" data-testid={"f91-selftest-launcher-" + row.site.replace(/[^a-z0-9]+/g, "-")} data-ok={cellOk(row, "launcherQueue") ? "1" : "0"} title={row.launcherQueueNote || err}>
                    <F91Mark ok={cellOk(row, "launcherQueue")} />
                  </td>
                  <td className="py-1 pr-2" data-testid={"f91-selftest-download-" + row.site.replace(/[^a-z0-9]+/g, "-")} data-ok={cellOk(row, "download") ? "1" : "0"} title={row.downloadPath || err}>
                    <F91Mark ok={cellOk(row, "download")} extra={typeof row.downloadBytes === "number" && row.downloadBytes > 0 ? row.downloadBytes : undefined} />
                  </td>
                  <td className="py-1 pr-2" data-testid={"f91-selftest-stream-" + row.site.replace(/[^a-z0-9]+/g, "-")} data-ok={cellOk(row, "streamProxy") ? "1" : "0"} title={String(row.streamProxyStatus ?? "") || err}>
                    <F91Mark ok={cellOk(row, "streamProxy")} extra={row.streamProxyStatus ? row.streamProxyStatus : undefined} />
                  </td>
                </tr>
              );
            })}
            {rows.map((row) =>
              open === row.site && errText(row) ? (
                <tr key={row.site + "#detail"} data-testid={"f87-selftest-detail-" + row.site.replace(/[^a-z0-9]+/g, "-")}>
                  <td colSpan={10} className="py-1 pr-2 text-danger whitespace-pre-wrap">
                    {errText(row)}
                  </td>
                </tr>
              ) : null,
            )}
          </tbody>
        </table>
      ) : null}
    </section>
  );
}

export default F87SelfTestPanel;
