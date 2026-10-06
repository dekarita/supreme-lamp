// [F49] Runtime mirror opt-in client: GET /api/mirror/status plus the
// POST /api/mirror/enable|/disable pair. The dash token travels in
// X-Dash-Token only (a URL carrying it is never built); POSTs additionally
// send the per-process X-CSRF-Token the status response delivered. The API
// lives on the always-on PowerShell dashboard (7331): a page served from the
// real-time Rust dashboard (7332) reaches across explicitly (v1 apiBase
// semantics); a pre-F49 server answers 404 and the caller keeps the legacy
// flush behaviour.
import { getKey } from "./api";

export interface MirrorStatus {
  ok: boolean;
  enabled: boolean;
  mirror: boolean;
  hosts: Array<{ id: string; enabled: boolean }>;
  host: string;
  scope: string;
  source: string;
  at: string;
  pending: boolean;
  /** [F101 §2.1 / N1] false when the server has no mirror module loaded. The
   *  status route then answers 200 (not 503) with `reason` + `advice`, so the
   *  UI renders a neutral "Mirror: disabled" line and stops treating the poll
   *  as an error. Absent on a pre-F101 server. */
  available?: boolean;
  reason?: string;
  advice?: string;
  loadError?: string;
}

export interface MirrorOptState {
  status: MirrorStatus;
  csrf: string;
}

function candidates(path: string): string[] {
  const out = [path];
  try {
    if (location.hostname && location.port !== "7331") {
      out.push(location.protocol + "//" + location.hostname + ":7331" + path);
    }
  } catch {
    /* ignore */
  }
  return out;
}

function readCsrfCookie(): string {
  try {
    const m = document.cookie.match(/(?:^|;\s*)ghrdp_mirror_csrf=([0-9a-f]+)/);
    if (m) return m[1];
  } catch {
    /* ignore */
  }
  return "";
}

export async function getMirrorStatus(): Promise<MirrorOptState | null> {
  const key = getKey();
  const headers: Record<string, string> = {};
  if (key) headers["X-Dash-Token"] = key;
  for (const url of candidates("/api/mirror/status")) {
    let r: Response | null = null;
    try {
      r = await fetch(url, { headers, cache: "no-store" });
    } catch {
      continue;
    }
    if (!r || r.status === 404) continue;
    // [F101 §2.1 / N1] A pre-F101 server answers 503 when the mirror module is
    // not loaded. Read the reason out of it instead of collapsing to null, so
    // even against an older server the card says WHY instead of showing the
    // pre-F49 legacy path (and the operator stops polling a route that can
    // never answer 200 on this run).
    if (!r.ok) {
      if (r.status === 503) {
        let e: { reason?: string; advice?: string; error?: string } | null = null;
        try {
          e = (await r.json()) as { reason?: string; advice?: string; error?: string };
        } catch {
          e = null;
        }
        if (e && (e.reason || e.error)) {
          return {
            status: {
              ok: false,
              enabled: false,
              available: false,
              mirror: false,
              hosts: [],
              host: "",
              scope: "",
              source: "off",
              at: "",
              pending: false,
              reason: e.reason || "mirror-module-not-installed",
              advice: e.advice || String(e.error || ""),
            },
            csrf: "",
          };
        }
      }
      return null;
    }
    let j: MirrorStatus | null = null;
    try {
      j = (await r.json()) as MirrorStatus;
    } catch {
      return null;
    }
    if (!j || typeof j !== "object") return null;
    let csrf = "";
    try {
      csrf = r.headers.get("X-CSRF-Token") || "";
    } catch {
      csrf = "";
    }
    if (!csrf) csrf = readCsrfCookie();
    return { status: j, csrf };
  }
  return null;
}

export async function setMirrorEnabled(on: boolean, csrf: string): Promise<{ ok: boolean; error: string }> {
  const key = getKey();
  if (!key) return { ok: false, error: "dashboard authorization missing (?key=)" };
  if (!csrf) return { ok: false, error: "CSRF token missing - refresh the Mirror page" };
  const headers = { "X-Dash-Token": key, "X-CSRF-Token": csrf };
  for (const url of candidates(on ? "/api/mirror/enable" : "/api/mirror/disable")) {
    let r: Response | null = null;
    try {
      r = await fetch(url, { method: "POST", headers, cache: "no-store" });
    } catch {
      continue;
    }
    if (!r || r.status === 404) continue;
    if (!r.ok) {
      let msg = "HTTP " + r.status;
      try {
        const j = (await r.json()) as { error?: string };
        if (j && j.error) msg = String(j.error);
      } catch {
        /* ignore */
      }
      return { ok: false, error: msg };
    }
    return { ok: true, error: "" };
  }
  return { ok: false, error: "mirror API not reachable (pre-F49 server?)" };
}
