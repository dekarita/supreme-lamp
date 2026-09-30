// [F56-c] File Explorer shell - left tree (Quick Access + This PC stubs), with
// [F56-c v2] the reserved "Fetched" root between them. Fixture-driven;
// selection is shell state only until F57 wires real listings. The Fetched
// group is reserved (F56-d owns the fetch plane) and carries the reserved
// badge; it is NOT a result of this phase.
import { useTranslation } from "react-i18next";
import fixture from "./fixture.json";

export interface TreeNode {
  id: string;
  labelKey: string;
  path: string;
  badgeKey?: string;
}

export function ExplorerTree({ activePath, onSelect }: { activePath: string; onSelect: (n: TreeNode) => void }) {
  const { t } = useTranslation();
  const groups: Array<{ id: string; groupId: string; labelKey: string; itemPrefix: string; nodes: TreeNode[]; stubKey?: string }> = [
    { id: "f57.explorer.quickAccess", groupId: "f57.explorer.quickAccess", labelKey: "files.quickAccess.label", itemPrefix: "f57.explorer.quickAccessItem.", nodes: fixture.quickAccess as TreeNode[] },
    {
      id: "f57.explorer.v2.fetchedGroup",
      groupId: "f57.explorer.v2.fetchedGroup",
      labelKey: "files.v2.fetched.group",
      itemPrefix: "f57.explorer.v2.fetchedNode.",
      nodes: (fixture as { fetched?: TreeNode[] }).fetched || [],
    },
    { id: "f57.explorer.thisPc", groupId: "f57.explorer.thisPc", labelKey: "files.thisPc.label", itemPrefix: "f57.explorer.thisPcItem.", nodes: fixture.thisPc as TreeNode[], stubKey: "files.v2.thisPc.stub" },
  ];

  return (
    <nav id="f57.explorer.tree" aria-label={t("files.tree.label")} data-testid="explorer-tree" className="w-56 shrink-0 bg-surface border border-default rounded-md p-2 flex flex-col gap-3 self-start">
      {groups.map((g) => (
        <div key={g.groupId} id={g.groupId} data-testid={g.groupId} className="flex flex-col gap-1">
          <h2 className="px-2 text-xs font-semibold text-tertiary">{t(g.labelKey)}</h2>
          {g.nodes.map((n) => (
            <button
              key={n.id}
              id={g.itemPrefix + n.id}
              type="button"
              aria-current={n.path === activePath ? "true" : undefined}
              onClick={() => onSelect(n)}
              className={
                "h-11 px-2 rounded-md text-left text-sm truncate inline-flex items-center gap-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent " +
                (n.path === activePath ? "bg-accent/10 text-accent font-medium" : "text-secondary hover:bg-raised")
              }
            >
              <span className="truncate">{t(n.labelKey)}</span>
              {n.badgeKey ? (
                <span id={"f57.explorer.v2.reservedBadge." + n.id} data-testid="reserved-badge" className="shrink-0 rounded bg-raised px-1.5 py-0.5 text-[10px] text-tertiary">
                  {t(n.badgeKey)}
                </span>
              ) : null}
            </button>
          ))}
          {g.stubKey ? <p className="px-2 text-[10px] text-tertiary">{t(g.stubKey)}</p> : null}
        </div>
      ))}
    </nav>
  );
}
