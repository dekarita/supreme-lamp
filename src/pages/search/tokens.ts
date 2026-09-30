// [F56-c v2] Shared search presentation tokens + guards. The licence palette
// and enum→i18n key mapping were exported from CommandBar (F56-c); they now
// live here so the v2 subtree (cards, advanced panel, preview) can share them
// without importing a component. CommandBar re-exports both names, so existing
// call sites keep working byte-for-byte.
import type { LicenceTag } from "@/api/search";

export function camel(v: string): string {
  return v.replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase());
}

/** Plan §C licence palette: muted tokens (tokens.css), never neon green. */
export function licenceStyle(tag: LicenceTag): string {
  switch (tag) {
    case "public-domain":
      return "text-[color:var(--search-licence-public-fg)] bg-[color:var(--search-licence-public-bg)]";
    case "open-access":
      return "text-[color:var(--search-licence-open-fg)] bg-[color:var(--search-licence-open-bg)]";
    case "creative-commons":
      return "text-[color:var(--search-licence-cc-fg)] bg-[color:var(--search-licence-cc-bg)]";
    case "purchase":
      return "text-[color:var(--search-licence-purchase-fg)] bg-[color:var(--search-licence-purchase-bg)]";
    default:
      return "text-[color:var(--search-licence-own-fg)] bg-[color:var(--search-licence-own-bg)]";
  }
}

/** The only URL form the UI ever surfaces or links: absolute https://. Anything
 *  else (http, protocol-relative, javascript:, data:, relative) is withheld -
 *  the locked rules forbid an unvalidated download/purchase URL reaching the
 *  client, and F56-c has no allowlist to validate against. */
export function validatedHttpsUrl(raw: string | null | undefined): string {
  if (!raw) return "";
  const v = String(raw).trim();
  if (!/^https:\/\/[A-Za-z0-9.-]+(:\d+)?(\/[^\s]*)?$/i.test(v)) return "";
  try {
    const u = new URL(v);
    return u.protocol === "https:" && u.hostname.includes(".") ? u.toString() : "";
  } catch {
    return "";
  }
}

/** Honest byte count for a card ("actual bytes"): grouped integer bytes plus
 *  the binary unit form the rest of the UI uses. Never a rounded-up label. */
export function formatActualBytes(n: number): string {
  const grouped = n.toLocaleString("en-US");
  if (n < 1024) return grouped + " B";
  if (n < 1024 * 1024) return grouped + " B (" + Math.round((n / 1024) * 10) / 10 + " KiB)";
  if (n < 1024 * 1024 * 1024) return grouped + " B (" + Math.round((n / (1024 * 1024)) * 10) / 10 + " MiB)";
  return grouped + " B (" + Math.round((n / (1024 * 1024 * 1024)) * 10) / 10 + " GiB)";
}
