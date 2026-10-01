// [F57 §2/§5] Multi-select state machine + the 20-slot undo stack: push/pop,
// LIFO order, cap enforcement, invertibility of move/rename/delete.
import { describe, expect, it } from "vitest";
import {
  EMPTY_SELECTION,
  clickSelect,
  pruneSelection,
  selectAll,
  selectRange,
  selectedRows,
  toggleId,
} from "@/lib/explorer/selection";
import { UNDO_LIMIT, UndoStack, applyOp, buildOp, invertOp, isValidName, type OpEntry } from "@/lib/explorer/ops";

const ROWS = [
  { id: "a", name: "a.txt", kind: "file" as const, sizeBytes: 1, modified: "2026-01-01T00:00:00Z" },
  { id: "b", name: "b.txt", kind: "file" as const, sizeBytes: 2, modified: "2026-01-02T00:00:00Z" },
  { id: "c", name: "c.txt", kind: "file" as const, sizeBytes: 3, modified: "2026-01-03T00:00:00Z" },
  { id: "d", name: "d.txt", kind: "file" as const, sizeBytes: 4, modified: "2026-01-04T00:00:00Z" },
];

describe("F57 multi-select", () => {
  it("plain click selects one, ctrl/meta toggles, shift extends from the anchor", () => {
    let s = clickSelect(ROWS, EMPTY_SELECTION, "b");
    expect(s.ids).toEqual(["b"]);
    s = clickSelect(ROWS, s, "d", { ctrl: true });
    expect(s.ids).toEqual(["b", "d"]);
    s = clickSelect(ROWS, s, "b", { meta: true });
    expect(s.ids).toEqual(["d"]);
    s = clickSelect(ROWS, { ids: ["a"], anchor: "a" }, "c", { shift: true });
    expect(s.ids).toEqual(["a", "b", "c"]);
    expect(s.anchor).toBe("a");
  });

  it("selectAll covers the list, prune drops vanished ids, selectedRows filters", () => {
    const all = selectAll(ROWS);
    expect(all.ids).toEqual(["a", "b", "c", "d"]);
    const pruned = pruneSelection(all, ROWS.slice(0, 2));
    expect(pruned.ids).toEqual(["a", "b"]);
    expect(selectedRows(ROWS, { ids: ["c"], anchor: "c" }).map((r) => r.id)).toEqual(["c"]);
    expect(toggleId(EMPTY_SELECTION, "x").ids).toEqual(["x"]);
    expect(selectRange(ROWS, EMPTY_SELECTION, "b").ids).toEqual(["b"]);
  });
});

describe("F57 undo stack (20 slots, LIFO)", () => {
  const entry = (id: string): OpEntry => ({ id, name: id + ".txt", kind: "file", sizeBytes: 1, modified: "2026-01-01T00:00:00Z" });

  it("caps at 20 and pops newest-first", () => {
    const stack = new UndoStack();
    for (let i = 0; i < 25; i += 1) stack.push(buildOp("rename", [entry("e" + i)], { targetName: "n" + i + ".txt" }));
    expect(stack.size()).toBe(UNDO_LIMIT);
    const first = stack.pop();
    expect(first?.op.entries[0].id).toBe("e24");
    const list = stack.list();
    expect(list[list.length - 1].op.entries[0].id).toBe("e23");
    while (stack.canUndo()) stack.pop();
    expect(stack.size()).toBe(0);
    expect(stack.pop()).toBeNull();
  });

  it("inverts every reversible op kind", () => {
    expect(invertOp(buildOp("trash", [entry("x")])).kind).toBe("restore");
    expect(invertOp(buildOp("restore", [entry("x")])).kind).toBe("trash");
    const moved = invertOp(buildOp("move", [entry("x")], { targetDir: "D:\\dst", sourceDir: "D:\\src" }));
    expect(moved.kind).toBe("move");
    expect(moved.targetDir).toBe("D:\\src");
    expect(moved.sourceDir).toBe("D:\\dst");
    const renamed = invertOp(buildOp("rename", [entry("x")], { targetName: "new.txt" }));
    expect(renamed.kind).toBe("rename");
    expect(renamed.targetName).toBe("x.txt");
    expect(invertOp(buildOp("mkdir", [], { targetName: "New" })).kind).toBe("delete");
  });

  it("applyOp validates names and applies each kind", () => {
    expect(isValidName("ok.txt")).toBe(true);
    expect(isValidName("bad/name")).toBe(false);
    expect(isValidName("")).toBe(false);
    expect(applyOp(ROWS, buildOp("mkdir", [], { targetName: "b.txt" }))).toEqual({ ok: false, reason: "name-taken" });
    const made = applyOp(ROWS, buildOp("mkdir", [], { targetName: "docs" }));
    expect(made.ok && made.rows.length).toBe(5);
    const renamed = applyOp(ROWS, buildOp("rename", [ROWS[0]], { targetName: "renamed.txt" }));
    expect(renamed.ok && renamed.rows[0].name).toBe("renamed.txt");
    const trashed = applyOp(ROWS, buildOp("trash", [ROWS[0]]));
    expect(trashed.ok && trashed.rows.length).toBe(3);
    const restored = applyOp(trashed.ok ? trashed.rows : ROWS, invertOp(buildOp("trash", [ROWS[0]])));
    expect(restored.ok && restored.rows.length).toBe(4);
    const copied = applyOp(ROWS, buildOp("copy", [ROWS[0]]));
    expect(copied.ok && copied.rows.length).toBe(5);
    const moved = applyOp(ROWS, buildOp("move", [ROWS[0]], { targetDir: "D:\\dst", sourceDir: "D:\\src" }));
    expect(moved.ok && moved.changed.length).toBe(1);
    expect(applyOp(ROWS, buildOp("trash", []))).toEqual({ ok: false, reason: "empty-selection" });
  });
});
