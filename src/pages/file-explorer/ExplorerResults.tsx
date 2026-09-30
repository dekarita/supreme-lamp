// [F56-c] File Explorer shell - results grid with list/grid view toggle.
// Rows come from src/pages/file-explorer/fixture.json (f57.explorer.row.* ids);
// no real directory reads happen before F57.
import { useTranslation } from "react-i18next";
import { File, Folder } from "lucide-react";
import fixture from "./fixture.json";

export interface FixtureRow {
  id: string;
  name: string;
  kind: "folder" | "file";
  sizeBytes: number | null;
  modified: string;
}

export type ViewMode = "list" | "grid";

export function ExplorerResults({
  view,
  onView,
  selectedId,
  onSelect,
}: {
  view: ViewMode;
  onView: (v: ViewMode) => void;
  selectedId: string;
  onSelect: (row: FixtureRow) => void;
}) {
  const { t } = useTranslation();
  const rows = fixture.rows as FixtureRow[];

  return (
    <section id="f57.explorer.results" data-testid="explorer-results" data-view={view} className="bg-surface border border-default rounded-md p-2 flex flex-col gap-2 flex-1 min-w-0">
      <div className="flex items-center gap-2">
        <h2 className="text-sm font-semibold text-primary">{t("files.results.label")}</h2>
        <div className="ml-auto flex items-center gap-1">
          <button
            id="f57.explorer.viewToggleList"
            type="button"
            aria-pressed={view === "list"}
            aria-label={t("files.view.list")}
            title={t("files.view.list")}
            data-testid="view-toggle-list"
            onClick={() => onView("list")}
            className="h-11 px-3 rounded-md border border-default text-xs text-secondary hover:bg-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            {t("files.view.list")}
          </button>
          <button
            id="f57.explorer.viewToggleGrid"
            type="button"
            aria-pressed={view === "grid"}
            aria-label={t("files.view.grid")}
            title={t("files.view.grid")}
            data-testid="view-toggle-grid"
            onClick={() => onView("grid")}
            className="h-11 px-3 rounded-md border border-default text-xs text-secondary hover:bg-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            {t("files.view.grid")}
          </button>
        </div>
      </div>
      <ul
        data-testid="explorer-rows"
        className={
          view === "list"
            ? "flex flex-col divide-y divide-default"
            : "grid grid-cols-2 md:grid-cols-3 gap-2"
        }
      >
        {rows.map((r) => {
          const Icon = r.kind === "folder" ? Folder : File;
          const selected = r.id === selectedId;
          return (
            <li key={r.id} id={"f57.explorer.row." + r.id} data-testid="explorer-row" data-row-id={r.id}>
              <button
                type="button"
                aria-pressed={selected}
                onClick={() => onSelect(r)}
                className={
                  "w-full h-11 px-2 rounded-md text-left text-sm flex items-center gap-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent " +
                  (selected ? "bg-accent/10 text-accent" : "text-primary hover:bg-raised")
                }
              >
                <Icon className="size-4 shrink-0 text-tertiary" aria-hidden />
                <span className="truncate flex-1 min-w-0">{r.name}</span>
                <span className="text-xs text-tertiary shrink-0">{r.kind === "folder" ? t("files.results.kind.folder") : t("files.results.kind.file")}</span>
                <span className="text-xs font-mono text-secondary shrink-0 w-20 text-right">
                  {r.sizeBytes != null ? String(r.sizeBytes) : "—"}
                </span>
                <span className="text-xs font-mono text-tertiary shrink-0 w-24 text-right hidden md:inline">
                  {r.modified.slice(0, 10)}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
