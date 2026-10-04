// [F79 D2/D4] Honest, query-specific states; adapter diagnostics never live here.
import { Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";

export function LoadingState() {
  const { t } = useTranslation();
  return (
    <div id="f56.search.resultsLoading" data-testid="results-loading" role="status" aria-live="polite" className="flex justify-center items-center gap-3 py-12 text-sm text-secondary">
      <Loader2 data-testid="search-spinner" className="size-5 animate-spin motion-reduce:animate-none" aria-hidden />
      <span>{t("search.loading")}</span>
    </div>
  );
}

export function EmptyState({ query, onAddSite }: { query: string; onAddSite: () => void }) {
  const { t } = useTranslation();
  return (
    <div id="f56.search.resultsEmpty" data-testid="results-empty" role="status" aria-live="polite" className="py-12 text-sm text-secondary text-center">
      <p>{t("search.noResults", { query })}</p>
      <button id="f79.search.addCustomSite" data-testid="add-custom-site-button" type="button" onClick={onAddSite} className="mt-3 min-h-11 px-3 rounded-md text-sm text-secondary hover:bg-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
        {t("search.addCustomSite")}
      </button>
    </div>
  );
}
