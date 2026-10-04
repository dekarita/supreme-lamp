// [F78 §1.2/§2/§4] Typed client for the three F78 surfaces:
//   GET  /api/f58/sources   the F58 registry list (operator-added sources)
//   POST /api/f58/sources   quick-add a Lab Mode source (https only)
//   POST /api/lab/inspect   fetch ONE stored site's homepage and return its
//                           links, with the query-matching subset flagged
// Auth mirrors the F49 pattern used everywhere else in this app: the dash token
// travels in the X-Dash-Token header ONLY - never in a URL, never in a query
// key, never in a body. Both mutations are same-origin POSTs to the apiBase().
//
// Client-side rules are the SHIPPED rules: labMode/hostname normalization comes
// from src/search/custom-source-core.js (F58.withHostname / F58.labSources), so
// the UI and the server cannot disagree about what a Lab source is. Validate
// with validateNewSite() before any network call; the server re-validates.
import { apiBase, getKey } from "@/lib/api";
import F58 from "@/search/custom-source-core";

export const SOURCES_PATH = "/api/f58/sources";
export const LAB_INSPECT_PATH = "/api/lab/inspect";
/** §2.1: the Name field is capped at 50 characters (client + server). */
export const NEW_SITE_NAME_MAX = 50;

export interface CustomSourceRow {
  id: string;
  name: string;
  baseUrl: string;
  hostname: string;
  labMode: boolean;
  category: string;
  allowedDomains: string[];
  enableState: string;
  addedAt: string;
}

export interface LabLink {
  text: string;
  href: string;
  matches: boolean;
}

export interface LabInspectResult {
  hostname: string;
  title: string;
  links: LabLink[];
  fetchedAt: string;
  linkCount: number;
  matchCount: number;
  /** [F81 §3.1/Q4] Which path served the data: "sitemap.xml" or "homepage". */
  source?: string;
  sourceUrls?: number;
  /** [F81 §3.1/Q4] Adapter-status style phase tag for UI display. */
  adapterStatus?: { phase: string; sourceLabel: string };
}

export interface LabError {
  code: string;
  messageKey: string;
  retryAfterSeconds?: number;
}

export type LabResult<T> = { ok: true; data: T } | { ok: false; error: LabError };

export type NewSiteError = "name-required" | "name-too-long" | "https-required" | "auth-not-allowed" | "network";

/** §2.1 validation: Name required (<=50), Base URL must be https and must not
 *  carry userinfo (`https://user:pass@host` is refused outright - credentials in
 *  a URL are never accepted, not even to be stripped later). */
export function validateNewSite(name: string, baseUrl: string): NewSiteError | null {
  const n = String(name || "").trim();
  if (!n) return "name-required";
  if (n.length > NEW_SITE_NAME_MAX) return "name-too-long";
  const u = String(baseUrl || "").trim();
  if (!/^https:\/\//i.test(u)) return "https-required";
  if (u.slice("https://".length).includes("@")) return "auth-not-allowed";
  if (!F58.hostnameFor(u)) return "https-required";
  return null;
}

function dashHeaders(): Record<string, string> {
  const key = getKey();
  return key ? { "X-Dash-Token": key } : {};
}

function asRow(raw: unknown): CustomSourceRow | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const descriptor = (r.descriptor && typeof r.descriptor === "object" ? r.descriptor : r) as Record<string, unknown>;
  // The extension view: an F58 store envelope wins, otherwise the row's own
  // top-level fields carry labMode/hostname (the shape /api/f58/sources sends).
  const rawExt = r.f58 ?? r.extension ?? { labMode: r.labMode, hostname: r.hostname, addedAt: r.addedAt, enableState: r.enableState };
  const ext = F58.withHostname(descriptor.baseUrl, rawExt);
  const id = String(descriptor.id ?? r.id ?? "");
  const baseUrl = String(descriptor.baseUrl ?? "");
  if (!id || !baseUrl) return null;
  const nameKey = String(descriptor.nameKey ?? "");
  const nameKeyText = typeof (r as { name?: unknown }).name === "string" ? String((r as { name?: unknown }).name) : "";
  return {
    id,
    name: nameKeyText || (nameKey.startsWith("search.sites.") ? nameKey.slice("search.sites.".length) : nameKey) || id,
    baseUrl,
    // Derived, never trusted from the payload: hostname always follows baseUrl.
    hostname: ext.hostname,
    labMode: ext.labMode !== false,
    category: String(descriptor.category ?? "software"),
    allowedDomains: Array.isArray(descriptor.allowedDomains) ? descriptor.allowedDomains.map(String) : ext.hostname ? [ext.hostname] : [],
    enableState: String(ext.enableState ?? "permanent"),
    addedAt: String(ext.addedAt ?? ""),
  };
}

function offline<T>(code: string, messageKey: string): LabResult<T> {
  return { ok: false, error: { code, messageKey } };
}

