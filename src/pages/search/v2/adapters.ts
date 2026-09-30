// [F56-c v2] Compiled adapter roster for the Advanced disclosure's "adapter
// selection". F56-b owns payloads/search-sources/ + the runtime registry; that
// substrate is not in main yet, so the roster is DERIVED from the frozen
// i18n source labels (src/i18n/en.json → search.sources.*, 28 entries) instead
// of being re-invented. camelCase label keys map to the registry's kebab-case
// adapterIds (projectGutenberg → project-gutenberg), which is exactly the id
// form the frozen contracts and the existing fixtures already use. A Vitest
// cell asserts the derived count against the i18n roster, so a missing
// descriptor label fails the build instead of silently dropping a source.
import en from "@/i18n/en.json";

export interface AdapterDescriptor {
  adapterId: string;
  nameKey: string;
}

export function camelToKebab(v: string): string {
  return v.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase());
}

const SOURCES = (en as { search: { sources: Record<string, string> } }).search.sources;

export const ADAPTER_ROSTER: AdapterDescriptor[] = Object.keys(SOURCES)
  .sort()
  .map((k) => ({ adapterId: camelToKebab(k), nameKey: "search.sources." + k }));

export const ADAPTER_ROSTER_SIZE = ADAPTER_ROSTER.length;

export function adapterNameKey(adapterId: string): string {
  const hit = ADAPTER_ROSTER.find((a) => a.adapterId === adapterId);
  return hit ? hit.nameKey : "search.errors.unknownSource";
}
