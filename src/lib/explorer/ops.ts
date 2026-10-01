// [F57 §2/§4] Explorer real-op model. Pure, transport-free: every command bar /
// context-menu / keyboard action builds ONE ExplorerOp, applies it optimistically
// to the row list, pushes it on the 20-slot undo stack and hands it to the
// durable operation queue (src/lib/explorer/queue.ts) which is the only place
// that talks to a transport. No DOM, no fetch, no i18n here - so the whole
// command surface is unit-testable without rendering.
export type ExplorerOpKind =
  | "mkdir"
  | "mkfile"
  | "rename"
  | "move"
  | "copy"
  | "trash"
  | "restore"
  | "delete"
  | "upload";

export interface OpEntry {
  id: string;
  name: string;
  kind: "folder" | "file";
  sizeBytes: number | null;
  modified: string;
}

export interface ExplorerOp {
  id: string;
  kind: ExplorerOpKind;
  ts: number;
  /** Snapshot of the affected entries BEFORE the op ran - the undo payload. */
  entries: OpEntry[];
  /** rename/mkdir/mkfile/copy: the new name (single entry ops only). */
  targetName?: string;
  /** move/copy: destination folder (tree path when known, else folder name). */
  targetDir?: string;
  /** move/copy: the source folder, so undo can move back. */
  sourceDir?: string;
}

export const UNDO_LIMIT = 20;

export type OpOutcome =
  | { ok: true; rows: OpEntry[]; changed: OpEntry[] }
  | { ok: false; reason: "empty-selection" | "name-taken" | "invalid-name" | "unsupported" };

