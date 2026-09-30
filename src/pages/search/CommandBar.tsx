// [F56-c] SearchCommandBar (Plan §A): QueryInput (URL-import detection),
// CategoryChipRow, LicenceChipRow, SizeSlider (logarithmic 0-100 GB), and
// SortSelector. Typing updates local state only (decisions.md A2): fan-out
// happens on Enter / explicit Search command. All ids are f56.search.* additive
// templates; chips/option children suffix with their enum value.
import { useTranslation } from "react-i18next";
import { Search as SearchIcon, X } from "lucide-react";
import {
  logToSizeBytes,
  sizeBytesToLog,
  useSearchStore,
  type SearchState,
} from "@/stores/searchStore";
import type { Category, LicenceTag, SortKey } from "@/api/search";

const CATEGORIES: Category[] = ["books", "audio", "scholarly", "education", "media", "software", "music", "video", "own-storage", "purchase"];
const LICENCES: LicenceTag[] = ["public-domain", "open-access", "creative-commons", "purchase", "own-storage"];
const SORTS: SortKey[] = ["relevance", "size", "date"];

export function camel(v: string): string {
  return v.replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase());
}

/** Plan §C licence palette: muted tokens (tokens.css), never neon green. */
export function licenceStyle(tag: LicenceTag): string {
  switch (tag) {
    case "public-domain":
      return "text-[color:var(--search-licence-public-fg)] bg-[color:var(--search-licence-public-bg)]";
    case "open-access":
      return "text-[color:var(--search-licence-open-fg)] bg-[color:var(--search-licence-open-bg)]";
    case "creative-commons":
      return "text-[color:var(--search-licence-cc-fg)] bg-[color:var(--search-licence-cc-bg)]";
    case "purchase":
      return "text-[color:var(--search-licence-purchase-fg)] bg-[color:var(--search-licence-purchase-bg)]";
    default:
      return "text-[color:var(--search-licence-own-fg)] bg-[color:var(--search-licence-own-bg)]";
  }
}

function formatGb(bytes: number): string {
  if (bytes <= 0) return "0";
  const gb = bytes / (1024 * 1024 * 1024);
  return gb >= 10 ? String(Math.round(gb)) : String(Math.round(gb * 10) / 10);
}

