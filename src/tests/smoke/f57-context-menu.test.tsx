// [F57 §2/§5] Context menu: opens on right-click AND on long-press, offers the
// real commands, closes on Escape / outside click, and distinguishes a row
// target (row-scoped items) from the background (create/paste/undo only).
import { beforeEach, describe, expect, it, vi, afterEach } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import "@/i18n";
import FileExplorer from "@/pages/FileExplorer";
import { useTrashStore } from "@/lib/explorer/trashStore";

/** jsdom has no PointerEvent: dispatch a MouseEvent named like one instead. */
function pointer(target: Element, type: string, x: number, y: number) {
  act(() => {
    target.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 }));
  });
}

function rowByName(name: string): HTMLElement {
  const row = screen.getAllByTestId("explorer-row").find((r) => (r.textContent || "").includes(name));
  if (!row) throw new Error("row not found: " + name);
  return row;
}

describe("F57 context menu (right-click + long-press)", () => {
  beforeEach(() => {
    useTrashStore.setState({ entries: [] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("opens on right-click on a row with that row's ids and runs trash", () => {
    render(<FileExplorer />);
    const row = rowByName("NeatDM_setup.exe");
    fireEvent.contextMenu(row, { clientX: 40, clientY: 60 });
    const menu = screen.getByTestId("explorer-context-menu");
    expect(menu.getAttribute("data-row-ids")).toBe("row-neatdm");
    // row-scoped items exist, background-only items do not
    expect(document.getElementById("f57.explorer.ops.ctxRename")).not.toBeNull();
    expect(document.getElementById("f57.explorer.ops.ctxTrash")).not.toBeNull();
    fireEvent.click(document.getElementById("f57.explorer.ops.ctxTrash") as HTMLElement);
    expect(screen.queryByTestId("explorer-context-menu")).toBeNull();
    expect(rowByName("session-report.md")).toBeTruthy();
    expect(useTrashStore.getState().entries.length).toBe(1);
  });

  it("opens on long-press (touch) after the hold threshold", () => {
    vi.useFakeTimers();
    render(<FileExplorer />);
    const row = rowByName("session-report.md");
    pointer(row, "pointerdown", 10, 10);
    expect(screen.queryByTestId("explorer-context-menu")).toBeNull();
    act(() => {
      vi.advanceTimersByTime(700);
    });
    expect(screen.getByTestId("explorer-context-menu")).toBeTruthy();
  });

  it("a moving finger (or a pointercancel) cancels the long-press", () => {
    vi.useFakeTimers();
    render(<FileExplorer />);
    const row = rowByName("session-report.md");
    pointer(row, "pointerdown", 10, 10);
    pointer(row, "pointermove", 60, 60);
    act(() => {
      vi.advanceTimersByTime(700);
    });
    expect(screen.queryByTestId("explorer-context-menu")).toBeNull();

    pointer(row, "pointerdown", 10, 10);
    fireEvent.pointerCancel(row);
    act(() => {
      vi.advanceTimersByTime(700);
    });
    expect(screen.queryByTestId("explorer-context-menu")).toBeNull();
  });

  it("background right-click offers create/paste but no row items", () => {
    render(<FileExplorer />);
    fireEvent.contextMenu(screen.getByTestId("explorer-results"), { clientX: 5, clientY: 5 });
    const menu = screen.getByTestId("explorer-context-menu");
    expect(menu.getAttribute("data-row-ids")).toBe("");
    expect(document.getElementById("f57.explorer.ops.ctxNewFolder")).not.toBeNull();
    expect(document.getElementById("f57.explorer.ops.ctxRename")).toBeNull();
    expect(document.getElementById("f57.explorer.ops.ctxDeletePermanent")).toBeNull();
  });

  it("closes on Escape and on an outside click", () => {
    render(<FileExplorer />);
    fireEvent.contextMenu(rowByName("session-report.md"), { clientX: 1, clientY: 1 });
    expect(screen.getByTestId("explorer-context-menu")).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByTestId("explorer-context-menu")).toBeNull();

    fireEvent.contextMenu(rowByName("session-report.md"), { clientX: 1, clientY: 1 });
    fireEvent.mouseDown(document.body);
    expect(screen.queryByTestId("explorer-context-menu")).toBeNull();
  });

  it("context menu copy then paste works through the menu only", () => {
    render(<FileExplorer />);
    fireEvent.contextMenu(rowByName("NeatDM_setup.exe"), { clientX: 2, clientY: 2 });
    fireEvent.click(document.getElementById("f57.explorer.ops.ctxCopy") as HTMLElement);
    fireEvent.contextMenu(screen.getByTestId("explorer-results"), { clientX: 2, clientY: 2 });
    fireEvent.click(document.getElementById("f57.explorer.ops.ctxPaste") as HTMLElement);
    expect(screen.getAllByTestId("explorer-row").length).toBe(7);
    // the pasted copy carries the collision-renamed name
    expect(screen.getByText("NeatDM_setup (2).exe")).toBeTruthy();
  });
});
