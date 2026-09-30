// [F56-c v2] Google-style command bar. ONE input element serves both modes:
// the landing bar is centered, ~60% of the viewport wide and 64px tall with
// autofocus; on submit the same element animates center -> top (a transition
// on the hero container, latched by searchUiStore.animating) and the results
// view renders beneath it. Typing still updates local state only (decisions.md
// A2) - fan-out happens on Enter / explicit Search only.
//
// The visible surface is deliberately bare (brief §2): no filter chips and no
// size cap. The "Advanced ⋯" toggle discloses the frozen F56-c filter id set
// (category/licence chips, size slider, sort, scope, reset) plus the v2
// adapter selection; collapsed means the panel is `hidden`, so the ids stay in
// the DOM exactly once while nothing is visible.
import { useTranslation } from "react-i18next";
import { MoreHorizontal, Search as SearchIcon, X } from "lucide-react";
import { useSearchStore } from "@/stores/searchStore";
import { hostOf, useSearchUiStore } from "@/stores/searchUiStore";
import { AdvancedPanel } from "./v2/AdvancedPanel";

export { camel, licenceStyle } from "@/pages/search/tokens";

export function CommandBar({ onAnimationEnd }: { onAnimationEnd?: () => void } = {}) {
  const { t } = useTranslation();
  const rawQuery = useSearchStore((s) => s.rawQuery);
  const inputKind = useSearchStore((s) => s.inputKind);
  const phase = useSearchStore((s) => s.phase);
  const setQuery = useSearchStore((s) => s.setQuery);
  const clearQuery = useSearchStore((s) => s.clearQuery);
  const submit = useSearchStore((s) => s.submit);
  const view = useSearchUiStore((s) => s.view);
  const animating = useSearchUiStore((s) => s.animating);
  const advancedOpen = useSearchUiStore((s) => s.advancedOpen);
  const toggleAdvanced = useSearchUiStore((s) => s.toggleAdvanced);
  const importMode = useSearchUiStore((s) => s.importMode);
  const setImportMode = useSearchUiStore((s) => s.setImportMode);
  const openCredModal = useSearchUiStore((s) => s.openCredModal);
  const enterResults = useSearchUiStore((s) => s.enterResults);

  const busy = phase === "queued" || phase === "running" || phase === "partial";
  const landing = view === "landing";
  const urlHost = hostOf(rawQuery);

  const validationKey: string =
    inputKind === "https-url"
      ? "search.urlImport.valid"
      : inputKind === "unsupported-url"
        ? /^http:/i.test(rawQuery.trim())
          ? "search.urlImport.invalidScheme"
          : "search.urlImport.unknownDomain"
        : "";

  const doSubmit = () => {
    if (inputKind !== "text" && inputKind !== "https-url") return;
    enterResults(rawQuery.trim());
    if (inputKind === "https-url") setImportMode(true);
    void submit();
  };

  return (
    <div
      id="f56.search.v2.heroBar"
      data-testid="hero-bar"
      data-mode={landing ? "landing" : "results"}
      data-anim={animating ? "to-top" : "idle"}
      onTransitionEnd={onAnimationEnd}
      className={
        "w-full flex flex-col gap-3 transition-all duration-500 motion-reduce:transition-none " +
        (landing ? "items-center justify-center min-h-[45vh]" : "items-stretch pt-0")
      }
    >
      <section
        id="f56.search.commandBar"
        aria-label={t("search.a11y.commandBar")}
        className={
          "flex flex-col gap-2 " +
          (landing ? "w-[60%] max-w-3xl" : "w-full")
        }
      >
        <form
          className={"flex items-center gap-2 " + (landing ? "" : "")}
          onSubmit={(e) => {
            e.preventDefault();
            doSubmit();
          }}
        >
          <label htmlFor="f56.search.query" className="sr-only">
            {t("search.query.label")}
          </label>
          <span id="f56.search.queryDescription" className="sr-only">
            {t("search.a11y.queryDescription")}
          </span>
          <input
            id="f56.search.query"
            data-testid="search-query"
            type="text"
            role="searchbox"
            autoFocus={landing}
            value={rawQuery}
            aria-describedby="f56.search.queryDescription f56.search.urlImportValidation"
            placeholder={t("search.query.placeholder")}
            onChange={(e) => setQuery(e.target.value)}
            className={
              "flex-1 px-3 rounded-full border border-default bg-surface text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent " +
              (landing ? "h-16 text-base shadow-md" : "h-11 text-sm")
            }
          />
          <button
            id="f56.search.queryClear"
            type="button"
            aria-label={t("search.query.clear")}
            title={t("search.query.clear")}
            onClick={() => clearQuery()}
            className="h-11 w-11 rounded-full border border-default text-secondary hover:bg-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            <X className="size-4 mx-auto" aria-hidden />
          </button>
          <button
            id="f56.search.querySubmit"
            data-testid="search-submit"
            type="submit"
            disabled={inputKind === "empty" || inputKind === "unsupported-url" || busy}
            className="h-11 px-4 rounded-full bg-accent text-accent-fg text-sm font-medium hover:bg-accent-hover disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent inline-flex items-center gap-2"
          >
            <SearchIcon className="size-4" aria-hidden />
            {busy ? t("search.query.searching") : t("search.query.submit")}
          </button>
          <button
            id="f56.search.v2.advancedToggle"
            data-testid="advanced-toggle"
            type="button"
            aria-expanded={advancedOpen}
            aria-controls="f56.search.v2.advancedPanel"
            title={t("search.v2.advanced.toggle")}
            aria-label={t("search.v2.advanced.toggle")}
            onClick={toggleAdvanced}
            className="h-11 w-11 rounded-full border border-default text-secondary hover:bg-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            <MoreHorizontal className="size-4 mx-auto" aria-hidden />
          </button>
        </form>

        {inputKind === "https-url" && (
          <p id="f56.search.urlImport" className="text-xs text-accent">
            {t("search.query.urlDetected")} — {t("search.query.urlImport")}
          </p>
        )}
        <p id="f56.search.urlImportValidation" role="status" aria-live="polite" className="text-xs text-secondary">
          {validationKey ? t(validationKey) : ""}
        </p>

        {importMode && inputKind === "https-url" ? (
          <div id="f56.search.v2.importBanner" data-testid="url-import-banner" className="bg-surface border border-default rounded-md p-3 flex flex-wrap items-center gap-2">
            <span className="text-xs font-semibold text-primary">{t("search.v2.import.banner")}</span>
            <span className="text-xs text-secondary flex-1 min-w-0">{t("search.v2.import.body")}</span>
            <button
              id="f56.search.v2.importOwnCredential"
              data-testid="import-own-credential"
              type="button"
              onClick={() => openCredModal(urlHost || "unknown")}
              className="h-11 px-3 rounded-md border border-default text-xs text-secondary hover:bg-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              {t("search.v2.import.ownCredential")}
            </button>
            <span className="text-xs text-tertiary">{t("search.v2.import.ownCredentialHint")}</span>
          </div>
        ) : null}

        <AdvancedPanel open={advancedOpen} />

        <p id="f56.search.keyboardHelp" className="text-xs text-tertiary">
          {t("search.keyboard.help")}
        </p>
      </section>
    </div>
  );
}
