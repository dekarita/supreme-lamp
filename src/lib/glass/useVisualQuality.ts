// [R-GLASS / #213] The React bridge for the visual-quality system.
//
// ONE subscription for the whole app, not one matchMedia listener per
// GlassContainer: the shell mounts hundreds of surfaces, and 300 listeners on
// the same two media queries is exactly the kind of "clever" that shows up as
// a long task in the very benchmark this feature has to pass.
import { useEffect, useSyncExternalStore } from "react";
import { useGlassStore } from "@/stores/prefsStore";
import {
  currentQualityEnv,
  isPerfFallbackActive,
  resolveQuality,
  setEnvChangeListener,
  prefersForcedColors,
  prefersReducedTransparency,
  supportsBackdropFilter,
  type GlassQuality,
  type QualityEnv,
} from "./quality";

const listeners = new Set<() => void>();
// Computed LAZILY on first read, not at module load: the module is imported
// before a test can stub CSS.supports, and an eager read would freeze whatever
// the host happened to answer at import time.
let snapshot: (QualityEnv & { quality: GlassQuality }) | null = null;
let mqls: MediaQueryList[] = [];
let bound = false;

function emit() {
  snapshot = { ...currentQualityEnv(), quality: "auto" };
  for (const l of listeners) l();
}

setEnvChangeListener(emit);

function bind() {
  if (bound || typeof window === "undefined" || typeof window.matchMedia !== "function") return;
  bound = true;
  for (const q of ["(prefers-reduced-transparency: reduce)", "(forced-colors: active)"]) {
    try {
      const m = window.matchMedia(q);
      m.addEventListener("change", emit);
      mqls.push(m);
    } catch {
      /* older Safari: the initial read is still correct */
    }
  }
}

function subscribe(cb: () => void): () => void {
  bind();
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function getSnapshot(): QualityEnv & { quality: GlassQuality } {
  if (snapshot === null) snapshot = { ...currentQualityEnv(), quality: "auto" };
  return snapshot;
}

export function refreshVisualQualityEnv(): void {
  emit();
}

export interface VisualQualityState {
  /** What the operator chose. */
  requested: GlassQuality;
  /** What actually paints, after every accessibility/perf override. */
  resolved: Exclude<GlassQuality, "auto">;
  env: QualityEnv;
}

/**
 * The app-wide visual quality. Cheap: one module-level snapshot, so every
 * GlassContainer re-renders together and none of them owns a listener.
 */
export function useVisualQuality(): VisualQualityState {
  const env = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const requested = useGlassStore((s) => s.quality);
  return { requested, resolved: resolveQuality(requested, env), env };
}

/**
 * Mounted ONCE (in AppShell). Publishes the RESOLVED quality on
 * <html data-glass-quality-resolved>, plus the capability flags, so CSS and
 * the browser lab can assert the real state without guessing.
 */
export function useVisualQualityRootAttribute(): VisualQualityState {
  const state = useVisualQuality();
  const { requested, resolved, env } = state;
  useEffect(() => {
    if (typeof document === "undefined") return;
    const root = document.documentElement;
    root.setAttribute("data-glass-quality-resolved", resolved);
    root.setAttribute("data-glass-requested", requested);
    root.setAttribute("data-glass-backdrop-support", env.supports ? "yes" : "no");
    root.setAttribute(
      "data-glass-reduced-transparency",
      env.reducedTransparency ? "yes" : "no"
    );
    root.setAttribute("data-glass-forced-colors", env.forcedColors ? "yes" : "no");
    root.setAttribute("data-glass-perf-fallback", env.perfForcedOpaque ? "yes" : "no");
  }, [requested, resolved, env]);
  return state;
}

/* Re-exported so components import from one place. */
export {
  supportsBackdropFilter,
  prefersReducedTransparency,
  prefersForcedColors,
  isPerfFallbackActive,
};
