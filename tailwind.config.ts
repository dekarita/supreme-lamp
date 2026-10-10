import type { Config } from "tailwindcss";

// [F41 plan §1] Design tokens live in src/styles/tokens.css as CSS custom
// properties; this config only MIRRORS them into Tailwind utilities
// (bg-base, text-primary, border-default, ...). Never hand-write hex here.
export default {
  darkMode: ["class", '[data-theme="dark"]'],
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  // [F79] A timestamp regex in lib/api.ts is not an arbitrary CSS property.
  blocklist: ["[-:TZ.]"],
  theme: {
    extend: {
      colors: {
        "fx-selection": "var(--color-fx-selection)",
        "fx-selection-border": "var(--color-fx-selection-border)",
        "fx-drop-target": "var(--color-fx-drop-target)",
        "fx-thumb-bg": "var(--color-fx-thumb-bg)",
        "fx-preview-scrim": "var(--color-fx-preview-scrim)",
        "fx-mask": "var(--color-fx-mask)",
        base: "var(--color-bg-base)",
        surface: "var(--color-bg-surface)",
        raised: "var(--color-bg-surface-raised)",
        sunken: "var(--color-bg-surface-sunken)",
        "border-default": "var(--color-border-default)",
        "border-strong": "var(--color-border-strong)",
        primary: "var(--color-text-primary)",
        secondary: "var(--color-text-secondary)",
        tertiary: "var(--color-text-tertiary)",
        "text-mono": "var(--color-text-mono)",
        accent: "var(--color-accent)",
        "accent-hover": "var(--color-accent-hover)",
        "accent-fg": "var(--color-accent-fg)",
        success: "var(--color-success)",
        warning: "var(--color-warning)",
        danger: "var(--color-danger)",
        "danger-hover": "var(--color-danger-hover)",
        "danger-fg": "var(--color-danger-fg)",
        "focus-ring": "var(--color-focus-ring)",
      },
      spacing: {
        "fx-row": "var(--space-fx-row)",
        "fx-row-compact": "var(--space-fx-row-compact)",
        "fx-tile": "var(--space-fx-tile)",
        "fx-column": "var(--space-fx-column)",
        "fx-drawer": "var(--space-fx-drawer)",
      },
      zIndex: {
        "fx-context": "var(--z-fx-context)",
        "fx-drawer": "var(--z-fx-drawer)",
        "fx-palette": "var(--z-fx-palette)",
      },
      borderColor: {
        default: "var(--color-border-default)",
        strong: "var(--color-border-strong)",
      },
      fontFamily: {
        sans: ["Inter", "-apple-system", "BlinkMacSystemFont", "Segoe UI Variable Text", "Segoe UI", "Noto Sans Sinhala", "Nirmala UI", "Iskoola Pota", "sans-serif"],
        mono: ["JetBrains Mono", "Roboto Mono", "SF Mono", "Cascadia Mono", "Consolas", "ui-monospace", "monospace"],
      },
      borderRadius: {
        DEFAULT: "var(--radius-sm)",
        md: "var(--radius-md)",
        lg: "var(--radius-lg)",
      },
      boxShadow: {
        xs: "var(--shadow-xs)",
        sm: "var(--shadow-sm)",
        md: "var(--shadow-md)",
      },
      transitionDuration: {
        fast: "100ms",
        med: "150ms",
        slow: "200ms",
      },
      maxWidth: {
        shell: "1600px",
      },
    },
  },
  plugins: [],
} satisfies Config;
