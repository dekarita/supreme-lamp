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
  errors?: string[];
}

export interface SelfTestResponse {
  ok?: boolean;
  ranAt?: string;
  total?: number;
  passed?: number;
  results?: SelfTestRow[];
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
export function cellOk(row: SelfTestRow, col: "https" | "sitemapUrls" | "launchTier" | "downloadDir"): boolean {
  if (col === "https") return row.probeOk === true;
  if (col === "sitemapUrls") return typeof row.sitemapUrls === "number" && row.sitemapUrls > 0;
  if (col === "launchTier") return row.launchOk === true && typeof row.launchTier === "number" && row.launchTier >= 1 && row.launchTier <= 3;
  return row.downloadDirOk === true;
}

export function rowOk(row: SelfTestRow): boolean {
  return cellOk(row, "https") && cellOk(row, "sitemapUrls") && cellOk(row, "launchTier") && cellOk(row, "downloadDir");
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
                </tr>
              );
            })}
            {rows.map((row) =>
              open === row.site && errText(row) ? (
                <tr key={row.site + "#detail"} data-testid={"f87-selftest-detail-" + row.site.replace(/[^a-z0-9]+/g, "-")}>
                  <td colSpan={5} className="py-1 pr-2 text-danger whitespace-pre-wrap">
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
