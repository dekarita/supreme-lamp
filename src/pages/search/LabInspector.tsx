// [F78 §4.2/F86 §B.2] The deep Lab inspector. It serves TWO shapes with ONE
// renderer, which is the whole point of F86 §B.2:
//   * a stored Lab Mode source  -> inspectSource(source.id, query)
//   * a RESULT (result-id route) -> inspectResultUrl(result.sourceUrl, query)
// The F74/F75 placeholder ("Full inspector coming in F75") is gone: a result-id
// navigation now runs the same deep-inspector pipeline over the result's own
// sourceUrl and shows the same link list, header and refetch affordance.
//
// What it is allowed to do: ask the server to fetch the STORED homepage of ONE
// operator-added site and show the links that came back. Default posture:
//   * "Matches first" ON - links whose text or href contains the query are
//     listed first and highlighted; everything else stays behind the collapsed
//     "All N links" section, so a 180-link homepage is readable at a glance;
//   * every row is an explicit new-tab link (target=_blank +
//     rel="noopener noreferrer") - the Lab never navigates this app away;
//   * Refetch is the ONLY repeating call and it respects the server's
//     10-fetches/minute-per-source budget: a 429 switches the button into a
//     visible countdown instead of hammering the route.
// Error states are the server's own codes (TIMEOUT / SIZE_LIMIT /
// HOSTNAME_MISMATCH / NOT_FOUND) plus the shared rate-limit code.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { ArrowLeft, Download, ExternalLink, FlaskConical, RefreshCw } from "lucide-react";
import { inspectResultUrl, inspectSource, type CustomSourceRow, type LabError, type LabInspectResult } from "@/api/lab";
// [F91 §B.2/§C.2] mirror open + the "Open in RDP File Explorer" toast action.
import { dirnameWindows, openMirrored, queueLauncherJob } from "@/lib/launchUrl";
import { requestFetch } from "@/lib/fetchStub";
import { isFileLikeUrl } from "./tokens";
// [F91 §D.3] media rows in the Lab list gain the SAME smart-streaming control
// the result cards show (inline audio via /api/stream, Watch-in-RDP buttons).
import { hasMediaRoute } from "@/lib/streamRouter";
import { StreamCard } from "@/components/search/StreamCard";
import { useToastStore } from "@/stores/toastStore";

const ERROR_KEYS: Record<string, string> = {
  RATE_LIMITED: "lab.rateLimited",
  TIMEOUT: "lab.timeout",
  SIZE_LIMIT: "lab.sizeLimit",
  HOSTNAME_MISMATCH: "lab.hostnameMismatch",
  NOT_FOUND: "lab.notFound",
  TRANSPORT_UNAVAILABLE: "lab.timeout",
};

/** [F86 §B.2] What a result-id navigation hands the inspector: the title and
 *  adapter of the result plus the URL to inspect. */
export interface LabResultTarget {
  title: string;
  sourceUrl: string;
  adapterKey: string;
}

/** Exactly one of `source` (stored site) or `result` (result-id route). */
export type LabInspectorProps =
  | { source: CustomSourceRow; result?: undefined; query: string }
  | { result: LabResultTarget; source?: undefined; query: string };

