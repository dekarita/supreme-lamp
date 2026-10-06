// [F100 §3.1] collectorAgent.ts - button-click action logger for Collector.
//
// Every dashboard button click logs a structured record { feature, action, params, result, elapsedMs, ts }.
// Records are persisted in localStorage (so they survive reloads) and can be replayed.
// This lets the Collector page present BOTH auto-probe results and user-driven button outcomes,
// producing 100% feature coverage.

const STORAGE_KEY = "ghrdp.collector.actions.v1";

export interface ButtonAction {
  id: string;
  ts: string; // ISO timestamp
  feature: string; // e.g. "add-site", "launcher", "download", "fetch", "lab"
  action: string; // e.g. "save", "openUrl", "fetch", "inspect", "reconnect"
  params?: Record<string, unknown>;
  result?: unknown;
  elapsedMs?: number;
  error?: string;
  // ---------------------------------------------------------------------------
  // [F101 §3.1 / N5] DEEP INSTRUMENTATION. The F100 row was
  // {feature, action, params, result}: enough to know THAT a click failed,
  // useless for knowing WHY. Every field below is optional so the F100 rows
  // already in localStorage keep rendering, and every field is populated by
  // instrumentButton() - the wrapper every button handler now goes through.
  // ---------------------------------------------------------------------------
  /** State of the world BEFORE the click: services, token, route reachability. */
  preCheck?: PreCheck;
  /** The exact wire request the click produced (token values are masked). */
  request?: RequestRecord;
  /** The exact wire answer, with elapsed time. */
  response?: ResponseRecord;
  /** State of the world AFTER the click, plus the diff against preCheck. */
  postCheck?: PostCheck;
  /** Every backend service the action depended on, with latency. */
  serviceDependencies?: ServiceDependency[];
  /** ok | warn | fail, why, and the one-line fix the operator can act on. */
  verdict?: Verdict;
}

/** [F101 §3.1] Service liveness snapshot, machine-readable states only. */
export interface ServiceStates {
  launcher: string; // running | stopped | unknown | unreachable
  watcher: string; // alive | stale | unknown | unreachable
  ws: string; // live | idle | dead | unknown
  logon: string; // success | failed | none | unknown
  mirror: string; // enabled | disabled | module-missing | unknown
  health: string; // ok | degraded | unreachable
}

export interface Prerequisite {
  check: string;
  pass: boolean;
  detail: string;
}

export interface PreCheck {
  serviceStates: ServiceStates;
  tokenPresence: boolean;
  routeReachable: boolean;
  prerequisites: Prerequisite[];
  at: string;
}

export interface RequestRecord {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
  timestamp: string;
}

export interface ResponseRecord {
  status: number;
  headers: Record<string, string>;
  body: string;
  elapsedMs: number;
}

export interface SideEffect {
  what: string;
  detected: boolean;
}

export interface PostCheck {
  sideEffects: SideEffect[];
  newServiceStates: ServiceStates;
  stateChanged: boolean;
  at: string;
}

export interface ServiceDependency {
  name: string;
  state: string;
  lastCheckTs: string;
  latencyMs: number | null;
  errorRate: number | null;
}

export type VerdictStatus = "ok" | "warn" | "fail";

export interface Verdict {
  status: VerdictStatus;
  reason: string;
  suggestedFix: string;
  relatedIssue: string | null;
}

type Listener = (actions: ButtonAction[]) => void;
const listeners = new Set<Listener>();

function readAll(): ButtonAction[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed as ButtonAction[];
    return [];
  } catch {
    return [];
  }
}

function writeAll(actions: ButtonAction[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(actions));
  } catch {
    // localStorage full / unavailable - keep in-memory
  }
}

function notify() {
  const snap = readAll();
  listeners.forEach((l) => {
    try { l(snap); } catch { /* ignore listener errors */ }
  });
}

/** Subscribe to action list changes. Returns unsubscribe fn. */
export function subscribeToActions(fn: Listener): () => void {
  listeners.add(fn);
  fn(readAll());
  return () => listeners.delete(fn);
}

/** Get a snapshot of all recorded actions. */
export function getRecordedActions(): ButtonAction[] {
  return readAll();
}

