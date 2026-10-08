// [F109 §2-§5] debugHud.ts - the browser half of the Debug HUD.
//
// Owns: the enabled flag (the ONLY reader/writer of HUD_ENABLED_KEY), the open
// state, the Shift+F12 listener, and two bounded in-memory rings (Network rows,
// WebSocket frame descriptors). Every decision is delegated to debugHudCore.js.
//
// OBSERVE, NEVER WRAP. The Network panel reads PerformanceObserver("resource")
// entries. It does NOT wrap window.fetch: three modules already do (F101's
// permanent observer, F104's 10 s click windows, F106's lab interceptor), and their
// conditional-restore rules interact - the F109 session proved that a wrapper on top
// of the lab's once kept a forced lab scenario alive after the lab unmounted (fixed
// in lib/lab/mockBackend.ts). A fourth wrapper would add a fourth ordering hazard to
// buy data the browser already publishes passively. tests/f109-debug-hud.test.js
// pins the absence (no `window.fetch =` in any F109 file).
//
// DEFAULT-OFF. Nothing here runs until the operator enables the HUD: the shortcut
// handler returns early, recordWsFrame() returns early, and the observers are only
// started by enableObservers(), which the overlay calls while enabled.
import {
  HUD_ENABLED_KEY,
  HUD_RING_MAX,
  isHudShortcut,
  parseEnabled,
  pushRing,
  resourceToNetRow,
  wsFrameDescriptor,
  type HudNetRow,
  type HudWsFrame,
} from "./debugHudCore";
import { onFeatureBoundaryError, type FeatureBoundaryErrorDetail } from "@/lib/featureBoundary";

type Listener = () => void;
const listeners = new Set<Listener>();
let version = 0;
let enabledCache: boolean | null = null;
let open = false;
const netRing: HudNetRow[] = [];
const wsRing: HudWsFrame[] = [];
const lastErrors = new Map<string, { message: string; ts: string; count: number }>();

function notify(): void {
  version += 1;
  for (const fn of Array.from(listeners)) {
    try {
      fn();
    } catch {
      /* a HUD subscriber must never break the page */
    }
  }
}

