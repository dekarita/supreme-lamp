// [R-GLASS / #213 §6] GlassContainer — the ONE component that owns a glass
// surface. Nothing else in the app may write `backdrop-filter`, which is what
// keeps the compositor layer count auditable (the browser lab counts them).
//
// ADAPTED FROM (Flutter, MIT — facts, not source):
//   SpotiFLAC-Mobile @ a434e66fa8f30fd8489ee16e3d5d37b492f88edc
//   lib/widgets/mornye_chrome.dart (MornyeGlass) + lib/theme/mornye_theme.dart
//   * `_GlassBackdropScope` sets `insideGlass`; children skip backdrop
//     sampling — "child controls paint on this surface; never re-blur their
//     parent."  -> the `GlassBackdropScope` context below.
//   * clarity is one clamped, QUANTIZED 0..1 value  -> quantizeClarity().
//   * nested surfaces never sample again            -> surface="nested".
//   * tint is paint, not a saturation filter        -> alpha on
//     background-color, never `opacity` on the element.
//
// NOT ported: the Impeller refraction shader (`liquid_glass_easy`). CSS has no
// equivalent, and faking it with stacked filters would cost more GPU passes
// than it buys (#213 §5).
import React, { createContext, useContext, useMemo } from "react";
import { cn } from "@/lib/cn";
import { useGlassStore } from "@/stores/prefsStore";
import { useVisualQuality } from "@/lib/glass/useVisualQuality";
import {
  DEFAULT_CLARITY,
  DEFAULT_QUALITY,
  glassPaint,
  quantizeClarity,
  type GlassQuality,
  type GlassSurface,
  type GlassVariant,
} from "@/lib/glass/quality";

/**
 * `true` while rendering INSIDE a surface that already samples the backdrop.
 * Every descendant GlassContainer therefore paints paint-only — the CSS
 * analogue of `_GlassBackdropScope`'s `insideGlass` flag.
 */
const GlassBackdropScope = createContext(false);

export function GlassBackdropProvider({
  children,
  inside = true,
}: {
  children: React.ReactNode;
  inside?: boolean;
}) {
  return <GlassBackdropScope.Provider value={inside}>{children}</GlassBackdropScope.Provider>;
}

/** Does this element sit inside another backdrop surface? */
export function useInsideGlassBackdrop(): boolean {
  return useContext(GlassBackdropScope);
}

export type { GlassQuality, GlassVariant, GlassSurface };

type GlassTagName = "div" | "section" | "nav" | "aside" | "header" | "footer" | "ul" | "li" | "span" | "article" | "form";

export interface GlassContainerProps extends React.HTMLAttributes<HTMLElement> {
  /** tinted = menu/popover/strong fill; clear = chrome that shows the backdrop hue. */
  variant?: GlassVariant;
  /**
   * "backdrop" = this element may own the one shared backdrop filter.
   * "nested"   = paint on the parent's surface; never re-sample.
   * NOTE: this is a RENDERING prop. It is deliberately NOT called `role`,
   * so the HTML/ARIA role attribute stays free for real semantics.
   */
  surface?: GlassSurface;
  /** 0..1. Snapped to a step; never animated continuously. */
  clarity?: number;
  /** Bypasses the stored preference (used by the lab and by forced chrome). */
  quality?: GlassQuality;
  radius?: "none" | "sm" | "md" | "lg" | "overlay";
  as?: GlassTagName;
  /** Opt out of the shared backdrop scope (portals use this). */
  escapeScope?: boolean;
  children?: React.ReactNode;
}

const RADIUS_VAR: Record<NonNullable<GlassContainerProps["radius"]>, string> = {
  none: "0px",
  sm: "var(--radius-sm)",
  md: "var(--radius-md)",
  lg: "var(--radius-lg)",
  overlay: "var(--glass-overlay-radius)",
};

export const GlassContainer = React.forwardRef<HTMLElement, GlassContainerProps>(
  function GlassContainer(
    {
      variant: variantProp,
      surface: surfaceProp = "backdrop",
      clarity: clarityProp,
      quality: qualityProp,
      radius = "lg",
      as: Tag = "div",
      escapeScope = false,
      className,
      style,
      children,
      ...rest
    },
    ref
  ) {
    const prefQuality = useGlassStore((s) => s.quality);
    const prefClarity = useGlassStore((s) => s.clarity);
    const prefVariant = useGlassStore((s) => s.variant);
    const { env } = useVisualQuality();
    const insideGlass = useContext(GlassBackdropScope);

    const variant = variantProp ?? prefVariant;
    const requested = qualityProp ?? prefQuality ?? DEFAULT_QUALITY;
    const clarity = quantizeClarity(clarityProp ?? prefClarity ?? DEFAULT_CLARITY);
    // A descendant of a backdrop surface NEVER samples again, whatever it was
    // asked for. This is the load-bearing line of the whole system.
    const surface: GlassSurface = !escapeScope && insideGlass ? "nested" : surfaceProp;

    const paint = useMemo(
      () => glassPaint({ requested, variant, surface, clarity, env }),
      [requested, variant, surface, clarity, env]
    );

    const styleVars: React.CSSProperties = {
      ["--glass-alpha" as string]: String(paint.fillAlpha),
      ["--glass-blur" as string]: paint.blurPx + "px",
      ["--glass-border-alpha" as string]: String(paint.borderAlpha),
      ["--glass-radius" as string]: RADIUS_VAR[radius],
      ...style,
    };

    return (
      <GlassBackdropScope.Provider value={surface === "backdrop" ? true : insideGlass}>
        <Tag
          ref={ref as React.Ref<never>}
          data-glass="1"
          data-glass-surface={surface}
          data-glass-variant={variant}
          data-glass-quality={paint.quality}
          data-glass-samples={paint.samples ? "1" : "0"}
          data-glass-clarity={clarity}
          className={cn("glass", className)}
          style={styleVars}
          {...rest}
        >
          {children}
        </Tag>
      </GlassBackdropScope.Provider>
    );
  }
);

export default GlassContainer;

/**
 * A backdrop-filter element must never be a descendant of another one, and a
 * portal to document.body is its own backdrop layer. Wrap portaled overlay
 * content in this so its descendants stay paint-only while the overlay itself
 * is allowed to sample.
 */
export function GlassPortalScope({ children }: { children: React.ReactNode }) {
  return <GlassBackdropScope.Provider value={false}>{children}</GlassBackdropScope.Provider>;
}