/** Log a button action. Returns the recorded action (with generated id + ts). */
export function logButtonAction(rec: Omit<ButtonAction, "id" | "ts">): ButtonAction {
  const action: ButtonAction = {
    id: "act_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8),
    ts: new Date().toISOString(),
    ...rec,
  };
  const all = readAll();
  all.push(action);
  // Cap at 500 actions to avoid localStorage bloat
  while (all.length > 500) all.shift();
  writeAll(all);
  notify();
  return action;
}

/** Clear all recorded actions. */
export function clearActions() {
  writeAll([]);
  notify();
}

/**
 * Replay a single action by index. The caller must provide a dispatcher map that
 * knows how to re-execute each (feature, action) pair. This keeps collectorAgent
 * free of UI/store imports - wiring lives in the feature modules.
 *
 *   replayAction(i, {
 *     "add-site:save": (p) => addSite(p.url, p.name),
 *     "launcher:openUrl": (p) => openUrl(p.url),
 *     ...
 *   })
 */
export async function replayAction(
  index: number,
  handlers: Record<string, (params: Record<string, unknown>) => unknown | Promise<unknown>>
): Promise<ButtonAction | null> {
  const all = readAll();
  const src = all[index];
  if (!src) return null;
  const key = src.feature + ":" + src.action;
  const handler = handlers[key];
  if (!handler) {
    const err: ButtonAction = {
      ...src,
      id: "act_" + Date.now().toString(36) + "_r",
      ts: new Date().toISOString(),
      error: "no replay handler for " + key,
      result: undefined,
    };
    const updated = readAll();
    updated.push(err);
    writeAll(updated);
    notify();
    return err;
  }
  const start = performance.now();
  try {
    const result = await handler(src.params || {});
    const elapsedMs = Math.round(performance.now() - start);
    const rec = logButtonAction({
      feature: src.feature,
      action: src.action + ".replay",
      params: src.params,
      result,
      elapsedMs,
    });
    return rec;
  } catch (e) {
    const elapsedMs = Math.round(performance.now() - start);
    const rec = logButtonAction({
      feature: src.feature,
      action: src.action + ".replay",
      params: src.params,
      error: String((e as Error)?.message || e),
      elapsedMs,
    });
    return rec;
  }
}

/**
 * Replay ALL recorded actions in sequence. Returns the new replay records.
 */
export async function replayAllActions(
  handlers: Record<string, (params: Record<string, unknown>) => unknown | Promise<unknown>>
): Promise<ButtonAction[]> {
  const all = readAll();
  const results: ButtonAction[] = [];
  // Only replay the original (non-replay) actions.
  for (let i = 0; i < all.length; i++) {
    if (all[i].action.endsWith(".replay")) continue;
    const r = await replayAction(i, handlers);
    if (r) results.push(r);
  }
  return results;
}

// =============================================================================
// [F101 §3.2] DEEP INSTRUMENTATION RUNTIME
//
// instrumentButton() is the wrapper every dashboard button handler now runs
// through. It captures the world before the click, the wire request the click
// produced, the wire answer, the world after the click, the services the action
// depended on, and a verdict with a one-line fix. Nothing here is optional
// decoration: the operator's F99 report was "add-site save -> ERR" with no way
// to tell a stale token from a dead route, and that ambiguity is what this file
// removes.
// =============================================================================

import { apiBase, getDashToken, hasDashToken } from "@/lib/api";
import { useTelemetryStore } from "@/stores/telemetryStore";

const PROBE_TIMEOUT_MS = 2500;
const BODY_CAPTURE_CHARS = 2000;
const SECRET_HEADER = /token|authorization|cookie|key|secret|password/i;

/** Cheap, dependency-free 8-hex fingerprint so a masked credential is still
 *  comparable across rows without ever storing the value itself. */
function fingerprint(v: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < v.length; i++) {
    h ^= v.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

function maskHeaders(h: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of Object.keys(h)) {
    const v = String(h[k] ?? "");
    out[k] = SECRET_HEADER.test(k) && v ? "present(len=" + v.length + ",sha=" + fingerprint(v) + ")" : v;
  }
  return out;
}

