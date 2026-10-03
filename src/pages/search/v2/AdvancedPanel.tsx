// [F56-c v2] Advanced disclosure (the "⋯ Advanced" affordance). Collapsed by
// default and rendered hidden - the landing surface shows NO filter chips and
// NO size cap, while the frozen F56-c filter ids (category/licence chips, size
// slider, sort selector, scope, reset, counter) stay in the DOM exactly once
// so the id lock and the local-filter behaviour are unchanged.
//
// Size default is 0 = unlimited (v2 brief; overrides the A1 10 GB default in
// place - docs/f56/decisions.md A1 carries the overwrite.
//
// [F58 §2] One additive block at the tail: the "Add source" inline card, which
// mounts the SHARED SourceForm (src/components/search/SourceForm.tsx) so the
// Advanced surface and Settings are the same component writing the same store.
import { useTranslation } from "react-i18next";
import { SourceForm } from "@/components/search/SourceForm";
import {
  logToSizeBytes,
  sizeBytesToLog,
  useSearchStore,
  selectFilterSelectionCount,
  type SearchState,
} from "@/stores/searchStore";
import { MAX_SIZE_BYTES } from "@/stores/searchStore";
import type { Category, LicenceTag, SortKey } from "@/api/search";
import { camel, licenceStyle } from "@/pages/search/tokens";
import { ADAPTER_ROSTER } from "./adapters";

const CATEGORIES: Category[] = ["books", "audio", "scholarly", "education", "media", "software", "music", "video", "own-storage", "purchase"];
const LICENCES: LicenceTag[] = ["public-domain", "open-access", "creative-commons", "purchase", "own-storage", "unknown"];
const FILE_TYPES = ["pdf", "epub", "mp3", "mp4", "zip", "tar.gz", "source-code", "exe", "deb", "rpm", "dmg", "msi"] as const;
const LANGUAGES = ["JavaScript", "TypeScript", "Python", "Go", "Rust", "Java", "C", "C++"];
const SORTS: SortKey[] = ["relevance", "size", "date"];

function formatGb(bytes: number): string {
  if (bytes <= 0) return "0";
  const gb = bytes / (1024 * 1024 * 1024);
  return gb >= 10 ? String(Math.round(gb)) : String(Math.round(gb * 10) / 10);
}

