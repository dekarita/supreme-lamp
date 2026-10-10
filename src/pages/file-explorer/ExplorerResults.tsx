// [F57 §2/§4] Results grid/list with real multi-select, context-menu and
// HTML5 drag-drop wiring. The frozen F56-c surface (ids f57.explorer.results /
// f57.explorer.row.<id>, data-view, the list/grid toggle) is preserved; rows
// gain aria-selected, draggable, drop targets for folders, the drop indicator
// and the inline create/rename editor.
//
// [R-FILES / #217] SCALE. This list used to render every row into the DOM, so a
// 5000-entry directory meant 5000 <li> elements on first paint. It now renders
// a windowed slice with the react-window version ALREADY in package.json
// (1.8.10 - the same v1 API and the same pattern ResultsGrid.tsx ships; no v2
// bump, no second virtualization library).
//
// Everything the frozen F57 contract depends on is preserved on purpose:
//   * stable row component identity (module-level `Row`, never re-created);
//   * stable item keys (`itemKey` = the row id, so React recycles by identity
//     and no row ever inherits another row's local state);
//   * selection stays EXTERNAL (FileExplorer owns it) - unmounting a row does
//     not deselect it;
//   * long-press / context menu / drag-drop / inline rename keep their
//     handlers, and a row that scrolls off screen is re-created with the same
//     props when it comes back;
//   * list semantics are kept with ARIA roles (react-window renders divs, not
//     ul/li, so `role="list"` / `role="listitem"` carry the meaning);
//   * keyboard navigation moves a cursor and SCROLLS the target row into view
//     (an offscreen selection you cannot see is not navigation).
import { forwardRef, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { FixedSizeList, type ListChildComponentProps } from "react-window";
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

/** Row height in the list view - identical to the frozen `h-11` (44px). */
export const LIST_ROW_HEIGHT = 44;
/** One row of grid cards (a card is two lines tall). */
export const GRID_ROW_HEIGHT = 96;
/** Hard cap on the windowed viewport, so a huge directory cannot push the page. */
export const MAX_VISIBLE_LIST_ROWS = 14;
export const MAX_VISIBLE_GRID_ROWS = 6;
/** Grid column count fallback when no ResizeObserver / no measured width. */
export const DEFAULT_GRID_COLUMNS = 2;
/** react-window renders a few extra rows above/below the viewport. */
const OVERSCAN = 4;

type Entry = { kind: "editor" } | { kind: "row"; row: FixtureRow };

interface RowData {
  entries: Entry[];
  columns: number;
  view: ViewMode;
  selection: SelectionState;
  draggingIds: string[];
  dropTargetId: string | null;
  dropAllowed: boolean;
  editor: InlineEditor | null;
  readOnly: boolean;
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
}

// NOTE ON THE itemData IDENTITY (this is load-bearing, do not "optimise" it).
// react-window v1's List is a React.PureComponent: if none of its props change
// identity it does NOT re-render, so a permanently-stable `itemData` object
// freezes the rows at their first snapshot - selection, dragging state and the
// inline editor would silently stop updating. `rowData` therefore changes
// identity whenever any input changes (see the useMemo below), while the ROW
// RENDERER itself stays referentially stable so React updates rows in place
// instead of unmounting them (which would drop the rename input's focus).

/** react-window's outer element - carries the list role and the frozen testid. */
const ListOuter = forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(function ListOuter(props, ref) {
  return <div ref={ref} role="list" data-testid="explorer-rows" {...props} />;
});

/** react-window's inner element - presentational; the roles live on the rows. */
const ListInner = forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(function ListInner(props, ref) {
  return <div ref={ref} role="presentation" {...props} />;
});

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

/** The columns the grid view should use for a measured container width. */
export function gridColumnsForWidth(width: number): number {
  if (!(width > 0)) return DEFAULT_GRID_COLUMNS;
  if (width >= 768) return 3; // matches the frozen `md:grid-cols-3`
  if (width >= 480) return 2;
  return 2; // `grid-cols-2` below md
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

  const listRef = useRef<FixedSizeList | null>(null);
  const scrollHostRef = useRef<HTMLDivElement | null>(null);
  const [measuredWidth, setMeasuredWidth] = useState(0);

  // Responsive grid columns. The old markup used CSS (grid-cols-2 md:grid-cols-3);
  // a windowed list must know its column count up front, so the width is measured.
  useEffect(() => {
    const el = scrollHostRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect?.width || 0;
      setMeasuredWidth(w);
    });
    ro.observe(el);
    setMeasuredWidth(el.getBoundingClientRect().width || 0);
    return () => ro.disconnect();
  }, [view]);

  const columns = view === "list" ? 1 : gridColumnsForWidth(measuredWidth);
  const rowHeight = view === "list" ? LIST_ROW_HEIGHT : GRID_ROW_HEIGHT;

  // The create editor occupies slot 0 of the windowed list, exactly where the
  // old markup put it (first child of the list).
  const hasCreateEditor = !!(editor && editor.mode === "create");
  const entries: Entry[] = useMemo(() => {
    const out: Entry[] = [];
    if (hasCreateEditor) out.push({ kind: "editor" });
    for (const r of rows) out.push({ kind: "row", row: r });
    return out;
  }, [hasCreateEditor, rows]);

  const groupCount = Math.max(1, Math.ceil(entries.length / columns));
  const maxVisible = view === "list" ? MAX_VISIBLE_LIST_ROWS : MAX_VISIBLE_GRID_ROWS;
  // Only announce windowing when the list is actually clipped: a 6-row fixture
  // renders in full and must not claim to be windowed.
  const windowing = groupCount > maxVisible;
  const height = Math.max(rowHeight, Math.min(groupCount, maxVisible) * rowHeight);

  const rowData = useMemo<RowData>(
    () => ({
      entries,
      columns,
      view,
      selection,
      draggingIds,
      dropTargetId,
      dropAllowed,
      editor,
      readOnly,
      onSelect,
      onOpen,
      onContextMenuRow,
      onDragStartRow,
      onDragOverTarget,
      onDragLeaveTarget,
      onDropTarget,
      onEditorChange,
      onEditorCommit,
      onEditorCancel,
    }),
    [
      entries,
      columns,
      view,
      selection,
      draggingIds,
      dropTargetId,
      dropAllowed,
      editor,
      readOnly,
      onSelect,
      onOpen,
      onContextMenuRow,
      onDragStartRow,
      onDragOverTarget,
      onDragLeaveTarget,
      onDropTarget,
      onEditorChange,
      onEditorCommit,
      onEditorCancel,
    ],
  );

  const itemKey = useCallback(
    (index: number) => {
      const e = entries[index];
      return e && e.kind === "row" ? "row:" + e.row.id : "editor:" + index;
    },
    [entries],
  );

  // [R-FILES / #217] Keep the row the operator is acting on IN VIEW. A rename
  // started from the command bar, or a keyboard move past the window edge,
  // scrolls the target into view instead of editing an invisible row.
  const editorRowIndex = useMemo(() => {
    if (!editor || editor.mode !== "rename" || !editor.id) return -1;
    return entries.findIndex((e) => e.kind === "row" && e.row.id === editor.id);
  }, [editor, entries]);

  useEffect(() => {
    if (editorRowIndex >= 0) listRef.current?.scrollToItem(editorRowIndex, "smart");
  }, [editorRowIndex]);

  // Keyboard navigation. Selection stays external: this only moves the cursor
  // and asks FileExplorer to select, then scrolls the row into view.
  const cursorIndex = useMemo(() => {
    const anchor = selection.anchor;
    if (!anchor) return -1;
    return entries.findIndex((e) => e.kind === "row" && e.row.id === anchor);
  }, [selection.anchor, entries]);

  const moveCursor = useCallback(
    (delta: number, e: React.KeyboardEvent) => {
      if (!entries.length) return;
      const firstRow = entries.findIndex((x) => x.kind === "row");
      if (firstRow < 0) return;
      e.preventDefault();
      const from = cursorIndex >= 0 ? cursorIndex : firstRow - 1;
      let next = from + delta;
      // skip the create-editor slot while arrowing through rows
      while (next >= 0 && next < entries.length && entries[next].kind !== "row") next += delta;
      next = Math.max(0, Math.min(entries.length - 1, next));
      const entry = entries[next];
      if (!entry || entry.kind !== "row") return;
      listRef.current?.scrollToItem(next, "smart");
      onSelect(entry.row, { shift: e.shiftKey });
    },
    [entries, cursorIndex, onSelect],
  );

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "ArrowDown") moveCursor(1, e);
      else if (e.key === "ArrowUp") moveCursor(-1, e);
      else if (e.key === "Home") {
        const first = entries.findIndex((x) => x.kind === "row");
        if (first >= 0) {
          e.preventDefault();
          listRef.current?.scrollToItem(first, "start");
          const entry = entries[first];
          if (entry.kind === "row") onSelect(entry.row, {});
        }
      } else if (e.key === "End") {
        const last = entries.length - 1;
        if (last >= 0 && entries[last].kind === "row") {
          e.preventDefault();
          listRef.current?.scrollToItem(last, "end");
          const entry = entries[last];
          if (entry.kind === "row") onSelect(entry.row, {});
        }
      }
    },
    [entries, moveCursor, onSelect],
  );

  const RowRenderer = useCallback(
    ({ index, style, data }: ListChildComponentProps<RowData>) => {
      const slice: Entry[] = [];
      for (let c = 0; c < data.columns; c += 1) {
        const e = data.entries[index * data.columns + c];
        if (e) slice.push(e);
      }
      return (
        <div
          role="listitem"
          style={style}
          className={data.columns > 1 ? "grid grid-cols-2 md:grid-cols-3 gap-2" : "flex flex-col"}
        >
          {slice.map((e) =>
            e.kind === "editor" ? (
              <CreateEditor
                key="create-editor"
                value={data.editor ? data.editor.value : ""}
                label={t("files.ops.create.nameLabel")}
                onChange={data.onEditorChange}
                onCommit={data.onEditorCommit}
                onCancel={data.onEditorCancel}
              />
            ) : (
              <Row
                key={"row:" + e.row.id}
                row={e.row}
                view={data.view}
                selected={isSelected(data.selection, e.row.id)}
                dragging={data.draggingIds.indexOf(e.row.id) >= 0}
                dropActive={data.dropTargetId === e.row.id}
                dropAllowed={data.dropAllowed}
                readOnly={data.readOnly}
                editor={data.editor && data.editor.id === e.row.id ? data.editor : null}
                onSelect={data.onSelect}
                onOpen={data.onOpen}
                onContextMenuRow={data.onContextMenuRow}
                onDragStartRow={data.onDragStartRow}
                onDragOverTarget={data.onDragOverTarget}
                onDragLeaveTarget={data.onDragLeaveTarget}
                onDropTarget={data.onDropTarget}
                onEditorChange={data.onEditorChange}
                onEditorCommit={data.onEditorCommit}
                onEditorCancel={data.onEditorCancel}
              />
            ),
          )}
        </div>
      );
    },
    // `t` is the only stable dep: a new function identity per render would be a
    // new element TYPE to React, remounting every row on every keystroke.
    [t],
  );

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
        {windowing ? (
          <span
            id="f57.explorer.windowedNote"
            data-testid="explorer-windowed-note"
            data-windowed="1"
            data-total={String(rows.length)}
            className="rounded bg-raised px-2 py-0.5 text-[10px] text-tertiary"
          >
            {t("files.results.windowed", { shown: String(Math.min(groupCount, maxVisible) * columns), total: String(rows.length) })}
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
      <div ref={scrollHostRef} onKeyDown={onKeyDown} className="min-w-0">
        {entries.length === 0 ? (
          <div role="list" data-testid="explorer-rows" className="flex flex-col divide-y divide-default" />
        ) : (
          <FixedSizeList
            ref={listRef}
            height={height}
            itemCount={groupCount}
            itemSize={rowHeight}
            itemKey={itemKey}
            itemData={rowData}
            overscanCount={OVERSCAN}
            width="100%"
            outerElementType={ListOuter}
            innerElementType={ListInner}
            className="outline-none"
          >
            {RowRenderer}
          </FixedSizeList>
        )}
      </div>
      {dropTargetId === "container" && dropAllowed ? (
        <div id="f57.explorer.ops.dropIndicator" data-testid="drop-indicator" data-drop-target="container" className="rounded border border-dashed border-accent p-2 text-xs text-accent">
          {t("files.ops.drop.moveHere")}
        </div>
      ) : null}
    </section>
  );
}

function CreateEditor(props: {
  value: string;
  label: string;
  onChange: (v: string) => void;
  onCommit: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="p-1">
      <input
        id="f57.explorer.ops.renameInput"
        data-testid="inline-editor"
        data-mode="create"
        value={props.value}
        aria-label={props.label}
        onChange={(e) => props.onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") props.onCommit();
          if (e.key === "Escape") props.onCancel();
        }}
        autoFocus
        className="h-9 w-full rounded border border-default bg-base px-2 text-sm"
      />
    </div>
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
      <div id={"f57.explorer.row." + r.id} data-testid="explorer-row" data-row-id={r.id} className="p-1">
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
      </div>
    );
  }

  return (
    <div
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
        (props.view === "grid" ? "h-[88px] " : "") +
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
    </div>
  );
}
