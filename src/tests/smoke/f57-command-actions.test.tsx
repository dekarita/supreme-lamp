// [F57 §2/§5] Command bar REAL actions: new (folder/file), rename, cut/copy,
// paste, share (copy path), delete->trash, undo. The bar is the same frozen
// F56-c surface (six ids) plus the additive F57 commands.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import "@/i18n";
import FileExplorer from "@/pages/FileExplorer";
import fixture from "@/pages/file-explorer/fixture.json";
import { useTrashStore } from "@/lib/explorer/trashStore";

const ROWS = fixture.rows as Array<{ id: string; name: string }>;

function rowByName(name: string): HTMLElement {
  const row = screen.getAllByTestId("explorer-row").find((r) => (r.textContent || "").includes(name));
  if (!row) throw new Error("row not found: " + name);
  return row;
}

function selectByName(name: string) {
  fireEvent.click(within(rowByName(name)).getByTestId("explorer-row-button"));
}

function cmd(id: string) {
  fireEvent.click(document.getElementById(id) as HTMLElement);
}

describe("F57 command bar real actions", () => {
  beforeEach(() => {
    useTrashStore.setState({ entries: [] });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
  });

  it("creates a folder through the inline editor and queues a mkdir op", () => {
    render(<FileExplorer />);
    cmd("f57.explorer.commandNewFolder");
    const editor = screen.getByTestId("inline-editor");
    expect(editor.getAttribute("data-mode")).toBe("create");
    fireEvent.change(editor, { target: { value: "Receipts" } });
    fireEvent.keyDown(editor, { key: "Enter" });
    expect(screen.queryByTestId("inline-editor")).toBeNull();
    expect(screen.getAllByTestId("explorer-row").length).toBe(ROWS.length + 1);
    expect(rowByName("Receipts")).toBeTruthy();
    const jobs = screen.getAllByTestId("queue-job");
    expect(jobs.length).toBeGreaterThan(0);
    expect(jobs[0].getAttribute("data-status")).toBeTruthy();
  });

  it("renames the selected row (F2-equivalent command) and refuses a taken name", () => {
    render(<FileExplorer />);
    selectByName("session-report.md");
    cmd("f57.explorer.commandRename");
    const editor = screen.getByTestId("inline-editor");
    expect(editor.getAttribute("data-mode")).toBe("rename");
    fireEvent.change(editor, { target: { value: "NeatDM_setup.exe" } });
    fireEvent.keyDown(editor, { key: "Enter" });
    // name clash refused, row keeps its old name and a warning toast is pushed
    expect(rowByName("session-report.md")).toBeTruthy();
    cmd("f57.explorer.commandRename");
    fireEvent.change(screen.getByTestId("inline-editor"), { target: { value: "report.md" } });
    fireEvent.keyDown(screen.getByTestId("inline-editor"), { key: "Enter" });
    expect(rowByName("report.md")).toBeTruthy();
    expect(screen.getAllByTestId("explorer-row").some((r) => (r.textContent || "").includes("session-report.md"))).toBe(false);
  });

  it("copy + paste duplicates, cut + paste moves (no duplicate)", () => {
    render(<FileExplorer />);
    selectByName("session-report.md");
    cmd("f57.explorer.commandCopy");
    cmd("f57.explorer.ops.commandPaste");
    expect(screen.getAllByTestId("explorer-row").length).toBe(ROWS.length + 1);

    selectByName("NeatDM_setup.exe");
    cmd("f57.explorer.ops.commandCut");
    cmd("f57.explorer.ops.commandPaste");
    // a cut+paste "move" never duplicates the entry in the same folder view
    expect(screen.getAllByTestId("explorer-row").length).toBe(ROWS.length + 1);
  });

  it("delete soft-deletes into D:\\RDP-Storage\\.trash and undo brings it back", () => {
    render(<FileExplorer />);
    selectByName("ghrdp-handler-kit.zip");
    cmd("f57.explorer.commandDelete");
    expect(screen.queryAllByTestId("explorer-row").length).toBe(ROWS.length - 1);

    const trash = useTrashStore.getState().entries;
    expect(trash.length).toBe(1);
    expect(trash[0].trashPath.startsWith("D:\\RDP-Storage\\.trash\\")).toBe(true);
    expect(trash[0].originalPath).toBe("D:\\RDP-Storage\\ghrdp-handler-kit.zip");

    cmd("f57.explorer.ops.commandUndo");
    expect(screen.getAllByTestId("explorer-row").length).toBe(ROWS.length);
    expect(useTrashStore.getState().entries.length).toBe(0);
  });

  it("share copies the absolute path to the clipboard", () => {
    render(<FileExplorer />);
    selectByName("NeatDM_setup.exe");
    cmd("f57.explorer.ops.commandShare");
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("D:\\RDP-Storage\\NeatDM_setup.exe");
  });

  it("enables rename/delete only with a selection and undo only with history", () => {
    render(<FileExplorer />);
    const rename = document.getElementById("f57.explorer.commandRename") as HTMLButtonElement;
    const del = document.getElementById("f57.explorer.commandDelete") as HTMLButtonElement;
    const undo = document.getElementById("f57.explorer.ops.commandUndo") as HTMLButtonElement;
    expect(rename.disabled).toBe(true);
    expect(del.disabled).toBe(true);
    expect(undo.disabled).toBe(true);
    selectByName("session-report.md");
    expect(rename.disabled).toBe(false);
    expect(del.disabled).toBe(false);
    cmd("f57.explorer.commandDelete");
    expect(undo.disabled).toBe(false);
  });
});
