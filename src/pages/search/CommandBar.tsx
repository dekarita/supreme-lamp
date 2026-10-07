// [F56-c v3] All-in-one search bar (§1/§2): ONE control, centered, ~60% of the
// viewport wide and ~72px tall, autofocus. Inline left icon = magnifier (the
// submit control); inline right icons in order: [clip] URL-import indicator
// (auto-lights on an HTTPS paste), [⋯] the inline filter drawer (every §1
// filter lives there; it collapses on Enter or Esc), [mic] stub, then clear.
// The landing surface itself shows ZERO chips: the drawer content is rendered
// only while open, so no Category/Licence/Size/Sort/Sources/Scope control is
// ever present on the landing surface. Keyboard hint = "Alt+F opens Search.
// Enter submits." and nothing else.
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Mic, MoreHorizontal, Paperclip, Search as SearchIcon, X, ExternalLink } from "lucide-react";
import { useSearchStore } from "@/stores/searchStore";
import { hostOf, useSearchUiStore } from "@/stores/searchUiStore";
import { useToastStore } from "@/stores/toastStore";
import { useCustomSourcesStore } from "@/stores/customSourcesStore";
import { useSearchHistoryStore } from "@/stores/searchHistoryStore";
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
  const setAdvanced = useSearchUiStore((s) => s.setAdvanced);
  const toggleAdvanced = useSearchUiStore((s) => s.toggleAdvanced);
  const importMode = useSearchUiStore((s) => s.importMode);
  const setImportMode = useSearchUiStore((s) => s.setImportMode);
  const openCredModal = useSearchUiStore((s) => s.openCredModal);
  const enterResults = useSearchUiStore((s) => s.enterResults);
  const pushToast = useToastStore((s) => s.push);

  // [F78 §1.2] The stored-site list is loaded with the bar, so "Your sites"
  // (and the Lab inspector's source lookup) are never stale on first paint.
  // A failure is non-fatal here: the list stays empty and the row hides.
  useEffect(() => {
    void useCustomSourcesStore.getState().refresh();
  }, []);

  const busy = phase === "queued" || phase === "running" || phase === "partial";
  const landing = view === "landing";
  const urlHost = hostOf(rawQuery);
  // §2: the clip auto-lights the moment the bar holds an HTTPS URL.
  const urlLit = inputKind === "https-url";

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
    // [F81 §2.2/Q6] Inline hint: when the operator tries to submit a query
    // shorter than 3 chars, show the "too short" hint right below the bar
    // instead of dispatching a request the backend would refuse.
    if (inputKind === "text" && rawQuery.trim().length > 0 && rawQuery.trim().length < 3) {
      pushToast(t("search.errors.queryTooShort"));
      return;
    }
    setAdvanced(false); // §2: the drawer collapses on Enter
    enterResults(rawQuery.trim());
    if (inputKind === "https-url") setImportMode(true);
    void submit();
  };

  const iconBtn =
    "h-11 w-11 shrink-0 rounded-full border text-secondary hover:bg-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ";

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
        onKeyDown={(e) => {
          // §2: the drawer also collapses on Esc (never swallows a closed drawer).
          if (e.key === "Escape" && advancedOpen) {
            e.preventDefault();
            setAdvanced(false);
          }
        }}
        className="w-full max-w-[760px] flex flex-col gap-2"
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            doSubmit();
          }}
          className={
            "flex items-center gap-1 rounded-full border border-default bg-surface shadow-md px-2 focus-within:ring-2 focus-within:ring-accent " +
            (landing ? "h-[72px]" : "h-16")
          }
        >
          <label htmlFor="f56.search.query" className="sr-only">
            {t("search.query.label")}
          </label>
          <span id="f56.search.queryDescription" className="sr-only">
            {t("search.a11y.queryDescription")}
          </span>
          <button
            id="f56.search.querySubmit"
            data-testid="search-submit"
            type="submit"
            disabled={inputKind === "empty" || inputKind === "unsupported-url" || busy}
            aria-label={busy ? t("search.query.searching") : t("search.query.submit")}
            title={busy ? t("search.query.searching") : t("search.query.submit")}
            className="h-11 w-11 shrink-0 rounded-full text-secondary hover:bg-raised disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            <SearchIcon className="size-5 mx-auto" aria-hidden />
          </button>
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
              "min-w-0 flex-1 bg-transparent text-primary placeholder:text-tertiary focus-visible:outline-none " +
              (landing ? "text-base" : "text-sm")
            }
          />
          <button
            id="f56.search.v2.urlImportIndicator"
            data-testid="bar-icon-clip"
            type="button"
            data-active={urlLit ? "true" : "false"}
            aria-pressed={urlLit}
            aria-label={t("search.v3.bar.clip")}
            title={t("search.v3.bar.clip")}
            onClick={() => {
              setImportMode(true);
              document.getElementById("f56.search.query")?.focus();
            }}
            className={
              iconBtn +
              (urlLit || importMode ? "border-accent text-accent bg-accent/10" : "border-transparent")
            }
          >
            <Paperclip className="size-4 mx-auto" aria-hidden />
          </button>
          <button
            id="f56.search.v2.advancedToggle"
            data-testid="bar-icon-drawer"
            type="button"
            aria-expanded={advancedOpen}
            aria-controls="f56.search.v2.advancedPanel"
            title={t("search.v2.advanced.toggle")}
            aria-label={t("search.v2.advanced.toggle")}
            onClick={() => toggleAdvanced()}
            className={iconBtn + (advancedOpen ? "border-accent" : "border-transparent")}
          >
            <MoreHorizontal className="size-4 mx-auto" aria-hidden />
          </button>
          <button
            id="f56.search.v2.micStub"
            data-testid="bar-icon-mic"
            type="button"
            aria-label={t("search.v3.bar.mic")}
            title={t("search.v3.bar.mic")}
            onClick={() => pushToast(t("search.v3.toast.micStub"))}
            className={iconBtn + "border-transparent"}
          >
            <Mic className="size-4 mx-auto" aria-hidden />
          </button>
          <button
            data-testid="search-query-clear"
            id="f56.search.queryClear"
            type="button"
            aria-label={t("search.query.clear")}
            title={t("search.query.clear")}
            onClick={() => clearQuery()}
            className={iconBtn + "border-transparent"}
          >
            <X className="size-4 mx-auto" aria-hidden />
          </button>
        </form>

        {/* [F81 §5.0/Q13=D] Autocomplete dropdown — recent queries
            (session-only, localStorage) + active custom-site hostnames.
            Hidden when the bar is empty or already an https:// URL import. */}
        {inputKind === "text" && rawQuery.trim().length > 0 && rawQuery.trim().length < 8 && !advancedOpen ? (
          <SuggestionList query={rawQuery} onPick={(v) => { setQuery(v); }} />
        ) : null}

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

        {/* §1: the single inline drawer. Rendered ONLY while open, so the
            landing surface exposes zero chips; every F56-c filter id lives
            here exactly once (AdvancedPanel keeps the frozen id inventory). */}
        {advancedOpen ? <AdvancedPanel open={advancedOpen} /> : null}

        {/* [F79 D6] Secondary external link, never the full-width primary CTA. */}
        <div id="f79.search.externalRow" data-testid="search-external-row" className="flex flex-wrap items-center gap-3 text-xs text-tertiary">
        <span>{t("search.external")}</span>

        {/* [F72 §2.3] "Open on google.com" navigation button (Q1 operator decision).
            Always available; zero API cost; opens in new tab. */}
        <button
          id="f56.search.v2.googleNav"
          data-testid="google-nav-button"
          type="button"
          title={t("search.googleSearch.hint")}
          aria-label={t("search.openOnGoogle")}
          disabled={!rawQuery.trim()}
          onClick={() => {
            const q = rawQuery.trim();
            if (q) window.open("https://www.google.com/search?q=" + encodeURIComponent(q), "_blank", "noopener,noreferrer");
          }}
          className="min-h-11 px-2 rounded-full text-xs text-tertiary hover:text-secondary hover:bg-raised inline-flex items-center gap-1.5 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          <ExternalLink className="size-3.5" aria-hidden />
          {t("search.openOnGoogle")}
        </button>
        <p id="f56.search.keyboardHelp" data-testid="keyboard-help" className="text-xs text-tertiary">
          {t("search.keyboard.help")}
        </p>
        </div>
      </section>
    </div>
  );
}

