// [R-GLASS / #213 §4 + §6] Visual-quality resolution for the Mornye-inspired
// glass system.
//
// WHAT THIS FILE OWNS. The decision "what presentation does this browser get
// right now?" — and nothing else. Pixels live in `src/styles/tokens.css` and
// `src/styles/globals.css`; components live in
// `src/components/primitives/GlassContainer.tsx`.
//
// SOURCE-DERIVED FACTS (Flutter, SpotiFLAC-Mobile @ a434e66f, MIT). Adapted,
// not copied — a Flutter sigma is not a CSS px:
//   * three levels: flat (opaque) / frosted (one backdrop blur) / liquid
//     (shader, REJECTED here — CSS has no Impeller lens);
//   * nested glass never samples the backdrop again
//     ("child controls paint on this surface");
//   * clarity is ONE 0..1 value, default 0.75, clamped, and QUANTIZED — the
//     reference rebuilds its filter only on a step change, never per frame;
//   * below a threshold the blur is OFF even when clarity is non-zero
//     (frosted 0.5, liquid 0.2) — "10% must not suddenly enable backdrop
//     sampling";
//   * tint is paint, not a saturation filter.
//
// PROPOSED_FOR_VALIDATION (CSS). Blur px, fill alphas and border alphas are
// this repo's hypotheses (issue #213 §6 table), validated in the browser lab
// this session and published in the PR. They are NOT conversions of Flutter
// sigma.

export type GlassQuality = "auto" | "opaque" | "frosted" | "clear";
export type GlassVariant = "tinted" | "clear";
/** How the element relates to the shared backdrop. Never an ARIA role. */
export type GlassSurface = "backdrop" | "nested";

/** The five clarity steps. Continuous sliders are rejected: every intermediate
 *  value would rebuild a backdrop filter while the operator drags. */
export const CLARITY_STEPS = [0, 0.25, 0.5, 0.75, 1] as const;
export const DEFAULT_CLARITY = 0.75;
export const DEFAULT_QUALITY: GlassQuality = "auto";
export const DEFAULT_VARIANT: GlassVariant = "tinted";

/** Below this clarity the blur is off even though the fill is still tinted
 *  (the reference's "frosted 0.5" threshold). */
export const BLUR_THRESHOLD = 0.5;

/** Blur per quality, in CSS px. PROPOSED_FOR_VALIDATION (#213 §6 table). */
export const QUALITY_BLUR_PX: Record<Exclude<GlassQuality, "auto">, number> = {
  opaque: 0,
  frosted: 8,
  clear: 4,
};

/**
 * Fill alpha at clarity = 1, per (quality, variant).
 * Clarity interpolates 1.0 (clarity 0) -> this value (clarity 1), so the
 * published number at the 0.75 default is higher than the table entry.
 * PROPOSED_FOR_VALIDATION, then measured in the browser lab.
 */
export const QUALITY_FILL_ALPHA: Record<
  Exclude<GlassQuality, "auto">,
  Record<GlassVariant, number>
> = {
  opaque: { tinted: 1, clear: 1 },
  frosted: { tinted: 0.72, clear: 0.55 },
  clear: { tinted: 0.5, clear: 0.38 },
};

/** Border alpha per quality (opaque uses the solid contrast-tested token). */
export const QUALITY_BORDER_ALPHA: Record<Exclude<GlassQuality, "auto">, number> = {
  opaque: 0,
  frosted: 0.22,
  clear: 0.28,
};

export function clampClarity(n: number): number {
  const v = Number(n);
  if (!Number.isFinite(v)) return DEFAULT_CLARITY;
  return Math.min(1, Math.max(0, v));
}

/**
 * Snap to the nearest step. The reference quantizes for exactly this reason:
 * a continuous slider would rebuild the filter on every animation frame.
 */
