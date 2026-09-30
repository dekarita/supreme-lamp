// [F58 §3] Add-time presets for the shared source form. The preset table itself
// lives in custom-source-core.js (so the Node lab proves the same data the form
// offers); this module is the typed accessor the two mount points use.
import F58 from "./custom-source-core";
import { sha256Hex } from "./custom-source-store";
import type { SourceDescriptor, SourceExtension } from "./custom-source-core";

export interface PresetSummary {
  presetId: string;
  displayName: string;
  formCategory: string;
  scope: string;
  baseUrl: string;
  allowedDomains: string[];
  requireAllowlisted: boolean;
}

export interface AppliedPreset {
  ok: boolean;
  errors: string[];
  draft: SourceDescriptor | null;
  extension: SourceExtension | null;
  summary: PresetSummary | null;
}

export const PRESET_IDS = F58.presetIds();

export function listPresets(): PresetSummary[] {
  return PRESET_IDS.map((id) => {
    const p = F58.PRESETS[id];
    return {
      presetId: p.presetId,
      displayName: p.displayName,
      formCategory: p.formCategory,
      scope: p.scope,
      baseUrl: p.baseUrl,
      allowedDomains: p.allowedDomains.slice(0),
      requireAllowlisted: true,
    };
  });
}

/** The allowlist a preset pins is NOT editable: the form renders it read-only and
 *  any operator edit is rejected by validate() as an off-preset domain. */
export function isAllowlistPinned(presetId: string): boolean {
  return Object.prototype.hasOwnProperty.call(F58.PRESETS, presetId);
}

export function applyPreset(presetId: string, opts: { name?: string; operatorId?: string; hash?: (s: string) => string; addedAt?: string; id?: string }): AppliedPreset {
  // §1 attribution is a HASH of the operator id - never the identity, never a credential.
  const hash = opts.hash || sha256Hex;
  const source = opts.operatorId ? hash(String(opts.operatorId)).slice(0, 64) : "";
  const res = F58.instantiate(presetId, {
    addedAt: opts.addedAt || new Date().toISOString(),
    source,
    enableState: "permanent",
    id: opts.id,
    nameKey: opts.name ? "search.registry.custom." + opts.name.toLowerCase().replace(/[^a-z0-9]+/g, "-") : undefined,
  });
  const p = F58.PRESETS[presetId];
  const summary: PresetSummary | null = p
    ? { presetId: p.presetId, displayName: p.displayName, formCategory: p.formCategory, scope: p.scope, baseUrl: p.baseUrl, allowedDomains: p.allowedDomains.slice(0), requireAllowlisted: true }
    : null;
  return { ok: res.ok, errors: res.errors, draft: res.draft, extension: res.extension || null, summary };
}