const BAD_NAME = /[\\/:*?"<>|]/;

export function isValidName(name: string): boolean {
  const n = String(name || "").trim();
  return n.length > 0 && n.length <= 120 && !BAD_NAME.test(n) && n !== "." && n !== "..";
}

let seq = 0;
/** Deterministic-enough op id: monotonic counter + timestamp (no crypto dep). */
export function newOpId(now = Date.now()): string {
  seq += 1;
  return "op-" + now.toString(36) + "-" + seq.toString(36);
}

export function buildOp(
  kind: ExplorerOpKind,
  entries: OpEntry[],
  extra: Partial<Pick<ExplorerOp, "targetName" | "targetDir" | "sourceDir">> = {},
  now = Date.now()
): ExplorerOp {
  return { id: newOpId(now), kind, ts: now, entries: entries.map((e) => ({ ...e })), ...extra };
}

function uniqueName(rows: OpEntry[], name: string): boolean {
  return !rows.some((r) => r.name.toLowerCase() === name.trim().toLowerCase());
}

/**
 * Optimistic application of one op to a row list. Returns the new list plus the
 * entries the op touched (undo stack + queue payload). Never throws.
 */
export function applyOp(rows: OpEntry[], op: ExplorerOp): OpOutcome {
  const list = rows.map((r) => ({ ...r }));
  switch (op.kind) {
    case "mkdir":
    case "mkfile": {
      const name = String(op.targetName || "").trim();
      if (!isValidName(name)) return { ok: false, reason: "invalid-name" };
      if (!uniqueName(list, name)) return { ok: false, reason: "name-taken" };
      const created: OpEntry = {
        id: op.id + ":" + name,
        name,
        kind: op.kind === "mkdir" ? "folder" : "file",
        sizeBytes: op.kind === "mkdir" ? null : 0,
        modified: new Date(op.ts).toISOString(),
      };
      return { ok: true, rows: [...list, created], changed: [created] };
    }
    case "rename": {
      if (op.entries.length !== 1) return { ok: false, reason: "unsupported" };
      const name = String(op.targetName || "").trim();
      if (!isValidName(name)) return { ok: false, reason: "invalid-name" };
      const id = op.entries[0].id;
      const rest = list.filter((r) => r.id !== id);
      if (!uniqueName(rest, name)) return { ok: false, reason: "name-taken" };
      const next = list.map((r) => (r.id === id ? { ...r, name } : r));
      return { ok: true, rows: next, changed: next.filter((r) => r.id === id) };
    }
    case "move": {
      if (!op.entries.length) return { ok: false, reason: "empty-selection" };
      const ids = new Set(op.entries.map((e) => e.id));
      const next = list.map((r) => (ids.has(r.id) ? { ...r, name: r.name } : r));
      return { ok: true, rows: next, changed: next.filter((r) => ids.has(r.id)) };
    }
    case "copy": {
      if (op.entries.length !== 1) return { ok: false, reason: "unsupported" };
      const src = op.entries[0];
      let name = src.name;
      let n = 1;
      while (!uniqueName(list, name)) {
        n += 1;
        name = src.name.replace(/(\.[^.]+)?$/, " (" + n + ")$1");
      }
      const created: OpEntry = { ...src, id: op.id + ":" + name, name, modified: new Date(op.ts).toISOString() };
      return { ok: true, rows: [...list, created], changed: [created] };
    }
    case "trash": {
      if (!op.entries.length) return { ok: false, reason: "empty-selection" };
      const ids = new Set(op.entries.map((e) => e.id));
      return { ok: true, rows: list.filter((r) => !ids.has(r.id)), changed: op.entries };
    }
    case "delete": {
      if (!op.entries.length) return { ok: false, reason: "empty-selection" };
      const ids = new Set(op.entries.map((e) => e.id));
      return { ok: true, rows: list.filter((r) => !ids.has(r.id)), changed: op.entries };
    }
    case "upload":
      // Uploads queue a runner-side job; the local row list does not change.
      return { ok: true, rows: list, changed: [] };
    case "restore": {
      if (!op.entries.length) return { ok: false, reason: "empty-selection" };
      const back = op.entries.filter((e) => !list.some((r) => r.id === e.id));
      return { ok: true, rows: [...list, ...back.map((e) => ({ ...e }))], changed: back };
    }
    default:
      return { ok: false, reason: "unsupported" };
  }
}

/** The op that reverses `op`. Trash restores, mkdir/mkfile/copy delete. */
export function invertOp(op: ExplorerOp, now = Date.now()): ExplorerOp {
  const inv: ExplorerOpKind =
    op.kind === "trash" || op.kind === "delete"
      ? "restore"
      : op.kind === "restore"
      ? "trash"
      : op.kind === "move"
      ? "move"
      : op.kind === "rename"
      ? "rename"
      : "delete";
  const extra: Partial<Pick<ExplorerOp, "targetName" | "targetDir" | "sourceDir">> = {};
  if (op.kind === "rename") extra.targetName = op.entries[0]?.name;
  if (op.kind === "move") {
    extra.targetDir = op.sourceDir;
    extra.sourceDir = op.targetDir;
  }
  return { id: newOpId(now), kind: inv, ts: now, entries: op.entries.map((e) => ({ ...e })), ...extra };
}

export interface UndoRecord {
  op: ExplorerOp;
  inverse: ExplorerOp;
}

/** LIFO undo stack, 20 slots, per session (plan M8). */
export class UndoStack {
  private items: UndoRecord[] = [];
  push(op: ExplorerOp, now = Date.now()): void {
    this.items.push({ op, inverse: invertOp(op, now) });
    if (this.items.length > UNDO_LIMIT) this.items.splice(0, this.items.length - UNDO_LIMIT);
  }
  pop(): UndoRecord | null {
    return this.items.pop() || null;
  }
  peek(): UndoRecord | null {
    return this.items.length ? this.items[this.items.length - 1] : null;
  }
  size(): number {
    return this.items.length;
  }
  canUndo(): boolean {
    return this.items.length > 0;
  }
  /** Oldest-first copy - the rail renders it; mutation stays internal. */
  list(): UndoRecord[] {
    return this.items.slice();
  }
  clear(): void {
    this.items = [];
  }
}

export function describeOp(op: ExplorerOp): string {
  const names = op.entries.map((e) => e.name).join(", ");
  return op.kind + (names ? ":" + names : op.targetName ? ":" + op.targetName : "");
}
