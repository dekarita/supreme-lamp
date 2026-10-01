// [F56-c] File Explorer shell - left tree (Quick Access + This PC stubs), with
// [F56-c v2] the reserved "Fetched" root between them.
// [F57 §4] Every folder node is now a DRAG-DROP ZONE (data-drop-target +
// indicator) and a new group exposes the trash; the frozen F56-c/F56-c v2 ids
// and the reserved badge render exactly as before.
import { useTranslation } from "react-i18next";
import { Trash2 } from "lucide-react";
import fixture from "./fixture.json";
import { useLongPress } from "./ExplorerContextMenu";

export interface TreeNode {
  id: string;
  labelKey: string;
  path: string;
  badgeKey?: string;
}

export interface ExplorerTreeProps {
  activePath: string;
  onSelect: (n: TreeNode) => void;
  dragging: boolean;
  dropTargetId: string | null;
  dropAllowed: boolean;
  onDragOverNode: (id: string, path: string, e: React.DragEvent) => void;
  onDragLeaveNode: (e: React.DragEvent) => void;
  onDropNode: (id: string, path: string, e: React.DragEvent) => void;
}

const TRASH_NODE = { id: "ops-trash", path: "D:\\RDP-Storage\\.trash", labelKey: "files.ops.trash.node" };

export function ExplorerTree(props: ExplorerTreeProps) {
  const { t } = useTranslation();
  const { activePath, onSelect, dragging, dropTargetId, dropAllowed } = props;
  const groups: Array<{ id: string; groupId: string; labelKey: string; itemPrefix: string; nodes: TreeNode[]; stubKey?: string }> = [
    { id: "f57.explorer.quickAccess", groupId: "f57.explorer.quickAccess", labelKey: "files.quickAccess.label", itemPrefix: "f57.explorer.quickAccessItem.", nodes: fixture.quickAccess as TreeNode[] },
    { id: "f57.explorer.v2.fetchedGroup", groupId: "f57.explorer.v2.fetchedGroup", labelKey: "files.v2.fetched.group", itemPrefix: "f57.explorer.v2.fetchedNode.", nodes: (fixture as { fetched?: TreeNode[] }).fetched || [] },
    { id: "f57.explorer.thisPc", groupId: "f57.explorer.thisPc", labelKey: "files.thisPc.label", itemPrefix: "f57.explorer.thisPcItem.", nodes: fixture.thisPc as TreeNode[], stubKey: "files.v2.thisPc.stub" },
  ];

  return (
    <nav id="f57.explorer.tree" aria-label={t("files.tree.label")} data-testid="explorer-tree" className="w-56 shrink-0 bg-surface border border-default rounded-md p-2 flex flex-col gap-3 self-start">
      {groups.map((g) => (
        <div key={g.groupId} id={g.groupId} data-testid={g.groupId} className="flex flex-col gap-1">
          <h2 className="px-2 text-xs font-semibold text-tertiary">{t(g.labelKey)}</h2>
          {g.nodes.map((n) => (
            <TreeNodeButton
              key={n.id}
              node={n}
              id={g.itemPrefix + n.id}
              active={n.path === activePath}
              dragging={dragging}
              dropActive={dropTargetId === n.id}
              dropAllowed={dropAllowed}
              onSelect={onSelect}
              onDragOverNode={props.onDragOverNode}
              onDragLeaveNode={props.onDragLeaveNode}
              onDropNode={props.onDropNode}
            />
          ))}
          {g.stubKey ? <p className="px-2 text-[10px] text-tertiary">{t(g.stubKey)}</p> : null}
        </div>
      ))}
      {/* [F57 §4] Trash view - soft-deleted entries + restore/purge. */}
      <div id="f57.explorer.ops.trashGroup" className="flex flex-col gap-1">
        <h2 className="px-2 text-xs font-semibold text-tertiary">{t("files.ops.trash.group")}</h2>
        <TreeNodeButton
          node={{ id: TRASH_NODE.id, labelKey: TRASH_NODE.labelKey, path: TRASH_NODE.path }}
          id="f57.explorer.ops.trashNode"
          active={activePath === TRASH_NODE.path}
          dragging={dragging}
          dropActive={dropTargetId === "ops-trash"}
          dropAllowed={false}
          onSelect={onSelect}
          onDragOverNode={props.onDragOverNode}
          onDragLeaveNode={props.onDragLeaveNode}
          onDropNode={props.onDropNode}
          icon
        />
      </div>
    </nav>
  );
}

function TreeNodeButton({
  node,
  id,
  active,
  dragging,
  dropActive,
  dropAllowed,
  onSelect,
  onDragOverNode,
  onDragLeaveNode,
  onDropNode,
  icon,
}: {
  node: TreeNode;
  id: string;
  active: boolean;
  dragging: boolean;
  dropActive: boolean;
  dropAllowed: boolean;
  onSelect: (n: TreeNode) => void;
  onDragOverNode: (id: string, path: string, e: React.DragEvent) => void;
  onDragLeaveNode: (e: React.DragEvent) => void;
  onDropNode: (id: string, path: string, e: React.DragEvent) => void;
  icon?: boolean;
}) {
  const { t } = useTranslation();
  const longPress = useLongPress(() => onSelect(node));
  return (
    <button
      id={id}
      type="button"
      aria-current={active ? "true" : undefined}
      data-drop-target={dropActive ? "true" : undefined}
      data-drop-allowed={dropActive ? String(dropAllowed) : undefined}
      onClick={() => onSelect(node)}
      onDragOver={(e) => onDragOverNode(node.id, node.path, e)}
      onDragLeave={onDragLeaveNode}
      onDrop={(e) => onDropNode(node.id, node.path, e)}
      {...longPress}
      className={
        "h-11 px-2 rounded-md text-left text-sm truncate inline-flex items-center gap-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent " +
        (dropActive ? (dropAllowed ? "ring-2 ring-accent " : "ring-2 ring-danger ") : "") +
        (dragging ? "opacity-90 " : "") +
        (active ? "bg-accent/10 text-accent font-medium" : "text-secondary hover:bg-raised")
      }
    >
      {icon ? <Trash2 className="size-4 shrink-0 text-tertiary" aria-hidden /> : null}
      <span className="truncate">{t(node.labelKey)}</span>
      {node.badgeKey ? (
        <span id={"f57.explorer.v2.reservedBadge." + node.id} data-testid="reserved-badge" className="shrink-0 rounded bg-raised px-1.5 py-0.5 text-[10px] text-tertiary">
          {t(node.badgeKey)}
        </span>
      ) : null}
    </button>
  );
}