export interface CapturedExchange {
  /** Monotonic ring position. A plain array index would go stale the moment
   *  the bounded ring evicts an entry, which silently empties a row. */
  seq: number;
  request: RequestRecord;
  response: ResponseRecord | null;
  failed: string;
}

let observerInstalled = false;
const exchangeRing: CapturedExchange[] = [];
let exchangeSeq = 0;
const RING_MAX = 200;

/**
 * [F101 §3.2] One global fetch observer. Buttons reach the network through
 * src/api/**, so wrapping the single window.fetch is what lets a row show the
 * real request of a real click without every call site growing a recorder.
 * Idempotent; safe in jsdom and in a worker-less build.
 */
export function installFetchObserver(): void {
  if (observerInstalled) return;
  if (typeof window === "undefined" || typeof window.fetch !== "function") return;
  const original = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const startedAt = Date.now();
    const method = String(init?.method || (typeof input !== "string" && input && typeof (input as Request).method === "string" ? (input as Request).method : "GET")).toUpperCase();
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : String((input as Request).url || "");
    const rawHeaders: Record<string, string> = {};
    try {
      const h = init?.headers;
      if (h instanceof Headers) h.forEach((v, k) => { rawHeaders[k] = v; });
      else if (Array.isArray(h)) for (const [k, v] of h) rawHeaders[k] = String(v);
      else if (h) for (const k of Object.keys(h as Record<string, string>)) rawHeaders[k] = String((h as Record<string, string>)[k]);
    } catch { /* headers are best-effort */ }
    let body = "";
    try {
      if (typeof init?.body === "string") body = init.body;
    } catch { /* non-string bodies are not captured */ }
    const rec: CapturedExchange = {
      seq: ++exchangeSeq,
      request: { method, url, headers: maskHeaders(rawHeaders), body: body.slice(0, BODY_CAPTURE_CHARS), timestamp: new Date(startedAt).toISOString() },
      response: null,
      failed: "",
    };
    exchangeRing.push(rec);
    while (exchangeRing.length > RING_MAX) exchangeRing.shift();
    try {
      const res = await original(input as RequestInfo, init);
      let status = res.status;
      let headers: Record<string, string> = {};
      let text = "";
      try {
        res.headers.forEach((v, k) => { headers[k] = SECRET_HEADER.test(k) ? "masked" : v; });
        const clone = res.clone();
        text = (await clone.text()).slice(0, BODY_CAPTURE_CHARS);
      } catch { /* an unreadable body is still a status we can report */ }
      rec.response = { status, headers, body: text, elapsedMs: Date.now() - startedAt };
      return res;
    } catch (e) {
      rec.failed = String((e as Error)?.message || e);
      throw e;
    }
  };
  observerInstalled = true;
}

/** Snapshot the ring position so a window of exchanges can be sliced out. */
function ringMark(): number {
  return exchangeSeq;
}

/** Every exchange recorded strictly between two marks. */
function ringBetween(from: number, to: number): CapturedExchange[] {
  return exchangeRing.filter((e) => e.seq > from && e.seq <= to);
}

async function probe(path: string, token: string): Promise<{ status: number; json: unknown; latencyMs: number }> {
  const startedAt = Date.now();
  const ctl = typeof AbortController === "function" ? new AbortController() : null;
  const timer = ctl ? window.setTimeout(() => ctl.abort(), PROBE_TIMEOUT_MS) : 0;
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (token) headers["X-Dash-Token"] = token;
    const r = await fetch(apiBase() + path, { cache: "no-store", headers, signal: ctl ? ctl.signal : undefined });
    const text = await r.text().catch(() => "");
    let json: unknown = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { status: r.status, json, latencyMs: Date.now() - startedAt };
  } catch {
    return { status: 0, json: null, latencyMs: Date.now() - startedAt };
  } finally {
    if (timer) window.clearTimeout(timer);
  }
}

interface ProbeSet {
  states: ServiceStates;
  deps: ServiceDependency[];
  routeReachable: boolean;
}

/** [F101 §3.2] Read the four services a button can depend on. Every probe is
 *  best-effort: an unreachable lane yields "unreachable", never a throw. */
