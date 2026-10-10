// [F41 plan §4.16/§8.2] Persisted UI preference stores (zustand + localStorage).
import { create } from "zustand";
import { persist } from "zustand/middleware";

// Theme: html[data-theme="dark"|"light"], key 'ghrdp:theme' (F38-compatible).
export type Theme = "dark" | "light";
interface ThemeState {
  theme: Theme;
  setTheme: (t: Theme) => void;
  toggle: () => void;
}
export const useThemeStore = create<ThemeState>()(
  persist(
    (set, get) => ({
      theme: "dark",
      setTheme: (t) => {
        set({ theme: t });
        applyTheme(t);
      },
      toggle: () => get().setTheme(get().theme === "dark" ? "light" : "dark"),
    }),
    {
      name: "ghrdp:theme",
      onRehydrateStorage: () => (state) => {
        if (state) applyTheme(state.theme);
      },
    }
  )
);
export function applyTheme(t: Theme): void {
  document.documentElement.setAttribute("data-theme", t);
}

// Text scale: html[data-scale="comfort"|"large"|"a11y"], key 'textScale' (plan §1.7).
export type TextScale = "comfort" | "large" | "a11y";
interface ScaleState {
  scale: TextScale;
  setScale: (s: TextScale) => void;
  cycle: () => void;
}
export const useScaleStore = create<ScaleState>()(
  persist(
    (set, get) => ({
      scale: "comfort",
      setScale: (s) => {
        set({ scale: s });
        applyScale(s);
      },
      cycle: () => {
        const order: TextScale[] = ["comfort", "large", "a11y"];
        const next = order[(order.indexOf(get().scale) + 1) % order.length];
        get().setScale(next);
      },
    }),
    {
      name: "ghrdp:textScale",
      onRehydrateStorage: () => (state) => {
        if (state) applyScale(state.scale);
      },
    }
  )
);
export function applyScale(s: TextScale): void {
  document.documentElement.setAttribute("data-scale", s);
}

// Sidebar: collapsed persisted ('sidebarCollapsed', plan §4.16) + transient
// mobile overlay open state.
interface SidebarState {
  collapsed: boolean;
  mobileOpen: boolean;
  toggleCollapsed: () => void;
  setMobileOpen: (v: boolean) => void;
}
export const useSidebarStore = create<SidebarState>()(
  persist(
    (set, get) => ({
      collapsed: false,
      mobileOpen: false,
      toggleCollapsed: () => set({ collapsed: !get().collapsed }),
      setMobileOpen: (v) => set({ mobileOpen: v }),
    }),
    { name: "ghrdp:sidebarCollapsed", partialize: (s) => ({ collapsed: s.collapsed }) }
  )
);

// Language: 'ghrdp:lang' (F38-compatible key); drives i18next + html[lang].
export type Lang = "en" | "si";
interface LangState {
  lang: Lang;
  setLang: (l: Lang) => void;
  toggle: () => void;
}
export const useLangStore = create<LangState>()(
  persist(
    (set, get) => ({
      lang: "en",
      setLang: (l) => {
        set({ lang: l });
        applyLang(l);
      },
      toggle: () => get().setLang(get().lang === "en" ? "si" : "en"),
    }),
    {
      name: "ghrdp:lang",
      onRehydrateStorage: () => (state) => {
        if (state) applyLang(state.lang);
      },
    }
  )
);
export function applyLang(l: Lang): void {
  document.documentElement.lang = l;
}

/* ------------------------------------------------------------------ *
 * [R-GLASS / #213 §8] Visual quality + glass clarity.
 *
 * Persisted beside the theme on purpose: the reference app keeps quality and
 * clarity in its own theme settings object, and the operator's choice has to
 * survive a reload the same way `ghrdp:theme` does.
 *
 * DEFAULT is `auto`, NOT `opaque`. #213 §8 proposed opaque as the default;
 * this session was asked to validate auto instead, and §Auto-Decision of the
 * delivery notes records why: `auto` resolves to opaque on every browser that
 * cannot afford the effect (no backdrop-filter, reduced transparency, forced
 * colors, measured frame-time failure), so the solid presentation is still
 * what an ineligible browser gets — while an eligible one gets the frosted
 * presentation the operator asked to see. An explicit existing `opaque`
 * preference is preserved: we never upgrade a stored choice.
 * ------------------------------------------------------------------ */
export type GlassQuality = "auto" | "opaque" | "frosted" | "clear";
export type GlassVariant = "tinted" | "clear";

export const DEFAULT_CLARITY = 0.75;

interface GlassState {
  quality: GlassQuality;
  clarity: number;
  variant: GlassVariant;
  setQuality: (q: GlassQuality) => void;
  setClarity: (c: number) => void;
  setVariant: (v: GlassVariant) => void;
}

/** The attribute the CSS reads, so the root is the single switch. */
function applyGlass(quality: GlassQuality, clarity: number, variant: GlassVariant): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  // The RESOLVED quality (auto -> frosted/opaque) is applied by
  // syncGlassQualityAttribute() from lib/glass/quality, which also owns the
  // media-query listeners. Here we only publish what the operator chose.
  root.setAttribute("data-glass-quality", quality);
  root.setAttribute("data-glass-variant", variant);
  root.setAttribute("data-glass-clarity", String(clarity));
}

export const useGlassStore = create<GlassState>()(
  persist(
    (set, get) => ({
      quality: "auto",
      clarity: DEFAULT_CLARITY,
      variant: "tinted",
      setQuality: (q) => {
        set({ quality: q });
        applyGlass(q, get().clarity, get().variant);
      },
      setClarity: (c) => {
        const v = Math.min(1, Math.max(0, Number(c) || 0));
        set({ clarity: v });
        applyGlass(get().quality, v, get().variant);
      },
      setVariant: (v) => {
        set({ variant: v });
        applyGlass(get().quality, get().clarity, v);
      },
    }),
    {
      name: "ghrdp:glass",
      onRehydrateStorage: () => (state) => {
        if (state) applyGlass(state.quality, state.clarity, state.variant);
      },
    }
  )
);