export function CommandBar() {
  const { t } = useTranslation();
  const rawQuery = useSearchStore((s) => s.rawQuery);
  const inputKind = useSearchStore((s) => s.inputKind);
  const categories = useSearchStore((s) => s.categories);
  const licenceTags = useSearchStore((s) => s.licenceTags);
  const maxSizeBytes = useSearchStore((s) => s.maxSizeBytes);
  const sort = useSearchStore((s) => s.sort);
  const scope = useSearchStore((s) => s.scope);
  const phase = useSearchStore((s) => s.phase);
  const filterCount = useSearchStore((s) => s.categories.length + s.licenceTags.length);
  const setQuery = useSearchStore((s) => s.setQuery);
  const clearQuery = useSearchStore((s) => s.clearQuery);
  const toggleCategory = useSearchStore((s) => s.toggleCategory);
  const toggleLicence = useSearchStore((s) => s.toggleLicence);
  const resetFilters = useSearchStore((s) => s.resetFilters);
  const setMaxSizeBytes = useSearchStore((s) => s.setMaxSizeBytes);
  const setSort = useSearchStore((s) => s.setSort);
  const setScope = useSearchStore((s) => s.setScope);
  const submit = useSearchStore((s) => s.submit);
  const busy = phase === "queued" || phase === "running" || phase === "partial";

  const validationKey: string =
    inputKind === "https-url"
      ? "search.urlImport.valid"
      : inputKind === "unsupported-url"
        ? /^http:/i.test(rawQuery.trim())
          ? "search.urlImport.invalidScheme"
          : "search.urlImport.unknownDomain"
        : "";

  return (
    <section id="f56.search.commandBar" aria-label={t("search.a11y.commandBar")} className="bg-surface border border-default rounded-md p-3 flex flex-col gap-3">
      <form
        className="flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (inputKind === "text" || inputKind === "https-url") void submit();
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
          value={rawQuery}
          aria-describedby="f56.search.queryDescription f56.search.urlImportValidation"
          placeholder={t("search.query.placeholder")}
          onChange={(e) => setQuery(e.target.value)}
          className="flex-1 h-11 px-3 rounded-md border border-default bg-base text-primary text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        />
        <button
          id="f56.search.queryClear"
          type="button"
          aria-label={t("search.query.clear")}
          title={t("search.query.clear")}
          onClick={() => clearQuery()}
          className="h-11 px-2 rounded-md border border-default text-secondary hover:bg-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          <X className="size-4" aria-hidden />
        </button>
        <button
          id="f56.search.querySubmit"
          data-testid="search-submit"
          type="submit"
          disabled={inputKind === "empty" || inputKind === "unsupported-url" || busy}
          className="h-11 px-4 rounded-md bg-accent text-accent-fg text-sm font-medium hover:bg-accent-hover disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent inline-flex items-center gap-2"
        >
          <SearchIcon className="size-4" aria-hidden />
          {busy ? t("search.query.searching") : t("search.query.submit")}
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

      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor="f56.search.scope" className="text-xs text-tertiary">
          {t("search.scope.label")}
        </label>
        <select
          id="f56.search.scope"
          value={scope}
          onChange={(e) => setScope(e.target.value as SearchState["scope"])}
          className="h-11 px-2 rounded-md border border-default bg-base text-xs text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          <option value="federated">{t("search.scope.federated")}</option>
          <option value="own-storage">{t("search.scope.ownStorage")}</option>
        </select>
        <span
          id="f56.search.filterSelectionCount"
          data-testid="filter-selection-count"
          className="text-xs text-tertiary"
        >
          {filterCount}
        </span>
        <button
          id="f56.search.filtersReset"
          type="button"
          onClick={() => resetFilters()}
          className="h-11 px-3 rounded-md border border-default text-xs text-secondary hover:bg-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          {t("search.filters.reset")}
        </button>
      </div>

      <div id="f56.search.filters" className="flex flex-col gap-2">
        <div id="f56.search.categoryGroup" role="group" aria-label={t("search.a11y.categoryGroup")} className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-tertiary mr-1">{t("search.filters.category.label")}</span>
          <button
            id="f56.search.categoryChip.all"
            type="button"
            aria-pressed={categories.length === 0}
            onClick={() => toggleCategory("all")}
            className={"h-11 px-3 rounded-full border text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent " + (categories.length === 0 ? "bg-accent/10 border-accent text-accent" : "border-default text-secondary hover:bg-raised")}
          >
            {t("search.filters.category.all")}
          </button>
          {CATEGORIES.map((c) => (
            <button
              key={c}
              id={"f56.search.categoryChip." + c}
              type="button"
              aria-pressed={categories.includes(c)}
              onClick={() => toggleCategory(c)}
              className={"h-11 px-3 rounded-full border text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent " + (categories.includes(c) ? "bg-accent/10 border-accent text-accent" : "border-default text-secondary hover:bg-raised")}
            >
              {t("search.filters.category." + camel(c))}
            </button>
          ))}
        </div>

        <div id="f56.search.licenceGroup" role="group" aria-label={t("search.a11y.licenceGroup")} className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-tertiary mr-1">{t("search.filters.licence.label")}</span>
          {LICENCES.map((l) => (
            <button
              key={l}
              id={"f56.search.licenceChip." + l}
              type="button"
              aria-pressed={licenceTags.includes(l)}
              onClick={() => toggleLicence(l)}
              className={"h-11 px-3 rounded-full border text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent " + (licenceTags.includes(l) ? licenceStyle(l) + " border-current" : "border-default text-secondary hover:bg-raised")}
            >
              {t("search.filters.licence." + camel(l))}
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <label htmlFor="f56.search.sizeSlider" className="text-xs text-tertiary">
            {t("search.filters.size.label")}
          </label>
          <input
            id="f56.search.sizeSlider"
            data-testid="size-slider"
            type="range"
            min={0}
            max={100}
            step={1}
            value={sizeBytesToLog(maxSizeBytes)}
            aria-valuetext={maxSizeBytes <= 0 ? t("search.filters.size.zero") : formatGb(maxSizeBytes) + " GB"}
            onChange={(e) => setMaxSizeBytes(logToSizeBytes(Number(e.target.value)))}
            className="w-48 h-11"
          />
          <span id="f56.search.sizeValue" data-testid="size-value" className="text-xs font-mono text-secondary">
            {maxSizeBytes <= 0 ? t("search.filters.size.zero") : t("search.filters.size.valueGb", { value: formatGb(maxSizeBytes) })}
          </span>

          <label htmlFor="f56.search.sortSelector" className="text-xs text-tertiary ml-2">
            {t("search.filters.sort.label")}
          </label>
          <select
            id="f56.search.sortSelector"
            data-testid="sort-selector"
            value={sort}
            aria-label={t("search.a11y.sortSelector")}
            onChange={(e) => setSort(e.target.value as SortKey)}
            className="h-11 px-2 rounded-md border border-default bg-base text-xs text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            {SORTS.map((s) => (
              <option key={s} id={"f56.search.sortOption." + s} value={s}>
                {t("search.filters.sort." + s)}
              </option>
            ))}
          </select>
        </div>
      </div>

      <p id="f56.search.keyboardHelp" className="text-xs text-tertiary">
        {t("search.keyboard.help")}
      </p>
    </section>
  );
}
