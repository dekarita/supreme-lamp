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
