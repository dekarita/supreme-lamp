// [F56-d] File Explorer page shell - Fetched-root empty-state replaced by file-arrival event listener via ws /ws progress mirrorDiag.
// [F57 §2-§4] REAL file operations: command bar, right-click + long-press
// context menu, multi-select, HTML5 drag-drop across the watcher's six roots,
// inline rename, keyboard shortcuts, soft-delete to D:\RDP-Storage\.trash with
// 30-day retention, and a durable operation queue surfaced in the bottom dock.
// Every op is optimistic on the local index and dispatched through the
// injectable transport (default: POST /api/fx/op, dash-token + CSRF) - the
// Fetched root keeps its F56-d arrival-event feed untouched.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import fixture from "./file-explorer/fixture.json";
import { ExplorerTree, type TreeNode } from "./file-explorer/ExplorerTree";
import { ExplorerCommandBar, type ExplorerCommand } from "./file-explorer/ExplorerCommandBar";
import { ExplorerResults, type FixtureRow, type InlineEditor, type ViewMode } from "./file-explorer/ExplorerResults";
import { ExplorerPreview } from "./file-explorer/ExplorerPreview";
import { ExplorerContextMenu, type ContextMenuState } from "./file-explorer/ExplorerContextMenu";
import { ExplorerTrashView } from "./file-explorer/ExplorerTrashView";
import { ExplorerProgressRail } from "./file-explorer/ExplorerProgressRail";
import { EXPLORER_KEYMAP, tinykeys } from "./file-explorer/keymap";
import { UndoStack, applyOp, buildOp, type ExplorerOp, type OpEntry } from "@/lib/explorer/ops";
import {
  EMPTY_SELECTION,
  clickSelect,
  selectAll,
  selectedRows,
  type SelectionState,
} from "@/lib/explorer/selection";
import { dropRefusalKey, resolveDropTarget } from "@/lib/explorer/roots";
import { useTrashStore } from "@/lib/explorer/trashStore";
import { useExplorerQueueStore } from "@/lib/explorer/queueStore";
import { useToastStore } from "@/stores/toastStore";
import { copyText } from "@/lib/clipboard";

interface Crumb {
  id: string;
  labelKey: string;
  path: string;
}

export const FETCHED_PATH = "D:\\RDP-Storage\\Fetched";
export const TRASH_PATH = "D:\\RDP-Storage\\.trash";
export const F57_SHORTCUTS = EXPLORER_KEYMAP;

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

export function rowPath(dir: string, row: { name: string }): string {
  return String(dir || "").replace(/\\+$/, "") + "\\" + row.name;
}