export async function captureServiceStates(): Promise<ProbeSet> {
  const token = (() => { try { return getDashToken(); } catch { return ""; } })();
  const [health, launcher, native, mirror] = await Promise.all([
    probe("/api/health", ""),
    probe("/api/launcher/health", token),
    probe("/api/native-status", token),
    probe("/api/mirror/status", token),
  ]);
  const nowIso = new Date().toISOString();
  const states: ServiceStates = { launcher: "unknown", watcher: "unknown", ws: "unknown", logon: "unknown", mirror: "unknown", health: "unknown" };
  const deps: ServiceDependency[] = [];
  const push = (name: string, state: string, latencyMs: number | null, errorRate: number | null) => {
    deps.push({ name, state, lastCheckTs: nowIso, latencyMs, errorRate });
  };

  if (health.status === 0) states.health = "unreachable";
  else if (health.status >= 200 && health.status < 300) states.health = "ok";
  else states.health = "degraded";
  push("health", states.health, health.latencyMs, health.status === 0 ? 1 : health.status >= 400 ? 1 : 0);

  const l = (launcher.json || {}) as { serviceRunning?: boolean; heartbeatAge?: number; taskExists?: boolean };
  if (launcher.status === 0) states.launcher = "unreachable";
  else if (launcher.status === 401 || launcher.status === 403) states.launcher = "unauthorized";
  else if (l.serviceRunning === true) states.launcher = "running";
  else if (l.serviceRunning === false) states.launcher = "stopped";
  push("launcher", states.launcher, launcher.latencyMs, launcher.status >= 400 ? 1 : 0);

  const n = (native.json || {}) as {
    watcher?: { alive?: boolean; heartbeatAgeSec?: number };
    rdpListener?: { authLast?: { result?: string } | null };
  };
  if (native.status === 0) states.watcher = "unreachable";
  else if (n.watcher?.alive === true) states.watcher = "alive";
  else if (n.watcher?.alive === false) states.watcher = "stale";
  if (n.rdpListener?.authLast?.result) states.logon = String(n.rdpListener.authLast.result);
  push("watcher", states.watcher, native.latencyMs, native.status >= 400 ? 1 : 0);

  const mi = (mirror.json || {}) as { ok?: boolean; enabled?: boolean; available?: boolean; reason?: string };
  if (mirror.status === 0) states.mirror = "unreachable";
  else if (mi.available === false || mi.reason === "mirror-module-not-installed") states.mirror = "module-missing";
  else if (mi.enabled === true) states.mirror = "enabled";
  else if (mirror.status === 200) states.mirror = "disabled";
  push("mirror", states.mirror, mirror.latencyMs, mirror.status >= 500 ? 1 : 0);

  try {
    const t = useTelemetryStore.getState();
    states.ws = t.wsLive ? "live" : t.wsDead ? "dead" : "idle";
  } catch { states.ws = "unknown"; }
  push("ws", states.ws, null, null);

  return { states, deps, routeReachable: health.status !== 0 };
}

function prerequisiteList(pre: { states: ServiceStates; routeReachable: boolean }, tokenPresent: boolean): Prerequisite[] {
  return [
    { check: "dashTokenPresent", pass: tokenPresent, detail: tokenPresent ? "token available to this tab" : "no dash token in this tab (?key= missing)" },
    { check: "serverReachable", pass: pre.routeReachable, detail: pre.routeReachable ? "/api/health answered" : "/api/health did not answer" },
    { check: "launcherService", pass: pre.states.launcher === "running", detail: "launcher=" + pre.states.launcher },
    { check: "watcherAlive", pass: pre.states.watcher === "alive", detail: "watcher=" + pre.states.watcher },
    { check: "webSocket", pass: pre.states.ws === "live", detail: "ws=" + pre.states.ws },
  ];
}

/** [F101 §3.2] One classifier for every failure shape the operator can hit,
 *  so the verdict tab always carries an actionable sentence and (where the
 *  cause is one of the four F101 bugs) a link to the tracking issue. */
