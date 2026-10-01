// [F57 §2] Keyboard shortcuts. tinykeys-style binding tables implemented
// in-repo (no new runtime dependency - the single-file bundle and the frozen
// lockfile stay untouched): a combo is `mod+shift+z`, `F2`, `Delete`, and
// `mod` resolves to Control on Windows/Linux and Meta on macOS. The binder is
// deliberately tiny: one listener per target, exact key + modifier matching,
// form fields exempt so typing a rename never triggers Delete.
export type KeyHandler = (event: KeyboardEvent) => void;
export type KeyBindings = Record<string, KeyHandler>;

export interface ParsedCombo {
  key: string;
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
  alt: boolean;
  mod: boolean;
}

export const IS_MAC =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/.test(String(navigator.platform || navigator.userAgent || ""));

/** The exact F57 shortcut table (session §2) - gated verbatim. */
export const EXPLORER_KEYMAP: readonly string[] = [
  "F2",
  "Delete",
  "Shift+Delete",
  "mod+c",
  "mod+x",
  "mod+v",
  "mod+a",
  "mod+z",
  "Enter",
] as const;

export function parseCombo(combo: string): ParsedCombo {
  const parts = String(combo || "")
    .split("+")
    .map((p) => p.trim())
    .filter(Boolean);
  const key = parts.length ? parts[parts.length - 1] : "";
  const mods = parts.slice(0, -1).map((m) => m.toLowerCase());
  return {
    key,
    ctrl: mods.includes("ctrl") || mods.includes("control"),
    meta: mods.includes("meta") || mods.includes("cmd") || mods.includes("command"),
    shift: mods.includes("shift"),
    alt: mods.includes("alt") || mods.includes("option"),
    mod: mods.includes("mod") || mods.includes("ctrl+mod"),
  };
}

export function matchesCombo(combo: string, event: KeyboardEvent): boolean {
  const c = parseCombo(combo);
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  const want = c.key.length === 1 ? c.key.toLowerCase() : c.key;
  if (key !== want) return false;
  if (c.shift !== event.shiftKey) return false;
  if (c.alt !== event.altKey) return false;
  if (c.mod) {
    const primary = IS_MAC ? event.metaKey : event.ctrlKey;
    if (!primary) return false;
    const secondary = IS_MAC ? event.ctrlKey : event.metaKey;
    if (secondary) return false;
    return true;
  }
  if (c.ctrl !== event.ctrlKey) return false;
  if (c.meta !== event.metaKey) return false;
  return true;
}

export function isFormField(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || !el.tagName) return false;
  const tag = el.tagName.toUpperCase();
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return el.isContentEditable === true;
}

/**
 * Bind a table to a target. Returns the unbind function (React effect cleanup).
 * `Escape` is NOT part of the pinned table but callers may add it; handlers
 * always run with the matched combo and the original event.
 */
export function tinykeys(target: EventTarget, bindings: KeyBindings): () => void {
  const combos = Object.keys(bindings);
  const onKeyDown = (raw: Event) => {
    const event = raw as KeyboardEvent;
    if (isFormField(event.target) && event.key !== "Escape") return;
    for (const combo of combos) {
      if (matchesCombo(combo, event)) {
        event.preventDefault();
        bindings[combo](event);
        return;
      }
    }
  };
  target.addEventListener("keydown", onKeyDown as EventListener);
  return () => target.removeEventListener("keydown", onKeyDown as EventListener);
}
