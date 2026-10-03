// [F71 §D#5 / F74] Explicit-entry Lab landing page. It displays in-memory
// result context only; no inspection, fetch, or provider request runs on mount.
import { useTranslation } from "react-i18next";
import { useNavigate, useParams } from "react-router-dom";
import { useSearchStore } from "@/stores/searchStore";

export function SearchLabPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { targetId = "" } = useParams();
  const result = useSearchStore((state) => state.results[targetId]);

  return (
    <section
      id="f74.search.lab"
      data-testid="search-lab-page"
      aria-labelledby="f74.search.labTitle"
      className="flex flex-col gap-4 rounded-md border border-default bg-surface p-4"
    >
      <div>
        <h1 id="f74.search.labTitle" className="text-lg font-semibold text-primary">{t("search.lab.title")}</h1>
        <p className="mt-1 text-sm text-secondary">{t("search.lab.placeholder")}</p>
      </div>
      <div className="rounded-md border border-default bg-base p-3">
        <p className="text-xs text-tertiary">{t("search.lab.target")}</p>
        <code className="break-all text-sm text-primary">{result?.title || targetId}</code>
        {!result ? <p className="mt-2 text-xs text-secondary">{t("search.lab.notFound")}</p> : null}
      </div>
      <div>
        <button
          id="f74.search.labBack"
          type="button"
          onClick={() => navigate("/search")}
          className="h-11 rounded-md border border-default px-3 text-xs text-secondary hover:bg-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          {t("search.lab.back")}
        </button>
      </div>
    </section>
  );
}
