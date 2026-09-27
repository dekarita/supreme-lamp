// [F41 §0] API surface - UNCHANGED endpoints, identical semantics to F38 ui.html:
//   /api/config?key=        creds block only for token/tailnet-authenticated calls
//   /api/native-status?key= fqdn/cert/nla/handler/telescope snapshot (+ last beacon)
//   /api/rdp-token  POST    Bearer-gated single-use 60s ticket {rid}
//   /api/purge-stale-creds  Bearer-gated age-aware purge command (copy-only)
//   /api/progress /ping /health /launch /flush /diag   mirror + connectivity
// The dashboard is served by the SAME server (port 7331), so the API base is
// this origin; v1 kept an explicit :7331 for the dual-port layout, and we keep
// that fallback when the page is opened on a non-API port.

export function getKey(): string {
  const m = location.search.match(/[?&]key=([^&]+)/);
  try {
    return m ? decodeURIComponent(m[1]) : "";
  } catch {
    return "";
  }
}

export function apiBase(): string {
  if (location.port === "7331" || location.port === "7332" || location.protocol === "https:") {
    return location.origin;
  }
  // Same-host explicit fallback mirrors ui.html apiBase() semantics.
  return "http://" + location.hostname + ":7331";
}

export async function getJson<T = unknown>(url: string, init?: RequestInit): Promise<T | null> {
  try {
    const r = await fetch(url, { cache: "no-store", ...init });
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch {
    return null;
  }
}

export function configUrl(): string {
  const key = getKey();
  return apiBase() + "/api/config" + (key ? "?key=" + encodeURIComponent(key) : "");
}

export function nativeStatusUrl(): string {
  const key = getKey();
  return apiBase() + "/api/native-status" + (key ? "?key=" + encodeURIComponent(key) : "");
}

// F27/F28: mint ONE single-use ticket; no password is ever read by this path.
export async function postRdpToken(): Promise<{ ok: true; rid: string } | { ok: false; error: string }> {
  const key = getKey();
  if (!key) return { ok: false, error: "dashboard authorization missing" };
  try {
    const r = await fetch(apiBase() + "/api/rdp-token", {
      method: "POST",
      headers: { Authorization: "Bearer " + key },
      cache: "no-store",
    });
    if (!r.ok) return { ok: false, error: "ticket issue HTTP " + r.status };
    const j = (await r.json()) as { rid?: string };
    const rid = String(j.rid || "");
    if (!/^[0-9a-f]{32}$/.test(rid)) return { ok: false, error: "invalid ticket response" };
    return { ok: true, rid };
  } catch {
    return { ok: false, error: "ticket issue network error" };
  }
}

// F30 §2.2: fetch (never execute) the server-generated age-aware purge command.
export async function fetchPurgeCommand(): Promise<string> {
  const key = getKey();
  if (!key) return "(open this dashboard with ?key=... to load the server-generated 7-day purge command; the plain purge line above works without it)";
  try {
    const r = await fetch(apiBase() + "/api/purge-stale-creds", {
      headers: { Authorization: "Bearer " + key },
      cache: "no-store",
    });
    if (!r.ok) return "(server refused the purge command: HTTP " + r.status + ")";
    const j = (await r.json()) as { command?: string };
    return j && j.command ? String(j.command) : "(server returned no purge command)";
  } catch {
    return "(purge command fetch failed - server not reachable)";
  }
}

// [F15 §3] protocol verbs: top-level navigation (U1), never an iframe.
export function launchProto(url: string): void {
  try {
    window.location.href = url;
  } catch {
    /* ignore */
  }
}

// [F37 §3] per-click trace id the client beacons carry.
export function mintTraceId(src?: string): string {
  let r = "";
  try {
    const b = new Uint8Array(4);
    (window.crypto && window.crypto.getRandomValues) ? window.crypto.getRandomValues(b) : b.set([1, 2, 3, 4]);
    for (let i = 0; i < b.length; i++) r += ("0" + b[i].toString(16)).slice(-2);
  } catch {
    r = "00000000";
  }
  const t = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(2, 14);
  return "t" + t + "-" + String(src || "client") + "-" + r;
}
