// [F57 §4/§5] Drag-drop: drop-zone states on folders (tree + grid), cross-root
// moves allowed inside the watcher's six roots, drops outside the roots refused
// (including the .trash node), plus the trash soft-delete + 30-day retention.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import "@/i18n";
import FileExplorer from "@/pages/FileExplorer";
import { ROOT_COUNT, WATCHER_ROOTS, isWithinRoots, resolveDropTarget } from "@/lib/explorer/roots";
import {
  TRASH_RETENTION_DAYS,
  TRASH_ROOT,
  daysLeft,
  expiryFor,
  isExpired,
  makeTrashEntry,
  trashStamp,
  trashTargetFor,
} from "@/lib/explorer/trash";
import { useTrashStore } from "@/lib/explorer/trashStore";

function dt() {
  return { setData: vi.fn(), getData: vi.fn(() => "[]"), effectAllowed: "", dropEffect: "" };
}

function rowByName(name: string): HTMLElement {
  const row = screen.getAllByTestId("explorer-row").find((r) => (r.textContent || "").includes(name));
  if (!row) throw new Error("row not found: " + name);
  return row;
}

describe("F57 drag-drop zones", () => {
  beforeEach(() => {
    useTrashStore.setState({ entries: [] });
  });

  it("allows cross-root drops inside the six watched roots", () => {
    expect(ROOT_COUNT).toBe(6);
    expect(WATCHER_ROOTS.length).toBe(6);
    const cross = resolveDropTarget(["D:\\RDP-Storage\\Fetched\\a.txt"], "C:\\Users\\RDP\\Desktop");
    expect(cross.allowed).toBe(true);
    expect(cross.destination).toBe("C:\\Users\\RDP\\Desktop");
    expect(isWithinRoots("D:\\RDP-Storage\\Fetched\\a.txt")).toBe(true);
  });

  it("refuses drops outside the roots, onto itself, or into a descendant", () => {
    expect(resolveDropTarget(["D:\\RDP-Storage\\a.txt"], "E:\\Media").reason).toBe("outside-roots");
    expect(resolveDropTarget(["D:\\RDP-Storage\\a.txt"], "D:\\RDP-Storage").reason).toBe("self");
    expect(resolveDropTarget(["D:\\RDP-Storage\\docs"], "D:\\RDP-Storage\\docs\\deep").reason).toBe("descendant");
    expect(resolveDropTarget(["D:\\RDP-Storage\\a.txt"], TRASH_ROOT).reason).toBe("outside-roots");
    expect(resolveDropTarget(["D:\\RDP-Storage\\a.txt"], "").reason).toBe("no-destination");
  });

  it("marks the tree node as a drop target while dragging and moves on drop", () => {
    render(<FileExplorer />);
    const row = rowByName("NeatDM_setup.exe");
    fireEvent.dragStart(row, { dataTransfer: dt() });
    expect(row.getAttribute("data-dragging")).toBe("true");

    const desktop = document.getElementById("f57.explorer.quickAccessItem.qa-desktop") as HTMLElement;
    fireEvent.dragOver(desktop, { dataTransfer: dt() });
    expect(desktop.getAttribute("data-drop-target")).toBe("true");
    expect(desktop.getAttribute("data-drop-allowed")).toBe("true");

    fireEvent.drop(desktop, { dataTransfer: dt() });
    expect(desktop.getAttribute("data-drop-target")).toBeNull();
    const jobs = screen.getAllByTestId("queue-job");
    expect(jobs.some((j) => (j.textContent || "").includes("move"))).toBe(true);
  });

  it("shows the refusal state on the trash node (outside the watched roots)", () => {
    render(<FileExplorer />);
    fireEvent.dragStart(rowByName("NeatDM_setup.exe"), { dataTransfer: dt() });
    const trash = document.getElementById("f57.explorer.ops.trashNode") as HTMLElement;
    fireEvent.dragOver(trash, { dataTransfer: dt() });
    expect(trash.getAttribute("data-drop-allowed")).toBe("false");
    expect(trash.getAttribute("data-drop-target")).toBe("true");
    fireEvent.drop(trash, { dataTransfer: dt() });
    // refused: the entry is neither moved nor trashed
    expect(useTrashStore.getState().entries.length).toBe(0);
    expect(rowByName("NeatDM_setup.exe")).toBeTruthy();
  });

  it("renders the drop indicator when hovering the results container from another root", () => {
    render(<FileExplorer />);
    fireEvent.dragStart(rowByName("NeatDM_setup.exe"), { dataTransfer: dt() });
    // container drop = same folder -> "self" refusal (no indicator)
    fireEvent.dragOver(screen.getByTestId("explorer-results"), { dataTransfer: dt() });
    expect(document.getElementById("f57.explorer.ops.dropIndicator")).toBeNull();
    expect(screen.getByTestId("explorer-results").getAttribute("data-drop-allowed")).toBe("false");
  });
});

