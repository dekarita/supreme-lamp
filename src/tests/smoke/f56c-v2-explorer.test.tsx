// [F56-c v2] File Explorer shell (§3) additions: the reserved "Fetched" tree
// root with its reserved badge, a breadcrumb that follows the selected
// location, and - when Fetched is selected - the "coming in F56-d" empty state
// instead of invented rows (the F56-d fetch plane owns that root). The F57
// command bar stays disabled with its "coming in F57" tooltips.
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import "@/i18n";
import FileExplorer, { crumbsFor, FETCHED_PATH } from "@/pages/FileExplorer";
import fixture from "@/pages/file-explorer/fixture.json";

describe("File Explorer shell (F56-c v2)", () => {
  it("reserves the Fetched root in the tree with the reserved badge", () => {
    render(<FileExplorer />);
    expect(document.getElementById("f57.explorer.v2.fetchedGroup")).not.toBeNull();
    const node = document.getElementById("f57.explorer.v2.fetchedNode.fetched-root");
    expect(node).not.toBeNull();
    expect(node?.textContent).toContain("Fetched");
    expect(screen.getByTestId("reserved-badge").textContent).toBe("reserved for F56-d");
  });

  it("derives the breadcrumb from the selected location", () => {
    expect(crumbsFor("D:\\RDP-Storage").map((c) => c.id)).toEqual(["bc-this-pc", "bc-rdp-storage"]);
    expect(crumbsFor(FETCHED_PATH).map((c) => c.id)).toEqual(["bc-this-pc", "bc-rdp-storage", "bc-fetched"]);
    expect(crumbsFor("C:\\").map((c) => c.id)).toEqual(["bc-this-pc", "bc-windows"]);

    render(<FileExplorer />);
    fireEvent.click(document.getElementById("f57.explorer.v2.fetchedNode.fetched-root") as HTMLElement);
    const bc = screen.getByTestId("explorer-breadcrumbs");
    expect(bc.getAttribute("data-location")).toBe(FETCHED_PATH);
    expect(bc.textContent).toContain("Fetched");
    expect(document.getElementById("f57.explorer.breadcrumbItem.bc-fetched")).not.toBeNull();
  });

  it("shows the reserved Fetched empty state ('coming in F56-d') instead of rows", () => {
    render(<FileExplorer />);
    // default location (RDP-Storage) still lists the fixture rows and keeps the
    // frozen F57 shell (disabled commands + list/grid toggle) intact
    expect(screen.getAllByTestId("explorer-row").length).toBe((fixture.rows as unknown[]).length);
    // [F57] SUPERSEDED PIN: the bar is a real command surface now (the F56-c
    // disabled state is asserted in file-explorer-shell.test.tsx's F57 cell).
    const bar = screen.getByTestId("explorer-command-bar");
    expect(bar.querySelectorAll("button").length).toBeGreaterThanOrEqual(6);
    fireEvent.click(screen.getByTestId("view-toggle-grid"));
    expect(screen.getByTestId("explorer-results").getAttribute("data-view")).toBe("grid");
    fireEvent.click(document.getElementById("f57.explorer.v2.fetchedNode.fetched-root") as HTMLElement);
    const empty = screen.getByTestId("fetched-empty");
    expect(empty).toBeInTheDocument();
    expect(empty.textContent).toContain("F56-d");
    expect(screen.queryAllByTestId("explorer-row").length).toBe(0);
    expect(screen.getByTestId("fetched-reserved-badge").textContent).toBe("reserved for F56-d");
    expect(screen.queryByTestId("explorer-results")).toBeNull();
    expect(screen.queryByTestId("view-toggle-grid")).toBeNull();
  });
});
