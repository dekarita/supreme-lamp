// [F78 §4.2] The stored-website Lab inspector (replaces the F74 placeholder for
// Lab Mode sources; the legacy result-id view in Lab.tsx is untouched).
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
import { ArrowLeft, ExternalLink, FlaskConical, RefreshCw } from "lucide-react";
import { inspectSource, type CustomSourceRow, type LabError, type LabInspectResult } from "@/api/lab";

const ERROR_KEYS: Record<string, string> = {
  RATE_LIMITED: "lab.rateLimited",
  TIMEOUT: "lab.timeout",
  SIZE_LIMIT: "lab.sizeLimit",
  HOSTNAME_MISMATCH: "lab.hostnameMismatch",
  NOT_FOUND: "lab.notFound",
  TRANSPORT_UNAVAILABLE: "lab.timeout",
};

export interface LabInspectorProps {
  source: CustomSourceRow;
  query: string;
}

export function LabInspector({ source, query }: LabInspectorProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [data, setData] = useState<LabInspectResult | null>(null);
  const [error, setError] = useState<LabError | null>(null);
  const [loading, setLoading] = useState(false);
  const [matchesFirst, setMatchesFirst] = useState(true);
  const [allOpen, setAllOpen] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const alive = useRef(true);

  const q = String(query || "").trim();

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await inspectSource(source.id, q);
    if (!alive.current) return;
    setLoading(false);
    if (res.ok) {
      setData(res.data);
      return;
    }
    setError(res.error);
    if (res.error.code === "RATE_LIMITED") setCooldown(Math.max(1, res.error.retryAfterSeconds ?? 60));
  }, [source.id, q]);

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

  const links = data?.links ?? [];
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
          {data?.title || source.name || source.hostname}
        </h1>
        <span id="f78.lab.hostname" data-testid="lab-hostname" className="text-xs font-mono text-tertiary">
          {data?.hostname || source.hostname}
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

      <p id="f78.lab.query" data-testid="lab-query-echo" className="text-xs text-secondary">
        {t("lab.query")}: <span className="font-mono text-primary">{q || "—"}</span>
        {data ? (
          <span id="f78.lab.matchCount" data-testid="lab-match-count" className="ml-2">
            {t("lab.matchCount", { matches: data.matchCount, total: data.linkCount, query: q })}
          </span>
        ) : null}
      </p>

      {cooldown > 0 ? (
        <p id="f78.lab.rateLimited" data-testid="lab-rate-limited" role="status" className="text-xs text-warning">
          {t("lab.rateLimited", { seconds: cooldown })}
        </p>
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
                <a
                  id={"f78.lab.linkOpen." + i}
                  data-testid="lab-link-open"
                  href={l.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={t("lab.openInNewTab") + ": " + (l.text || l.href)}
                  className="ml-auto shrink-0 text-xs text-secondary hover:text-primary inline-flex items-center gap-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded px-1"
                >
                  <ExternalLink className="size-3" aria-hidden />
                  {t("lab.openInNewTab")}
                </a>
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