export function quantizeClarity(n: number): number {
  const v = clampClarity(n);
  let best: number = CLARITY_STEPS[0];
  let bestD = Math.abs(v - best);
  for (const s of CLARITY_STEPS) {
    const d = Math.abs(v - s);
    if (d < bestD) {
      best = s;
      bestD = d;
    }
  }
  return best;
}

export function isClarityStep(n: number): boolean {
  return CLARITY_STEPS.includes(clampClarity(n) as (typeof CLARITY_STEPS)[number]);
}

/** Memoized: this is read on every GlassContainer render. */
let supportsCache: boolean | null = null;
export function supportsBackdropFilter(): boolean {
  if (supportsCache !== null) return supportsCache;
  if (typeof window === "undefined" || typeof CSS === "undefined" || typeof CSS.supports !== "function") {
    // jsdom: no backdrop-filter, and no way to ask. Assume opaque (the safe
    // readable answer) — tests assert the opaque fallback, never a blur.
    supportsCache = false;
    return supportsCache;
  }
  try {
    supportsCache =
      CSS.supports("backdrop-filter", "blur(4px)") ||
      CSS.supports("-webkit-backdrop-filter", "blur(4px)");
  } catch {
    supportsCache = false;
  }
  return supportsCache;
}

/** Test seam: jsdom and the lab need to force both branches. */
export function __setSupportsBackdropFilter(v: boolean | null): void {
  supportsCache = v;
}

function mediaMatches(query: string): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  try {
    return window.matchMedia(query).matches;
  } catch {
    return false;
  }
}

export function prefersReducedTransparency(): boolean {
  return mediaMatches("(prefers-reduced-transparency: reduce)");
}

export function prefersForcedColors(): boolean {
  return mediaMatches("(forced-colors: active)");
}

export interface QualityEnv {
  supports?: boolean;
  reducedTransparency?: boolean;
  forcedColors?: boolean;
  /** Set by the performance watchdog after a measured frame-time failure. */
  perfForcedOpaque?: boolean;
}

export function currentQualityEnv(): QualityEnv {
  return {
    supports: supportsBackdropFilter(),
    reducedTransparency: prefersReducedTransparency(),
    forcedColors: prefersForcedColors(),
    perfForcedOpaque: isPerfFallbackActive(),
  };
}

/**
 * Resolve the requested quality into the one that actually paints.
 *
 * Precedence (highest first) — matches #213 §8 and the operator's instruction
 * to preserve existing accessibility preferences:
 *   1. forced-colors / high contrast
 *   2. prefers-reduced-transparency: reduce
 *   3. measured performance failure (one-way latch, see watchdog below)
 *   4. backdrop-filter unsupported (older WebViews)
 *   5. the operator's explicit opaque choice
 *   6. the operator's explicit frosted / clear choice
 *   7. auto -> frosted on an eligible browser (the product default)
 */
export function resolveQuality(
  requested: GlassQuality,
  env: QualityEnv = currentQualityEnv()
): Exclude<GlassQuality, "auto"> {
  if (env.forcedColors) return "opaque";
  if (env.reducedTransparency) return "opaque";
  if (env.perfForcedOpaque) return "opaque";
  if (env.supports === false) return "opaque";
  if (requested === "opaque") return "opaque";
  if (requested === "frosted") return "frosted";
  if (requested === "clear") return "clear";
  return "frosted"; // auto
}

export interface GlassPaint {
  quality: Exclude<GlassQuality, "auto">;
  /** CSS px. 0 means "no backdrop-filter is applied at all". */
  blurPx: number;
  /** 0..1 alpha for `rgb(var(--glass-tint-rgb) / a)`. */
  fillAlpha: number;
  /** 0..1 border alpha; 0 means "use the solid border token". */
  borderAlpha: number;
  /** True only when this element is allowed to own a backdrop filter. */
  samples: boolean;
}

