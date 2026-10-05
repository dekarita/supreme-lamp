// [F94 §3.1] DASHBOARD TOKEN - one resolver, three sources, never a silent "".
//
// THE BUG THIS CLOSES (operator report F94 problem 1): `getKey()` read the
// token from `location.search` ONLY. The dashboard URL main.yml publishes is a
// long single-file page; the moment it is copied out of a log, a chat window or
// a browser that re-wrote the query, the `?key=` fragment is lost - and the
// page still rendered completely normally. Every write route on the server
// (POST /api/f58/sources, /api/launcher/queue, /api/launch-url, /api/stream)
// then answered 401/403, which surfaced to the operator as a per-feature
// mystery: "Add site rejected: Dashboard permission missing", "RDP launcher:
// queue-403", "යම් දෝෂයක් සිදු විය". One missing query parameter produced eight
// unrelated-looking failures.
//
// The resolution order is now explicit and every source is visible:
//   1. `?key=` in the query string  (the canonical source; main.yml prints it)
//   2. `#key=` in the hash          (the v2 UI is a HashRouter - a key pasted
//                                    after the route is preserved here)
//   3. localStorage `ghrdp.dashToken` (survives a refresh, a bookmark, or a
//                                    URL re-shared without its query string)
//
// A successful token is STORED (§3.1 "save to localStorage on success") so the
// very first good load immunises every later one. Nothing here logs the token:
// `dashTokenDebug()` reports shape only (length + source), never the value.

export const DASH_TOKEN_STORAGE_KEY = "ghrdp.dashToken";

/** Extract `?key=` from a query string. Empty when absent or malformed. */
export function keyFromSearch(search?: string): string {
  const raw = search ?? (typeof location !== "undefined" ? String(location.search || "") : "");
  const m = raw.match(/[?&]key=([^&]+)/);
  if (!m) return "";
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return m[1];
  }
}

/** Extract `#key=` from a hash (`#/overview?key=...` and `#key=...` both work). */
export function keyFromHash(hash?: string): string {
  const raw = hash ?? (typeof location !== "undefined" ? String(location.hash || "") : "");
  if (!raw) return "";
  // Accept both `#key=abc` and `#/route?key=abc`.
  const q = raw.indexOf("?");
  const candidate = q >= 0 ? raw.slice(q + 1) : raw.replace(/^#/, "");
  const m = candidate.match(/(?:^|&)key=([^&]+)/);
  if (!m) return "";
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return m[1];
  }
}

/** The token persisted by an earlier successful load, or "". */
export function readStoredToken(): string {
  try {
    if (typeof localStorage === "undefined") return "";
    return String(localStorage.getItem(DASH_TOKEN_STORAGE_KEY) || "");
  } catch {
    // A locked-down storage area is not a reason to break the page.
    return "";
  }
}

/** Persist a token for later loads. Never throws. */
export function storeDashToken(token: string): void {
  const v = String(token || "").trim();
  try {
    if (typeof localStorage === "undefined") return;
    if (!v) localStorage.removeItem(DASH_TOKEN_STORAGE_KEY);
    else localStorage.setItem(DASH_TOKEN_STORAGE_KEY, v);
  } catch {
    /* ignore */
  }
}

/** Forget a stored token (the "wrong key" escape hatch in the gate). */
export function clearDashToken(): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.removeItem(DASH_TOKEN_STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * The single resolver every caller uses. Returns "" (never null/undefined) so
 * the existing `if (key)` guards all keep their meaning.
 *
 * A non-empty token from ANY source is remembered, which is what makes the
 * refresh-safe behaviour in §3.1 work without a second code path.
 */
export function getDashToken(search?: string, hash?: string): string {
  const fromUrl = keyFromSearch(search) || keyFromHash(hash);
  if (fromUrl) {
    // Reaching here means this load carries a good key: bank it.
    if (fromUrl !== readStoredToken()) storeDashToken(fromUrl);
    return fromUrl;
  }
  return readStoredToken();
}

/** True when this page can authorise a write. */
export function hasDashToken(search?: string, hash?: string): boolean {
  return !!getDashToken(search, hash);
}

/**
 * [F94 §3.1] Is this page being served by the RUNNER's dashboard server?
 *
 * The gate must block the production dashboard and must NOT block a local
 * `vite dev` session or the offline test suite - a hard gate on a developer
 * machine would be a modal nobody can dismiss. The discriminator is the same
 * one `apiBase()` (src/lib/api.ts) already uses to decide where the API lives:
 * port 7331/7332 is the runner's own server, and an https origin that is not
 * loopback is a real deployment. Anything else (vite on 5173, vitest's
 * localhost:3000, `vite preview`) is development and stays un-gated.
 */
export function isRunnerServed(): boolean {
  if (typeof location === "undefined") return false;
  const port = String(location.port || "");
  if (port === "7331" || port === "7332") return true;
  if (location.protocol === "https:") {
    const host = String(location.hostname || "");
    return host !== "localhost" && host !== "127.0.0.1" && host !== "[::1]";
  }
  return false;
}

/**
 * Should the full-page blocking gate be shown right now?
 *
 *   runner-served AND no token anywhere -> BLOCK (the dashboard cannot write)
 *   anything else                        -> no gate
 *
 * `force` exists so the smoke tests can pin the blocked branch directly
 * instead of having to redefine `location`.
 */
export function shouldGate(force?: boolean): boolean {
  if (force !== undefined) return force;
  return isRunnerServed() && !hasDashToken();
}

/**
 * Shape-only diagnostic (length + source). The token VALUE is never included,
 * so this is safe to render in the UI and to log.
 */
export function dashTokenDebug(search?: string, hash?: string): { present: boolean; source: "url" | "stored" | "none"; length: number } {
  const fromUrl = keyFromSearch(search) || keyFromHash(hash);
  if (fromUrl) return { present: true, source: "url", length: fromUrl.length };
  const stored = readStoredToken();
  if (stored) return { present: true, source: "stored", length: stored.length };
  return { present: false, source: "none", length: 0 };
}