export function classifyFailure(status: number, body: string, failed: string): Verdict {
  const text = (body || "") + " " + (failed || "");
  if (status === 401 || status === 403) {
    return {
      status: "fail",
      reason: "the server refused the dash token (HTTP " + status + ")",
      suggestedFix:
        "Re-open the dashboard with ?key=<dash token> or paste the current token under Settings → Keys. F101 made the add-site and search lanes refresh-aware (snapshot ∪ dash-token.txt ∪ config.json), so a token rotated mid-run is now accepted; if this still fails the presented token is genuinely not one of the three.",
      relatedIssue: "#157",
    };
  }
  if (status === 503 && /mirror/i.test(text)) {
    return {
      status: "warn",
      reason: "the mirror module is not installed on this run (HTTP 503)",
      suggestedFix: "Stage payloads/ghrdp-mirror.ps1 next to the server (main.yml MIRROR=1). Until then Mirror correctly reads 'disabled' and /api/mirror/status answers 200.",
      relatedIssue: "#157",
    };
  }
  if (status === 503) {
    return { status: "fail", reason: "the service behind this button is unavailable (HTTP 503)", suggestedFix: "Read the response body below: it names the missing dependency. A fresh main.yml dispatch restores it.", relatedIssue: null };
  }
  if (status === 429) {
    return { status: "warn", reason: "rate limited (HTTP 429)", suggestedFix: "Wait for retryAfterSeconds and try once; the server caps collector runs at 1 per 5 minutes and lab inspects at 60/min.", relatedIssue: null };
  }
  if (status === 404 || status === 410) {
    return { status: "fail", reason: "the route does not exist on this server build (HTTP " + status + ")", suggestedFix: "The UI is newer than the deployed server. Dispatch main.yml fresh so the runner stages the current payloads/ghrdp-server.ps1.", relatedIssue: null };
  }
  if (status === 0) {
    return { status: "fail", reason: "no HTTP response at all" + (failed ? " (" + failed + ")" : ""), suggestedFix: "The server is unreachable from this tab: check the runner is up, the port is the advertised one, and the page is not blocked by a mixed-content or CORS refusal.", relatedIssue: null };
  }
  if (status >= 500) {
    return { status: "fail", reason: "server error (HTTP " + status + ")", suggestedFix: "Paste the response body below into a new issue: a 5xx from the PowerShell server is always a code path, never a configuration problem.", relatedIssue: null };
  }
  if (status >= 400) {
    return { status: "fail", reason: "the request was rejected (HTTP " + status + ")", suggestedFix: "The per-field error in the response body names the field; fix that input and retry.", relatedIssue: null };
  }
  return { status: "warn", reason: "no failure status, but no success either", suggestedFix: "Expand the request/response tabs below to see what actually went over the wire.", relatedIssue: null };
}

function verdictFor(args: {
  threw: string;
  exchange: CapturedExchange | null;
  pre: PreCheck;
  post: PostCheck;
}): Verdict {
  if (args.threw) {
    const v = classifyFailure(args.exchange?.response?.status ?? 0, args.exchange?.response?.body ?? "", args.threw);
    return { ...v, reason: "the handler threw: " + args.threw + (v.reason ? " — " + v.reason : "") };
  }
  const ex = args.exchange;
  if (!ex) {
    return {
      status: "warn",
      reason: "the click produced no HTTP request (client-only action)",
      suggestedFix: "Nothing to fix unless a request was expected: check the request tab is empty because the handler short-circuited on validation.",
      relatedIssue: null,
    };
  }
  const status = ex.response?.status ?? 0;
  const v = classifyFailure(status, ex.response?.body ?? "", ex.failed);
  if (v.status === "ok" || (status >= 200 && status < 300)) {
    if (!args.pre.tokenPresence) {
      return { status: "warn", reason: "succeeded without a dash token (loopback/tailnet allowance)", suggestedFix: "Add ?key=<dash token> so the same click works from off-runner.", relatedIssue: null };
    }
    return {
      status: "ok",
      reason: "HTTP " + status + " and the action's service states are consistent" + (args.post.stateChanged ? " (state changed as expected)" : ""),
      suggestedFix: "None needed.",
      relatedIssue: null,
    };
  }
  return v;
}

export interface InstrumentOptions {
  params?: Record<string, unknown>;
  /** Extra side effects to look for after the click. */
  sideEffects?: string[];
  /** Skip the post-check probe round (for pure client-side actions). */
  skipPostCheck?: boolean;
}