/**
 * The numbers one element paints with.
 *
 * `surface === "nested"` never samples: it paints on the parent's already
 * frosted surface (the reference's "child controls paint on this surface").
 * Nested surfaces also get a fill FLOOR so page text scrolling behind them
 * cannot bleed through — the honest alternative to giving every nested card
 * its own backdrop read.
 */
export function glassPaint(opts: {
  requested?: GlassQuality;
  variant?: GlassVariant;
  surface?: GlassSurface;
  clarity?: number;
  env?: QualityEnv;
}): GlassPaint {
  const requested = opts.requested ?? DEFAULT_QUALITY;
  const variant = opts.variant ?? DEFAULT_VARIANT;
  const surface = opts.surface ?? "backdrop";
  const clarity = clampClarity(opts.clarity ?? DEFAULT_CLARITY);
  const env = opts.env ?? currentQualityEnv();
  const quality = resolveQuality(requested, env);

  if (quality === "opaque") {
    return { quality, blurPx: 0, fillAlpha: 1, borderAlpha: 0, samples: false };
  }

  const tableAlpha = QUALITY_FILL_ALPHA[quality][variant];
  // clarity 0 -> fully opaque; clarity 1 -> the table value.
  let fillAlpha = 1 - (1 - tableAlpha) * clarity;
  const blurPx = clarity > BLUR_THRESHOLD ? QUALITY_BLUR_PX[quality] : 0;
  let borderAlpha = QUALITY_BORDER_ALPHA[quality] * (0.6 + 0.4 * clarity);

  const samples = surface === "backdrop" && blurPx > 0;
  if (!samples) {
    // Paint-only: raise the fill so nothing behind shows through.
    fillAlpha = Math.min(1, Math.max(fillAlpha, NESTED_FILL_FLOOR));
    if (blurPx === 0) borderAlpha = Math.max(borderAlpha, QUALITY_BORDER_ALPHA[quality] * 0.6);
  }

  return {
    quality,
    blurPx: samples ? blurPx : 0,
    fillAlpha: Math.round(fillAlpha * 10000) / 10000,
    borderAlpha: Math.round(borderAlpha * 10000) / 10000,
    samples,
  };
}

/** Minimum fill alpha for a paint-only (nested) surface. */
export const NESTED_FILL_FLOOR = 0.86;

/* ------------------------------------------------------------------ *
 * Performance watchdog (#213 §8: "demonstrated performance problems
 * select the redesigned opaque mode").
 *
 * ONE-WAY LATCH, never a loop: once it trips, the app stays opaque for the
 * rest of the session. That is the whole point — a single slow frame must not
 * produce an unstable quality-toggle loop, and an automatic switch BACK to
 * frosted would let the next slow frame re-trip it forever.
 * ------------------------------------------------------------------ */

let perfFallback = false;
/** Why it tripped. IN MEMORY ONLY, deliberately: the latch's job is "the rest
 *  of this page load", so it must not outlive the tab - and a storage key would
 *  add a surface to src/lib/ci/storageInventory.json for no operator benefit
 *  (nothing reads it back after a reload, by design). */
let perfFallbackWhy = "";

/**
 * Set by the React bridge so tripping the latch actually re-renders the app.
 * (A direct import would make quality.ts depend on React and create a cycle
 * with useVisualQuality.ts, which imports quality.ts.)
 */
let envChangeListener: (() => void) | null = null;
export function setEnvChangeListener(fn: (() => void) | null): void {
  envChangeListener = fn;
}

export function isPerfFallbackActive(): boolean {
  return perfFallback;
}

export function tripPerfFallback(reason: string): void {
  if (perfFallback) return;
  perfFallback = true;
  perfFallbackWhy = reason;
  if (typeof document !== "undefined") {
    document.documentElement.setAttribute("data-glass-perf", "opaque");
  }
  // Publish to React, or the operator would keep looking at a frosted shell
  // the code has already decided to make solid.
  if (envChangeListener) envChangeListener();
}

export function perfFallbackReason(): string {
  return perfFallbackWhy;
}