export function AdvancedPanel({ open }: { open: boolean }) {
  const { t } = useTranslation();
  const categories = useSearchStore((s) => s.categories);
  const licenceTags = useSearchStore((s) => s.licenceTags);
  const maxSizeBytes = useSearchStore((s) => s.maxSizeBytes);
  const sort = useSearchStore((s) => s.sort);
  const scope = useSearchStore((s) => s.scope);
  const adapterIds = useSearchStore((s) => s.adapterIds);
  const fileExtensions = useSearchStore((s) => s.fileExtensions);
  const yearFrom = useSearchStore((s) => s.yearFrom);
  const yearTo = useSearchStore((s) => s.yearTo);
  const language = useSearchStore((s) => s.language);
  const groupBySource = useSearchStore((s) => s.groupBySource);
  const filterCount = useSearchStore(selectFilterSelectionCount);
  const toggleFileExtension = useSearchStore((s) => s.toggleFileExtension);
  const setYearRange = useSearchStore((s) => s.setYearRange);
  const setLanguage = useSearchStore((s) => s.setLanguage);
  const toggleGroupBySource = useSearchStore((s) => s.toggleGroupBySource);
  const toggleCategory = useSearchStore((s) => s.toggleCategory);
  const toggleLicence = useSearchStore((s) => s.toggleLicence);
  const toggleAdapter = useSearchStore((s) => s.toggleAdapter);
  const resetFilters = useSearchStore((s) => s.resetFilters);
  const setMaxSizeBytes = useSearchStore((s) => s.setMaxSizeBytes);
  const setSort = useSearchStore((s) => s.setSort);
  const setScope = useSearchStore((s) => s.setScope);

  return (
    <div
      id="f56.search.v2.advancedPanel"
      data-testid="advanced-panel"
      hidden={!open}
      aria-label={t("search.v2.advanced.panel")}
      className="w-full bg-surface border border-default rounded-md p-3 flex flex-col gap-3 text-left"
    >
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
        <span id="f56.search.filterSelectionCount" data-testid="filter-selection-count" className="text-xs text-tertiary">
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

        {/* [F71 §D#4 / F73.2] Local-only filters; no new network lane. */}
        <div id="f56.search.v2.fileExtGroup" role="group" aria-label={t("search.filters.fileTypes.label")} className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-tertiary mr-1">{t("search.filters.fileTypes.label")}</span>
          {FILE_TYPES.map((ext) => {
            const idExt = ext === "tar.gz" ? "tar-gz" : ext;
            return (
              <button
                key={ext}
                id={"f56.search.v2.fileExtChip." + idExt}
                type="button"
                aria-pressed={fileExtensions.includes(ext)}
                onClick={() => toggleFileExtension(ext)}
                className={"h-11 px-3 rounded-full border text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent " + (fileExtensions.includes(ext) ? "bg-accent/10 border-accent text-accent" : "border-default text-secondary hover:bg-raised")}
              >
                {ext === "source-code" ? t("search.filters.fileTypes.sourceCode") : "." + ext}
              </button>
            );
          })}
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <label htmlFor="f56.search.v2.yearFrom" className="text-xs text-tertiary">{t("search.filters.yearFrom")}</label>
          <input
            id="f56.search.v2.yearFrom"
            type="number"
            min={0}
            max={9999}
            value={yearFrom ?? ""}
            onChange={(e) => setYearRange(e.currentTarget.value === "" ? null : Number(e.currentTarget.value), yearTo)}
            className="h-11 w-24 px-2 rounded-md border border-default bg-base text-xs text-primary"
          />
          <label htmlFor="f56.search.v2.yearTo" className="text-xs text-tertiary">{t("search.filters.yearTo")}</label>
          <input
            id="f56.search.v2.yearTo"
            type="number"
            min={0}
            max={9999}
            value={yearTo ?? ""}
            onChange={(e) => setYearRange(yearFrom, e.currentTarget.value === "" ? null : Number(e.currentTarget.value))}
            className="h-11 w-24 px-2 rounded-md border border-default bg-base text-xs text-primary"
          />
          <label htmlFor="f56.search.v2.languageFilter" className="text-xs text-tertiary">{t("search.filters.language")}</label>
          <select
            id="f56.search.v2.languageFilter"
            value={language}
            onChange={(e) => setLanguage(e.currentTarget.value)}
            className="h-11 px-2 rounded-md border border-default bg-base text-xs text-primary"
          >
            <option value="">{t("search.filters.anyLanguage")}</option>
            {LANGUAGES.map((lang) => <option key={lang} value={lang}>{lang}</option>)}
          </select>
          <button
            id="f56.search.v2.groupBySourceToggle"
            type="button"
            aria-pressed={groupBySource}
            onClick={() => toggleGroupBySource()}
            className={"h-11 px-3 rounded-md border text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent " + (groupBySource ? "bg-accent/10 border-accent text-accent" : "border-default text-secondary hover:bg-raised")}
          >
            {t("search.filters.groupBySource")}
          </button>
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

        <div id="f56.search.v2.adapterGroup" role="group" aria-label={t("search.v2.advanced.adapters.label")} className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-tertiary mr-1">{t("search.v2.advanced.adapters.label")}</span>
          <span id="f56.search.v2.adapterCount" data-testid="adapter-count" className="text-xs font-mono text-tertiary">
            {t("search.v2.advanced.adapters.count", { count: adapterIds.length })}
          </span>
          {ADAPTER_ROSTER.map((a) => (
            <button
              key={a.adapterId}
              id={"f56.search.v2.adapterChip." + a.adapterId}
              type="button"
              aria-pressed={adapterIds.includes(a.adapterId)}
              onClick={() => toggleAdapter(a.adapterId)}
              className={"h-11 px-3 rounded-full border text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent " + (adapterIds.includes(a.adapterId) ? "bg-accent/10 border-accent text-accent" : "border-default text-secondary hover:bg-raised")}
            >
              {t(a.nameKey)}
            </button>
          ))}
          <span className="text-xs text-tertiary">{t("search.v2.advanced.adapters.hint")}</span>
        </div>
      </div>

      {/* [F58 §2] Secondary mount point of the SHARED form: the same SourceForm
          component the canonical Settings surface renders, writing the same store
          instance. Additive block only - the frozen F56-c filter ids above stay in
          the DOM exactly once and unchanged. */}
      <div
        id="f56.search.v2.sourcesCard"
        data-testid="source-add-card"
        role="group"
        aria-label={t("search.registry.card.label")}
        className="w-full rounded-md border border-default bg-base p-2 flex flex-col gap-2"
      >
        <span className="text-xs font-medium text-primary">{t("search.registry.add")}</span>
        <SourceForm surface="advanced" />
      </div>
    </div>
  );
}

export { MAX_SIZE_BYTES };
