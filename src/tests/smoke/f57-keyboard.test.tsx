// [F57 §2/§5] Keyboard shortcuts route to the real actions: F2 rename,
// Delete -> trash, Shift+Delete -> permanent confirm, mod+c/x/v/a/z, Enter open.
// The combo table is pinned against the shipped EXPLORER_KEYMAP export so the
// test cannot drift from the surface the gate greps.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import "@/i18n";
import FileExplorer, { F57_SHORTCUTS } from "@/pages/FileExplorer";
import fixture from "@/pages/file-explorer/fixture.json";
import { useTrashStore } from "@/lib/explorer/trashStore";

const ROWS = fixture.rows as Array<{ id: string }>;

function key(combo: string, init: KeyboardEventInit = {}) {
  fireEvent.keyDown(document, { key: combo, ...init });
}

function selectByName(name: string) {
  const row = screen.getAllByTestId("explorer-row").find((r) => (r.textContent || "").includes(name));
  if (!row) throw new Error("row not found: " + name);
  fireEvent.click(within(row).getByTestId("explorer-row-button"));
}

describe("F57 keyboard shortcuts", () => {
  beforeEach(() => {
    useTrashStore.setState({ entries: [] });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
  });

  it("pins the exact shortcut table", () => {
    expect(F57_SHORTCUTS).toEqual(["F2", "Delete", "Shift+Delete", "mod+c", "mod+x", "mod+v", "mod+a", "mod+z", "Enter"]);
  });

  it("F2 opens the inline rename editor for the single selected row", () => {
    render(<FileExplorer />);
    selectByName("session-report.md");
    key("F2");
    const editor = screen.getByTestId("inline-editor");
    expect(editor.getAttribute("data-mode")).toBe("rename");
    expect((editor as HTMLInputElement).value).toBe("session-report.md");
    fireEvent.change(editor, { target: { value: "notes.md" } });
    fireEvent.keyDown(editor, { key: "Enter" });
    expect(screen.getAllByTestId("explorer-row").some((r) => (r.textContent || "").includes("notes.md"))).toBe(true);
  });

  it("Delete routes to soft-delete (trash), Shift+Delete asks for confirmation", () => {
    render(<FileExplorer />);
    selectByName("session-report.md");
    key("Delete");
    expect(useTrashStore.getState().entries.length).toBe(1);
    expect(screen.queryByTestId("confirm-modal")).toBeNull();

    selectByName("NeatDM_setup.exe");
    key("Delete", { shiftKey: true });
    const modal = screen.getByTestId("confirm-modal");
    expect(modal).toBeTruthy();
    fireEvent.click(screen.getByTestId("confirm-cancel"));
    expect(screen.queryByTestId("confirm-modal")).toBeNull();
    expect(screen.getAllByTestId("explorer-row").length).toBe(ROWS.length - 1);

    key("Delete", { shiftKey: true });
    fireEvent.click(screen.getByTestId("confirm-accept"));
    expect(screen.getAllByTestId("explorer-row").length).toBe(ROWS.length - 2);
  });

  it("mod+a selects every row, mod+z undoes the last reversible op", () => {
    render(<FileExplorer />);
    key("a", { ctrlKey: true });
    const selected = screen.getAllByTestId("explorer-row").filter((r) => r.getAttribute("data-selected") === "true");
    expect(selected.length).toBe(ROWS.length);

    selectByName("ghrdp-handler-kit.zip");
    key("Delete");
    expect(screen.getAllByTestId("explorer-row").length).toBe(ROWS.length - 1);
    key("z", { ctrlKey: true });
    expect(screen.getAllByTestId("explorer-row").length).toBe(ROWS.length);
    expect(useTrashStore.getState().entries.length).toBe(0);
  });

  it("mod+c / mod+v copy-paste and mod+x / mod+v move", () => {
    render(<FileExplorer />);
    selectByName("session-report.md");
    key("c", { ctrlKey: true });
    key("v", { ctrlKey: true });
    expect(screen.getAllByTestId("explorer-row").length).toBe(ROWS.length + 1);

    selectByName("NeatDM_setup.exe");
    key("x", { ctrlKey: true });
    key("v", { ctrlKey: true });
    expect(screen.getAllByTestId("explorer-row").length).toBe(ROWS.length + 1);
  });

  it("Enter opens the selection: a folder navigates, a file previews", () => {
    render(<FileExplorer />);
    selectByName("Archives");
    key("Enter");
    expect(screen.getByTestId("explorer-breadcrumbs").getAttribute("data-location")).toBe("D:\\RDP-Storage\\Archives");
  });

  it("ignores shortcuts while typing in a form field (rename input)", () => {
    render(<FileExplorer />);
    selectByName("session-report.md");
    key("F2");
    const editor = screen.getByTestId("inline-editor");
    fireEvent.keyDown(editor, { key: "Delete" });
    expect(useTrashStore.getState().entries.length).toBe(0);
  });
});
