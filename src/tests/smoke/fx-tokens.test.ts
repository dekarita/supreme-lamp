// F45 S1 — exact Explorer §1 values, aliases, and no extra hue/radius/motion.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import postcss from 'postcss';
import config from '../../../tailwind.config';

const css = readFileSync('src/styles/tokens.css', 'utf8').replace(/\r\n?/g, '\n');
const theme = (selector: string) => {
  const values: Record<string, string> = {};
  postcss.parse(css).walkRules(selector, (rule) => {
    rule.walkDecls((decl) => { if (decl.prop.includes('-fx-')) values[decl.prop] = decl.value; });
  });
  return values;
};
const colors = {
  selection: ['rgba(14,165,233,0.12)', 'rgba(14,165,233,0.18)'],
  'selection-border': ['#0ea5e9', '#38bdf8'],
  'drop-target': ['rgba(14,165,233,0.08)', 'rgba(14,165,233,0.14)'],
  'thumb-bg': ['#f1f5f9', '#0b1220'],
  'preview-scrim': ['rgba(15,23,42,0.60)', 'rgba(15,23,42,0.72)'],
  mask: ['#334155', '#94a3b8'],
};

describe('F45 S1 Explorer tokens', () => {
  it.each(Object.entries(colors))('%s uses the exact light/dark ramp and Tailwind alias', (name, values) => {
    expect(theme(':root')[`--color-fx-${name}`]).toBe(values[0]);
    expect(theme('html[data-theme="dark"]')[`--color-fx-${name}`]).toBe(values[1]);
    expect(config.theme.extend.colors).toHaveProperty(`fx-${name}`, `var(--color-fx-${name})`);
  });
  it('keeps spacing on the 4px grid and mirrors each token', () => {
    for (const [name, pixels] of Object.entries({ row: 36, 'row-compact': 28, tile: 128, column: 240, drawer: 480 })) {
      expect(pixels % 4).toBe(0);
      expect(theme(':root')[`--space-fx-${name}`]).toBe(`${pixels}px`);
      expect(config.theme.extend.spacing).toHaveProperty(`fx-${name}`, `var(--space-fx-${name})`);
    }
  });
  it('mirrors context/drawer/palette layers without changing parent layers', () => {
    for (const [name, z] of Object.entries({ context: 60, drawer: 45, palette: 70 })) {
      expect(theme(':root')[`--z-fx-${name}`]).toBe(String(z));
      expect(config.theme.extend.zIndex).toHaveProperty(`fx-${name}`, `var(--z-fx-${name})`);
    }
    expect(Object.keys(theme(':root'))).toHaveLength(14);
    expect(Object.keys(theme('html[data-theme="dark"]'))).toHaveLength(6);
  });
});
