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
import { hasDashToken } from "@/lib/dashToken";

export const SOURCES_PATH = "/api/f58/sources";
export const LAB_INSPECT_PATH = "/api/lab/inspect";
/** §2.1: the Name field is capped at 50 characters (client + server). */
export const NEW_SITE_NAME_MAX = 50;

export interface CustomSourceRow {
  id: string;
  name: string;
  baseUrl: string;
  hostname: string;
  /** [F85 §2] The host the save-time HTTPS probe ACTUALLY answered from (the
   *  redirect target). Empty when it equals `hostname`. F84 stores it on the
   *  server row and allowlists it; before F85 the client dropped it in asRow(),
   *  so an operator whose site redirects to www.<host> had no way to SEE that
   *  the tolerant fence was what kept the Lab working. */
  canonicalHostname?: string;
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
  /** [F88 §A.3] The visible "Source:" line + timing. */
  sourceDisplay?: string;
  sourceStrategy?: string;
  /** [F90 §B.2] the README's owning repo ("sindresorhus/awesome"), from the
   *  hint's declared redirectTo - so the Lab can NAME the real source. */
  sourceRepo?: string;
  /** [F90 §B.2/§D] sub-items found in the matched markdown section (row 0, the
   *  section link itself, is not counted). */
  sourceItemCount?: number;
  tookMs?: number;
  /** [F88 §A.3] One entry per source actually fetched - the Lab tabs across them. */
  sourceSets?: LabSourceSet[];
}

export interface LabSourceSet {
  key: string;
  label: string;
  strategy: string;
  count: number;
  links: LabLink[];
}

export interface LabError {
  code: string;
  messageKey: string;
  retryAfterSeconds?: number;
  /** [F93 §1.3] Per-field errors as the server sent them (errors.name /
   *  errors.url). The modal renders each under its own input; the generic
   *  messageKey line is only used when this object is absent/empty. */
  fieldErrors?: { name?: string; url?: string };
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
    // [F85 §2] The probe-answered host (server row field, or the F58 extension
    // envelope). canonicalOf() collapses the same-site case to undefined so the
    // single-host card renders exactly as it did in F84.
    canonicalHostname: canonicalOf(ext.hostname, r.canonicalHostname ?? (rawExt as Record<string, unknown>).canonicalHostname),
    labMode: ext.labMode !== false,
    category: String(descriptor.category ?? "software"),
    allowedDomains: Array.isArray(descriptor.allowedDomains) ? descriptor.allowedDomains.map(String) : ext.hostname ? [ext.hostname] : [],
    enableState: String(ext.enableState ?? "permanent"),
    addedAt: String(ext.addedAt ?? ""),
  };
}

/** [F85 §2] The canonical (probe-answered) host, lowercased and www-trimmed for
 *  the compare. Returns undefined when the server did not report one or when it
 *  is the same site as the typed hostname - the card then shows nothing extra,
 *  so the normal single-host case stays visually identical to F84. */
function canonicalOf(hostname: string, raw: unknown): string | undefined {
  const c = String(raw ?? "").trim().toLowerCase();
  if (!c) return undefined;
  const h = String(hostname || "").trim().toLowerCase();
  if (c === h) return undefined;
  if (c.replace(/^www\./, "") === h.replace(/^www\./, "")) return undefined;
  return c;
}

function offline<T>(code: string, messageKey: string, fieldErrors?: { name?: string; url?: string }): LabResult<T> {
  return { ok: false, error: { code, messageKey, ...(fieldErrors ? { fieldErrors } : {}) } };
}

/**
 * [F94 §3.7] "යම් දෝෂයක් සිදු විය" ("Something went wrong") for EVERYTHING.
 *
 * Every transport failure in this file collapsed to the same generic key, so a
 * rate limit, a dead server and a missing dashboard token were indistinguishable
 * - and the missing token was by far the most common cause (the server answers
 * 403 to every unauthenticated write). The operator then had nothing to act on.
 *
 * This resolver keeps `search.errors.generic` for the genuinely unknown case and
 * upgrades the three causes that have a concrete, one-click remedy.
 */
export function transportErrorKey(status: number): string {
  if (status === 429) return "lab.rateLimited";
  if (status === 401 || status === 403) return "addSite.authMissing";
  if (status === 404 || status === 410) return "lab.routeMissing";
  return "search.errors.generic";
}

/** A network-level failure (no response at all): the server is unreachable. */
export function unreachableErrorKey(): string {
  // No token + no server both look like a fetch rejection, so name the token
  // case first: it is the one the operator can fix without leaving the page.
  return hasDashToken() ? "search.errors.generic" : "addSite.authMissing";
}

