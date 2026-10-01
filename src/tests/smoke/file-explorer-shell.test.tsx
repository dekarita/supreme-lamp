// [F56-c] File Explorer shell (session §4): tree stubs, breadcrumb, list/grid
// view toggle, and the disabled command bar with "coming in F57" tooltips.
// Rows come from src/pages/file-explorer/fixture.json; no real file ops (F57).
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import "@/i18n";
import FileExplorer from "@/pages/FileExplorer";
import fixture from "@/pages/file-explorer/fixture.json";

describe("File Explorer shell (F56-c)", () => {
  it("renders the shell: Quick Access + This PC tree stubs and fixture rows", () => {
    render(<FileExplorer />);
    expect(screen.getByTestId("file-explorer-page")).toBeInTheDocument();
    const tree = screen.getByTestId("explorer-tree");
    expect(tree).toBeInTheDocument();
    expect(document.getElementById("f57.explorer.quickAccess")).not.toBeNull();
    expect(document.getElementById("f57.explorer.thisPc")).not.toBeNull();
    expect(screen.getAllByTestId("explorer-row").length).toBe((fixture.rows as unknown[]).length);
  });

  it("renders the breadcrumb for the active location (v2: derived, not static)", () => {
    render(<FileExplorer />);
    const bc = screen.getByTestId("explorer-breadcrumbs");
    expect(bc).toBeInTheDocument();
    const text = bc.textContent || "";
    // Default location is D:\RDP-Storage, so the crumb trail is This PC /
    // RDP-Storage (D:). Selecting the reserved Fetched root appends the third
    // crumb - covered by f56c-v2-explorer.test.tsx.
    expect(text).toContain("This PC");
    expect(text).toContain("RDP-Storage (D:)");
    expect(bc.getAttribute("data-location")).toBe("D:\\RDP-Storage");
    expect(document.getElementById("f57.explorer.breadcrumbItem.bc-rdp-storage")).not.toBeNull();
    expect(document.getElementById("f57.explorer.breadcrumbItem.bc-fetched")).toBeNull();
  });

  it("toggles list/grid view", () => {
    render(<FileExplorer />);
    const results = screen.getByTestId("explorer-results");
    expect(results.getAttribute("data-view")).toBe("list");
    fireEvent.click(screen.getByTestId("view-toggle-grid"));
    expect(results.getAttribute("data-view")).toBe("grid");
    expect(screen.getByTestId("view-toggle-grid").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("view-toggle-list").getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(screen.getByTestId("view-toggle-list"));
    expect(results.getAttribute("data-view")).toBe("list");
  });

  // [F57 §2] SUPERSEDED PIN: the F56-c shell shipped this bar DISABLED with
  // "coming in F57" tooltips. F57 makes it real, so the cell now asserts the
  // frozen six ids are enabled actions and the additive F57 commands exist.
  it("wires every command-bar action to a real command (F57)", () => {
    render(<FileExplorer />);
    const bar = screen.getByTestId("explorer-command-bar");
    expect(bar).toBeInTheDocument();
    const frozen = [
      "f57.explorer.commandNewFolder",
      "f57.explorer.commandUpload",
      "f57.explorer.commandRename",
      "f57.explorer.commandCopy",
      "f57.explorer.commandDelete",
      "f57.explorer.commandRefresh",
    ];
    for (const id of frozen) {
      const el = document.getElementById(id) as HTMLButtonElement;
      expect(el).not.toBeNull();
      expect(el.getAttribute("title")).not.toBe("coming in F57");
      expect(el.getAttribute("data-command")).toBeTruthy();
    }
    // selection-free commands are live straight away...
    for (const id of ["f57.explorer.commandNewFolder", "f57.explorer.commandUpload", "f57.explorer.commandRefresh"]) {
      expect((document.getElementById(id) as HTMLButtonElement).disabled).toBe(false);
    }
    // ...selection-scoped ones enable once a row is chosen (real ops, not stubs)
    for (const id of ["f57.explorer.commandRename", "f57.explorer.commandCopy", "f57.explorer.commandDelete"]) {
      expect((document.getElementById(id) as HTMLButtonElement).disabled).toBe(true);
    }
    const row = screen.getAllByTestId("explorer-row")[0];
    fireEvent.click(within(row).getByTestId("explorer-row-button"));
    for (const id of ["f57.explorer.commandRename", "f57.explorer.commandCopy", "f57.explorer.commandDelete"]) {
      expect((document.getElementById(id) as HTMLButtonElement).disabled).toBe(false);
    }
    const buttons = Array.from(bar.querySelectorAll("button"));
    expect(buttons.length).toBeGreaterThanOrEqual(11);
    expect(document.getElementById("f57.explorer.ops.commandPaste")).not.toBeNull();
    expect(document.getElementById("f57.explorer.preview")).not.toBeNull();
  });
});