/**
 * [F101 §3.2] THE WRAPPER. Every button handler runs through this:
 *
 *   const row = await instrumentButton("add-site", "save", () => saveSite(url));
 *
 * It never swallows the action's own result or error - both are returned and
 * logged - and it never lets instrumentation break the button.
 */
export async function instrumentButton<T>(
  featureName: string,
  actionName: string,
  action: () => Promise<T> | T,
  opts: InstrumentOptions = {}
): Promise<{ result?: T; error?: string; record: ButtonAction }> {
  installFetchObserver();
  const tokenPresent = (() => { try { return hasDashToken(); } catch { return false; } })();
  const preProbe = await captureServiceStates();
  const pre: PreCheck = {
    serviceStates: preProbe.states,
    tokenPresence: tokenPresent,
    routeReachable: preProbe.routeReachable,
    prerequisites: prerequisiteList(preProbe, tokenPresent),
    at: new Date().toISOString(),
  };
  const mark = ringMark();
  const startedAt = Date.now();
  let result: T | undefined;
  let threw = "";
  try {
    result = await action();
  } catch (e) {
    threw = String((e as Error)?.message || e);
  }
  const elapsedMs = Math.round(Date.now() - startedAt);
  // Slice the window BEFORE the post-check probes run: those four probes are
  // the recorder's own traffic and must never be mistaken for the button's.
  const exchanges = ringBetween(mark, ringMark());
  const exchange = exchanges.length ? exchanges[exchanges.length - 1] : null;
  const postProbe = opts.skipPostCheck ? null : await captureServiceStates();
  const newStates = postProbe ? postProbe.states : pre.serviceStates;
  const stateChanged = JSON.stringify(newStates) !== JSON.stringify(pre.serviceStates);
  const sideEffects: SideEffect[] = (opts.sideEffects || []).map((what) => ({ what, detected: stateChanged }));
  const post: PostCheck = { sideEffects, newServiceStates: newStates, stateChanged, at: new Date().toISOString() };
  const verdict = verdictFor({ threw, exchange, pre, post });
  const record = logButtonAction({
    feature: featureName,
    action: actionName,
    params: opts.params,
    result: threw ? undefined : (result as unknown),
    error: threw || undefined,
    elapsedMs,
    preCheck: pre,
    request: exchange ? exchange.request : undefined,
    response: exchange ? (exchange.response ?? undefined) : undefined,
    postCheck: post,
    serviceDependencies: postProbe ? postProbe.deps : preProbe.deps,
    verdict,
  });
  return { result, error: threw || undefined, record };
}

// =============================================================================
// [F101 §3.4] ALL KNOWN BUTTONS
//
// The operator's ask: one page that can exercise the whole dashboard. Every
// entry names the real data-testid the button renders with, so "Click now"
// performs a REAL DOM click (the same code path the operator's mouse takes,
// which the fetch observer then records). Entries whose button is not mounted
// on the current route fall back to probing the route directly, so the table
// still yields a verdict instead of a blank.
// =============================================================================

export interface KnownButton {
  id: string;
  feature: string;
  action: string;
  label: string;
  testId: string;
  /** Route probed when the button is not mounted on this page. */
  route?: string;
  method?: string;
  /** True when the real click mutates state and needs operator-supplied input. */
  mutating?: boolean;
}

