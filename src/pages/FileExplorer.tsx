// [F56-c] File Explorer page shell (session §3): left tree (Quick Access +
// This PC stubs), breadcrumb, results grid (list + grid toggle), preview panel
// stub, and a disabled command bar with "coming in F57" tooltips. Rows come
// from src/pages/file-explorer/fixture.json; F57 ids are reserved under
// f57.explorer.* (additive, collision-free against the frozen 219).
import { useState } from "react";
import { useTranslation } from "react-i18next";
import fixture from "./file-explorer/fixture.json";
import { ExplorerTree, type TreeNode } from "./file-explorer/ExplorerTree";
import { ExplorerCommandBar } from "./file-explorer/ExplorerCommandBar";
import { ExplorerResults, type FixtureRow, type ViewMode } from "./file-explorer/ExplorerResults";
import { ExplorerPreview } from "./file-explorer/ExplorerPreview";

interface Crumb {
  id: string;
  labelKey: string;
  path: string;
}

export default function FileExplorer() {
  const { t } = useTranslation();
  const [view, setView] = useState<ViewMode>("list");
  const [location, setLocation] = useState<TreeNode>(() => (fixture.thisPc as TreeNode[])[1]);
  const [selected, setSelected] = useState<FixtureRow | null>(null);

  return (
    <div id="f57.explorer.view" data-testid="file-explorer-page" className="flex flex-col gap-4">
      <h1 className="text-lg font-semibold text-primary">{t("files.page.title")}</h1>
      <p className="text-sm text-secondary">{t("files.page.description")}</p>

      <nav id="f57.explorer.breadcrumbs" aria-label={t("files.breadcrumb.label")} data-testid="explorer-breadcrumbs" className="flex items-center gap-1 text-xs text-secondary">
        {(fixture.breadcrumb as Crumb[]).map((c, i) => (
          <span key={c.id} id={"f57.explorer.breadcrumbItem." + c.id} className="inline-flex items-center gap-1">
            {i > 0 ? <span aria-hidden className="text-tertiary">/</span> : null}
            <span>{t(c.labelKey)}</span>
          </span>
        ))}
      </nav>

      <ExplorerCommandBar />

      <div className="flex flex-wrap items-start gap-3">
        <ExplorerTree activePath={location.path} onSelect={setLocation} />
        <ExplorerResults view={view} onView={setView} selectedId={selected ? selected.id : ""} onSelect={setSelected} />
        <ExplorerPreview name={selected ? selected.name : ""} />
      </div>
    </div>
  );
}
