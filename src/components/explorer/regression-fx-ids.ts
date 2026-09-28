/** F45 S1 — frozen stable DOM identifiers extracted from Explorer §§2–3.
 * Additions require an explicit lock change with plan-section references.
 * Repeated rows use data attributes, never repeated IDs or file-derived IDs.
 * Tailwind utilities/shared primitive classes are not stable Explorer hooks.
 */
export const REGRESSION_FX_IDS = [
  "fx-btn-upload-open",
  "fx-rail-roots",
  "fx-main",
  "fx-toolbar",
  "fx-breadcrumbs",
  "fx-search",
  "fx-panel-upload",
  "fx-drawer-quickview",
  "fx-palette",
  "fx-context",
] as const;

export const REGRESSION_FX_CLASSES = [
  "fx-upload-wrapper",
] as const;

export type FxId = (typeof REGRESSION_FX_IDS)[number];
