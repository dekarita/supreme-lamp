// [R-FILES / #217] Explorer scale: windowed rendering with the 5000-file
// fixture, and proof that virtualization did not break the frozen F57 contract.
//
// Evidence classes: these are CONTROLLED_BEHAVIOR tests (real DOM, real
// react-window, real fixture). They measure rendered node counts, not strings.
import { beforeEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import "@/i18n";
import {
  ExplorerResults,
  gridColumnsForWidth,
  LIST_ROW_HEIGHT,
  MAX_VISIBLE_LIST_ROWS,
  type FixtureRow,
  type ViewMode,
} from "@/pages/file-explorer/ExplorerResults";
import { EMPTY_SELECTION, type SelectionState } from "@/lib/explorer/selection";
import stress from "@/components/explorer/data/fixtures/5000-files.json";

function rowsFromFixture(n: number): FixtureRow[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const files = (stress as any).files as { id?: string; name?: string; path?: string; sizeBytes?: number; modified?: string }[];
  return files.slice(0, n).map((f, i) => ({
    id: String(f.id || f.path || "f-" + i),
    name: String(f.name || f.path || "file-" + i),
    kind: (String(f.name || f.path || "").endsWith("/") ? "folder" : "file") as "folder" | "file",
    sizeBytes: typeof f.sizeBytes === "number" ? f.sizeBytes : null,
    modified: String(f.modified || "2026-01-01T00:00:00.000Z"),
  }));
}

const noop = () => {};
const noopRow = (_r: FixtureRow) => {};

function mount(opts: {
  rows: FixtureRow[];
  view?: ViewMode;
  selection?: SelectionState;
  editor?: { id: string | null; mode: "create" | "rename"; value: string } | null;
  onSelect?: (row: FixtureRow, mods: { shift?: boolean; ctrl?: boolean; meta?: boolean }) => void;
}) {
  const onSelect = opts.onSelect || noopRow;
  return render(
    <ExplorerResults
      rows={opts.rows}
      view={opts.view || "list"}
      onView={noop}
      selection={opts.selection || EMPTY_SELECTION}
      onSelect={onSelect}
      onOpen={noopRow}
      onContextMenuRow={noopRow}
      onContextMenuBackground={noop}
      draggingIds={[]}
      dropTargetId={null}
      dropAllowed={false}
      onDragStartRow={noopRow}
      onDragOverTarget={noop}
      onDragLeaveTarget={noop}
      onDropTarget={noop}
      editor={opts.editor ?? null}
      onEditorChange={noop}
      onEditorCommit={noop}
      onEditorCancel={noop}
      readOnly={false}
    />,
  );
}

beforeEach(() => {
  // jsdom has no ResizeObserver; the component falls back to DEFAULT columns.
  // Nothing in this file depends on layout metrics.
});


/**
 * jsdom performs no layout, so `scrollTop` is a permanently-zero no-op and
 * clientHeight/scrollHeight are 0 - which makes react-window clamp every scroll
 * offset to 0. These three properties are the ONLY thing being shimmed; the
 * component, react-window and the scroll handler all run for real afterwards.
 */
function makeScrollable(el: HTMLElement, viewportHeight: number, contentHeight: number) {
  let top = 0;
  Object.defineProperty(el, "scrollTop", { get: () => top, set: (v) => { top = Number(v) || 0; }, configurable: true });
  Object.defineProperty(el, "scrollLeft", { get: () => 0, set: () => {}, configurable: true });
  Object.defineProperty(el, "clientHeight", { get: () => viewportHeight, configurable: true });
  Object.defineProperty(el, "scrollHeight", { get: () => contentHeight, configurable: true });
  Object.defineProperty(el, "clientWidth", { get: () => 800, configurable: true });
  return {
    to(offset: number) {
      el.scrollTop = offset;
      fireEvent.scroll(el);
    },
  };
}

describe("R-FILES-1: bounded DOM at scale", () => {
  it("the stress fixture really is 5000 files (the test cannot pass vacuously)", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((stress as any).files.length).toBe(5000);
  });

  it("renders a WINDOWED slice for 5000 rows, not 5000 nodes", () => {
    mount({ rows: rowsFromFixture(5000) });
    const rendered = screen.getAllByTestId("explorer-row");
    // 14 visible rows + react-window overscan - never the whole directory.
    expect(rendered.length).toBeGreaterThan(0);
    expect(rendered.length).toBeLessThanOrEqual(MAX_VISIBLE_LIST_ROWS + 10);
    expect(rendered.length).toBeLessThan(100);
    // and the section says how many exist in total
    expect(screen.getByTestId("explorer-windowed-note").getAttribute("data-total")).toBe("5000");
    expect(screen.getByTestId("explorer-windowed-note").getAttribute("data-windowed")).toBe("1");
  });

  it("renders EVERY row when the directory is small (no windowing claim)", () => {
    const rows = rowsFromFixture(6);
    mount({ rows });
    expect(screen.getAllByTestId("explorer-row").length).toBe(6);
    expect(screen.queryByTestId("explorer-windowed-note")).toBeNull();
  });

  it("keeps list semantics despite rendering divs (react-window)", () => {
    mount({ rows: rowsFromFixture(40) });
    expect(screen.getByTestId("explorer-rows").getAttribute("role")).toBe("list");
    const rows = screen.getAllByTestId("explorer-row");
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.parentElement?.getAttribute("role")).toBe("listitem");
  });
});

