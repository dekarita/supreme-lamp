// [F103 §3/§4] REACHABILITY: one place that knows whether the browser can
// actually talk to the backend, and WHY not.
//
// Operator bundle fdd57261-button-actions.json (18/18 records): every fetch
// came back status=0 with elapsedMs=null and "/api/health did not answer",
// while the WebSocket stayed live and X-Dash-Token was present. status=0 is
// not "the server is down" - a fetch that never leaves the browser (CORS
// preflight denial, mixed-content block) looks exactly the same to JS as a
// dead host. The three causes need three different fixes, so F103 measures
// them instead of guessing:
//   * mixed content  - an https:// page may not call an http:// backend
//   * cors-preflight - OPTIONS was refused / lacked Allow-Headers X-Dash-Token
//   * network        - nothing answers at all (runner down / no tailnet)
// The results are cached here so the banner, the troubleshooter and the
// collector's status=0 verdict all speak with one voice.
import { apiBase } from "@/lib/api";

export type ReachabilityCategory = "mixed-content" | "cors-preflight" | "network" | "ok";

export interface ProbeResult {
  ok: boolean;
  status: number;
  ts: string;
  elapsedMs: number | null;
  error: string | null;
  headers: Record<string, string>;
}

export interface Status0Classification {
  reason: string;
  suggestedFix: string;
  category: ReachabilityCategory;
}

/** The origin this dashboard is served from (e.g. https://dekarita.github.io). */
export function pageOrigin(): string {
  try {
    return location.origin;
  } catch {
    return "";
  }
}

/** The origin the API lives on (e.g. http://100.83.53.46:7331). */
export function backendOrigin(): string {
  try {
    return new URL(apiBase(), pageOrigin() || undefined).origin;
  } catch {
    return apiBase();
  }
}

export function isMixedContent(origin = pageOrigin(), backend = backendOrigin()): boolean {
  return origin.startsWith("https://") && backend.startsWith("http://");
}

let lastOptions: ProbeResult | null = null;
let lastHealth: ProbeResult | null = null;

export function lastOptionsResult(): ProbeResult | null {
  return lastOptions;
}
export function lastHealthResult(): ProbeResult | null {
  return lastHealth;
}
/** Test seam: reset the cached probes. */
export function resetReachabilityCache(): void {
  lastOptions = null;
  lastHealth = null;
}

function emptyResult(error: string): ProbeResult {
  return { ok: false, status: 0, ts: new Date().toISOString(), elapsedMs: null, error, headers: {} };
}

function collectHeaders(r: Response): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    r.headers.forEach((v, k) => {
      out[k] = v;
    });
  } catch {
    /* headers are opaque on some responses */
  }
  return out;
}

async function timedFetch(url: string, init: RequestInit, timeoutMs: number): Promise<ProbeResult> {
  const startedAt = Date.now();
  const ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null;
  try {
    const r = await fetch(url, { cache: "no-store", signal: ctl ? ctl.signal : undefined, ...init });
    return { ok: r.ok, status: r.status, ts: new Date().toISOString(), elapsedMs: Date.now() - startedAt, error: null, headers: collectHeaders(r) };
  } catch (e) {
    // status=0: the request never produced an HTTP response.
    return { ...emptyResult(e instanceof Error ? e.message : String(e)), ts: new Date().toISOString() };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** GET /api/health with a short deadline. 2s is the banner's patience budget. */
export async function probeHealth(timeoutMs = 2000): Promise<ProbeResult> {
  lastHealth = await timedFetch(apiBase() + "/api/health", { method: "GET" }, timeoutMs);
  return lastHealth;
}

/** OPTIONS /api/health - the preflight the browser itself would send. */
export async function probeOptions(path = "/api/health", timeoutMs = 2000): Promise<ProbeResult> {
  lastOptions = await timedFetch(apiBase() + path, { method: "OPTIONS" }, timeoutMs);
  return lastOptions;
}

/** [F103 §4] The pure decision table. Separated from the probes so it can be
 *  unit-tested without a network and reused by the synchronous verdict path. */
export function classifyStatus0Sync(args: {
  origin: string;
  backendOrigin: string;
  optionsOk: boolean | null;
  wsLive?: boolean;
  failed?: string;
}): Status0Classification {
  const { origin, backendOrigin: backend, optionsOk } = args;
  if (isMixedContent(origin, backend)) {
    return {
      category: "mixed-content",
      reason: "Mixed content block: the HTTPS page " + origin + " cannot call the HTTP backend " + backend + ", so the request was cancelled before it left the browser.",
      suggestedFix: "Serve the backend over HTTPS (reverse proxy with TLS, e.g. `tailscale serve`) OR open the dashboard from the backend origin directly: " + backend + "/dashboard",
    };
  }
  if (optionsOk === false) {
    return {
      category: "cors-preflight",
      reason: "CORS preflight denied: the backend did not answer OPTIONS, or answered without Access-Control-Allow-Headers: X-Dash-Token. The browser cancelled the real request and reported status=0.",
      suggestedFix:
        "The backend must answer OPTIONS with 204 and Access-Control-Allow-Headers: X-Dash-Token (plus Allow-Origin echoing " +
        origin +
        " and Allow-Credentials: true). That is F103 §2 in payloads/ghrdp-server.ps1 - dispatch main.yml so the runner stages the current server.",
    };
  }
  const wsNote = args.wsLive ? " (the WebSocket is live, which is normal: WS never sends a CORS preflight, so it survives a block that kills every fetch)" : "";
  return {
    category: "network",
    reason: "Network unreachable: nothing answered at " + backend + wsNote + (args.failed ? " [" + args.failed + "]" : ""),
    suggestedFix: "Check the runner is online and Tailscale is connected on THIS device, and that the port in the URL is the advertised one (7331).",
  };
}

/** [F103 §4] Full classification: measures the preflight, then decides. */
export async function classifyStatus0(args: { url?: string; origin?: string; backend?: string; wsLive?: boolean; failed?: string } = {}): Promise<Status0Classification> {
  const origin = args.origin ?? pageOrigin();
  const backend = args.backend ?? backendOrigin();
  if (isMixedContent(origin, backend)) {
    return classifyStatus0Sync({ origin, backendOrigin: backend, optionsOk: null, wsLive: args.wsLive, failed: args.failed });
  }
  const opt = await probeOptions();
  return classifyStatus0Sync({ origin, backendOrigin: backend, optionsOk: opt.ok || opt.status === 204, wsLive: args.wsLive, failed: args.failed });
}

/** The best classification available WITHOUT awaiting (uses the cached probe). */
export function classifyStatus0Cached(failed?: string, wsLive?: boolean): Status0Classification {
  const opt = lastOptions;
  return classifyStatus0Sync({
    origin: pageOrigin(),
    backendOrigin: backendOrigin(),
    optionsOk: opt ? opt.ok || opt.status === 204 : null,
    wsLive,
    failed,
  });
}

export interface CorsConfig {
  ok: boolean;
  allowlist: string[];
  allowHeaders: string;
  allowMethods: string;
  maxAge: string;
  requestOrigin: string;
  originAllowed: boolean;
}

/** [F103 §3] The allowlist actually in effect, straight from the server. */
export async function fetchCorsConfig(token: string): Promise<CorsConfig | null> {
  try {
    const r = await fetch(apiBase() + "/api/f103/cors-config", {
      cache: "no-store",
      headers: token ? { "X-Dash-Token": token } : undefined,
    });
    if (!r.ok) return null;
    return (await r.json()) as CorsConfig;
  } catch {
    return null;
  }
}