describe("F57 trash soft-delete + retention", () => {
  it("routes a delete into .trash\\<original-path>\\<ts> with a 30-day expiry", () => {
    const at = Date.UTC(2026, 9, 1, 10, 15, 30);
    const entry = makeTrashEntry(
      { id: "row-report", name: "session-report.md", kind: "file", sizeBytes: 14822, modified: "2026-09-29T20:11:02Z" },
      "D:\\RDP-Storage",
      at
    );
    expect(entry.trashPath).toBe("D:\\RDP-Storage\\.trash\\D\\RDP-Storage\\session-report.md\\" + trashStamp(at));
    expect(entry.trashPath.startsWith(TRASH_ROOT)).toBe(true);
    expect(entry.trashedAt).toBe("2026-10-01T10:15:30.000Z");
    expect(entry.expiresAt).toBe(expiryFor("2026-10-01T10:15:30.000Z"));
    expect(daysLeft(entry.trashedAt, at)).toBe(TRASH_RETENTION_DAYS);
    expect(isExpired(entry.trashedAt, at)).toBe(false);
    expect(isExpired(entry.trashedAt, at + TRASH_RETENTION_DAYS * 24 * 3600 * 1000 + 1)).toBe(true);
    expect(trashTargetFor("C:\\Users\\RDP\\Desktop\\a.txt", at)).toBe("D:\\RDP-Storage\\.trash\\C\\Users\\RDP\\Desktop\\a.txt\\" + trashStamp(at));
  });

  it("stores, restores, purges and sweeps past-retention entries", () => {
    const store = useTrashStore.getState();
    const at = Date.now();
    const made = store.softDelete([{ id: "r1", name: "a.txt", kind: "file", sizeBytes: 5, modified: "2026-01-01T00:00:00Z" }], "D:\\RDP-Storage", at);
    expect(useTrashStore.getState().entries.length).toBe(1);
    expect(useTrashStore.getState().summary(at).count).toBe(1);

    // an expired entry (31 days old) is swept, the fresh one is kept
    const old = makeTrashEntry({ id: "r0", name: "old.txt", kind: "file", sizeBytes: 1, modified: "2026-01-01T00:00:00Z" }, "D:\\RDP-Storage", at - 31 * 24 * 3600 * 1000);
    useTrashStore.setState({ entries: [old, ...useTrashStore.getState().entries] });
    const swept = useTrashStore.getState().sweep(at);
    expect(swept.length).toBe(1);
    expect(useTrashStore.getState().entries.length).toBe(1);

    expect(useTrashStore.getState().restore([made[0].id]).length).toBe(1);
    expect(useTrashStore.getState().entries.length).toBe(0);

    useTrashStore.getState().softDelete([{ id: "r2", name: "b.txt", kind: "file", sizeBytes: 7, modified: "2026-01-01T00:00:00Z" }], "D:\\RDP-Storage", at);
    expect(useTrashStore.getState().purge(useTrashStore.getState().entries.map((e) => e.id))).toBe(1);
    expect(useTrashStore.getState().entries.length).toBe(0);
  });

  it("shows the trash view with retention note, restore and purge controls", () => {
    useTrashStore.getState().softDelete([{ id: "r9", name: "gone.txt", kind: "file", sizeBytes: 2, modified: "2026-01-01T00:00:00Z" }], "D:\\RDP-Storage");
    render(<FileExplorer />);
    fireEvent.click(document.getElementById("f57.explorer.ops.trashNode") as HTMLElement);
    expect(screen.getByTestId("trash-view")).toBeTruthy();
    expect(screen.getByTestId("trash-retention-note").textContent).toContain(String(TRASH_RETENTION_DAYS));
    const row = screen.getByTestId("trash-row");
    expect(within(row).getByText("gone.txt")).toBeTruthy();
    expect(row.textContent).toContain(TRASH_ROOT);
    fireEvent.click(within(row).getByTestId("trash-restore"));
    expect(useTrashStore.getState().entries.length).toBe(0);
  });
});