describe("R-FILES-2: the frozen F57 contract survives virtualization", () => {
  it("keeps the frozen ids, testids and the row button", () => {
    const rows = rowsFromFixture(6);
    mount({ rows });
    expect(document.getElementById("f57.explorer.results")?.getAttribute("data-view")).toBe("list");
    const first = screen.getAllByTestId("explorer-row")[0];
    expect(first.getAttribute("data-row-id")).toBe(rows[0].id);
    expect(document.getElementById("f57.explorer.row." + rows[0].id)).toBe(first);
    expect(within(first).getByTestId("explorer-row-button")).toBeInTheDocument();
    expect(document.getElementById("f57.explorer.viewToggleList")).toBeInTheDocument();
    expect(document.getElementById("f57.explorer.viewToggleGrid")).toBeInTheDocument();
  });

  it("selection is EXTERNAL: an unmounted (offscreen) row stays selected", () => {
    const rows = rowsFromFixture(5000);
    const target = rows[4900];
    mount({ rows, selection: { ids: [target.id], anchor: target.id } });
    // the selected row is outside the first window, so it is not in the DOM...
    const firstWindow = screen.getAllByTestId("explorer-row");
    expect(firstWindow.some((r) => r.getAttribute("data-row-id") === target.id)).toBe(false);
    // ...but scrolling to it renders it WITH the selection intact
    const scroller = screen.getByTestId("explorer-rows");
    const scroll = makeScrollable(scroller, LIST_ROW_HEIGHT * MAX_VISIBLE_LIST_ROWS, LIST_ROW_HEIGHT * 5000);
    scroll.to(LIST_ROW_HEIGHT * 4900);
    const visible = screen.getAllByTestId("explorer-row");
    const match = visible.find((r) => r.getAttribute("data-row-id") === target.id);
    expect(match).toBeTruthy();
    expect(match?.getAttribute("data-selected")).toBe("true");
  });

  it("a recycled row never inherits another row's name (keys are row ids)", () => {
    const rows = rowsFromFixture(5000);
    mount({ rows });
    const scroller = screen.getByTestId("explorer-rows");
    const scroll = makeScrollable(scroller, LIST_ROW_HEIGHT * MAX_VISIBLE_LIST_ROWS, LIST_ROW_HEIGHT * 5000);
    const nameOf = () =>
      screen.getAllByTestId("explorer-row").map((r) => ({
        id: r.getAttribute("data-row-id"),
        name: r.textContent || "",
      }));
    scroll.to(LIST_ROW_HEIGHT * 10);
    const a = nameOf();
    scroll.to(LIST_ROW_HEIGHT * 3000);
    const b = nameOf();
    // every rendered row's id is echoed in its own content/identity, and the two
    // windows share no row id
    const idsA = new Set(a.map((x) => x.id));
    expect(b.every((x) => !idsA.has(x.id))).toBe(true);
    for (const row of b) {
      const expected = rows.find((r) => r.id === row.id);
      expect(expected).toBeTruthy();
      expect(row.name).toContain(String(expected!.name));
    }
  });

  it("the inline rename editor renders in place and keeps its mode", () => {
    const rows = rowsFromFixture(6);
    mount({ rows, editor: { id: rows[2].id, mode: "rename", value: "new-name" } });
    const editor = screen.getByTestId("inline-editor");
    expect(editor.getAttribute("data-mode")).toBe("rename");
    expect((editor as HTMLInputElement).value).toBe("new-name");
    // the row under rename is replaced by the editor, and the rest survive
    expect(screen.getAllByTestId("explorer-row").length).toBe(6);
  });

  it("the create editor occupies the first slot, exactly as before", () => {
    const rows = rowsFromFixture(6);
    mount({ rows, editor: { id: null, mode: "create", value: "" } });
    const editor = screen.getByTestId("inline-editor");
    expect(editor.getAttribute("data-mode")).toBe("create");
    const list = screen.getByTestId("explorer-rows");
    const firstRow = screen.getAllByTestId("explorer-row")[0];
    expect(editor.compareDocumentPosition(firstRow) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(list).toBeInTheDocument();
  });

  it("keyboard navigation moves the selection and is wired to the list", () => {
    const rows = rowsFromFixture(5000);
    const seen: string[] = [];
    mount({
      rows,
      selection: { ids: [rows[0].id], anchor: rows[0].id },
      onSelect: (row) => seen.push(row.id),
    });
    const host = screen.getByTestId("explorer-rows");
    fireEvent.keyDown(host, { key: "ArrowDown" });
    expect(seen).toEqual([rows[1].id]);
    fireEvent.keyDown(host, { key: "ArrowUp" });
    // ArrowUp from the cursor at index 1 goes back to index 0
    expect(seen[seen.length - 1]).toBe(rows[0].id);
  });

  it("Home/End jump to the first/last row", () => {
    const rows = rowsFromFixture(5000);
    const seen: string[] = [];
    mount({ rows, selection: { ids: [rows[5].id], anchor: rows[5].id }, onSelect: (row) => seen.push(row.id) });
    const host = screen.getByTestId("explorer-rows");
    fireEvent.keyDown(host, { key: "Home" });
    expect(seen[seen.length - 1]).toBe(rows[0].id);
    fireEvent.keyDown(host, { key: "End" });
    expect(seen[seen.length - 1]).toBe(rows[rows.length - 1].id);
  });
});

describe("R-FILES-3: grid view and column math", () => {
  it("gridColumnsForWidth mirrors the frozen CSS breakpoints", () => {
    expect(gridColumnsForWidth(0)).toBe(2);
    expect(gridColumnsForWidth(400)).toBe(2);
    expect(gridColumnsForWidth(768)).toBe(3);
    expect(gridColumnsForWidth(1440)).toBe(3);
  });

  it("the grid view is windowed too, and still renders row nodes", () => {
    mount({ rows: rowsFromFixture(5000), view: "grid" });
    const rendered = screen.getAllByTestId("explorer-row");
    expect(rendered.length).toBeGreaterThan(0);
    expect(rendered.length).toBeLessThan(100);
    expect(screen.getByTestId("explorer-results").getAttribute("data-view")).toBe("grid");
  });
});