export default function FileExplorer() {
  const { t } = useTranslation();
  const push = useToastStore((s) => s.push);
  const [view, setView] = useState<ViewMode>("list");
  const [location, setLocation] = useState<TreeNode>(() => (fixture.thisPc as TreeNode[])[1]);
  const [rows, setRows] = useState<FixtureRow[]>(() => fixture.rows as FixtureRow[]);
  const [fetchedFiles, setFetchedFiles] = useState<FixtureRow[]>([]);
  const [selection, setSelection] = useState<SelectionState>(EMPTY_SELECTION);
  const [clipboard, setClipboard] = useState<{ mode: "copy" | "cut"; entries: FixtureRow[] } | null>(null);
  const [editor, setEditor] = useState<(InlineEditor & { kind: "folder" | "file" }) | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [confirmRows, setConfirmRows] = useState<OpEntry[] | null>(null);
  const [undoSize, setUndoSize] = useState(0);
  const [previewTarget, setPreviewTarget] = useState<FixtureRow | null>(null);
  const [draggingIds, setDraggingIds] = useState<string[]>([]);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [dropAllowed, setDropAllowed] = useState(false);

  const undoRef = useRef(new UndoStack());
  const uploadRef = useRef<HTMLInputElement | null>(null);
  const enqueue = useExplorerQueueStore((s) => s.enqueue);
  const trashEntries = useTrashStore((s) => s.entries);

  const atFetched = location.path === FETCHED_PATH;
  const atTrash = location.path === TRASH_PATH;
  const readOnly = atFetched || atTrash;
  const visibleRows: FixtureRow[] = atFetched ? fetchedFiles : atTrash ? [] : rows;
  const selected = useMemo(() => selectedRows(visibleRows, selection), [visibleRows, selection]);

  // [F56-d §4] The Fetched-root empty state is replaced by a FILE-ARRIVAL event, never
  // by a UI file-API poll: the watcher's post-fetch notify rides the existing /ws
  // progress frame and useDashboardPolling re-emits its `fetchedFiles` as
  // 'ghrdp-fetched-arrival'.
  useEffect(() => {
    if (!atFetched) return;
    let alive = true;

    const onArrival = (evt: Event) => {
      try {
        const custom = evt as CustomEvent;
        const detail = custom.detail;
        if (Array.isArray(detail)) {
          const mapped: FixtureRow[] = detail.map((e: any, idx: number) => ({
            id: e.id || e.name || `fetched-${idx}`,
            name: e.name || e.path || `file-${idx}`,
            kind: "file",
            sizeBytes: Number.isFinite(Number(e.sizeBytes ?? e.size)) ? Number(e.sizeBytes ?? e.size) : null,
            modified: e.modified || new Date().toISOString(),
          }));
          if (alive)
            setFetchedFiles((prev) => {
              const merged = [...prev];
              for (const m of mapped) {
                if (!merged.find((p) => p.name === m.name)) merged.push(m);
              }
              return merged;
            });
        }
      } catch {
        /* ignore malformed frames */
      }
    };

    window.addEventListener("ghrdp-fetched-arrival", onArrival as EventListener);
    return () => {
      alive = false;
      window.removeEventListener("ghrdp-fetched-arrival", onArrival as EventListener);
    };
  }, [atFetched]);

  const startJob = useCallback(
    (ops: ExplorerOp[], label: string) => {
      enqueue(ops, label);
    },
    [enqueue]
  );

  /** Optimistic apply + undo push + queue hand-off for one op. */
  const runOp = useCallback(
    (op: ExplorerOp, reversible = true): boolean => {
      const outcome = applyOp(rows, op);
      if (!outcome.ok) {
        push(t("files.ops.error." + outcome.reason), "warn");
        return false;
      }
      setRows(outcome.rows);
      if (reversible) {
        undoRef.current.push(op);
        setUndoSize(undoRef.current.size());
      }
      startJob([op], op.kind);
      return true;
    },
    [rows, push, t, startJob]
  );

  const trashIdsFor = useCallback((op: ExplorerOp): string[] => {
    const srcIds = op.entries.map((e) => e.id);
    return useTrashStore
      .getState()
      .entries.filter((e) => srcIds.some((id) => e.id.startsWith("trash-" + id + "-")))
      .map((e) => e.id);
  }, []);

  const doUndo = useCallback(() => {
    const rec = undoRef.current.pop();
    if (!rec) {
      push(t("files.ops.undo.empty"), "warn");
      return;
    }
    setUndoSize(undoRef.current.size());
    if (rec.op.kind === "trash") useTrashStore.getState().restore(trashIdsFor(rec.op));
    if (rec.op.kind === "delete") useTrashStore.getState().purge(trashIdsFor(rec.op));
    const outcome = applyOp(rows, rec.inverse);
    if (!outcome.ok) {
      push(t("files.ops.error." + outcome.reason), "warn");
      return;
    }
    setRows(outcome.rows);
    startJob([rec.inverse], "undo:" + rec.op.kind);
    push(t("files.ops.undo.done"), "ok");
  }, [rows, push, t, startJob, trashIdsFor]);

  const softDelete = useCallback(
    (targets: FixtureRow[]) => {
      if (!targets.length) {
        push(t("files.ops.error.empty-selection"), "warn");
        return;
      }
      const entries = targets.map((r) => ({ id: r.id, name: r.name, kind: r.kind, sizeBytes: r.sizeBytes, modified: r.modified }));
      useTrashStore.getState().softDelete(entries, location.path);
      const op = buildOp("trash", entries, { sourceDir: location.path });
      if (runOp(op)) push(t("files.ops.undo.movedToTrash", { count: targets.length }), "ok");
      setSelection(EMPTY_SELECTION);
    },
    [location.path, push, runOp, t]
  );

  const permanentDelete = useCallback(
    (targets: OpEntry[]) => {
      const op = buildOp("delete", targets, { sourceDir: location.path });
      useTrashStore.getState().purge(trashIdsFor(op));
      const outcome = applyOp(rows, op);
      if (!outcome.ok) {
        push(t("files.ops.error." + outcome.reason), "warn");
        return;
      }
      setRows(outcome.rows);
      startJob([op], "purge"); // NOT reversible: the operator confirmed it
      setSelection(EMPTY_SELECTION);
      setConfirmRows(null);
      push(t("files.ops.deletePermanent.done", { count: targets.length }), "warn");
    },
    [location.path, push, rows, startJob, t, trashIdsFor]
  );

  const commitEditor = useCallback(() => {
    if (!editor) return;
    const name = editor.value.trim();
    if (editor.mode === "create") {
      const op = buildOp(editor.kind === "folder" ? "mkdir" : "mkfile", [], { targetName: name, targetDir: location.path });
      if (runOp(op)) push(t("files.ops.create.done", { name }), "ok");
    } else {
      const row = rows.find((r) => r.id === editor.id);
      if (row) {
        const op = buildOp("rename", [row], { targetName: name, sourceDir: location.path });
        if (runOp(op)) push(t("files.ops.rename.done", { name }), "ok");
      }
    }
    setEditor(null);
  }, [editor, location.path, push, rows, runOp, t]);

  const paste = useCallback(() => {
    if (!clipboard || !clipboard.entries.length) {
      push(t("files.ops.paste.empty"), "warn");
      return;
    }
    let list = rows;
    const ops: ExplorerOp[] = [];
    for (const entry of clipboard.entries) {
      const op =
        clipboard.mode === "cut"
          ? buildOp("move", [entry], { targetDir: location.path, sourceDir: location.path })
          : buildOp("copy", [entry], { targetDir: location.path, sourceDir: location.path });
      const outcome = applyOp(list, op);
      if (!outcome.ok) {
        push(t("files.ops.error." + outcome.reason), "warn");
        continue;
      }
      list = outcome.rows;
      ops.push(op);
      undoRef.current.push(op);
    }
    if (!ops.length) return;
    setRows(list);
    setUndoSize(undoRef.current.size());
    startJob(ops, clipboard.mode === "cut" ? "move" : "copy");
    push(t("files.ops.paste.done", { count: ops.length }), "ok");
    if (clipboard.mode === "cut") setClipboard(null);
  }, [clipboard, location.path, push, rows, startJob, t]);

  const openRow = useCallback(
    (row: FixtureRow) => {
      if (row.kind === "folder") {
        setLocation({ id: "row-" + row.id, labelKey: "files.tree.label", path: rowPath(location.path, row) });
        setSelection(EMPTY_SELECTION);
        setPreviewTarget(null);
        return;
      }
      setPreviewTarget(row);
    },
    [location.path]
  );

  const dispatch = useCallback(
    (command: ExplorerCommand | "deletePermanent" | "selectAll" | "open", rowIdsArg?: string[]) => {
      const ids = rowIdsArg && rowIdsArg.length ? rowIdsArg : selection.ids;
      const targets = visibleRows.filter((r) => ids.indexOf(r.id) >= 0);
      const dir = location.path;
      switch (command) {
        case "newFolder":
          setEditor({ id: null, mode: "create", value: t("files.ops.create.folderDefault"), kind: "folder" });
          break;
        case "newFile":
          setEditor({ id: null, mode: "create", value: t("files.ops.create.fileDefault"), kind: "file" });
          break;
        case "rename":
          if (targets.length === 1) setEditor({ id: targets[0].id, mode: "rename", value: targets[0].name, kind: targets[0].kind });
          else push(t("files.ops.rename.needsOne"), "warn");
          break;
        case "delete":
          softDelete(targets);
          break;
        case "deletePermanent":
          if (!targets.length) push(t("files.ops.error.empty-selection"), "warn");
          else setConfirmRows(targets.map((r) => ({ ...r })));
          break;
        case "cut":
        case "copy": {
          if (!targets.length) {
            push(t("files.ops.error.empty-selection"), "warn");
            break;
          }
          setClipboard({ mode: command, entries: targets });
          void copyText(targets.map((r) => rowPath(dir, r)).join("\n"), t("files.ops.command." + command));
          push(command === "cut" ? t("files.ops.clipboard.cut", { count: targets.length }) : t("files.ops.clipboard.copy", { count: targets.length }), "ok");
          break;
        }
        case "paste":
          paste();
          break;
        case "share":
          if (targets.length) void copyText(targets.map((r) => rowPath(dir, r)).join("\n"), t("files.ops.command.share"));
          else push(t("files.ops.error.empty-selection"), "warn");
          break;
        case "undo":
          doUndo();
          break;
        case "refresh": {
          setRows(fixture.rows as FixtureRow[]);
          setSelection(EMPTY_SELECTION);
          useTrashStore.getState().sweep();
          void useExplorerQueueStore.getState().run();
          push(t("files.ops.refresh.done"), "ok");
          break;
        }
        case "upload":
          uploadRef.current?.click();
          break;
        case "selectAll":
          setSelection(selectAll(visibleRows));
          break;
        case "open":
          if (targets.length === 1) openRow(targets[0]);
          break;
        default:
          break;
      }
    },
    [doUndo, location.path, openRow, paste, push, selection.ids, softDelete, t, visibleRows]
  );

  const onSelect = useCallback(
    (row: FixtureRow, mods: { shift?: boolean; ctrl?: boolean; meta?: boolean }) => {
      setSelection((prev) => clickSelect(visibleRows, prev, row.id, mods));
      if (row.kind === "file") setPreviewTarget(row);
    },
    [visibleRows]
  );

  // Keyboard: tinykeys-style table (F2 / Delete / Shift+Delete / mod+c x v a z / Enter).
  useEffect(() => {
    return tinykeys(document, {
      F2: () => dispatch("rename"),
      Delete: () => dispatch("delete"),
      "Shift+Delete": () => dispatch("deletePermanent"),
      "mod+c": () => dispatch("copy"),
      "mod+x": () => dispatch("cut"),
      "mod+v": () => dispatch("paste"),
      "mod+a": () => dispatch("selectAll"),
      "mod+z": () => dispatch("undo"),
      Enter: () => dispatch("open"),
    });
  }, [dispatch]);

  // Preview follows the selection: one file selected -> that file.
  useEffect(() => {
    const one = selected.length === 1 && selected[0].kind === "file" ? selected[0] : null;
    setPreviewTarget((prev) => (prev && one && prev.id === one.id ? prev : one));
  }, [selected]);

  // ...and a rename/trash refreshes (or clears) the panel's row snapshot.
  useEffect(() => {
    setPreviewTarget((prev) => (prev ? visibleRows.find((r) => r.id === prev.id) || null : prev));
  }, [visibleRows]);

  const onUploadPicked = useCallback(
    (files: FileList | null) => {
      if (!files || !files.length) return;
      const ops = Array.from(files).map((f, i) =>
        buildOp("upload", [{ id: "upload-" + i + "-" + f.name, name: f.name, kind: "file", sizeBytes: f.size, modified: new Date().toISOString() }])
      );
      startJob(ops, "upload");
      push(t("files.ops.upload.queued", { count: ops.length }), "ok");
    },
    [push, startJob, t]
  );

  const draggingPaths = draggingIds
    .map((id) => visibleRows.find((r) => r.id === id))
    .filter((r): r is FixtureRow => Boolean(r))
    .map((r) => rowPath(location.path, r));

  const dropPlanFor = useCallback(
    (targetId: string, nodePath?: string) => {
      const dest =
        targetId === "container"
          ? location.path
          : nodePath
          ? nodePath
          : rowPath(location.path, visibleRows.find((r) => r.id === targetId) || { name: "" });
      return resolveDropTarget(draggingPaths, dest);
    },
    [draggingPaths, location.path, visibleRows]
  );

  const onDragOverTarget = useCallback(
    (targetId: string, e: React.DragEvent, nodePath?: string) => {
      if (!draggingIds.length) return;
      const plan = dropPlanFor(targetId, nodePath);
      setDropTarget(targetId);
      setDropAllowed(plan.allowed);
      if (plan.allowed) {
        e.preventDefault();
        try {
          e.dataTransfer.dropEffect = "move";
        } catch {
          /* jsdom */
        }
      }
    },
    [draggingIds.length, dropPlanFor]
  );

  const endDrag = useCallback(() => {
    setDraggingIds([]);
    setDropTarget(null);
    setDropAllowed(false);
  }, []);

  const onDropTarget = useCallback(
    (targetId: string, e: React.DragEvent, nodePath?: string) => {
      e.preventDefault();
      const plan = dropPlanFor(targetId, nodePath);
      if (plan.allowed && draggingPaths.length) {
        const targets = visibleRows.filter((r) => draggingIds.indexOf(r.id) >= 0);
        const op = buildOp("move", targets, { targetDir: plan.destination, sourceDir: location.path });
        if (runOp(op)) push(t("files.ops.drop.moved", { count: targets.length }), "ok");
      } else {
        push(t(dropRefusalKey(plan.reason)), "warn");
      }
      endDrag();
    },
    [draggingIds, draggingPaths.length, dropPlanFor, endDrag, location.path, push, runOp, t, visibleRows]
  );

  const onDragStartRow = useCallback(
    (row: FixtureRow, e: React.DragEvent) => {
      const ids = selection.ids.indexOf(row.id) >= 0 ? selection.ids : [row.id];
      setDraggingIds(ids);
      try {
        e.dataTransfer.setData("application/x-ghrdp-explorer", JSON.stringify(ids));
        e.dataTransfer.effectAllowed = "move";
      } catch {
        /* jsdom */
      }
    },
    [selection.ids]
  );

  const openContextMenu = useCallback(
    (row: FixtureRow | null, x: number, y: number) => {
      const ids = row ? (selection.ids.indexOf(row.id) >= 0 ? selection.ids : [row.id]) : [];
      if (row && ids.length === 1) setSelection({ ids, anchor: row.id });
      setContextMenu({ x, y, rowIds: ids });
    },
    [selection.ids]
  );

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

      <ExplorerCommandBar
        hasSelection={selected.length > 0}
        canPaste={Boolean(clipboard && clipboard.entries.length)}
        canUndo={undoSize > 0}
        readOnly={readOnly}
        onCommand={(c) => dispatch(c)}
      />

      <div className="flex flex-wrap items-start gap-3">
        <ExplorerTree
          activePath={location.path}
          onSelect={(n) => {
            setLocation(n);
            setSelection(EMPTY_SELECTION);
          }}
          dragging={draggingIds.length > 0}
          dropTargetId={dropTarget}
          dropAllowed={dropAllowed}
          onDragOverNode={(id, path, e) => onDragOverTarget(id, e, path)}
          onDragLeaveNode={endDrag}
          onDropNode={(id, path, e) => onDropTarget(id, e, path)}
        />
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
                    {f.name} {f.sizeBytes ? `(${f.sizeBytes} bytes)` : ""}
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
        ) : atTrash ? (
          <ExplorerTrashView
            entries={trashEntries}
            onRestore={(ids) => {
              const restored = useTrashStore.getState().restore(ids);
              const op = buildOp(
                "restore",
                restored.map((e) => ({ id: e.id, name: e.name, kind: e.kind, sizeBytes: e.sizeBytes, modified: e.modified }))
              );
              const outcome = applyOp(rows, op);
              if (outcome.ok) setRows(outcome.rows);
              startJob([op], "restore");
              push(t("files.ops.trash.restored", { count: restored.length }), "ok");
            }}
            onPurge={(ids) => {
              const n = useTrashStore.getState().purge(ids);
              push(t("files.ops.trash.purged", { count: n }), "warn");
            }}
          />
        ) : (
          <ExplorerResults
            rows={visibleRows}
            view={view}
            onView={setView}
            selection={selection}
            onSelect={onSelect}
            onOpen={openRow}
            onContextMenuRow={(row, x, y) => openContextMenu(row, x, y)}
            onContextMenuBackground={(x, y) => openContextMenu(null, x, y)}
            draggingIds={draggingIds}
            dropTargetId={dropTarget}
            dropAllowed={dropAllowed}
            onDragStartRow={onDragStartRow}
            onDragOverTarget={onDragOverTarget}
            onDragLeaveTarget={endDrag}
            onDropTarget={onDropTarget}
            editor={editor}
            onEditorChange={(value) => setEditor((prev) => (prev ? { ...prev, value } : prev))}
            onEditorCommit={commitEditor}
            onEditorCancel={() => setEditor(null)}
            readOnly={readOnly}
          />
        )}
        <ExplorerPreview entry={previewTarget ? { id: previewTarget.id, name: previewTarget.name, sizeBytes: previewTarget.sizeBytes } : null} />
      </div>

      <ExplorerProgressRail />

      <input
        ref={uploadRef}
        data-testid="explorer-upload-input"
        type="file"
        multiple
        hidden
        onChange={(e) => {
          onUploadPicked(e.target.files);
          e.target.value = "";
        }}
      />

      <ExplorerContextMenu
        state={contextMenu}
        onCommand={(command, rowIds) => dispatch(command, rowIds)}
        onClose={() => setContextMenu(null)}
      />

      {confirmRows ? (
        <div
          id="f57.explorer.ops.confirmModal"
          data-testid="confirm-modal"
          role="dialog"
          aria-label={t("files.ops.deletePermanent.title")}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
        >
          <div className="w-80 rounded-md border border-default bg-surface p-4 flex flex-col gap-3">
            <h2 className="text-sm font-semibold text-primary">{t("files.ops.deletePermanent.title")}</h2>
            <p className="text-xs text-secondary">{t("files.ops.deletePermanent.body", { count: confirmRows.length })}</p>
            <div className="flex items-center gap-2">
              <button
                id="f57.explorer.ops.confirmAccept"
                type="button"
                data-testid="confirm-accept"
                onClick={() => permanentDelete(confirmRows)}
                className="h-9 px-3 rounded-md border border-default text-xs text-secondary"
              >
                {t("files.ops.deletePermanent.accept")}
              </button>
              <button
                id="f57.explorer.ops.confirmCancel"
                type="button"
                data-testid="confirm-cancel"
                onClick={() => setConfirmRows(null)}
                className="h-9 px-3 rounded-md border border-default text-xs text-secondary"
              >
                {t("files.ops.deletePermanent.cancel")}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
