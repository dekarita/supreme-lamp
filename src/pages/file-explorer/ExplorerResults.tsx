// [F57 §2/§4] Results grid/list with real multi-select, context-menu and
// HTML5 drag-drop wiring. The frozen F56-c surface (ids f57.explorer.results /
// f57.explorer.row.<id>, data-view, the list/grid toggle) is preserved; rows
// gain aria-selected, draggable, drop targets for folders, the drop indicator
// and the inline create/rename editor.
import { useTranslation } from "react-i18next";
import { File, Folder } from "lucide-react";
import type { SelectionState } from "@/lib/explorer/selection";
import { isSelected } from "@/lib/explorer/selection";
import { useLongPress } from "./ExplorerContextMenu";

export interface FixtureRow {
  id: string;
  name: string;
  kind: "folder" | "file";
  sizeBytes: number | null;
  modified: string;
}

export type ViewMode = "list" | "grid";

export interface InlineEditor {
  id: string | null;
  mode: "create" | "rename";
  value: string;
}

export interface ExplorerResultsProps {
  rows: FixtureRow[];
  view: ViewMode;
  onView: (v: ViewMode) => void;
  selection: SelectionState;
  onSelect: (row: FixtureRow, mods: { shift?: boolean; ctrl?: boolean; meta?: boolean }) => void;
  onOpen: (row: FixtureRow) => void;
  onContextMenuRow: (row: FixtureRow, x: number, y: number) => void;
  onContextMenuBackground: (x: number, y: number) => void;
  draggingIds: string[];
  dropTargetId: string | null;
  dropAllowed: boolean;
  onDragStartRow: (row: FixtureRow, e: React.DragEvent) => void;
  onDragOverTarget: (targetId: string, e: React.DragEvent) => void;
  onDragLeaveTarget: (e: React.DragEvent) => void;
  onDropTarget: (targetId: string, e: React.DragEvent) => void;
  editor: InlineEditor | null;
  onEditorChange: (value: string) => void;
  onEditorCommit: () => void;
  onEditorCancel: () => void;
  readOnly: boolean;
}

export function ExplorerResults(props: ExplorerResultsProps) {
  const { t } = useTranslation();
  const {
    rows,
    view,
    onView,
    selection,
    onSelect,
    onOpen,
    onContextMenuRow,
    onContextMenuBackground,
    draggingIds,
    dropTargetId,
    dropAllowed,
    onDragStartRow,
    onDragOverTarget,
    onDragLeaveTarget,
    onDropTarget,
    editor,
    onEditorChange,
    onEditorCommit,
    onEditorCancel,
    readOnly,
  } = props;

  return (
    <section
      id="f57.explorer.results"
      data-testid="explorer-results"
      data-view={view}
      data-drop-active={dropTargetId === "container" ? "true" : undefined}
      data-drop-allowed={dropTargetId ? String(dropAllowed) : undefined}
      onContextMenu={(e) => {
        e.preventDefault();
        onContextMenuBackground(e.clientX, e.clientY);
      }}
      onDragOver={(e) => onDragOverTarget("container", e)}
      onDragLeave={onDragLeaveTarget}
      onDrop={(e) => onDropTarget("container", e)}
      className="bg-surface border border-default rounded-md p-2 flex flex-col gap-2 flex-1 min-w-0"
    >
      <div className="flex items-center gap-2">
        <h2 className="text-sm font-semibold text-primary">{t("files.results.label")}</h2>
        {selection.ids.length > 1 ? (
          <span id="f57.explorer.ops.selectionBar" data-testid="selection-count" className="rounded bg-raised px-2 py-0.5 text-[10px] text-tertiary">
            {t("files.ops.selection.count", { count: selection.ids.length })}
          </span>
        ) : null}
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
        className={view === "list" ? "flex flex-col divide-y divide-default" : "grid grid-cols-2 md:grid-cols-3 gap-2"}
      >
        {editor && editor.mode === "create" ? (
          <li className="p-1">
            <input
              id="f57.explorer.ops.renameInput"
              data-testid="inline-editor"
              data-mode="create"
              value={editor.value}
              aria-label={t("files.ops.create.nameLabel")}
              onChange={(e) => onEditorChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") onEditorCommit();
                if (e.key === "Escape") onEditorCancel();
              }}
              autoFocus
              className="h-9 w-full rounded border border-default bg-base px-2 text-sm"
            />
          </li>
        ) : null}
        {rows.map((r) => (
          <Row
            key={r.id}
            row={r}
            view={view}
            selected={isSelected(selection, r.id)}
            dragging={draggingIds.indexOf(r.id) >= 0}
            dropActive={dropTargetId === r.id}
            dropAllowed={dropAllowed}
            readOnly={readOnly}
            editor={editor && editor.id === r.id ? editor : null}
            onSelect={onSelect}
            onOpen={onOpen}
            onContextMenuRow={onContextMenuRow}
            onDragStartRow={onDragStartRow}
            onDragOverTarget={onDragOverTarget}
            onDragLeaveTarget={onDragLeaveTarget}
            onDropTarget={onDropTarget}
            onEditorChange={onEditorChange}
            onEditorCommit={onEditorCommit}
            onEditorCancel={onEditorCancel}
          />
        ))}
      </ul>
      {dropTargetId === "container" && dropAllowed ? (
        <div id="f57.explorer.ops.dropIndicator" data-testid="drop-indicator" data-drop-target="container" className="rounded border border-dashed border-accent p-2 text-xs text-accent">
          {t("files.ops.drop.moveHere")}
        </div>
      ) : null}
    </section>
  );
}

