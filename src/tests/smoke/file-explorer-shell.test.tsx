// [F56-c] File Explorer shell (session §4): tree stubs, breadcrumb, list/grid
// view toggle, and the disabled command bar with "coming in F57" tooltips.
// Rows come from src/pages/file-explorer/fixture.json; no real file ops (F57).
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
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

  it("disables every command-bar action with the coming-in-F57 tooltip", () => {
    render(<FileExplorer />);
    const bar = screen.getByTestId("explorer-command-bar");
    expect(bar).toBeInTheDocument();
    const buttons = Array.from(bar.querySelectorAll("button"));
    expect(buttons.length).toBe(6);
    for (const b of buttons) {
      expect((b as HTMLButtonElement).disabled).toBe(true);
      expect(b.getAttribute("title")).toBe("coming in F57");
    }
    expect(document.getElementById("f57.explorer.commandUpload")).not.toBeNull();
    expect(document.getElementById("f57.explorer.preview")).not.toBeNull();
  });
});