export async function listCustomSources(): Promise<LabResult<CustomSourceRow[]>> {
  try {
    const r = await fetch(apiBase() + SOURCES_PATH, { method: "GET", cache: "no-store", headers: dashHeaders() });
    if (!r.ok) return offline(r.status === 429 ? "RATE_LIMITED" : "TRANSPORT_UNAVAILABLE", transportErrorKey(r.status));
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
      const env = (body || {}) as { code?: string; messageKey?: string; errors?: Record<string, string>; details?: { reason?: string; detail?: string } };
      // [F84 §2.1] The server probe failure comes back as a per-field key
      // (`errors.url`), the same envelope shape F81 introduced. Field keys win
      // over the generic messageKey so the modal can render the specific
      // reason next to the URL input instead of "Something went wrong".
      // [F93 §1.3] The F93 server sends a CONCRETE reason code in errors.url
      // (cloudflare-challenge | dns-nxdomain | ssl-cert-invalid | timeout-10s |
      // http-5xx | redirect-loop | http-<code> | no-response) and mirrors it in
      // details.reason - both are carried through verbatim, so the modal never
      // has to fall back to the generic line when a reason exists. A 401/403 is
      // the dashboard-token gate, not a field problem: that is named too,
      // instead of masquerading as "rejected by validation".
      if (r.status === 401 || r.status === 403) {
        return offline("AUTH_REQUIRED", "addSite.authMissing");
      }
      const fieldErrors: { name?: string; url?: string } = {};
      if (env.errors && typeof env.errors === "object") {
        if (env.errors.url) fieldErrors.url = String(env.errors.url);
        if (env.errors.name) fieldErrors.name = String(env.errors.name);
      }
      if (!fieldErrors.url && env.details && env.details.reason) fieldErrors.url = String(env.details.reason);
      const fieldErr = fieldErrors.url || fieldErrors.name || null;
      const hasField = !!(fieldErrors.url || fieldErrors.name);
      return offline(String(env.code || "VALIDATION_ERROR"), String(fieldErr || env.messageKey || "search.errors.generic"), hasField ? fieldErrors : undefined);
    }
    const row = asRow((body as { source?: unknown })?.source ?? body);
    return row ? { ok: true, data: row } : offline("INTERNAL_ERROR", "search.errors.generic");
  } catch {
    return offline("TRANSPORT_UNAVAILABLE", unreachableErrorKey());
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
        sourceDisplay: typeof d.sourceDisplay === "string" ? d.sourceDisplay : undefined,
        sourceStrategy: typeof d.sourceStrategy === "string" ? d.sourceStrategy : undefined,
        tookMs: typeof d.tookMs === "number" ? d.tookMs : undefined,
        sourceSets: Array.isArray(d.sourceSets) ? d.sourceSets.filter((s) => s && typeof s.key === "string" && Array.isArray(s.links)).map((s) => ({ key: String(s.key), label: String(s.label ?? ""), strategy: String(s.strategy ?? ""), count: typeof s.count === "number" ? s.count : s.links.length, links: s.links.filter((l) => l && typeof l.href === "string").map((l) => ({ text: String(l.text ?? ""), href: String(l.href), matches: Boolean(l.matches) })) })) : undefined,
      },
    };
  } catch {
    return offline("TIMEOUT", "lab.timeout");
  }
}

/**
 * [F86 §B.2] Result-view inspection. The Lab opens on a RESULT id (not a stored
 * site), so there is no sourceId to send: the result's own `sourceUrl` travels
 * as the payload instead and the server inspects THAT page (same transport
 * fences as /api/preview: https only, no userinfo, <=2048, 2MB cap, same-host
 * hrefs only). The response shape is byte-identical to inspectSource()'s, which
 * is exactly what lets both Lab surfaces render the same deep inspector.
 */
export async function inspectResultUrl(sourceUrl: string, query: string): Promise<LabResult<LabInspectResult>> {
  const url = String(sourceUrl || "").trim();
  if (!/^https:\/\//i.test(url) || url.length > 2048) return { ok: false, error: { code: "VALIDATION_ERROR", messageKey: "search.errors.validation" } };
  try {
    const r = await fetch(apiBase() + LAB_INSPECT_PATH, {
      method: "POST",
      cache: "no-store",
      headers: { "Content-Type": "application/json", ...dashHeaders() },
      body: JSON.stringify({ sourceUrl: url, query: String(query || "") }),
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
        sourceDisplay: typeof d.sourceDisplay === "string" ? d.sourceDisplay : undefined,
        sourceStrategy: typeof d.sourceStrategy === "string" ? d.sourceStrategy : undefined,
        tookMs: typeof d.tookMs === "number" ? d.tookMs : undefined,
        sourceSets: Array.isArray(d.sourceSets) ? d.sourceSets.filter((s) => s && typeof s.key === "string" && Array.isArray(s.links)).map((s) => ({ key: String(s.key), label: String(s.label ?? ""), strategy: String(s.strategy ?? ""), count: typeof s.count === "number" ? s.count : s.links.length, links: s.links.filter((l) => l && typeof l.href === "string").map((l) => ({ text: String(l.text ?? ""), href: String(l.href), matches: Boolean(l.matches) })) })) : undefined,
      },
    };
  } catch {
    return offline("TIMEOUT", "lab.timeout");
  }
}
