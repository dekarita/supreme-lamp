// [F78 §3.1] "Your sites" - the stored-website row that sits ABOVE the public
// adapter results (mounted first in ResultsGrid, §3.2). One card per operator
// source; four visible, the rest reachable by horizontal scroll.
//
// Behaviour is intentionally bounded: a card navigates to the Lab inspector for
// that stored site (/search/lab/<sourceId>?q=<query>) and nothing else. There is
// no auto fan-out query for these sources (labMode sources are Lab shortcuts),
// no cross-domain follow, and no query is ever sent to a site the operator did
// not add. When the query is empty the CTA drops the injection and just opens
// the site in the Lab.
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { FlaskConical, Globe, MoreHorizontal } from "lucide-react";
import { useCustomSourcesStore } from "@/stores/customSourcesStore";
import type { CustomSourceRow } from "@/api/lab";

/** §3.1 four visible cards; the row scrolls horizontally beyond that. */
const CARD_WIDTH_PX = 232;

function LetterAvatar({ hostname }: { hostname: string }) {
  const letter = (hostname.charAt(0) || "?").toUpperCase();
  return (
    <span
      data-testid="site-avatar-letter"
      aria-hidden
      className="size-6 shrink-0 rounded bg-raised text-secondary text-xs leading-6 text-center font-semibold"
    >
      {letter}
    </span>
  );
}

export interface CustomSitesRowProps {
  query: string;
  sources?: CustomSourceRow[];
}

export function CustomSitesRow({ query, sources }: CustomSitesRowProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const fromStore = useCustomSourcesStore((s) => s.labSources);
  const rows = sources ?? fromStore;
  // §3.1 empty state: the row does not exist at all when there are no stored
  // sites - no placeholder card, no heading.
  const [brokenIcons, setBrokenIcons] = useState<Record<string, boolean>>({});

  if (!rows.length) return null;

  const q = String(query || "").trim();

  return (
    <section
      id="f78.search.yourSitesRow"
      data-testid="your-sites-row"
      aria-label={t("search.yourSites")}
      className="flex flex-col gap-2"
    >
      <h2 className="text-sm font-semibold text-primary">{t("search.yourSites")}</h2>
      <div className="flex gap-2 overflow-x-auto pb-1" data-testid="your-sites-scroll">
        {rows.map((s) => {
          const href = "/search/lab/" + encodeURIComponent(s.id) + (q ? "?q=" + encodeURIComponent(q) : "");
          const cta = q ? t("search.deepInspect", { query: q, hostname: s.hostname }) : t("search.openInLabSite", { hostname: s.hostname });
          return (
            <article
              key={s.id}
              id={"f78.search.siteCard." + s.id}
              data-testid={"your-site-card-" + s.id}
              style={{ width: CARD_WIDTH_PX }}
              className="shrink-0 rounded-md border border-default bg-surface p-3 flex flex-col gap-2"
            >
              <div className="flex items-center gap-2 min-w-0">
                {brokenIcons[s.id] || !s.hostname ? (
                  <LetterAvatar hostname={s.hostname || s.id} />
                ) : (
                  <img
                    data-testid={"your-site-favicon-" + s.id}
                    src={s.baseUrl.replace(/\/+$/, "") + "/favicon.ico"}
                    alt=""
                    width={24}
                    height={24}
                    className="size-6 shrink-0 rounded"
                    onError={() => setBrokenIcons((prev) => ({ ...prev, [s.id]: true }))}
                  />
                )}
                <span className="text-sm font-semibold text-primary truncate" title={s.hostname}>
                  {s.hostname}
                </span>
                <span className="ml-auto inline-flex items-center gap-1 text-xs text-tertiary">
                  <Globe className="size-3" aria-hidden />
                  {t("search.labMode.badge")}
                </span>
              </div>

              <button
                id={"f78.search.siteDeepInspect." + s.id}
                data-testid={"your-site-cta-" + s.id}
                type="button"
                onClick={() => navigate(href)}
                className="h-11 rounded-md border border-default text-xs text-secondary hover:bg-raised text-left px-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                {cta}
              </button>

              <button
                id={"f78.search.siteOpenLab." + s.id}
                data-testid={"your-site-open-lab-" + s.id}
                type="button"
                onClick={() => navigate("/search/lab/" + encodeURIComponent(s.id) + (q ? "?q=" + encodeURIComponent(q) : ""))}
                className="h-11 rounded-md border border-default text-xs text-secondary hover:bg-raised inline-flex items-center justify-center gap-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                <MoreHorizontal className="size-3.5" aria-hidden />
                <FlaskConical className="size-3" aria-hidden />
                {t("search.lab.openInLab")}
              </button>
            </article>
          );
        })}
      </div>
    </section>
  );
}

export default CustomSitesRow;