export async function listCustomSources(): Promise<LabResult<CustomSourceRow[]>> {
  try {
    const r = await fetch(apiBase() + SOURCES_PATH, { method: "GET", cache: "no-store", headers: dashHeaders() });
    if (!r.ok) return offline(r.status === 429 ? "RATE_LIMITED" : "TRANSPORT_UNAVAILABLE", "search.errors.generic");
    const body = (await r.json()) as unknown;
    const rawList = Array.isArray(body) ? body : Array.isArray((body as { sources?: unknown[] })?.sources) ? (body as { sources: unknown[] }).sources : [];
    const rows = rawList.map(asRow).filter((x): x is CustomSourceRow => x !== null);
    // §1.1: the Lab Mode subset is what the UI shows; labMode absent/undefined
    // means true (the default applied by asRow via F58.withHostname).
    return { ok: true, data: rows.filter((row) => row.labMode !== false) };
  } catch {
    return offline("TRANSPORT_UNAVAILABLE", "search.errors.generic");
  }
}

export async function createCustomSource(name: string, baseUrl: string): Promise<LabResult<CustomSourceRow>> {
  const invalid = validateNewSite(name, baseUrl);
  if (invalid) return offline("VALIDATION_ERROR", invalid);
  try {
    const r = await fetch(apiBase() + SOURCES_PATH, {
      method: "POST",
      cache: "no-store",
      headers: { "Content-Type": "application/json", ...dashHeaders() },
      // labMode:true is the F78 default for this flow (a Lab Mode shortcut).
      body: JSON.stringify({ name: String(name).trim(), baseUrl: String(baseUrl).trim(), labMode: true }),
    });
    const body = (await r.json().catch(() => null)) as unknown;
    if (!r.ok) {
      const env = (body || {}) as { code?: string; messageKey?: string };
      return offline(String(env.code || "VALIDATION_ERROR"), String(env.messageKey || "search.errors.generic"));
    }
    const row = asRow((body as { source?: unknown })?.source ?? body);
    return row ? { ok: true, data: row } : offline("INTERNAL_ERROR", "search.errors.generic");
  } catch {
    return offline("TRANSPORT_UNAVAILABLE", "search.errors.generic");
  }
}

// [F81 §1.2/Q3] DELETE /api/f58/sources/<id> — one-shot removal of a stored
// Lab Mode source. Validates the id is non-empty (no traversal); mirrors the
// server's per-row checks (404 on unknown id, 401 on missing token). The
// call site in the UI optimistically removes the row first; a failure
// restores the prior list. No URL credential is ever read or sent here.
export async function deleteCustomSource(sourceId: string): Promise<LabResult<{ deletedId: string }>> {
  const id = String(sourceId || "").trim();
  if (!id || id.includes("/") || id.includes("..")) return offline("VALIDATION_ERROR", "search.errors.validation");
  try {
    const r = await fetch(apiBase() + SOURCES_PATH + "/" + encodeURIComponent(id), {
      method: "DELETE",
      cache: "no-store",
      headers: dashHeaders(),
    });
    const body = (await r.json().catch(() => null)) as unknown;
    if (!r.ok) {
      const env = (body || {}) as { code?: string; messageKey?: string };
      return offline(String(env.code || "TRANSPORT_UNAVAILABLE"), String(env.messageKey || "search.errors.generic"));
    }
    return { ok: true, data: { deletedId: id } };
  } catch {
    return offline("TRANSPORT_UNAVAILABLE", "search.errors.generic");
  }
}

export async function inspectSource(sourceId: string, query: string): Promise<LabResult<LabInspectResult>> {
  try {
    const r = await fetch(apiBase() + LAB_INSPECT_PATH, {
      method: "POST",
      cache: "no-store",
      headers: { "Content-Type": "application/json", ...dashHeaders() },
      body: JSON.stringify({ sourceId: String(sourceId), query: String(query || "") }),
    });
    const body = (await r.json().catch(() => null)) as unknown;
    if (!r.ok) {
      const env = (body || {}) as { code?: string; messageKey?: string; retryAfterSeconds?: number };
      return {
        ok: false,
        error: {
          code: String(env.code || (r.status === 429 ? "RATE_LIMITED" : "INTERNAL_ERROR")),
          messageKey: String(env.messageKey || (r.status === 429 ? "lab.rateLimited" : "search.errors.generic")),
          retryAfterSeconds: typeof env.retryAfterSeconds === "number" ? env.retryAfterSeconds : r.status === 429 ? 60 : undefined,
        },
      };
    }
    const d = (body || {}) as Partial<LabInspectResult>;
    const links = Array.isArray(d.links) ? d.links.filter((l) => l && typeof l.href === "string").map((l) => ({ text: String(l.text ?? ""), href: String(l.href), matches: Boolean(l.matches) })) : [];
    return {
      ok: true,
      data: {
        hostname: String(d.hostname ?? ""),
        title: String(d.title ?? ""),
        links,
        fetchedAt: String(d.fetchedAt ?? ""),
        linkCount: typeof d.linkCount === "number" ? d.linkCount : links.length,
        matchCount: typeof d.matchCount === "number" ? d.matchCount : links.filter((l) => l.matches).length,
        source: typeof d.source === "string" ? d.source : undefined,
        sourceUrls: typeof d.sourceUrls === "number" ? d.sourceUrls : undefined,
        adapterStatus: d.adapterStatus && typeof d.adapterStatus === "object" ? (d.adapterStatus as { phase: string; sourceLabel: string }) : undefined,
      },
    };
  } catch {
    return offline("TIMEOUT", "lab.timeout");
  }
}