/** [F81 §5.0/Q13=D] Inline suggestion dropdown. Combines recent searches
 *  (session-only) and the operator's "Your sites" hostnames. The query is
 *  matched case-insensitively on either the history item or the hostname.
 *  The dropdown stays under the bar, navigable with the keyboard (Enter
 *  picks the first row), and hides itself on Esc or after a pick. */
function SuggestionList({ query, onPick }: { query: string; onPick: (v: string) => void }) {
  const { t } = useTranslation();
  const history = useSearchHistoryStore((s) => s.items);
  const sites = useCustomSourcesStore((s) => s.labSources);
  const q = String(query || "").trim().toLowerCase();
  const recent = q ? history.filter((h) => h.toLowerCase().includes(q)).slice(0, 5) : history.slice(0, 5);
  const fromSites = q
    ? sites.filter((s) => s.hostname.toLowerCase().includes(q)).slice(0, 5)
    : sites.slice(0, 5);
  if (!recent.length && !fromSites.length) return null;
  return (
    <ul
      id="f56.search.suggestions"
      data-testid="search-suggestions"
      className="rounded-md border border-default bg-surface shadow-md max-w-[760px] w-full mx-auto text-xs"
    >
      {recent.length ? (
        <li className="px-3 pt-2 pb-1 text-tertiary text-[10px] uppercase tracking-wide">{t("search.suggestions.recentLabel")}</li>
      ) : null}
      {recent.map((h, i) => (
        <li key={"h" + i}>
          <button
            id={"f56.search.suggestion.recent." + i}
            data-testid="suggestion-recent"
            type="button"
            onClick={() => onPick(h)}
            className="w-full text-left px-3 py-1 hover:bg-raised text-primary"
          >
            {h}
          </button>
        </li>
      ))}
      {fromSites.length ? (
        <li className="px-3 pt-2 pb-1 text-tertiary text-[10px] uppercase tracking-wide">{t("search.suggestions.fromSites")}</li>
      ) : null}
      {fromSites.map((s, i) => (
        <li key={"s" + i}>
          <button
            id={"f56.search.suggestion.site." + i}
            data-testid="suggestion-site"
            type="button"
            onClick={() => onPick(s.hostname)}
            className="w-full text-left px-3 py-1 hover:bg-raised text-primary font-mono"
          >
            {s.hostname}
          </button>
        </li>
      ))}
    </ul>
  );
}
