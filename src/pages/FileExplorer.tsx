// [F56-d] File Explorer page shell - Fetched-root empty-state replaced by file-arrival event listener via ws /ws progress mirrorDiag.
// When a file lands in D:\RDP-Storage\Fetched, the UI shows it via file-arrival event and /api/fx/list polling.
import { useEffect, useState } from "react";
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
  const [fetchedFiles, setFetchedFiles] = useState<FixtureRow[]>([]);

  const atFetched = location.path === FETCHED_PATH;

  // [F56-d] File-arrival event via ws progress mirrorDiag + polling /api/fx/list
  useEffect(() => {
    if (!atFetched) return;
    let alive = true;
    const fetchFetched = async () => {
      try {
        // Try fx API list
        const token = (() => { try { return localStorage.getItem('ghrdp-dash-token') || '' } catch { return '' } })();
        const headers: Record<string, string> = {};
        if (token) headers['X-Dash-Token'] = token;
        const res = await fetch(`/api/fx/list?path=${encodeURIComponent(FETCHED_PATH)}`, { headers, cache: 'no-store' });
        if (res.ok) {
          const j = await res.json();
          const entries = j?.entries || j?.files || [];
          if (Array.isArray(entries) && entries.length) {
            const mapped: FixtureRow[] = entries.map((e: any, idx: number) => ({
              id: e.id || e.name || `fetched-${idx}`,
              name: e.name || e.path || `file-${idx}`,
              kind: e.kind || (e.isDir ? 'folder' : 'file'),
              size: e.size || e.sizeBytes || 0,
              modified: e.modified || e.mtime || new Date().toISOString(),
            }));
            if (alive) setFetchedFiles(mapped);
          }
        }
      } catch {}
    };

    const onArrival = (evt: Event) => {
      try {
        const custom = evt as CustomEvent;
        const detail = custom.detail;
        if (Array.isArray(detail)) {
          const mapped: FixtureRow[] = detail.map((e: any, idx: number) => ({
            id: e.id || e.name || `fetched-${idx}`,
            name: e.name || e.path || `file-${idx}`,
            kind: 'file',
            size: e.size || 0,
            modified: e.modified || new Date().toISOString(),
          }));
          if (alive) setFetchedFiles((prev) => {
            const merged = [...prev];
            for (const m of mapped) {
              if (!merged.find(p => p.name === m.name)) merged.push(m);
            }
            return merged;
          });
        }
      } catch {}
    };

    void fetchFetched();
    const interval = window.setInterval(fetchFetched, 5000);
    window.addEventListener('ghrdp-fetched-arrival', onArrival as EventListener);
    return () => {
      alive = false;
      window.clearInterval(interval);
      window.removeEventListener('ghrdp-fetched-arrival', onArrival as EventListener);
    };
  }, [atFetched]);

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
          fetchedFiles.length > 0 ? (
            <section
              id="f57.explorer.v2.fetchedList"
              data-testid="fetched-list"
              aria-label={t("files.v2.fetched.list.title")}
              className="flex-1 min-w-0 bg-surface border border-default rounded-md p-4 flex flex-col gap-2"
            >
              <h2 className="text-sm font-semibold text-primary">{t("files.v2.fetched.list.title")}</h2>
              <p className="text-xs text-secondary">{t("files.v2.fetched.list.body", { count: fetchedFiles.length })}</p>
              <ul className="flex flex-col gap-1">
                {fetchedFiles.map((f) => (
                  <li key={f.id} data-testid="fetched-file" className="text-xs font-mono text-primary truncate">
                    {f.name} {f.size ? `(${f.size} bytes)` : ''}
                  </li>
                ))}
              </ul>
            </section>
          ) : (
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
              <p data-testid="fetched-file-arrival-listener" className="text-xs text-tertiary">
                {t("files.v2.fetched.listening")}
              </p>
            </section>
          )
        ) : (
          <ExplorerResults view={view} onView={setView} selectedId={selected ? selected.id : ""} onSelect={setSelected} />
        )}
        <ExplorerPreview name={selected ? selected.name : ""} />
      </div>
    </div>
  );
}