function Row(props: {
  row: FixtureRow;
  view: ViewMode;
  selected: boolean;
  dragging: boolean;
  dropActive: boolean;
  dropAllowed: boolean;
  readOnly: boolean;
  editor: InlineEditor | null;
  onSelect: (row: FixtureRow, mods: { shift?: boolean; ctrl?: boolean; meta?: boolean }) => void;
  onOpen: (row: FixtureRow) => void;
  onContextMenuRow: (row: FixtureRow, x: number, y: number) => void;
  onDragStartRow: (row: FixtureRow, e: React.DragEvent) => void;
  onDragOverTarget: (targetId: string, e: React.DragEvent) => void;
  onDragLeaveTarget: (e: React.DragEvent) => void;
  onDropTarget: (targetId: string, e: React.DragEvent) => void;
  onEditorChange: (value: string) => void;
  onEditorCommit: () => void;
  onEditorCancel: () => void;
}) {
  const { t } = useTranslation();
  const { row: r, selected, dragging, dropActive, dropAllowed, readOnly, editor } = props;
  const longPress = useLongPress((x, y) => props.onContextMenuRow(r, x, y));
  const Icon = r.kind === "folder" ? Folder : File;
  const isFolder = r.kind === "folder";

  if (editor) {
    return (
      <li id={"f57.explorer.row." + r.id} data-testid="explorer-row" data-row-id={r.id} className="p-1">
        <input
          id="f57.explorer.ops.renameInput"
          data-testid="inline-editor"
          data-mode="rename"
          value={editor.value}
          aria-label={t("files.ops.rename.label")}
          onChange={(e) => props.onEditorChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") props.onEditorCommit();
            if (e.key === "Escape") props.onEditorCancel();
          }}
          autoFocus
          className="h-9 w-full rounded border border-default bg-base px-2 text-sm"
        />
      </li>
    );
  }

  return (
    <li
      id={"f57.explorer.row." + r.id}
      data-testid="explorer-row"
      data-row-id={r.id}
      data-kind={r.kind}
      data-selected={selected ? "true" : "false"}
      data-dragging={dragging ? "true" : undefined}
      draggable={!readOnly}
      onDragStart={(e) => props.onDragStartRow(r, e)}
      onDragEnd={props.onDragLeaveTarget}
      onDragOver={isFolder ? (e) => props.onDragOverTarget(r.id, e) : undefined}
      onDragLeave={isFolder ? props.onDragLeaveTarget : undefined}
      onDrop={isFolder ? (e) => props.onDropTarget(r.id, e) : undefined}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation(); // the section handler is for the BACKGROUND only
        props.onContextMenuRow(r, e.clientX, e.clientY);
      }}
      {...longPress}
      className={
        "rounded-md " +
        (dropActive ? (dropAllowed ? "ring-2 ring-accent " : "ring-2 ring-danger ") : "") +
        (dragging ? "opacity-60 " : "")
      }
    >
      <button
        type="button"
        aria-selected={selected}
        data-testid="explorer-row-button"
        onClick={(e) => props.onSelect(r, { shift: e.shiftKey, ctrl: e.ctrlKey, meta: e.metaKey })}
        onDoubleClick={() => props.onOpen(r)}
        className={
          "w-full h-11 px-2 rounded-md text-left text-sm flex items-center gap-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent " +
          (selected ? "bg-accent/10 text-accent" : "text-primary hover:bg-raised")
        }
      >
        <Icon className="size-4 shrink-0 text-tertiary" aria-hidden />
        <span className="truncate flex-1 min-w-0">{r.name}</span>
        <span className="text-xs text-tertiary shrink-0">{isFolder ? t("files.results.kind.folder") : t("files.results.kind.file")}</span>
        <span className="text-xs font-mono text-secondary shrink-0 w-20 text-right">{r.sizeBytes != null ? String(r.sizeBytes) : "—"}</span>
        <span className="text-xs font-mono text-tertiary shrink-0 w-24 text-right hidden md:inline">{r.modified.slice(0, 10)}</span>
      </button>
    </li>
  );
}
