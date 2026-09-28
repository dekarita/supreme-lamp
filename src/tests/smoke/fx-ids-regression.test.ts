// F45 S1: source-lock proof only. S5 adds /files DOM coverage (not claimed here).
import { describe, expect, it } from 'vitest';
import { REGRESSION_IDS } from '@/lib/regression-ids';
import { REGRESSION_FX_IDS, REGRESSION_FX_CLASSES } from '@/components/explorer/regression-fx-ids';
// @ts-expect-error Node gate is shared with CI without a TS build step.
import { checkLocks, checkSource, checkProject, readLock } from '../../../scripts/check-fx-ids.mjs';

const file = 'src/components/explorer/Example.tsx';
const check = (source: string, path = file) => checkSource(source, path, REGRESSION_FX_IDS, REGRESSION_FX_CLASSES);

describe('F45 S1 fx-ids source lock', () => {
  it('freezes the ten IDs and one class explicitly named by Explorer §§2–3', () => {
    expect([...REGRESSION_FX_IDS]).toEqual([
      'fx-btn-upload-open', 'fx-rail-roots', 'fx-main', 'fx-toolbar', 'fx-breadcrumbs',
      'fx-search', 'fx-panel-upload', 'fx-drawer-quickview', 'fx-palette', 'fx-context',
    ]);
    expect([...REGRESSION_FX_CLASSES]).toEqual(['fx-upload-wrapper']);
    expect(checkLocks(REGRESSION_FX_IDS, REGRESSION_FX_CLASSES, REGRESSION_IDS)).toEqual([]);
  });
  it('scans the repository, including page adapters outside the Explorer directory', () => {
    expect(checkProject().errors).toEqual([]);
  });
  it.each(['\n', '\r\n'])('accepts registered JSX with EOL %j, comments are not markup', (eol) => {
    expect(check(['// <div id="fx-not-real" />', '<div id={"fx-main"} className="flex fx-upload-wrapper" />'].join(eol))).toEqual([]);
    expect(readLock(`export const LOCK = [${eol}"fx-main",${eol}] as const;`, 'LOCK')).toEqual(['fx-main']);
  });
  it('rejects unknown IDs (literal, expression, template) and unnamespaced Explorer IDs', () => {
    for (const source of ['<div id="fx-new"/>', '<div id={"fx-new"}/>', '<div id={`fx-new`}/>', '<div id="main"/>']) {
      expect(check(source).join(' ')).toContain('unregistered Explorer id');
    }
    expect(check('<div id="fx-new"/>', 'src/pages/Files.tsx').join(' ')).toContain('unregistered Explorer id');
    expect(check('<div id="fx-new"/>', 'src/components/layout/Sidebar.tsx').join(' ')).toContain('unregistered Explorer id');
  });
  it('rejects dynamic Explorer IDs instead of silently skipping expressions', () => {
    expect(check('<div id={`fx-row-${file.id}`}/>').join(' ')).toContain('dynamic id forbidden');
    expect(check('<div id={id}/>').join(' ')).toContain('dynamic id forbidden');
  });
  it('rejects duplicate declarations locally and across files', () => {
    expect(check('<><div id="fx-main"/><div id="fx-main"/></>').join(' ')).toContain('duplicate Explorer id');
    const seen = new Map();
    checkSource('<div id="fx-main"/>', file, REGRESSION_FX_IDS, REGRESSION_FX_CLASSES, seen);
    expect(checkSource('<div id="fx-main"/>', 'src/pages/Files.tsx', REGRESSION_FX_IDS, REGRESSION_FX_CLASSES, seen).join(' ')).toContain('duplicate Explorer id');
  });
  it('checks literal and conditional fx classes without banning shared Tailwind utilities', () => {
    expect(check('<div className={ok ? "flex fx-upload-wrapper" : "hidden"}/>' )).toEqual([]);
    expect(check('<div className={cn("fx-unregistered", "flex")}/>').join(' ')).toContain('unregistered Explorer class');
    expect(check('<div className={`fx-row-${kind}`}/>').join(' ')).toContain('dynamic fx class forbidden');
  });
  it('fails on duplicate lock entries, F38 collisions, missing locks, and malformed locks', () => {
    expect(checkLocks(['fx-main', 'fx-main'], [], REGRESSION_IDS)).toContain('duplicate fx lock entry');
    expect(checkLocks(['activeBar'], [], REGRESSION_IDS)).toContain('F38 collision: activeBar');
    expect(checkLocks(['fx-main'], [], ['fx-main'])).toContain('F38 collision: fx-main');
    expect(() => readLock('export const LOCK = [value];', 'LOCK')).toThrow('literal string array');
    expect(() => readLock('// nothing', 'LOCK')).toThrow('missing or empty lock');
  });
});
