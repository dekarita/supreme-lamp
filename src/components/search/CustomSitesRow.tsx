// [F78 §3.1] "Your sites" - the stored-website row that sits ABOVE the public
// adapter results (mounted first in ResultsGrid, §3.2). One card per operator
// source; four visible, the rest reachable by horizontal scroll.
//
// [F81 §1.2/A.2 + §3.1/Q3] Each card now carries a per-card trash button +
// a confirm modal that names the site. DELETE /api/f58/sources/<id> is
// fired on confirm and the row updates optimistically with a rollback on
// failure.
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
import { FlaskConical, Globe, MoreHorizontal, Trash2 } from "lucide-react";
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
  const removeSite = useCustomSourcesStore((s) => s.removeSite);
  const rows = sources ?? fromStore;
  // §3.1 empty state: the row does not exist at all when there are no stored
  // sites - no placeholder card, no heading.
  const [brokenIcons, setBrokenIcons] = useState<Record<string, boolean>>({});
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const confirmRow = confirmId ? rows.find((r) => r.id === confirmId) : null;

  if (!rows.length) return null;

  const q = String(query || "").trim();

  const onConfirmDelete = async () => {
    if (!confirmRow) return;
    const targetId = confirmRow.id;
    setConfirmId(null);
    const outcome = await removeSite(targetId);
    if (!outcome.ok) {
      // No toast store available here directly; surface the error via a
      // browser-native alert so the operator can see the failure. The
      // optimistic removal only happens AFTER a successful DELETE, so a
      // failure naturally leaves the row in place.
      try { window.alert("Delete failed: " + outcome.error); } catch { }
    }
  };

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
                <button
                  id={"f81.customSites.delete." + s.id}
                  data-testid={"your-site-delete-" + s.id}
                  type="button"
                  aria-label={t("search.deleteSite.confirmLabel", { hostname: s.hostname })}
                  title={t("search.deleteSite.confirmLabel", { hostname: s.hostname })}
                  onClick={() => setConfirmId(s.id)}
                  className="ml-auto inline-flex items-center justify-center size-7 rounded text-tertiary hover:bg-danger/10 hover:text-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                >
                  <Trash2 className="size-3.5" aria-hidden />
                </button>
                <span className="inline-flex items-center gap-1 text-xs text-tertiary">
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

      {confirmRow ? (
        <div
          id="f81.customSites.deleteModal"
          data-testid="delete-site-modal"
          role="dialog"
          aria-modal="true"
          aria-labelledby="f81.customSites.deleteTitle"
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
        >
          <div className="absolute inset-0 bg-black/40" aria-hidden onClick={() => setConfirmId(null)} />
          <div className="relative bg-surface border border-default rounded-md shadow-md max-w-sm w-full p-4">
            <h3 id="f81.customSites.deleteTitle" className="text-sm font-semibold text-primary">
              {t("search.deleteSite.confirmTitle", { hostname: confirmRow.hostname })}
            </h3>
            <p id="f81.customSites.deleteBody" data-testid="delete-site-body" className="text-xs text-secondary mt-2">
              {t("search.deleteSite.confirmBody", { hostname: confirmRow.hostname })}
            </p>
            <div className="mt-3 flex justify-end gap-2">
              <button
                id="f81.customSites.deleteCancel"
                data-testid="delete-site-cancel"
                type="button"
                onClick={() => setConfirmId(null)}
                className="h-11 px-3 rounded-md border border-default text-sm text-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                {t("search.deleteSite.cancel")}
              </button>
              <button
                id="f81.customSites.deleteConfirm"
                data-testid="delete-site-confirm"
                type="button"
                onClick={() => void onConfirmDelete()}
                className="h-11 px-3 rounded-md font-medium text-white bg-danger hover:bg-danger/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                {t("search.deleteSite.confirm")}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}

export default CustomSitesRow;