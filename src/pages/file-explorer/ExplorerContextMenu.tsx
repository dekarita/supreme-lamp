// [F57 §2] Context menu: opens on right-click AND on long-press (touch/pen),
// closes on Escape / outside click / scroll. Items mirror the command bar plus
// the two destructive-confirm entries; `f57.explorer.ops.contextMenu` is the
// id the gate pins, and every item carries data-action so the menu is testable
// without pixel math.
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Clipboard, Copy, CornerUpLeft, FilePlus2, FolderPlus, Pencil, Scissors, Share2, Trash2, ShieldAlert } from "lucide-react";
import type { ExplorerCommand } from "./ExplorerCommandBar";

export interface ContextMenuState {
  x: number;
  y: number;
  /** Empty = menu opened on the background (create/paste only). */
  rowIds: string[];
}

interface Item {
  id: string;
  action: string;
  key: string;
  icon: typeof Copy;
  command: ExplorerCommand | "deletePermanent";
  needsRow: boolean;
}

const ITEMS: Item[] = [
  { id: "ctxOpen", action: "open", key: "files.ops.ctx.open", icon: FolderPlus, command: "rename", needsRow: true },
  { id: "ctxNewFolder", action: "newFolder", key: "files.ops.ctx.newFolder", icon: FolderPlus, command: "newFolder", needsRow: false },
  { id: "ctxNewFile", action: "newFile", key: "files.ops.ctx.newFile", icon: FilePlus2, command: "newFile", needsRow: false },
  { id: "ctxRename", action: "rename", key: "files.ops.ctx.rename", icon: Pencil, command: "rename", needsRow: true },
  { id: "ctxCut", action: "cut", key: "files.ops.ctx.cut", icon: Scissors, command: "cut", needsRow: true },
  { id: "ctxCopy", action: "copy", key: "files.ops.ctx.copy", icon: Copy, command: "copy", needsRow: true },
  { id: "ctxPaste", action: "paste", key: "files.ops.ctx.paste", icon: Clipboard, command: "paste", needsRow: false },
  { id: "ctxShare", action: "share", key: "files.ops.ctx.share", icon: Share2, command: "share", needsRow: true },
  { id: "ctxTrash", action: "trash", key: "files.ops.ctx.trash", icon: Trash2, command: "delete", needsRow: true },
  { id: "ctxDeletePermanent", action: "deletePermanent", key: "files.ops.ctx.deletePermanent", icon: ShieldAlert, command: "deletePermanent", needsRow: true },
  { id: "ctxUndo", action: "undo", key: "files.ops.ctx.undo", icon: CornerUpLeft, command: "undo", needsRow: false },
];

export function ExplorerContextMenu({
  state,
  onCommand,
  onClose,
}: {
  state: ContextMenuState | null;
  onCommand: (command: ExplorerCommand | "deletePermanent", rowIds: string[]) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!state) return;
    const onDown = (e: Event) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    document.addEventListener("scroll", onClose, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("scroll", onClose, true);
    };
  }, [state, onClose]);

  if (!state) return null;
  const hasRow = state.rowIds.length > 0;
  return (
    <div
      ref={ref}
      id="f57.explorer.ops.contextMenu"
      data-testid="explorer-context-menu"
      role="menu"
      aria-label={t("files.ops.ctx.label")}
      data-row-ids={state.rowIds.join(",")}
      style={{ left: state.x, top: state.y }}
      className="fixed z-50 min-w-48 rounded-md border border-default glass-menu p-1 shadow-lg"
    >
      {ITEMS.filter((it) => !it.needsRow || hasRow).map((it) => (
        <button
          key={it.id}
          id={"f57.explorer.ops." + it.id}
          type="button"
          role="menuitem"
          data-testid={it.id}
          data-action={it.action}
          onClick={() => {
            onCommand(it.command, state.rowIds);
            onClose();
          }}
          className="w-full h-9 px-2 rounded text-left text-xs text-primary hover:bg-raised inline-flex items-center gap-2"
        >
          <it.icon className="size-3.5" aria-hidden />
          {t(it.key)}
        </button>
      ))}
    </div>
  );
}

/** Long-press detector used by rows + tree nodes (touch and pen). */
export const LONG_PRESS_MS = 550;

export function useLongPress(onLongPress: (x: number, y: number) => void, ms = LONG_PRESS_MS) {
  const timer = useRef<number | null>(null);
  const origin = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const clear = () => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
  };
  useEffect(() => clear, []);
  return {
    onPointerDown: (e: React.PointerEvent) => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      origin.current = { x: e.clientX, y: e.clientY };
      clear();
      timer.current = window.setTimeout(() => onLongPress(origin.current.x, origin.current.y), ms);
    },
    onPointerUp: clear,
    onPointerLeave: clear,
    onPointerMove: (e: React.PointerEvent) => {
      const dx = Math.abs(e.clientX - origin.current.x);
      const dy = Math.abs(e.clientY - origin.current.y);
      if (dx > 8 || dy > 8) clear();
    },
    onPointerCancel: clear,
  };
}