/** Subscribe to any HUD state change. Returns the unsubscribe function. */
export function subscribeHud(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Monotonic change counter (useSyncExternalStore snapshot). */
export function hudVersion(): number {
  return version;
}

function readEnabled(): boolean {
  try {
    return parseEnabled(typeof localStorage === "undefined" ? null : localStorage.getItem(HUD_ENABLED_KEY));
  } catch {
    return false;
  }
}

/** Is the HUD available (Settings toggle)? Default false. */
export function isHudEnabled(): boolean {
  if (enabledCache === null) enabledCache = readEnabled();
  return enabledCache;
}

/** Settings ▸ Debug HUD. Off removes the key (no residue) and closes the overlay. */
export function setHudEnabled(on: boolean): void {
  try {
    if (on) localStorage.setItem(HUD_ENABLED_KEY, "true");
    else localStorage.removeItem(HUD_ENABLED_KEY);
  } catch {
    /* storage may be unavailable (private mode); the in-memory flag still flips */
  }
  enabledCache = !!on;
  if (!on) {
    open = false;
    disableObservers();
  }
  notify();
}

export function isHudOpen(): boolean {
  return open && isHudEnabled();
}

export function setHudOpen(next: boolean): void {
  const want = !!next && isHudEnabled();
  if (want === open) return;
  open = want;
  notify();
}

// ---------------------------------------------------------------------------
// [F109 §2] Shift+F12. One window listener, idempotent install.
// ---------------------------------------------------------------------------
let shortcutOff: (() => void) | null = null;

export function installHudShortcut(): () => void {
  if (shortcutOff) return shortcutOff;
  if (typeof window === "undefined") return () => undefined;
  const onKey = (ev: KeyboardEvent): void => {
    try {
      if (!isHudEnabled()) return; // default-off: the shortcut is inert
      if (isHudShortcut(ev)) {
        ev.preventDefault();
        setHudOpen(!open);
      } else if (ev.key === "Escape" && open) {
        setHudOpen(false);
      }
    } catch {
      /* never break typing */
    }
  };
  const onStorage = (ev: StorageEvent): void => {
    // another tab flipped Settings ▸ Debug HUD
    if (ev && ev.key === HUD_ENABLED_KEY) {
      enabledCache = readEnabled();
      if (!enabledCache) {
        open = false;
        disableObservers();
      }
      notify();
    }
  };
  window.addEventListener("keydown", onKey);
  window.addEventListener("storage", onStorage);
  shortcutOff = () => {
    window.removeEventListener("keydown", onKey);
    window.removeEventListener("storage", onStorage);
    shortcutOff = null;
  };
  return shortcutOff;
}

// ---------------------------------------------------------------------------
// [F109 §5] WebSocket tap. Called from useDashboardPolling's socket handlers.
// Receives the raw inbound text (described, never stored) or, for OUR frames, a
// bare type tag - the hello frame's dash token is never handed to the HUD.
// ---------------------------------------------------------------------------
export function recordWsFrame(dir: "in" | "out" | "open" | "close", raw?: unknown): void {
  if (!isHudEnabled()) return;
  try {
    pushRing(wsRing, wsFrameDescriptor(dir, raw, Date.now()), HUD_RING_MAX);
    notify();
  } catch {
    /* the socket must never notice the HUD */
  }
}

export function hudWsFrames(): HudWsFrame[] {
  return wsRing.slice();
}

// ---------------------------------------------------------------------------
// [F109 §5] Network: passive resource timing + boundary crash feed.
// ---------------------------------------------------------------------------
let perfObserver: { disconnect: () => void } | null = null;
let boundaryOff: (() => void) | null = null;
let observersOn = false;

function ingestResource(entry: unknown): void {
  const row = resourceToNetRow(entry, Date.now());
  if (row) pushRing(netRing, row, HUD_RING_MAX);
}

/** Start the passive observers (idempotent). Returns whether resource timing is available. */
export function enableObservers(): boolean {
  if (!isHudEnabled()) return false;
  if (!boundaryOff) {
    boundaryOff = onFeatureBoundaryError((d: FeatureBoundaryErrorDetail) => {
      const prev = lastErrors.get(d.feature);
      lastErrors.set(d.feature, { message: d.message, ts: d.ts, count: (prev ? prev.count : 0) + 1 });
      notify();
    });
  }
  if (observersOn) return perfObserver !== null;
  observersOn = true;
  try {
    const PO = (typeof window !== "undefined" ? (window as unknown as { PerformanceObserver?: unknown }).PerformanceObserver : undefined) as
      | (new (cb: (list: { getEntries: () => unknown[] }) => void) => { observe: (o: unknown) => void; disconnect: () => void })
      | undefined;
    if (typeof PO !== "function") return false;
    const obs = new PO((list) => {
      try {
        for (const e of list.getEntries()) ingestResource(e);
        notify();
      } catch {
        /* ignore */
      }
    });
    obs.observe({ type: "resource", buffered: true });
    perfObserver = obs;
    return true;
  } catch {
    perfObserver = null;
    return false;
  }
}

export function disableObservers(): void {
  observersOn = false;
  try {
    if (perfObserver) perfObserver.disconnect();
  } catch {
    /* ignore */
  }
  perfObserver = null;
  if (boundaryOff) boundaryOff();
  boundaryOff = null;
}

export function networkObserverActive(): boolean {
  return perfObserver !== null;
}

export function hudNetRows(): HudNetRow[] {
  return netRing.slice();
}

export function hudLastErrors(): Map<string, { message: string; ts: string; count: number }> {
  return new Map(lastErrors);
}

/** Actions ▸ Clear: forget everything the HUD itself buffered. */
export function clearHudBuffers(): void {
  netRing.length = 0;
  wsRing.length = 0;
  lastErrors.clear();
  notify();
}

/** Test-only: forget every module-level flag and buffer. */
export function __resetDebugHudForTests(): void {
  if (shortcutOff) shortcutOff();
  disableObservers();
  enabledCache = null;
  open = false;
  netRing.length = 0;
  wsRing.length = 0;
  lastErrors.clear();
  listeners.clear();
  version = 0;
}
