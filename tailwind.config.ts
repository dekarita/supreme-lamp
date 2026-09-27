import type { Config } from "tailwindcss";

// [F41 plan §1] Design tokens live in src/styles/tokens.css as CSS custom
// properties; this config only MIRRORS them into Tailwind utilities
// (bg-base, text-primary, border-default, ...). Never hand-write hex here.
export default {
  darkMode: ["class", '[data-theme="dark"]'],
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
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
        "focus-ring": "var(--color-focus-ring)",
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