export const KNOWN_BUTTONS: KnownButton[] = [
  { id: "add-site-open", feature: "add-site", action: "openModal", label: "Add site (open modal)", testId: "add-site-button" },
  { id: "add-site-save", feature: "add-site", action: "save", label: "Add site (save)", testId: "add-site-save", route: "/api/f58/sources", method: "GET", mutating: true },
  { id: "lab-refetch", feature: "lab", action: "refetch", label: "Lab: refetch", testId: "lab-refetch", route: "/api/f58/sources", method: "GET" },
  { id: "search-submit", feature: "search", action: "submit", label: "Search: submit", testId: "search-submit", route: "/api/search/status?searchId=collector-probe", method: "GET" },
  { id: "search-cancel", feature: "search", action: "cancel", label: "Search: cancel", testId: "cancel-search" },
  { id: "card-open-rdp", feature: "launcher", action: "openUrl", label: "Result: open in RDP", testId: "card-open-rdp", mutating: true },
  { id: "card-fetch", feature: "fetch", action: "start", label: "Result: fetch", testId: "card-fetch", route: "/api/progress", method: "GET", mutating: true },
  { id: "card-download-rdp", feature: "download", action: "toRdp", label: "Result: download to RDP", testId: "card-download-rdp", mutating: true },
  { id: "card-open-lab", feature: "lab", action: "inspect", label: "Result: open in Lab", testId: "card-open-lab", route: "/api/f58/sources", method: "GET" },
  { id: "diag-test-launch", feature: "diag", action: "testLaunch", label: "Diag: test launch", testId: "f87-diag-test-launch", route: "/api/launch-url/diag", method: "GET", mutating: true },
  { id: "selftest-run", feature: "selftest", action: "run", label: "F87 self-test", testId: "f87-selftest-run", route: "/api/health", method: "GET", mutating: true },
  { id: "ws-reconnect", feature: "websocket", action: "reconnect", label: "WebSocket: reconnect", testId: "ws-reconnect", route: "/api/health", method: "GET" },
  { id: "mirror-disable", feature: "mirror", action: "disable", label: "Mirror: disable", testId: "mirror-disable", route: "/api/mirror/status", method: "GET", mutating: true },
  { id: "collector-run", feature: "collector", action: "run", label: "Collector: run diagnosis", testId: "collector-run", route: "/api/collector/status", method: "GET" },
  { id: "collector-refresh", feature: "collector", action: "refresh", label: "Collector: refresh report", testId: "collector-refresh", route: "/api/collector/report", method: "GET" },
  { id: "collector-download-json", feature: "collector", action: "downloadJson", label: "Collector: download JSON", testId: "collector-download-json" },
  { id: "preview-open-source", feature: "preview", action: "openSource", label: "Preview: open source", testId: "preview-open-source" },
  { id: "stream-watch-rdp", feature: "stream", action: "watchRdp", label: "Stream: watch in RDP", testId: "f91-stream-watch-rdp", mutating: true },
];

function settle(ms: number): Promise<void> {
  return new Promise((res) => {
    try { window.setTimeout(res, ms); } catch { res(); }
  });
}

/** [F101 §3.4] "Click now": a real DOM click when the button is mounted, an
 *  instrumented route probe when it is not. Either way the row is recorded with
 *  the full pre/req/resp/post breakdown. */
export async function clickKnownButton(btn: KnownButton): Promise<ButtonAction> {
  const out = await instrumentButton(
    btn.feature,
    btn.action + ".clickNow",
    async () => {
      let el: Element | null = null;
      try { el = document.querySelector('[data-testid="' + btn.testId + '"]'); } catch { el = null; }
      if (el && typeof (el as HTMLElement).click === "function") {
        (el as HTMLElement).click();
        await settle(1200);
        return { via: "dom-click", testId: btn.testId };
      }
      if (btn.route) {
        const headers: Record<string, string> = {};
        try {
          const token = getDashToken();
          if (token) headers["X-Dash-Token"] = token;
        } catch { /* no token: the probe then proves the auth wall */ }
        const r = await fetch(apiBase() + btn.route, { method: btn.method || "GET", headers, cache: "no-store" });
        const text = await r.text().catch(() => "");
        return { via: "route-probe", route: btn.route, status: r.status, body: text.slice(0, BODY_CAPTURE_CHARS) };
      }
      return { via: "not-mounted", testId: btn.testId, note: "button is not on this route and no probe route is defined" };
    },
    { params: { knownButton: btn.id } }
  );
  return out.record;
}

/** Last recorded outcome per known button, for the "All known buttons" table. */
export function lastOutcomePerButton(actions: ButtonAction[]): Record<string, ButtonAction> {
  const out: Record<string, ButtonAction> = {};
  for (const a of actions) {
    const key = a.feature + ":" + a.action.replace(/\.clickNow$/, "");
    const prev = out[key];
    if (!prev || new Date(a.ts).getTime() >= new Date(prev.ts).getTime()) out[key] = a;
  }
  return out;
}
