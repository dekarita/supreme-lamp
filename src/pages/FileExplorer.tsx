// [F56-c] File Explorer page shell (session §3 + payloads/docs/
// rdp-file-explorer-plan.md): left tree (Quick Access + reserved "Fetched" +
// This PC stubs), breadcrumb, results grid (list + grid toggle), preview panel
// stub, and a disabled command bar with "coming in F57" tooltips. Rows come
// from src/pages/file-explorer/fixture.json; F57 ids are reserved under
// f57.explorer.* (additive, collision-free against the frozen 219).
//
// [F56-c v2] The breadcrumb is now derived from the selected location instead
// of being a static fixture list, and selecting the reserved Fetched root
// renders its own empty state ("coming in F56-d") - no rows are invented for a
// root that the F56-d fetch plane owns.
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

export const FETCHED_PATH = "D:\\RDP-Storage\\Fetched";

/** Known path segments, longest-first, so a location maps to deterministic
 *  crumb ids (`f57.explorer.breadcrumbItem.<segment id>`) - never to a slice
 *  of an unsanitized path. */
const SEGMENTS: Crumb[] = [
  { id: "bc-fetched", labelKey: "files.v2.fetched.node", path: FETCHED_PATH },
  { id: "bc-rdp-storage", labelKey: "files.thisPc.rdpStorage", path: "D:\\RDP-Storage" },
  { id: "bc-windows", labelKey: "files.thisPc.windows", path: "C:\\" },
];

export function crumbsFor(path: string): Crumb[] {
  const root: Crumb = { id: "bc-this-pc", labelKey: "files.thisPc.label", path: "This PC" };
  const segments = SEGMENTS.filter((s) => path === s.path || path.startsWith(s.path.endsWith("\\") ? s.path : s.path + "\\")).sort(
    (a, b) => a.path.length - b.path.length
  );
  return [root, ...segments];
}

export default function FileExplorer() {
  const { t } = useTranslation();
  const [view, setView] = useState<ViewMode>("list");
  const [location, setLocation] = useState<TreeNode>(() => (fixture.thisPc as TreeNode[])[1]);
  const [selected, setSelected] = useState<FixtureRow | null>(null);

  const atFetched = location.path === FETCHED_PATH;

  return (
    <div id="f57.explorer.view" data-testid="file-explorer-page" className="flex flex-col gap-4">
      <h1 className="text-lg font-semibold text-primary">{t("files.page.title")}</h1>
      <p className="text-sm text-secondary">{t("files.page.description")}</p>

      <nav
        id="f57.explorer.breadcrumbs"
        aria-label={t("files.breadcrumb.label")}
        data-testid="explorer-breadcrumbs"
        data-location={location.path}
        className="flex items-center gap-1 text-xs text-secondary"
      >
        {crumbsFor(location.path).map((c, i) => (
          <span key={c.id} id={"f57.explorer.breadcrumbItem." + c.id} className="inline-flex items-center gap-1">
            {i > 0 ? <span aria-hidden className="text-tertiary">/</span> : null}
            <span>{t(c.labelKey)}</span>
          </span>
        ))}
      </nav>

      <ExplorerCommandBar />

      <div className="flex flex-wrap items-start gap-3">
        <ExplorerTree activePath={location.path} onSelect={setLocation} />
        {atFetched ? (
          <section
            id="f57.explorer.v2.fetchedEmpty"
            data-testid="fetched-empty"
            aria-label={t("files.v2.fetched.empty.title")}
            className="flex-1 min-w-0 bg-surface border border-default rounded-md p-4 flex flex-col gap-2"
          >
            <h2 className="text-sm font-semibold text-primary">{t("files.v2.fetched.empty.title")}</h2>
            <p className="text-sm text-secondary">{t("files.v2.fetched.empty.body")}</p>
            <p id="f57.explorer.v2.reservedBadge.empty" data-testid="fetched-reserved-badge" className="text-xs text-tertiary">
              {t("files.v2.fetched.badge")}
            </p>
          </section>
        ) : (
          <ExplorerResults view={view} onView={setView} selectedId={selected ? selected.id : ""} onSelect={setSelected} />
        )}
        <ExplorerPreview name={selected ? selected.name : ""} />
      </div>
    </div>
  );
}
