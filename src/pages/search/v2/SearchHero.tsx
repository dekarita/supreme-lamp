// [F56-c v2] Google-style landing: a sub-line under the centered bar and three
// QUIET chips (Recent | Own Storage | Paste URL). Quiet means genuinely quiet -
// muted pills, no chip row of filters, no size cap (those live behind the
// collapsed "Advanced ⋯" disclosure). All state is session-only.
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Clock, HardDrive, Link2 } from "lucide-react";
import { useSearchStore } from "@/stores/searchStore";
import { useSearchUiStore } from "@/stores/searchUiStore";

export function SearchHero() {
  const { t } = useTranslation();
  const recent = useSearchUiStore((s) => s.recentQueries);
  const importMode = useSearchUiStore((s) => s.importMode);
  const setImportMode = useSearchUiStore((s) => s.setImportMode);
  const rememberQuery = useSearchUiStore((s) => s.rememberQuery);
  const scope = useSearchStore((s) => s.scope);
  const setScope = useSearchStore((s) => s.setScope);
  const setQuery = useSearchStore((s) => s.setQuery);
  const [showRecent, setShowRecent] = useShowRecent();

  const ownStorage = scope === "own-storage";

  return (
    <div className="w-full flex flex-col items-center gap-3">
      <p id="f56.search.v2.heroSubline" data-testid="hero-subline" className="text-sm text-secondary text-center max-w-2xl">
        {t("search.v2.hero.subline")}
      </p>

      <div id="f56.search.v2.quietChips" role="group" aria-label={t("search.v2.hero.quietChips")} className="flex items-center gap-2">
        <button
          id="f56.search.v2.quietChipRecent"
          type="button"
          data-testid="quiet-chip-recent"
          aria-expanded={showRecent}
          aria-pressed={showRecent}
          onClick={() => setShowRecent(!showRecent)}
          className="inline-flex items-center gap-1.5 h-9 px-3 rounded-full border border-default bg-transparent text-xs text-tertiary hover:text-secondary hover:bg-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          <Clock className="size-3.5" aria-hidden />
          {t("search.v2.hero.chip.recent")}
        </button>
        <button
          id="f56.search.v2.quietChipOwnStorage"
          type="button"
          data-testid="quiet-chip-own-storage"
          aria-pressed={ownStorage}
          onClick={() => setScope(ownStorage ? "federated" : "own-storage")}
          className="inline-flex items-center gap-1.5 h-9 px-3 rounded-full border border-default bg-transparent text-xs text-tertiary hover:text-secondary hover:bg-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          <HardDrive className="size-3.5" aria-hidden />
          {ownStorage ? t("search.v2.hero.chip.ownStorageOn") : t("search.v2.hero.chip.ownStorage")}
        </button>
        <button
          id="f56.search.v2.quietChipPasteUrl"
          type="button"
          data-testid="quiet-chip-paste-url"
          aria-pressed={importMode}
          onClick={() => {
            setImportMode(true);
            document.getElementById("f56.search.query")?.focus();
          }}
          className="inline-flex items-center gap-1.5 h-9 px-3 rounded-full border border-default bg-transparent text-xs text-tertiary hover:text-secondary hover:bg-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          <Link2 className="size-3.5" aria-hidden />
          {t("search.v2.hero.chip.pasteUrl")}
        </button>
      </div>

      {showRecent ? (
        <div id="f56.search.v2.recentList" data-testid="recent-list" aria-label={t("search.v2.hero.recent.label")} className="w-full max-w-xl bg-surface border border-default rounded-md p-2 flex flex-col gap-1">
          {recent.length === 0 ? (
            <p className="text-xs text-tertiary px-2 py-1">{t("search.v2.hero.recent.empty")}</p>
          ) : (
            recent.map((q, i) => (
              <button
                key={q}
                id={"f56.search.v2.recentItem." + String(i)}
                type="button"
                data-testid="recent-item"
                onClick={() => {
                  setQuery(q);
                  rememberQuery(q);
                  document.getElementById("f56.search.query")?.focus();
                }}
                className="h-11 px-2 rounded-md text-left text-sm text-secondary hover:bg-raised truncate focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                {q}
              </button>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}

// Local disclosure state for the quiet Recent chip (component-local: it is a
// transient peek, never a contract field).
function useShowRecent(): [boolean, (v: boolean) => void] {
  return useState(false);
}
