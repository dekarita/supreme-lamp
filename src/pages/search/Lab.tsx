// [F78 §4.2] Lab Mode entry point. Two shapes share this route:
//   * /search/lab/<resultId>            - the F72/F74 result-metadata view below
//     (kept byte-for-byte; it is the "Open in Lab" target of a public result);
//   * /search/lab/<sourceId>?q=<query>  - F78: the STORED-site inspector for an
//     operator-added Lab Mode source (src/pages/search/LabInspector.tsx), which
//     fetches that one site's homepage through POST /api/lab/inspect and lists
//     the links matching the query.
// The route decides by DATA, not by URL shape: a stored source id renders the
// inspector, a known result id renders the metadata view, neither renders the
// not-found notice. No auto fan-out query is issued for a stored site.
import { useEffect, useMemo, useState } from "react";
import { useParams, useNavigate, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ArrowLeft } from "lucide-react";
import { useSearchStore } from "@/stores/searchStore";
import { useCustomSourcesStore } from "@/stores/customSourcesStore";
import { LabInspector } from "./LabInspector";
import { validatedHttpsUrl, fileExtension, formatActualBytes, licenceStyle, camel } from "@/pages/search/tokens";

export default function Lab() {
  const { targetId } = useParams<{ targetId: string }>();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const results = useSearchStore((s) => s.results);

  const decodedId = targetId ? decodeURIComponent(targetId) : "";
  const r = decodedId ? results[decodedId] : null;
  const labSources = useCustomSourcesStore((s) => s.labSources);
  const refreshSources = useCustomSourcesStore((s) => s.refresh);
  const [sourcesReady, setSourcesReady] = useState(false);
  const [params] = useSearchParams();
  const q = params.get("q") || "";

  // A deep link (or a page reload) must be able to resolve a sourceId without a
  // prior visit to the search page, so the registry is pulled once here too.
  useEffect(() => {
    let live = true;
    void refreshSources().finally(() => {
      if (live) setSourcesReady(true);
    });
    return () => {
      live = false;
    };
  }, [refreshSources]);

  const source = useMemo(() => (decodedId ? labSources.find((s) => s.id === decodedId) : undefined), [labSources, decodedId]);

  if (!r && source) return <LabInspector source={source} query={q} />;

  if (!r && !source && !sourcesReady) {
    return (
      <div id="f78.lab.loading" data-testid="lab-loading" className="w-full max-w-4xl mx-auto p-6 text-sm text-secondary">
        {t("lab.loading")}
      </div>
    );
  }

  const directUrl = r ? validatedHttpsUrl(r.sourceUrl) : "";
  const ext = r ? fileExtension(r) : null;

  return (
    <div className="w-full max-w-4xl mx-auto p-6 flex flex-col gap-4">
      <button
        id="f56.search.lab.backButton"
        data-testid="lab-back-button"
        type="button"
        onClick={() => navigate("/search")}
        className="h-11 px-3 rounded-md border border-default text-xs text-secondary hover:bg-raised inline-flex items-center gap-1.5 w-fit focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        <ArrowLeft className="size-3.5" aria-hidden />
        {t("search.lab.backToResults")}
      </button>

      <h1 id="f56.search.lab.title" className="text-lg font-semibold text-primary">
        {t("search.lab.title")}
      </h1>

      <p className="text-sm text-tertiary">{t("search.lab.comingSoon")}</p>

      {r ? (
        <div
          id="f56.search.lab.metadata"
          data-testid="lab-metadata"
          className="rounded-md border border-default bg-surface p-4 flex flex-col gap-3"
        >
          <div className="flex items-center gap-2 flex-wrap">
            <span className="rounded bg-raised px-2 py-0.5 text-xs text-secondary">{t(r.nameKey)}</span>
            <span className={"rounded px-2 py-0.5 text-xs font-medium " + licenceStyle(r.licenceTag)}>
              {t("search.filters.licence." + camel(r.licenceTag))}
            </span>
            {ext ? (
              <span className="rounded bg-raised px-1.5 py-0.5 font-mono text-xs text-tertiary">.{ext}</span>
            ) : null}
          </div>

          <h2 className="text-base font-semibold text-primary">{r.title}</h2>

          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
            <dt className="text-tertiary">{t("search.lab.adapter")}</dt>
            <dd className="text-primary">{t(r.nameKey)}</dd>
            <dt className="text-tertiary">{t("search.lab.category")}</dt>
            <dd className="text-primary">{t("search.filters.category." + camel(r.category))}</dd>
            {r.creator ? (
              <>
                <dt className="text-tertiary">{t("search.results.creator")}</dt>
                <dd className="text-primary">{r.creator}</dd>
              </>
            ) : null}
            {r.date ? (
              <>
                <dt className="text-tertiary">{t("search.lab.date")}</dt>
                <dd className="text-primary font-mono">{r.date}</dd>
              </>
            ) : null}
            {r.mimeType ? (
              <>
                <dt className="text-tertiary">{t("search.lab.mimeType")}</dt>
                <dd className="text-primary font-mono">{r.mimeType}</dd>
              </>
            ) : null}
            {r.sizeBytes != null ? (
              <>
                <dt className="text-tertiary">{t("search.lab.size")}</dt>
                <dd className="text-primary font-mono">{formatActualBytes(r.sizeBytes)}</dd>
              </>
            ) : null}
            <dt className="text-tertiary">{t("search.lab.sourceUrl")}</dt>
            <dd className="text-primary font-mono truncate">
              {directUrl ? (
                <a href={directUrl} target="_blank" rel="noopener noreferrer nofollow" className="text-accent underline-offset-2 hover:underline">
                  {directUrl}
                </a>
              ) : (
                <span className="text-warning">{t("search.v2.card.urlWithheld")}</span>
              )}
            </dd>
          </dl>
        </div>
      ) : (
        <div id="f78.lab.notFound" data-testid="lab-not-found" className="rounded-md border border-default bg-surface p-4 text-sm text-tertiary">
          {decodedId && sourcesReady ? t("lab.notFound") : t("search.errors.unknownSource")}
        </div>
      )}
    </div>
  );
}