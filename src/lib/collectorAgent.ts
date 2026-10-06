// [F100 §3.1] collectorAgent.ts - button-click action logger for Collector.
//
// Every dashboard button click logs a structured record { feature, action, params, result, elapsedMs, ts }.
// Records are persisted in localStorage (so they survive reloads) and can be replayed.
// This lets the Collector page present BOTH auto-probe results and user-driven button outcomes,
// producing 100% feature coverage.

const STORAGE_KEY = "ghrdp.collector.actions.v1";

export interface ButtonAction {
  id: string;
  ts: string; // ISO timestamp
  feature: string; // e.g. "add-site", "launcher", "download", "fetch", "lab"
  action: string; // e.g. "save", "openUrl", "fetch", "inspect", "reconnect"
  params?: Record<string, unknown>;
  result?: unknown;
  elapsedMs?: number;
  error?: string;
}

type Listener = (actions: ButtonAction[]) => void;
const listeners = new Set<Listener>();

function readAll(): ButtonAction[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed as ButtonAction[];
    return [];
  } catch {
    return [];
  }
}

function writeAll(actions: ButtonAction[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(actions));
  } catch {
    // localStorage full / unavailable - keep in-memory
  }
}

function notify() {
  const snap = readAll();
  listeners.forEach((l) => {
    try { l(snap); } catch { /* ignore listener errors */ }
  });
}

/** Subscribe to action list changes. Returns unsubscribe fn. */
export function subscribeToActions(fn: Listener): () => void {
  listeners.add(fn);
  fn(readAll());
  return () => listeners.delete(fn);
}

/** Get a snapshot of all recorded actions. */
export function getRecordedActions(): ButtonAction[] {
  return readAll();
}

/** Log a button action. Returns the recorded action (with generated id + ts). */
export function logButtonAction(rec: Omit<ButtonAction, "id" | "ts">): ButtonAction {
  const action: ButtonAction = {
    id: "act_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8),
    ts: new Date().toISOString(),
    ...rec,
  };
  const all = readAll();
  all.push(action);
  // Cap at 500 actions to avoid localStorage bloat
  while (all.length > 500) all.shift();
  writeAll(all);
  notify();
  return action;
}

/** Clear all recorded actions. */
export function clearActions() {
  writeAll([]);
  notify();
}

/**
 * Replay a single action by index. The caller must provide a dispatcher map that
 * knows how to re-execute each (feature, action) pair. This keeps collectorAgent
 * free of UI/store imports - wiring lives in the feature modules.
 *
 *   replayAction(i, {
 *     "add-site:save": (p) => addSite(p.url, p.name),
 *     "launcher:openUrl": (p) => openUrl(p.url),
 *     ...
 *   })
 */
export async function replayAction(
  index: number,
  handlers: Record<string, (params: Record<string, unknown>) => unknown | Promise<unknown>>
): Promise<ButtonAction | null> {
  const all = readAll();
  const src = all[index];
  if (!src) return null;
  const key = src.feature + ":" + src.action;
  const handler = handlers[key];
  if (!handler) {
    const err: ButtonAction = {
      ...src,
      id: "act_" + Date.now().toString(36) + "_r",
      ts: new Date().toISOString(),
      error: "no replay handler for " + key,
      result: undefined,
    };
    const updated = readAll();
    updated.push(err);
    writeAll(updated);
    notify();
    return err;
  }
  const start = performance.now();
  try {
    const result = await handler(src.params || {});
    const elapsedMs = Math.round(performance.now() - start);
    const rec = logButtonAction({
      feature: src.feature,
      action: src.action + ".replay",
      params: src.params,
      result,
      elapsedMs,
    });
    return rec;
  } catch (e) {
    const elapsedMs = Math.round(performance.now() - start);
    const rec = logButtonAction({
      feature: src.feature,
      action: src.action + ".replay",
      params: src.params,
      error: String((e as Error)?.message || e),
      elapsedMs,
    });
    return rec;
  }
}

/**
 * Replay ALL recorded actions in sequence. Returns the new replay records.
 */
export async function replayAllActions(
  handlers: Record<string, (params: Record<string, unknown>) => unknown | Promise<unknown>>
): Promise<ButtonAction[]> {
  const all = readAll();
  const results: ButtonAction[] = [];
  // Only replay the original (non-replay) actions.
  for (let i = 0; i < all.length; i++) {
    if (all[i].action.endsWith(".replay")) continue;
    const r = await replayAction(i, handlers);
    if (r) results.push(r);
  }
  return results;
}