export function LabInspector(props: LabInspectorProps) {
  const query = props.query;
  const source = props.source;
  const result = props.result;
  const { t } = useTranslation();
  const navigate = useNavigate();
  const push = useToastStore((s) => s.push);
  const [data, setData] = useState<LabInspectResult | null>(null);
  const [error, setError] = useState<LabError | null>(null);
  const [loading, setLoading] = useState(false);
  const [matchesFirst, setMatchesFirst] = useState(true);
  const [allOpen, setAllOpen] = useState(false);
  const [activeSet, setActiveSet] = useState(0); // [F88 §A.3] source tab
  const [cooldown, setCooldown] = useState(0);
  const alive = useRef(true);

  const q = String(query || "").trim();

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    // [F86 §B.2] result-id -> the result's sourceUrl IS the inspected target.
    const res = source
      ? await inspectSource(source.id, q)
      : await inspectResultUrl(result ? result.sourceUrl : "", q);
    if (!alive.current) return;
    setLoading(false);
    if (res.ok) {
      setData(res.data);
      setActiveSet(0);
      return;
    }
    setError(res.error);
    if (res.error.code === "RATE_LIMITED") setCooldown(Math.max(1, res.error.retryAfterSeconds ?? 60));
  }, [source ? source.id : "", result ? result.sourceUrl : "", q]);

  useEffect(() => {
    alive.current = true;
    void load();
    return () => {
      alive.current = false;
    };
  }, [load]);

  // §4.2 the 429 countdown: one tick per second, clamped at zero.
  useEffect(() => {
    if (cooldown <= 0) return;
    const id = window.setInterval(() => setCooldown((n) => (n <= 1 ? 0 : n - 1)), 1000);
    return () => window.clearInterval(id);
  }, [cooldown]);

  // [F88 §A.3] When the payload carries sourceSets, the visible list is the
  // ACTIVE tab's rows; otherwise the primary links (byte-compatible with F86).
  const sets = data?.sourceSets ?? [];
  const active = sets.length > 0 && activeSet < sets.length ? sets[activeSet] : null;
  const links = active ? active.links : data?.links ?? [];
  const matches = useMemo(() => links.filter((l) => l.matches), [links]);
  const others = useMemo(() => links.filter((l) => !l.matches), [links]);
  // §4.2 "Matches first" ON = the list IS the matching set; the rest of the
  // homepage stays behind the collapsed "All N links" section. OFF = the whole
  // homepage in server order.
  const visible = matchesFirst ? matches : links;
  const errorKey = error ? ERROR_KEYS[error.code] || "search.errors.generic" : null;

  return (
    <section id="f78.lab.root" data-testid="lab-inspector" className="w-full max-w-4xl mx-auto p-4 flex flex-col gap-3">
      <button
        id="f78.lab.back"
        data-testid="lab-back"
        type="button"
        onClick={() => navigate("/search")}
        className="h-11 px-3 rounded-md border border-default text-xs text-secondary hover:bg-raised inline-flex items-center gap-1.5 w-fit focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        <ArrowLeft className="size-3.5" aria-hidden />
        {t("search.lab.backToResults")}
      </button>

      <header className="flex flex-wrap items-center gap-2">
        <FlaskConical className="size-4 text-secondary" aria-hidden />
        <h1 id="f78.lab.title" data-testid="lab-site-title" className="text-base font-semibold text-primary truncate">
          {data?.title || (source ? source.name || source.hostname : result ? result.title : "")}
        </h1>
        <span id="f78.lab.hostname" data-testid="lab-hostname" className="text-xs font-mono text-tertiary">
          {data?.hostname || (source ? source.hostname : "")}
        </span>
        <button
          id="f78.lab.refetch"
          data-testid="lab-refetch"
          type="button"
          disabled={loading || cooldown > 0}
          onClick={() => void load()}
          className="ml-auto h-11 px-3 rounded-md border border-default text-xs text-secondary hover:bg-raised disabled:opacity-50 inline-flex items-center gap-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          <RefreshCw className={"size-3.5" + (loading ? " animate-spin" : "")} aria-hidden />
          {t("lab.refetch")}
        </button>
      </header>

      {result ? (
        <p id="f86.lab.resultContext" data-testid="lab-result-context" className="text-xs text-secondary">
          {t("lab.resultContext", { title: result.title, adapter: t(result.adapterKey) })}
        </p>
      ) : null}

      <p id="f78.lab.query" data-testid="lab-query-echo" className="text-xs text-secondary">
        {t("lab.query")}: <span className="font-mono text-primary">{q || "—"}</span>
        {data ? (
          <span id="f78.lab.matchCount" data-testid="lab-match-count" className="ml-2">
            {t("lab.matchCount", { matches: data.matchCount, total: data.linkCount, query: q })}
          </span>
        ) : null}
        {data && (data as any).source ? (
          <span id="f78.lab.source" data-testid="lab-source" className="ml-2 text-tertiary">
            {t("lab.source", { source: (data as any).source, count: (data as any).sourceUrls || data.linkCount })}
          </span>
        ) : null}
        {/* [F88 §A.3] the visible Source line: strategy + results + timing. */}
        {data && (data as any).sourceDisplay ? (
          <span id="f78.lab.sourceLine" data-testid="lab-source-line" className="ml-2 text-tertiary">
            {t("lab.sourceLine", {
              source: (data as any).sourceDisplay,
              count: (data as any).sourceUrls || data.linkCount,
              seconds: (((data as any).tookMs ?? 0) / 1000).toFixed(1),
            })}
          </span>
        ) : null}
        {/* [F90 §B.2] markdown-section names the REAL source. awesome.re is a
            redirect service: its content is the sindresorhus/awesome README on
            raw.githubusercontent.com, so "Source: <host> README" would be a lie
            and the cross-domain read used to be reported as a hostname error.
            This line states the repo and the item count instead - and because
            the strategy is the reason the read is cross-domain, it is never
            rendered as a red "different hostname" failure. */}
        {data && (data as any).sourceStrategy === "markdown-section" ? (
          <span
            id="f78.lab.sourceCrossDomain"
            data-testid="lab-source-cross-domain"
            data-repo={(data as any).sourceRepo || ""}
            data-items={String((data as any).sourceItemCount ?? 0)}
            className="ml-2 text-secondary"
          >
            {t("lab.sourceCrossDomain", {
              repo: (data as any).sourceRepo || "unknown/repo",
              count: (data as any).sourceItemCount ?? 0,
              section: (data as any).sourceDisplay || "",
            })}
          </span>
        ) : null}
      </p>

      {cooldown > 0 ? (
        <p id="f78.lab.rateLimited" data-testid="lab-rate-limited" role="status" className="text-xs text-warning">
          {t("lab.rateLimited", { seconds: cooldown })}
        </p>
      ) : null}

      {/* [F88 §A.3] one tab per source actually fetched (>= 2 only). */}
      {sets.length > 1 ? (
        <div id="f78.lab.sourceTabs" data-testid="lab-source-tabs" className="flex flex-wrap gap-2" role="tablist">
          {sets.map((st, i) => (
            <button
              key={st.key + "#" + i}
              type="button"
              role="tab"
              aria-selected={i === activeSet}
              data-testid="lab-source-tab"
              data-active={i === activeSet ? "true" : "false"}
              onClick={() => setActiveSet(i)}
              className={
                "h-9 px-2.5 rounded-md border text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent " +
                (i === activeSet ? "border-accent bg-accent/10 text-primary" : "border-default text-secondary hover:bg-raised")
              }
            >
              {st.label} ({st.count})
            </button>
          ))}
        </div>
      ) : null}

      {loading && !data ? (
        <p id="f78.lab.loading" data-testid="lab-loading" className="text-sm text-secondary">
          {t("lab.loading")}
        </p>
      ) : null}

      {errorKey ? (
        <p id="f78.lab.error" data-testid="lab-error" role="alert" className="text-sm text-danger bg-danger/10 rounded p-3">
          {t(errorKey, { seconds: cooldown })}
        </p>
      ) : null}

      {data ? (
        <>
          <label id="f78.lab.matchesFirstLabel" className="flex items-center gap-2 text-xs text-secondary w-fit">
            <input
              id="f78.lab.matchesFirst"
              data-testid="lab-matches-first"
              type="checkbox"
              checked={matchesFirst}
              onChange={(e) => setMatchesFirst(e.target.checked)}
            />
            {t("lab.matchesFirst")}
          </label>

          <ul id="f78.lab.list" data-testid="lab-link-list" className="flex flex-col divide-y divide-default">
            {visible.map((l, i) => (
              <li
                key={l.href + "#" + i}
                id={"f78.lab.link." + i}
                data-testid="lab-link-row"
                data-matches={l.matches ? "true" : "false"}
                className={"py-2 flex items-center gap-2 " + (l.matches ? "bg-accent/10 rounded" : "")}
              >
                <span className="text-sm text-primary truncate">{l.text || l.href}</span>
                <span className="text-xs font-mono text-tertiary truncate" title={l.href}>
                  {l.href}
                </span>
                {/* [F88 §C.3] file-ish URLs get a one-click Download to RDP
                    (the F56-d download=true lane) next to the open button. */}
                {isFileLikeUrl(l.href) ? (
                  <button
                    id={"f88.lab.linkDownload." + i}
                    data-testid="lab-link-download"
                    type="button"
                    title={t("download.toRdp")}
                    aria-label={t("download.toRdp") + ": " + (l.text || l.href)}
                    onClick={async () => {
                      try {
                        const out = await requestFetch({
                          operation: "start",
                          requestId: Math.random().toString(36).slice(2, 12),
                          idempotencyKey: Math.random().toString(36).slice(2, 12),
                          adapterId: "lab",
                          sourceSnapshotId: "lab-f88",
                          intent: "download",
                          transport: "https",
                          mirrorOptIn: false,
                          urlImport: { url: l.href },
                          download: true,
                        } as any);
                        const p = (out.data as any)?.path;
                        if (out.ok && typeof p === "string")
                          // [F91 §C.2] the same actionable download toast as the cards.
                          push(t("download.success", { path: p }), "ok", {
                            label: t("mirror.openInExplorer"),
                            onClick: () => void queueLauncherJob(dirnameWindows(p), "explorer", String(p).split(/[\\/]/).pop() || ""),
                          });
                        else push(t("download.failed", { reason: out.error?.messageKey || out.error?.code || "transport" }));
                      } catch {
                        push(t("download.failed", { reason: "transport" }));
                      }
                    }}
                    className="ml-auto shrink-0 h-8 px-2 rounded-md border border-default text-xs text-secondary hover:bg-raised inline-flex items-center gap-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                  >
                    <Download className="size-3" aria-hidden />
                    {t("download.toRdp")}
                  </button>
                ) : null}
                {/* [F91 §B.2] Button, not a new-tab anchor (F84 rule kept).
                    The click itself is MIRROR MODE now: the local tab is the
                    design, /api/launcher/queue mirrors it into the RDP session,
                    and a dead launcher degrades to an info line - never the
                    retired "could not open" error. */}
                <button
                  id={"f78.lab.linkOpen." + i}
                  data-testid="lab-link-open"
                  type="button"
                  onClick={async () => {
                    await openMirrored(l.href, { push, t });
                  }}
                  aria-label={t("lab.openInNewTab") + ": " + (l.text || l.href)}
                  className="ml-auto shrink-0 text-xs text-secondary hover:text-primary inline-flex items-center gap-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded px-1"
                >
                  <ExternalLink className="size-3" aria-hidden />
                  {t("lab.openInNewTab")}
                </button>
                {hasMediaRoute(l.href) ? (
                  <StreamCard url={l.href} title={l.text} suffix={"lab" + i} />
                ) : null}
              </li>
            ))}
          </ul>

          {/* §4.2 non-matching links live behind this collapsed section. */}
          <div className="flex flex-col gap-2">
            <button
              id="f78.lab.allLinks"
              data-testid="lab-all-links-toggle"
              type="button"
              aria-expanded={allOpen}
              onClick={() => setAllOpen((v) => !v)}
              className="h-11 px-3 rounded-md border border-default text-xs text-secondary hover:bg-raised w-fit focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              {t("lab.allLinks", { total: data.linkCount })}
            </button>
            {allOpen ? (
              <ul id="f78.lab.allLinksList" data-testid="lab-all-links-list" className="flex flex-col text-xs font-mono text-tertiary">
                {others.map((l, i) => (
                  <li key={l.href + "#other" + i} className="truncate">
                    {l.href}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        </>
      ) : null}
    </section>
  );
}

export default LabInspector;
