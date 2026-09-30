// [F56-c] File Explorer shell - left tree (Quick Access + This PC stubs).
// Fixture-driven; selection is shell state only until F57 wires real listings.
import { useTranslation } from "react-i18next";
import fixture from "./fixture.json";

export interface TreeNode {
  id: string;
  labelKey: string;
  path: string;
}

export function ExplorerTree({ activePath, onSelect }: { activePath: string; onSelect: (n: TreeNode) => void }) {
  const { t } = useTranslation();
  const groups: Array<{ id: "f57.explorer.quickAccess" | "f57.explorer.thisPc"; labelKey: string; itemPrefix: string; nodes: TreeNode[] }> = [
    { id: "f57.explorer.quickAccess", labelKey: "files.quickAccess.label", itemPrefix: "f57.explorer.quickAccessItem.", nodes: fixture.quickAccess as TreeNode[] },
    { id: "f57.explorer.thisPc", labelKey: "files.thisPc.label", itemPrefix: "f57.explorer.thisPcItem.", nodes: fixture.thisPc as TreeNode[] },
  ];

  return (
    <nav id="f57.explorer.tree" aria-label={t("files.tree.label")} data-testid="explorer-tree" className="w-56 shrink-0 bg-surface border border-default rounded-md p-2 flex flex-col gap-3 self-start">
      {groups.map((g) => (
        <div key={g.id} id={g.id} data-testid={g.id} className="flex flex-col gap-1">
          <h2 className="px-2 text-xs font-semibold text-tertiary">{t(g.labelKey)}</h2>
          {g.nodes.map((n) => (
            <button
              key={n.id}
              id={g.itemPrefix + n.id}
              type="button"
              aria-current={n.path === activePath ? "true" : undefined}
              onClick={() => onSelect(n)}
              className={
                "h-11 px-2 rounded-md text-left text-sm truncate focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent " +
                (n.path === activePath ? "bg-accent/10 text-accent font-medium" : "text-secondary hover:bg-raised")
              }
            >
              {t(n.labelKey)}
            </button>
          ))}
        </div>
      ))}
    </nav>
  );
}
