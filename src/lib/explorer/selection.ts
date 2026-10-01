// [F57 §2] Multi-select state machine: Shift-click range, Ctrl/Cmd-click
// toggle, Ctrl+A all. Pure functions over the row list - the component only
// stores the returned SelectionState, so every rule the gate pins is testable
// without a DOM (plan M6 anchor model).
export interface SelectableRow {
  id: string;
}

export interface SelectionState {
  ids: string[];
  /** Range anchor: the last row clicked WITHOUT shift. */
  anchor: string | null;
}

export const EMPTY_SELECTION: SelectionState = { ids: [], anchor: null };

export function isSelected(state: SelectionState, id: string): boolean {
  return state.ids.indexOf(id) >= 0;
}

export function selectOnly(id: string): SelectionState {
  return { ids: [id], anchor: id };
}

export function clearSelection(): SelectionState {
  return { ids: [], anchor: null };
}

export function toggleId(state: SelectionState, id: string): SelectionState {
  if (isSelected(state, id)) {
    return { ids: state.ids.filter((x) => x !== id), anchor: state.anchor === id ? null : state.anchor };
  }
  return { ids: [...state.ids, id], anchor: id };
}

/** Shift-click: inclusive range from the anchor to `id`, anchor preserved. */
export function selectRange(rows: SelectableRow[], state: SelectionState, id: string): SelectionState {
  const anchor = state.anchor && rows.some((r) => r.id === state.anchor) ? state.anchor : null;
  const to = rows.findIndex((r) => r.id === id);
  if (to < 0) return state;
  if (!anchor) return selectOnly(id);
  const from = rows.findIndex((r) => r.id === anchor);
  if (from < 0) return selectOnly(id);
  const lo = Math.min(from, to);
  const hi = Math.max(from, to);
  return { ids: rows.slice(lo, hi + 1).map((r) => r.id), anchor };
}

export function selectAll(rows: SelectableRow[]): SelectionState {
  return { ids: rows.map((r) => r.id), anchor: rows.length ? rows[0].id : null };
}

/** Click routing: shift = range, ctrl/meta = toggle, plain = single. */
export function clickSelect(
  rows: SelectableRow[],
  state: SelectionState,
  id: string,
  mods: { shift?: boolean; ctrl?: boolean; meta?: boolean } = {}
): SelectionState {
  if (mods.shift) return selectRange(rows, state, id);
  if (mods.ctrl || mods.meta) return toggleId(state, id);
  return selectOnly(id);
}

/** Drop ids that no longer exist (after ops / location changes). */
export function pruneSelection(state: SelectionState, rows: SelectableRow[]): SelectionState {
  const ids = state.ids.filter((id) => rows.some((r) => r.id === id));
  if (ids.length === state.ids.length) return state;
  return { ids, anchor: state.anchor && rows.some((r) => r.id === state.anchor) ? state.anchor : ids[0] || null };
}

export function selectedRows<T extends SelectableRow>(rows: T[], state: SelectionState): T[] {
  return rows.filter((r) => isSelected(state, r.id));
}
