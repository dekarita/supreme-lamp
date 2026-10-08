// [F110 §1/§6] state.ts - the arm switch, the subscriber set, and the reload seam.
//
// Deliberately imports NOTHING from channel.ts / audit.ts / featureToggles, and is the
// only module that touches PATCH_ARM_KEY: `featureToggles.ts` asks
// `isLivePatchArmed()` to decide whether stored "off" entries bite, so an import of
// channel.ts here would close a cycle (channel -> featureToggles -> state -> channel)
// and a cycle in the boot path is exactly how a section silently stops rendering.
//
// DEFAULT-OFF. Nothing in the live-patch surface runs until the operator writes
// PATCH_ARM_KEY = "true" (Settings > Developer > Live Patch). While disarmed,
// channel.ts returns before it verifies, before it writes, and before it touches
// IndexedDB - so a dashboard nobody armed cannot be patched, cannot grow an audit log,
// and cannot open a database.
import { PATCH_ARM_KEY, parseArmed } from "./patchCore";

type Listener = () => void;
const listeners = new Set<Listener>();
let version = 0;
let armedCache: boolean | null = null;
let crossTabOn: (() => void) | null = null;

function notify(): void {
  version += 1;
  for (const fn of Array.from(listeners)) {
    try {
      fn();
    } catch {
      /* a patch-audit subscriber must never break the socket or the page */
    }
  }
}

/** Subscribe to arm/audit changes. Returns the unsubscribe - the ONLY way to leave. */
export function subscribeLivePatch(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Publish a change made outside this module (the channel's audit appends). */
export function notifyLivePatch(): void {
  notify();
}

/** Monotonic change counter (useSyncExternalStore snapshot). */
export function livePatchVersion(): number {
  return version;
}

/** How many subscribers are installed right now - the lifecycle gate reads this. */
export function livePatchListenerCount(): number {
  return listeners.size;
}

function readArmed(): boolean {
  try {
    return parseArmed(typeof localStorage === "undefined" ? null : localStorage.getItem(PATCH_ARM_KEY));
  } catch {
    return false;
  }
}

/** Is the patch channel armed? Default false, and only the literal "true" enables it. */
export function isLivePatchArmed(): boolean {
  if (armedCache === null) armedCache = readArmed();
  return armedCache;
}

/** Settings > Developer > Live Patch. Off removes the key (no residue), like F109. */
export function setLivePatchArmed(on: boolean): void {
  try {
    if (on) localStorage.setItem(PATCH_ARM_KEY, "true");
    else localStorage.removeItem(PATCH_ARM_KEY);
  } catch {
    /* storage may be unavailable (private mode); the in-memory flag still flips */
  }
  armedCache = !!on;
  notify();
}

// ---------------------------------------------------------------------------
// [F110 §6 / §MOCK-LIFECYCLE] Cross-tab sync, installed on scope ENTRY and removed on
// scope EXIT. Every global this module adds goes through this pair, so "did F110 leave
// anything behind when the panel unmounted?" has one answer: livePatchListenerCount().
// ---------------------------------------------------------------------------
export function installLivePatchCrossTab(): () => void {
  if (crossTabOn) return crossTabOn;
  if (typeof window === "undefined") return () => undefined;
  const onStorage = (ev: StorageEvent): void => {
    // another tab armed or disarmed the channel
    if (ev && ev.key === PATCH_ARM_KEY) {
      armedCache = readArmed();
      notify();
    }
  };
  window.addEventListener("storage", onStorage);
  crossTabOn = () => {
    window.removeEventListener("storage", onStorage);
    crossTabOn = null;
  };
  return crossTabOn;
}

// ---------------------------------------------------------------------------
// [F110 §5] The reload seam. Rollback restores the toggles immediately; whether the
// page also reloads is an operator-facing choice, and jsdom (and any embedding host
// that owns navigation) has no reload to call. So the reloader is INJECTED, exactly as
// F107 injects its rasterizer and its downloader: the shipped default calls reload when
// one exists, a test installs a spy. An untestable side effect is a bug magnet.
// ---------------------------------------------------------------------------
type Reloader = () => void;
let reloader: Reloader | null = null;

export function setLivePatchReloader(fn: Reloader | null): void {
  reloader = typeof fn === "function" ? fn : null;
}

export function isDefaultReloaderActive(): boolean {
  return reloader === null;
}

export function requestPatchReload(): void {
  if (reloader) {
    try {
      reloader();
    } catch {
      /* a host that refuses navigation still has its toggles restored */
    }
    return;
  }
  try {
    if (typeof window !== "undefined" && window.location && typeof window.location.reload === "function") {
      window.location.reload();
    }
  } catch {
    /* jsdom and file:// contexts have no reload */
  }
}

/** Test-only: forget every module-level flag and subscriber. */
export function __resetLivePatchForTests(): void {
  if (crossTabOn) crossTabOn();
  listeners.clear();
  reloader = null;
  armedCache = null;
  version = 0;
}
