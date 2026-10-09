// [F100 §3.1] collectorAgent.ts - button-click action logger for Collector.
//
// Every dashboard button click logs a structured record { feature, action, params, result, elapsedMs, ts }.
// Records are persisted in localStorage (so they survive reloads) and can be replayed.
// This lets the Collector page present BOTH auto-probe results and user-driven button outcomes,
// producing 100% feature coverage.
//
// [F102 §2.2 / R3] Persistence is now a zustand `persist` store
// ("f102-collector-actions-v1") over a quota-safe localStorage adapter. The
// adapter is synchronous, so zustand hydrates the store INSIDE create() - i.e.
// before React's first paint - and onRehydrateStorage records how many rows
// came back so the Collector page can show "Rehydrated from localStorage".
// The F100/F101 key ("ghrdp.collector.actions.v1") is migrated once on first
// read and then removed, so the operator's existing rows survive the upgrade.
//
// [F102 §2.1 / R1+R2] "Click now" is a REAL DOM click: navigate to the
// button's host page, run its precondition steps, click the element, observe
// the network + DOM effects, record a verdict. There is no route-probe
// fallback any more (issue #159): a button that cannot be reached is recorded
// as exactly that, never as a fake success.

import { create } from "zustand";
import { persist, createJSONStorage, type StateStorage } from "zustand/middleware";

/** [F100] legacy key - read once for migration, then removed. */
const LEGACY_STORAGE_KEY = "ghrdp.collector.actions.v1";
/** [F102 §2.2] the zustand persist key. */
export const COLLECTOR_STORE_KEY = "f102-collector-actions-v1";
/** [F102 §2.2] row cap (the store keeps the newest 500). */
export const MAX_ACTIONS = 500;
/** [F102] tracking issue every F102 verdict links to. */
export const F102_ISSUE = "#159";

export interface ButtonAction {
  id: string;
  ts: string; // ISO timestamp
  feature: string; // e.g. "add-site", "launcher", "download", "fetch", "lab"
  action: string; // e.g. "save", "openUrl", "fetch", "inspect", "reconnect"
  params?: Record<string, unknown>;
  result?: unknown;
  elapsedMs?: number;
  error?: string;
  /** [F104 §3] where the row came from. "global-click-capture" = the
   *  document-level listener caught a real user click anywhere in Mission
   *  Control; undefined = the F100/F101/F102 instrumented paths. The
   *  Collector page renders the two provenances in separate sections. */
  source?: string;
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

// =============================================================================
// [F102 §2.2 / R3] PERSISTED COLLECTOR STORE
// =============================================================================

/** Live state of the click runner (never persisted). */
export interface CollectorRunState {
  buttonId: string;
  label: string;
  step: string;
  index?: number;
  total?: number;
  startedAt: string;
}

/** What onRehydrateStorage saw (never persisted). */
export interface CollectorHydration {
  at: string;
  count: number;
  source: "localStorage" | "legacy-migration" | "empty";
}

interface CollectorState {
  actions: ButtonAction[];
  running: CollectorRunState | null;
  notice: string | null;
  hydration: CollectorHydration | null;
  persistError: string | null;
  /** row the Collector page re-opens after a click navigated away and back */
  focusId: string | null;
  addAction: (a: ButtonAction) => void;
  /** [F104 §3] patch one row in place (the global observer fills its row in
   *  when the observation window closes). A no-op for unknown ids. */
  updateAction: (id: string, patch: Partial<ButtonAction>) => void;
  clear: () => void;
}

let hydrationSource: CollectorHydration["source"] = "localStorage";
let lastPersistError: string | null = null;

/** Older rows keep a short body so 500 deep rows stay far below the quota. */
const FULL_BODY_ROWS = 50;
const OLD_BODY_CHARS = 300;

function slimAction(a: ButtonAction): ButtonAction {
  const cut = (s: unknown) => (typeof s === "string" && s.length > OLD_BODY_CHARS ? s.slice(0, OLD_BODY_CHARS) + "…" : s);
  const out: ButtonAction = { ...a };
  if (out.request) out.request = { ...out.request, body: String(cut(out.request.body) ?? "") };
  if (out.response) out.response = { ...out.response, body: String(cut(out.response.body) ?? "") };
  if (out.result !== undefined) {
    try {
      const s = JSON.stringify(out.result);
      if (s && s.length > OLD_BODY_CHARS * 4) out.result = { truncated: true, preview: s.slice(0, OLD_BODY_CHARS) };
    } catch {
      out.result = { unserializable: true };
    }
  }
  return out;
}

function isQuotaError(e: unknown): boolean {
  const n = String((e as { name?: string })?.name || "");
  const m = String((e as { message?: string })?.message || e);
  return /quota/i.test(n) || /quota/i.test(m) || (e as { code?: number })?.code === 22;
}

function rawStorage(): Storage | null {
  try {
    if (typeof window === "undefined" || !window.localStorage) return null;
    return window.localStorage;
  } catch {
    return null; // a locked-down storage area must never break the page
  }
}

/**
 * [F102 §2.2] Quota-safe synchronous localStorage adapter for zustand persist.
 *   getItem  - first read migrates the F100/F101 array key into the new shape.
 *   setItem  - on QuotaExceededError the OLDEST rows are slimmed, then halved,
 *              until the write fits; a write that still fails is surfaced as
 *              `persistError` instead of being swallowed (the F101 bug class:
 *              a row that is on screen but silently not persisted).
 */
const safeLocalStorage: StateStorage = {
  getItem(name: string): string | null {
    const ls = rawStorage();
    if (!ls) return null;
    try {
      const cur = ls.getItem(name);
      if (cur) {
        hydrationSource = "localStorage";
        return cur;
      }
      const legacy = ls.getItem(LEGACY_STORAGE_KEY);
      if (legacy) {
        const arr = JSON.parse(legacy);
        if (Array.isArray(arr)) {
          hydrationSource = "legacy-migration";
          const migrated = JSON.stringify({ state: { actions: (arr as ButtonAction[]).slice(-MAX_ACTIONS) }, version: 0 });
          try {
            ls.setItem(name, migrated);
            ls.removeItem(LEGACY_STORAGE_KEY);
          } catch {
            /* keep the legacy key if the migrated copy does not fit */
          }
          return migrated;
        }
      }
      hydrationSource = "empty";
      return null;
    } catch {
      hydrationSource = "empty";
      return null;
    }
  },
  setItem(name: string, value: string): void {
    const ls = rawStorage();
    if (!ls) {
      lastPersistError = "localStorage unavailable in this tab - rows will not survive a refresh";
      return;
    }
    try {
      ls.setItem(name, value);
      lastPersistError = null;
      return;
    } catch (e) {
      if (!isQuotaError(e)) {
        lastPersistError = "localStorage write failed: " + String((e as Error)?.message || e);
        return;
      }
    }
    // Quota: slim every row but the newest FULL_BODY_ROWS, then halve.
    try {
      const parsed = JSON.parse(value) as { state?: { actions?: ButtonAction[] }; version?: number };
      let rows = Array.isArray(parsed.state?.actions) ? parsed.state!.actions! : [];
      rows = rows.map((r, i) => (i < rows.length - FULL_BODY_ROWS ? slimAction(r) : r));
      for (let attempt = 0; attempt < 8; attempt++) {
        try {
          ls.setItem(name, JSON.stringify({ ...parsed, state: { ...parsed.state, actions: rows } }));
          lastPersistError = attempt === 0 ? null : "localStorage quota: kept the newest " + rows.length + " rows";
          return;
        } catch {
          rows = rows.slice(Math.ceil(rows.length / 2));
        }
      }
      lastPersistError = "localStorage quota exceeded - collector rows are NOT persisted";
    } catch (e) {
      lastPersistError = "localStorage write failed: " + String((e as Error)?.message || e);
    }
  },
  removeItem(name: string): void {
    const ls = rawStorage();
    try {
      ls?.removeItem(name);
    } catch {
      /* ignore */
    }
  },
};

let setStore: ((partial: Partial<CollectorState>) => void) | null = null;

/**
 * [WP-13 / #193] One redaction pass over the persisted rows, run from
 * onRehydrateStorage — i.e. on the initial load, on the legacy-key migration
 * and on every cross-tab `storage` rehydrate. Every row goes through the shared
 * core's redactButtonAction (idempotent, never throws); the store is rewritten
 * only when something actually changed, so a clean store costs one comparison.
 * Lossy by design: old `?key=` routes, raw URLs, fingerprinted headers, raw
 * bodies and credential-input labels are rewritten in place and unrecoverable.
 * The rows come in as a parameter because this runs INSIDE create() on the
 * initial hydration, where the useCollectorStore binding is still initialising
 * (the same reason the hydration chip goes through setStore).
 */
function redactPersistedRows(rows: ButtonAction[] | undefined): void {
  try {
    if (!rows || !rows.length) return;
    const redacted = rows.map((r) => redactButtonAction(r));
    if (JSON.stringify(redacted) !== JSON.stringify(rows)) {
      if (setStore) setStore({ actions: redacted });
    }
  } catch {
    /* redaction must never break hydration */
  }
}

export const useCollectorStore = create<CollectorState>()(
  persist(
    (set) => {
      setStore = (partial) => set(partial);
      return {
        actions: [],
        running: null,
        notice: null,
        hydration: null,
        persistError: null,
        focusId: null,
        addAction: (a) =>
          set((s) => {
            const next = [...s.actions.slice(-(MAX_ACTIONS - 1)), a];
            // keep full bodies only on the newest rows (quota headroom)
            const cutAt = next.length - FULL_BODY_ROWS;
            if (cutAt > 0 && next[cutAt - 1]) next[cutAt - 1] = slimAction(next[cutAt - 1]);
            return { actions: next };
          }),
        // [F104 §3] in-place patch: the ONLY writer is the global observer
        // closing its window. The patched row is re-slimmed when it is old,
        // exactly like addAction, so the quota posture cannot drift.
        updateAction: (id, patch) =>
          set((s) => {
            const idx = s.actions.findIndex((a) => a.id === id);
            if (idx < 0) return {};
            const next = s.actions.slice();
            const merged: ButtonAction = { ...next[idx], ...patch, id: next[idx].id, ts: next[idx].ts };
            next[idx] = idx < next.length - FULL_BODY_ROWS ? slimAction(merged) : merged;
            return { actions: next };
          }),
        clear: () => set({ actions: [] }),
      };
    },
    {
      name: COLLECTOR_STORE_KEY,
      storage: createJSONStorage(() => safeLocalStorage),
      // only the rows are persisted; runner/hydration state is per-tab
      partialize: (s) => ({ actions: s.actions }) as unknown as CollectorState,
      onRehydrateStorage: () => (state, error) => {
        const count = state?.actions?.length ?? 0;
        const info: CollectorHydration = { at: new Date().toISOString(), count, source: error ? "empty" : hydrationSource };
        try {
          console.log("[F102] Collector rehydrated:", count, "actions (" + info.source + ")");
        } catch {
          /* console may be stubbed */
        }
        // hydration is synchronous: setStore exists (the initializer ran first)
        if (setStore) setStore({ hydration: info });
        // [WP-13 / #193] redaction pass on BOTH hydration paths: this callback
        // runs on the initial load AND on every cross-tab `storage`-event
        // rehydrate (and after the legacy-key migration above), so rows
        // persisted before the WP-13 capture fixes are rewritten in place.
        // Idempotent + lossy by design: a redacted row stays redacted.
        redactPersistedRows(state?.actions);
      },
    }
  )
);

// [F102 §2.2] keep two tabs in step: another tab's write re-hydrates this one.
try {
  if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
    window.addEventListener("storage", (e: StorageEvent) => {
      if (e.key === COLLECTOR_STORE_KEY) void useCollectorStore.persist.rehydrate();
    });
  }
} catch {
  /* no window: nothing to sync */
}

function syncPersistError() {
  const cur = useCollectorStore.getState().persistError;
  if (cur !== lastPersistError) useCollectorStore.setState({ persistError: lastPersistError });
}

type Listener = (actions: ButtonAction[]) => void;

/** Subscribe to action list changes. Returns unsubscribe fn. */
export function subscribeToActions(fn: Listener): () => void {
  fn(useCollectorStore.getState().actions);
  return useCollectorStore.subscribe((s, prev) => {
    if (s.actions !== prev.actions) {
      try { fn(s.actions); } catch { /* ignore listener errors */ }
    }
  });
}

/** Get a snapshot of all recorded actions. */
export function getRecordedActions(): ButtonAction[] {
  return useCollectorStore.getState().actions;
}

/**
 * [WP-13 / #193 / MC-P13] The export-safe view of the recorded rows: every row
 * through the shared redaction pass. The store is already redacted at capture
 * time and at hydration; this is the export sink's OWN fence, so the
 * `button-actions.json` download can never ship a raw row even if a future
 * writer forgets the capture-time sanitizers.
 */
export function exportableActions(): ButtonAction[] {
  return getRecordedActions().map((a) => redactButtonAction(a));
}

function newActionId(): string {
  // [F102] ids are unique even for rows minted in the same millisecond (the
  // F100 replay id "act_<ms>_r" collided and duplicated React keys).
  actionSeq = (actionSeq + 1) % 1e6;
  return "act_" + Date.now().toString(36) + "_" + actionSeq.toString(36) + "_" + Math.random().toString(36).slice(2, 8);
}
let actionSeq = 0;

/**
 * [F102] While a "Click now" is in flight, records written by the clicked
 * component's OWN instrumentation (e.g. AddSiteQuick's instrumentButton) are
 * folded into the click's row as `nested` instead of becoming a second row.
 */
interface CaptureContext {
  nested: ButtonAction[];
}
let activeCapture: CaptureContext | null = null;

/** Log a button action. Returns the recorded action (with generated id + ts). */
export function logButtonAction(rec: Omit<ButtonAction, "id" | "ts">): ButtonAction {
  // [WP-13 / #193] the persistence sink's own fence: every row passes through
  // the shared redaction pass BEFORE it reaches the store (and therefore
  // localStorage). The capture paths already sanitize at production; this is
  // the layer that makes a future unsanitized writer unable to persist a raw
  // `?key=` route, a fingerprinted header or an unscrubbed body. Idempotent,
  // so already-clean rows pass through unchanged in content.
  const action: ButtonAction = redactButtonAction({
    id: newActionId(),
    ts: new Date().toISOString(),
    ...rec,
  });
  if (activeCapture) {
    activeCapture.nested.push(action);
    return action;
  }
  useCollectorStore.getState().addAction(action);
  // [F102] a Click-now row is the one the Collector page re-opens on return
  if (action.action.endsWith(".clickNow")) useCollectorStore.setState({ focusId: action.id });
  syncPersistError();
  return action;
}

/** Clear all recorded actions. */
export function clearActions() {
  useCollectorStore.getState().clear();
  useCollectorStore.setState({ notice: null });
  syncPersistError();
}

/**
 * [F104 §3] Patch one recorded row (the global observer fills its row in when
 * the observation window closes). Unknown ids are ignored; id/ts are pinned
 * and can never be patched.
 */
export function updateRecordedAction(id: string, patch: Partial<ButtonAction>): void {
  useCollectorStore.getState().updateAction(id, patch);
  syncPersistError();
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
// [WP-13 / #193] all redaction lives in the shared core (src/lib/diagRedact.ts)
// so the capture path, the hydration pass and the export sink can never drift
// into three inconsistent scrubbers. WP-04/WP-10 reuse the same module.
import {
  maskSecretHeaders,
  redactButtonAction,
  sanitizeExchangeUrl,
  sanitizeRequestUrl,
  sanitizeRoute,
  scrubBodyText,
  scrubSecretText,
} from "@/lib/diagRedact";

const PROBE_TIMEOUT_MS = 2500;
const BODY_CAPTURE_CHARS = 2000;

/**
 * [WP-13 / MC-P13] Header masking is the shared core's. A secret-named header
 * keeps only its LENGTH — never the value, and never a fingerprint of it: the
 * old `sha=<FNV-1a>` fingerprint was secret-derived (an offline guess-check
 * oracle against a weak, unkeyed hash) and is removed. The alias keeps the
 * F101 call sites and pins (`maskHeaders(rawHeaders)`) unchanged.
 */
const maskHeaders = maskSecretHeaders;

export interface CapturedExchange {
  /** Monotonic ring position. A plain array index would go stale the moment
   *  the bounded ring evicts an entry, which silently empties a row. */
  seq: number;
  request: RequestRecord;
  response: ResponseRecord | null;
  failed: string;
  /** [F102] who issued it: the recorder's own service probes, the dashboard's
   *  background pollers, or the app (a button handler). Only "app" traffic is
   *  ever attributed to a click. */
  origin?: "app" | "probe" | "background";
  /** [F102] performance.now() at start / at response-or-failure. */
  startedAtPerf: number;
  endedAtPerf?: number;
}

/** [F102] The dashboard's interval pollers (useDashboardPolling, VersionGate,
 *  Health). No known button calls these, so their ticks can never be mistaken
 *  for the request a click produced. */
const BACKGROUND_POLL = /^\/(ping|health|diag)(\?|$)|^\/api\/(config|native-status|progress|f92-selftest)(\?|$)/;

/** [F102] >0 while the recorder itself is calling fetch() (set synchronously
 *  around the call, read synchronously by the observer): tags probe traffic. */
let probeCallDepth = 0;

function originOf(url: string): "app" | "probe" | "background" {
  if (probeCallDepth > 0) return "probe";
  let path = url;
  try {
    path = new URL(url, typeof location !== "undefined" ? location.href : "http://localhost/").pathname;
  } catch { /* relative or malformed: test the raw string */ }
  return BACKGROUND_POLL.test(path) ? "background" : "app";
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
      // [WP-13 / MC-P12] the ring is the source of every persisted
      // request/response: the URL is stored PATH-ONLY (a `?key=` query must
      // never reach a row), headers are masked without fingerprints, and bodies
      // are scrubbed (the /api/config creds block carries raw passwords).
      request: {
        method,
        url: sanitizeRequestUrl(url),
        headers: maskHeaders(rawHeaders),
        body: scrubBodyText(body, BODY_CAPTURE_CHARS),
        timestamp: new Date(startedAt).toISOString(),
      },
      response: null,
      failed: "",
      origin: originOf(url),
      startedAtPerf: typeof performance !== "undefined" ? performance.now() : startedAt,
    };
    exchangeRing.push(rec);
    while (exchangeRing.length > RING_MAX) exchangeRing.shift();
    try {
      const res = await original(input as RequestInfo, init);
      let status = res.status;
      let headers: Record<string, string> = {};
      let text = "";
      try {
        const rawRespHeaders: Record<string, string> = {};
        res.headers.forEach((v, k) => { rawRespHeaders[k] = v; });
        const masked = maskHeaders(rawRespHeaders);
        for (const k of Object.keys(masked)) headers[k] = scrubSecretText(masked[k], 300);
        const clone = res.clone();
        text = scrubBodyText(await clone.text(), BODY_CAPTURE_CHARS);
      } catch { /* an unreadable body is still a status we can report */ }
      rec.response = { status, headers, body: text, elapsedMs: Date.now() - startedAt };
      rec.endedAtPerf = typeof performance !== "undefined" ? performance.now() : Date.now();
      return res;
    } catch (e) {
      rec.failed = String((e as Error)?.message || e);
      rec.endedAtPerf = typeof performance !== "undefined" ? performance.now() : Date.now();
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
    // [F102] tag the recorder's own traffic: the flag is set only around the
    // synchronous fetch() call, which is when the observer reads it.
    let pending: Promise<Response>;
    probeCallDepth += 1;
    try {
      pending = fetch(apiBase() + path, { cache: "no-store", headers, signal: ctl ? ctl.signal : undefined });
    } finally {
      probeCallDepth -= 1;
    }
    const r = await pending;
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
  // [F102] the recorder's own service probes are never the button's request.
  // [WP-13 / MC-P12] neither is a background poller: only `app` traffic is
  // attributable to a click — a poll that lands inside the window (e.g. the
  // /api/config poll whose response carries the creds block) must never be
  // persisted as the button's request/response.
  const exchanges = ringBetween(mark, ringMark()).filter((e) => e.origin === "app");
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
// [F101 §3.4 → F102 §2.1] ALL KNOWN BUTTONS - REAL DOM CLICKS
//
// The operator's ask: one page that can exercise the whole dashboard. F101's
// table only DOM-clicked the 3 buttons that happen to live on /#/collector and
// answered the other 15 with an unrelated GET ("route-probe") or a no-op row
// ("not-mounted") - 32 identical warn rows, zero real clicks (issue #159).
//
// F102: every entry names its HOST PAGE and the PRECONDITION STEPS that make
// the button appear (open the modal, run a probe search, open a Lab, ...).
// "Click now" navigates there, performs the steps with real DOM events, clicks
// the element exactly like the operator's mouse would, and records what the
// click really did: the requests it fired, the DOM effects it caused, the
// service states before/after and a verdict. A button that cannot be reached is
// recorded as exactly that (fail/warn + the reason) - never as a fake success.
// =============================================================================

/** One precondition step, executed with real DOM events. */
export type PreStep =
  | { kind: "click"; selector: string; why: string; unless?: string; optional?: boolean }
  | { kind: "fill"; selector: string; value: string; why: string; onlyIfEmpty?: boolean }
  | { kind: "waitFor"; selector: string; why: string; timeoutMs?: number; enabled?: boolean; optional?: boolean }
  /** fill the search bar with the probe query and press the real submit button */
  | { kind: "search"; query: string; why: string }
  /** open a Lab page: a stored site's "Open in Lab", else a result's "Open in Lab" */
  | { kind: "openLab"; why: string; query: string };

export interface KnownButton {
  id: string;
  feature: string;
  action: string;
  label: string;
  testId: string;
  /** [F102] page that renders the button, in dashboard-URL form ("/#/search"). */
  hostRoute?: string;
  /** [F102] steps that make the button appear / become enabled. */
  preSteps?: PreStep[];
  /** [F102] run preSteps even when the button is already on screen (form fills). */
  alwaysRunPreSteps?: boolean;
  /** [F102] the button lives in the app shell (every route): never navigate. */
  global?: boolean;
  /** [F102] how long to wait for the target to render (ms). */
  findTimeoutMs?: number;
  /** [F102] how long to observe the click's effects (ms). */
  maxWaitMs?: number;
  /** [F102] verdict when the element legitimately is not rendered (state-gated). */
  absentStatus?: VerdictStatus;
  /** [F102] why the element can be absent - becomes part of the verdict. */
  absentHint?: string;
  /** [F102] why the element can be disabled - becomes part of the verdict. */
  disabledHint?: string;
  /** True when the real click mutates state on the runner. */
  mutating?: boolean;
  /** @deprecated F101 route-probe target. F102 never probes instead of clicking. */
  route?: string;
  /** @deprecated F101 route-probe method. */
  method?: string;
}

/** [F102] The probe query the search-driven buttons use. The mock backend
 *  (tests/e2e/fixtures/mock-backend.mjs) answers it with a direct .mp4 row on
 *  top of the F79 rows, the shape a real "public domain film" search returns:
 *  that single row carries Fetch, Open, Download-to-RDP, Watch-in-RDP,
 *  Preview and Open-in-Lab. */
export const COLLECTOR_PROBE_QUERY = "public domain film";

const SEARCH_STEP: PreStep = { kind: "search", query: COLLECTOR_PROBE_QUERY, why: "run the probe search so result cards render" };

export const KNOWN_BUTTONS: KnownButton[] = [
  { id: "add-site-open", feature: "add-site", action: "openModal", label: "Add site (open modal)", testId: "add-site-button", hostRoute: "/#/search" },
  { id: "add-site-save", feature: "add-site", action: "save", label: "Add site (save)", testId: "add-site-save", hostRoute: "/#/search", mutating: true, alwaysRunPreSteps: true,
    preSteps: [
      { kind: "click", selector: '[data-testid="add-site-button"]', unless: '[data-testid="add-site-modal"]', why: "open the Add site modal" },
      { kind: "waitFor", selector: '[data-testid="add-site-modal"]', why: "wait for the modal" },
      { kind: "fill", selector: '[data-testid="add-site-name"]', value: "F102 Collector probe", onlyIfEmpty: true, why: "type a site name" },
      { kind: "fill", selector: '[data-testid="add-site-url"]', value: "example.com", onlyIfEmpty: true, why: "type a site URL" },
    ],
  },
  { id: "lab-refetch", feature: "lab", action: "refetch", label: "Lab: refetch", testId: "lab-refetch", hostRoute: "/#/search", findTimeoutMs: 15000, preSteps: [{ kind: "openLab", query: COLLECTOR_PROBE_QUERY, why: "open a Lab page (stored site, else a result)" }] },
  { id: "search-submit", feature: "search", action: "submit", label: "Search: submit", testId: "search-submit", hostRoute: "/#/search", preSteps: [{ kind: "fill", selector: '[data-testid="search-query"]', value: COLLECTOR_PROBE_QUERY, onlyIfEmpty: true, why: "type the probe query" }] },
  { id: "search-cancel", feature: "search", action: "cancel", label: "Search: cancel", testId: "cancel-search", hostRoute: "/#/search", findTimeoutMs: 6000,
    disabledHint: "Cancel is only enabled while a search is running - the probe search finished before it could be cancelled.",
    preSteps: [
      // Cancel lives in the progress header, which only renders with the
      // Advanced panel's "Show progress" option on (a per-session display toggle).
      { kind: "click", selector: '[data-testid="bar-icon-drawer"]', unless: '[data-testid="advanced-panel"]', why: "open the Advanced panel" },
      { kind: "click", selector: '[data-testid="show-progress-toggle"]', unless: '[data-testid="show-progress-toggle"]:checked', why: "turn on Show progress (Cancel lives in the progress header)" },
      { kind: "fill", selector: '[data-testid="search-query"]', value: COLLECTOR_PROBE_QUERY, why: "type the probe query" },
      { kind: "click", selector: '[data-testid="search-submit"]', why: "start a search so Cancel becomes enabled" },
    ],
  },
  { id: "card-open-rdp", feature: "launcher", action: "openUrl", label: "Result: open in RDP", testId: "card-open-rdp", hostRoute: "/#/search", mutating: true, findTimeoutMs: 15000, preSteps: [SEARCH_STEP] },
  { id: "card-fetch", feature: "fetch", action: "start", label: "Result: fetch", testId: "card-fetch", hostRoute: "/#/search", mutating: true, findTimeoutMs: 15000, preSteps: [SEARCH_STEP] },
  { id: "card-download-rdp", feature: "download", action: "toRdp", label: "Result: download to RDP", testId: "card-download-rdp", hostRoute: "/#/search", mutating: true, findTimeoutMs: 15000, preSteps: [SEARCH_STEP],
    absentHint: "Download-to-RDP renders only on a result whose URL is a direct file (.pdf/.mp4/.zip/...).",
  },
  { id: "card-open-lab", feature: "lab", action: "inspect", label: "Result: open in Lab", testId: "card-open-lab", hostRoute: "/#/search", findTimeoutMs: 15000, preSteps: [SEARCH_STEP] },
  { id: "diag-test-launch", feature: "diag", action: "testLaunch", label: "Diag: test launch", testId: "f87-diag-test-launch", hostRoute: "/#/search?diag=1", mutating: true },
  { id: "selftest-run", feature: "selftest", action: "run", label: "F87 self-test", testId: "f87-selftest-run", hostRoute: "/#/search?selftest=1", mutating: true, maxWaitMs: 30000,
    disabledHint: "The self-test is already running.",
  },
  { id: "ws-reconnect", feature: "websocket", action: "reconnect", label: "WebSocket: reconnect", testId: "ws-reconnect", hostRoute: "/#/", global: true, findTimeoutMs: 1500,
    absentStatus: "warn", absentHint: "Reconnect is rendered only while the WebSocket is DISCONNECTED - a live/retrying socket has nothing to reconnect.",
  },
  { id: "mirror-disable", feature: "mirror", action: "disable", label: "Mirror: disable", testId: "mirror-disable", hostRoute: "/#/mirror", mutating: true, findTimeoutMs: 4000,
    absentStatus: "warn", absentHint: "Disable is rendered only while the mirror is ENABLED (module installed + opted in) - there is nothing to disable.",
  },
  { id: "collector-run", feature: "collector", action: "run", label: "Collector: run diagnosis", testId: "collector-run", hostRoute: "/#/collector", maxWaitMs: 30000,
    disabledHint: "Run diagnosis is rate limited to 1 run per 5 minutes (see 'Retry after' on the Collector page).",
  },
  { id: "collector-refresh", feature: "collector", action: "refresh", label: "Collector: refresh report", testId: "collector-refresh", hostRoute: "/#/collector" },
  { id: "collector-download-json", feature: "collector", action: "downloadJson", label: "Collector: download JSON", testId: "collector-download-json", hostRoute: "/#/collector" },
  { id: "preview-open-source", feature: "preview", action: "openSource", label: "Preview: open source", testId: "preview-open-source", hostRoute: "/#/search", mutating: true, findTimeoutMs: 15000,
    preSteps: [
      SEARCH_STEP,
      { kind: "waitFor", selector: '[id^="f56.search.resultPreview."]', timeoutMs: 15000, why: "wait for a result's Preview button" },
      { kind: "click", selector: '[id^="f56.search.resultPreview."]', why: "open the Preview dialog" },
    ],
  },
  { id: "stream-watch-rdp", feature: "stream", action: "watchRdp", label: "Stream: watch in RDP", testId: "f91-stream-watch-rdp", hostRoute: "/#/search", mutating: true, findTimeoutMs: 15000, preSteps: [SEARCH_STEP],
    absentHint: "Watch in RDP renders only on a video/live result (.mp4/.webm/... or a live-TV host).",
  },
];

/** [F102 §2.3] A button is wired when it names a host page; anything else is
 *  shown as "⚠️ Handler pending" and is NEVER recorded as a fake action. */
export function isHandlerWired(btn: KnownButton): boolean {
  return typeof btn.hostRoute === "string" && btn.hostRoute.length > 0 && btn.testId.length > 0;
}

function settle(ms: number): Promise<void> {
  return new Promise((res) => {
    try { window.setTimeout(res, ms); } catch { res(); }
  });
}

/** [F102] wait for the router to paint the new route. */
function waitForRender(ms: number): Promise<void> {
  return settle(ms);
}

// ---------------------------------------------------------------------------
// Navigation: the router registers its navigate() (CollectorRunBridge inside
// the HashRouter); outside a router (tests) the hash is set directly.
// ---------------------------------------------------------------------------
type Navigator = (path: string) => void;
let routerNavigate: Navigator | null = null;

/** [F102] called by <CollectorRunBridge/> with react-router's navigate(). */
export function registerCollectorNavigator(fn: Navigator | null): () => void {
  routerNavigate = fn;
  return () => {
    if (routerNavigate === fn) routerNavigate = null;
  };
}

/** "/#/search?diag=1" -> "/search?diag=1" */
export function routePath(hostRoute: string): string {
  const p = String(hostRoute || "").replace(/^\/?#/, "");
  return p.startsWith("/") ? p : "/" + p;
}

function currentPath(): string {
  try {
    const h = String(location.hash || "");
    return h ? routePath(h) : "/";
  } catch {
    return "/";
  }
}

/** [F102] SPA navigation to a dashboard route ("/#/search" or "/search"). */
export async function navigateTo(route: string): Promise<void> {
  const path = routePath(route);
  if (currentPath() === path) return;
  if (routerNavigate) {
    try {
      routerNavigate(path);
    } catch {
      location.hash = "#" + path;
    }
  } else {
    try { location.hash = "#" + path; } catch { /* no location: tests */ }
  }
  await waitForRender(500);
}

// ---------------------------------------------------------------------------
// DOM helpers - every interaction is a real DOM event on a real element.
// ---------------------------------------------------------------------------
function q(selector: string): HTMLElement | null {
  try { return document.querySelector(selector) as HTMLElement | null; } catch { return null; }
}

/** The target element - the SAME lookup the F101 table used, now reached
 *  after navigating to the host page. */
function findTarget(btn: KnownButton): HTMLElement | null {
  let el: Element | null = null;
  try { el = document.querySelector('[data-testid="' + btn.testId + '"]'); } catch { el = null; }
  return el as HTMLElement | null;
}

function isDisabled(el: HTMLElement | null): boolean {
  if (!el) return false;
  return (el as HTMLButtonElement).disabled === true || el.getAttribute("aria-disabled") === "true";
}

async function waitForEl(get: () => HTMLElement | null, timeoutMs: number, needEnabled: boolean): Promise<HTMLElement | null> {
  const deadline = Date.now() + timeoutMs;
  let el = get();
  while (Date.now() < deadline) {
    el = get();
    if (el && (!needEnabled || !isDisabled(el))) return el;
    await settle(100);
  }
  return get();
}

/** React-controlled inputs ignore `el.value = x`; use the native setter + an
 *  input event, which is what a keystroke produces. */
function fillInput(el: HTMLElement, value: string): void {
  const input = el as HTMLInputElement;
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  try {
    input.focus();
  } catch { /* focus is cosmetic */ }
  if (setter) setter.call(input, value);
  else input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

interface StepLog {
  step: string;
  outcome: "done" | "skipped" | "failed";
  detail?: string;
}

async function runPreStep(step: PreStep, log: StepLog[]): Promise<boolean> {
  const tag = step.kind + ": " + step.why;
  if (step.kind === "click") {
    if (step.unless && q(step.unless)) {
      log.push({ step: tag, outcome: "skipped", detail: step.unless + " already present" });
      return true;
    }
    const el = await waitForEl(() => q(step.selector), 4000, true);
    if (!el || isDisabled(el)) {
      log.push({ step: tag, outcome: "failed", detail: step.selector + (el ? " is disabled" : " not found") });
      return !!step.optional;
    }
    el.click();
    await settle(250);
    log.push({ step: tag, outcome: "done" });
    return true;
  }
  if (step.kind === "fill") {
    const el = await waitForEl(() => q(step.selector), 4000, true);
    if (!el) {
      log.push({ step: tag, outcome: "failed", detail: step.selector + " not found" });
      return false;
    }
    if (step.onlyIfEmpty && String((el as HTMLInputElement).value || "").trim()) {
      log.push({ step: tag, outcome: "skipped", detail: "already filled" });
      return true;
    }
    fillInput(el, step.value);
    await settle(150);
    log.push({ step: tag, outcome: "done", detail: JSON.stringify(step.value) });
    return true;
  }
  if (step.kind === "waitFor") {
    const el = await waitForEl(() => q(step.selector), step.timeoutMs ?? 6000, !!step.enabled);
    const ok = !!el && (!step.enabled || !isDisabled(el));
    log.push({ step: tag, outcome: ok ? "done" : "failed", detail: ok ? undefined : step.selector + " did not appear" });
    return ok || !!step.optional;
  }
  if (step.kind === "search") {
    const input = await waitForEl(() => q('[data-testid="search-query"]'), 4000, false);
    if (!input) {
      log.push({ step: tag, outcome: "failed", detail: "search bar not found" });
      return false;
    }
    fillInput(input, step.query);
    const submit = await waitForEl(() => q('[data-testid="search-submit"]'), 6000, true);
    if (!submit || isDisabled(submit)) {
      log.push({ step: tag, outcome: "failed", detail: "search submit is " + (submit ? "disabled" : "missing") });
      return false;
    }
    submit.click();
    log.push({ step: tag, outcome: "done", detail: JSON.stringify(step.query) });
    return true;
  }
  if (step.kind === "openLab") {
    let opener = q('[data-testid^="your-site-open-lab-"]');
    let via = "stored site";
    if (!opener) {
      opener = q('[data-testid="card-open-lab"]');
      via = "result card";
    }
    if (!opener) {
      const searched = await runPreStep({ kind: "search", query: step.query, why: "run the probe search to get a result to open in Lab" }, log);
      if (!searched) return false;
      opener = await waitForEl(() => q('[data-testid="card-open-lab"]'), 15000, true);
      via = "result card";
    }
    if (!opener) {
      log.push({ step: tag, outcome: "failed", detail: "no stored site and no result to open in Lab" });
      return false;
    }
    opener.click();
    await settle(300);
    log.push({ step: tag, outcome: "done", detail: "via " + via });
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Effect observation: network (fetch ring) + DOM signature + popups/downloads.
// ---------------------------------------------------------------------------
interface EffectProbe {
  stop: () => void;
  signature: () => string;
  popups: string[];
  downloads: string[];
}

function textOf(selector: string, max = 400): string {
  try {
    return Array.from(document.querySelectorAll(selector))
      .map((n) => (n.textContent || "").trim())
      .join(" | ")
      .slice(0, max);
  } catch {
    return "";
  }
}

function startEffectProbe(el: HTMLElement): EffectProbe {
  const popups: string[] = [];
  const downloads: string[] = [];
  const origOpen = window.open;
  try {
    window.open = function (this: Window, ...args: Parameters<typeof window.open>) {
      // [WP-13] a popup/download URL can carry `?key=` — cut query+fragment.
      popups.push(sanitizeExchangeUrl(String(args[0] ?? "")));
      return origOpen.apply(this, args);
    } as typeof window.open;
  } catch { /* read-only open: popups simply go uncounted */ }
  const onDocClick = (e: Event) => {
    const a = (e.target as Element | null)?.closest?.("a[download]") as HTMLAnchorElement | null;
    if (a) downloads.push(sanitizeExchangeUrl(a.getAttribute("download") || a.href || ""));
  };
  document.addEventListener("click", onDocClick, true);
  const signature = () =>
    JSON.stringify([
      document.querySelectorAll('[role="dialog"],[role="alertdialog"]').length,
      textOf("#toasts"),
      textOf('[role="alert"]'),
      textOf('[data-testid="status-live"]', 120),
      // [WP-13 / MC-P11] route template only — the raw hash can carry `?key=`.
      sanitizeRoute(typeof location !== "undefined" ? location.hash : ""),
      el.isConnected ? [isDisabled(el), el.getAttribute("aria-expanded"), (el.textContent || "").trim().slice(0, 60)].join("|") : "detached",
      popups.length,
      downloads.length,
    ]);
  return {
    popups,
    downloads,
    signature,
    stop: () => {
      try { window.open = origOpen; } catch { /* ignore */ }
      document.removeEventListener("click", onDocClick, true);
    },
  };
}

function describeEffects(before: string, after: string, probe: EffectProbe): string[] {
  const out: string[] = [];
  let b: unknown[] = [];
  let a: unknown[] = [];
  try { b = JSON.parse(before); a = JSON.parse(after); } catch { return out; }
  if (a[0] !== b[0]) out.push("dialog " + (Number(a[0]) > Number(b[0]) ? "opened" : "closed") + " (" + b[0] + "→" + a[0] + ")");
  if (a[1] !== b[1] && a[1]) out.push("toast: " + String(a[1]).slice(-160));
  if (a[2] !== b[2] && a[2]) out.push("alert: " + String(a[2]).slice(-160));
  if (a[3] !== b[3] && a[3]) out.push("search status: " + String(a[3]));
  if (a[4] !== b[4]) out.push("route → " + String(a[4]));
  if (a[5] !== b[5]) out.push("button state: " + String(b[5]) + " → " + String(a[5]));
  for (const p of probe.popups) out.push("popup opened: " + p);
  for (const d of probe.downloads) out.push("download triggered: " + d);
  return out;
}

interface WindowResult {
  exchanges: CapturedExchange[];
  appExchanges: CapturedExchange[];
  effects: string[];
  elapsedMs: number;
  timedOut: boolean;
}

/** [F102] Observe the click until the network is idle and the DOM has been
 *  quiet for QUIET_MS (min MIN_WAIT_MS, max maxWaitMs). elapsedMs is click →
 *  last observed effect (response landed / DOM changed), never a constant. */
const MIN_WAIT_MS = 250;
const QUIET_MS = 450;

async function observeClick(el: HTMLElement, mark: number, maxWaitMs: number): Promise<WindowResult> {
  const probe = startEffectProbe(el);
  const before = probe.signature();
  let lastSig = before;
  const t0 = performance.now();
  let lastActivity = -1;
  let timedOut = false;
  try {
    el.click();
    for (;;) {
      await settle(50);
      const now = performance.now();
      const sig = probe.signature();
      if (sig !== lastSig) {
        lastSig = sig;
        lastActivity = now;
      }
      const win = exchangeRing.filter((e) => e.seq > mark && e.origin !== "background");
      for (const e of win) {
        const end = e.endedAtPerf ?? e.startedAtPerf;
        if (end > lastActivity) lastActivity = end;
      }
      const inflight = win.some((e) => !e.response && !e.failed);
      const since = now - (lastActivity >= 0 ? lastActivity : t0);
      if (now - t0 >= MIN_WAIT_MS && !inflight && since >= QUIET_MS) break;
      if (now - t0 >= maxWaitMs) {
        timedOut = inflight;
        break;
      }
    }
  } finally {
    probe.stop();
  }
  const end = performance.now();
  const exchanges = exchangeRing.filter((e) => e.seq > mark && e.origin !== "background");
  const appExchanges = exchanges.filter((e) => e.origin !== "probe");
  const effects = describeEffects(before, probe.signature(), probe);
  const effective = lastActivity >= 0 ? lastActivity : end;
  return {
    exchanges,
    appExchanges,
    effects,
    elapsedMs: Math.max(1, Math.round((timedOut ? end : effective) - t0)),
    timedOut,
  };
}

function pathOf(url: string): string {
  try {
    // [WP-13 / MC-P12] path-only: a query string (`?key=…`) must never reach a
    // verdict reason or a persisted `result.requests[]` entry.
    const u = new URL(url, location.href);
    return u.pathname;
  } catch {
    return String(url || "").split(/[?#]/, 1)[0] || String(url || "");
  }
}

/** [F102] Verdict for a REAL click, from what the click did on the wire and in
 *  the DOM. ok = the action's request succeeded or it produced its client-side
 *  effect; fail = a request failed / the handler reported failure; warn = it
 *  ran but proved nothing (no request, no visible change) or ran unauthenticated. */
export function classifyFromFetchLog(args: {
  appExchanges: CapturedExchange[];
  effects: string[];
  nested: ButtonAction[];
  pre: PreCheck;
  timedOut: boolean;
  waitedMs: number;
}): Verdict {
  const ex = args.appExchanges;
  const bad = ex.find((e) => !!e.failed || !e.response || e.response.status >= 400);
  if (bad && !(args.timedOut && !bad.response && !bad.failed)) {
    const status = bad.response?.status ?? 0;
    const v = classifyFailure(status, bad.response?.body ?? "", bad.failed);
    return { ...v, reason: "real click → " + bad.request.method + " " + pathOf(bad.request.url) + " → " + (status || "no response") + ": " + v.reason };
  }
  const nestedBad = args.nested.find((n) => n.verdict?.status === "fail" || !!n.error);
  if (nestedBad) {
    const v = nestedBad.verdict;
    return {
      status: "fail",
      reason: "real click → the " + nestedBad.feature + ":" + nestedBad.action + " handler reported " + (v ? v.reason : "an error: " + nestedBad.error),
      suggestedFix: v?.suggestedFix || "Expand the result tab: the handler's own error is recorded there.",
      relatedIssue: v?.relatedIssue ?? F102_ISSUE,
    };
  }
  if (args.timedOut) {
    const pending = ex.filter((e) => !e.response && !e.failed).map((e) => e.request.method + " " + pathOf(e.request.url));
    return {
      status: "warn",
      reason: "real click → still waiting after " + args.waitedMs + "ms for " + (pending.join(", ") || "the server"),
      suggestedFix: "The action is long-running (self-test / diagnosis). Wait and press Click now again, or open the page to watch it finish.",
      relatedIssue: null,
    };
  }
  const okEx = ex.filter((e) => e.response && e.response.status >= 200 && e.response.status < 400);
  if (okEx.length) {
    const first = okEx[0];
    const what = first.request.method + " " + pathOf(first.request.url) + " → HTTP " + first.response!.status + (okEx.length > 1 ? " (+" + (okEx.length - 1) + " more)" : "");
    if (!args.pre.tokenPresence) {
      return { status: "warn", reason: "real click → " + what + ", but without a dash token (loopback/tailnet allowance)", suggestedFix: "Add ?key=<dash token> so the same click works from off-runner.", relatedIssue: null };
    }
    return { status: "ok", reason: "real click → " + what + (args.effects.length ? "; " + args.effects[0] : ""), suggestedFix: "None needed.", relatedIssue: null };
  }
  if (args.effects.length) {
    return { status: "ok", reason: "real click → client-side effect: " + args.effects.slice(0, 3).join("; "), suggestedFix: "None needed.", relatedIssue: null };
  }
  return {
    status: "warn",
    reason: "real click → no request and no visible change within " + args.waitedMs + "ms",
    suggestedFix: "The handler short-circuited (validation / precondition). Use Open page and click it by hand to see the inline message.",
    relatedIssue: F102_ISSUE,
  };
}

async function capturePreCheck(): Promise<{ pre: PreCheck; probe: ProbeSet }> {
  const tokenPresent = (() => { try { return hasDashToken(); } catch { return false; } })();
  const probe = await captureServiceStates();
  return {
    probe,
    pre: {
      serviceStates: probe.states,
      tokenPresence: tokenPresent,
      routeReachable: probe.routeReachable,
      prerequisites: prerequisiteList(probe, tokenPresent),
      at: new Date().toISOString(),
    },
  };
}

async function capturePostCheck(pre: PreCheck, effects: string[]): Promise<{ post: PostCheck; probe: ProbeSet }> {
  const probe = await captureServiceStates();
  const stateChanged = JSON.stringify(probe.states) !== JSON.stringify(pre.serviceStates);
  const sideEffects: SideEffect[] = effects.length ? effects.map((what) => ({ what, detected: true })) : [{ what: "visible DOM change", detected: false }];
  return { probe, post: { sideEffects, newServiceStates: probe.states, stateChanged, at: new Date().toISOString() } };
}

function setRunning(r: CollectorRunState | null) {
  useCollectorStore.setState({ running: r });
}

let clickChain: Promise<unknown> = Promise.resolve();

export interface ClickOptions {
  /** navigate back to the page the click started from (default true). */
  returnToOrigin?: boolean;
  index?: number;
  total?: number;
}

/**
 * [F102 §2.1] "Click now": a REAL DOM click.
 *   1. navigate to the button's host page (unless it is already on screen)
 *   2. run the precondition steps (modal, probe search, Lab, ...)
 *   3. capture pre-state (services, token)
 *   4. click the element - the operator's code path - observing every request
 *   5. wait for the network to go idle / the DOM to settle
 *   6. capture post-state
 *   7. verdict from the fetch log + DOM effects (+ the handler's own record)
 *   8. record it, then return to the page the click started from
 * There is NO route-probe fallback: an unreachable button is recorded as such.
 */
export async function clickKnownButton(btnOrId: KnownButton | string, opts: ClickOptions = {}): Promise<ButtonAction> {
  // one click at a time: a second Click now waits for the first to finish
  const run = clickChain.then(() => runClick(btnOrId, opts));
  clickChain = run.catch(() => undefined);
  return run;
}

async function runClick(btnOrId: KnownButton | string, opts: ClickOptions): Promise<ButtonAction> {
  const btn = typeof btnOrId === "string" ? KNOWN_BUTTONS.find((b) => b.id === btnOrId) : btnOrId;
  if (!btn) throw new Error("Unknown button " + String(btnOrId));
  if (!isHandlerWired(btn)) throw new Error("Handler pending for " + btn.id + " - not clicked, not recorded");
  installFetchObserver();
  const origin = currentPath();
  const hostRoute = btn.hostRoute as string;
  const started = performance.now();
  const steps: StepLog[] = [];
  const running = (step: string) => setRunning({ buttonId: btn.id, label: btn.label, step, index: opts.index, total: opts.total, startedAt: new Date().toISOString() });
  try {
    // 1. host page
    running("opening " + hostRoute);
    let el = findTarget(btn);
    const onScreen = !!el && !isDisabled(el);
    if (!onScreen && !btn.global) {
      await navigateTo(hostRoute);
      el = await waitForEl(() => findTarget(btn), 800, true);
    }
    // 2. preconditions
    if ((btn.preSteps && btn.preSteps.length) && (btn.alwaysRunPreSteps || !el || isDisabled(el))) {
      for (const step of btn.preSteps) {
        running(step.why);
        const ok = await runPreStep(step, steps);
        if (!ok) break;
      }
    }
    running("waiting for [data-testid=" + btn.testId + "]");
    el = await waitForEl(() => findTarget(btn), btn.findTimeoutMs ?? 8000, true);
    // [WP-13 / MC-P11] route template only — the raw hash can carry `?key=`.
    const routeNow = sanitizeRoute(typeof location !== "undefined" ? location.hash : "");
    if (!el || isDisabled(el)) {
      const disabled = !!el;
      running("recording " + (disabled ? "disabled" : "missing") + " button");
      const { pre, probe } = await capturePreCheck();
      const failedStep = steps.find((s) => s.outcome === "failed");
      const reason = disabled
        ? "button [data-testid=" + btn.testId + "] is rendered but DISABLED on " + routeNow + (btn.disabledHint ? " — " + btn.disabledHint : "")
        : "DOM element [data-testid=" + btn.testId + "] not found on route " + hostRoute + (failedStep ? " (precondition failed: " + failedStep.step + " — " + (failedStep.detail || "") + ")" : "") + (btn.absentHint ? " — " + btn.absentHint : "");
      const verdict: Verdict = disabled
        ? { status: "warn", reason, suggestedFix: "Wait for the precondition (rate-limit window / running action) and press Click now again.", relatedIssue: F102_ISSUE }
        : { status: btn.absentStatus || "fail", reason, suggestedFix: "Button may be hidden by state. Check feature prerequisites" + (btn.absentHint ? "" : " (use Open page to see it in context)") + ".", relatedIssue: F102_ISSUE };
      return logButtonAction({
        feature: btn.feature,
        action: btn.action + ".clickNow",
        params: { knownButton: btn.id, hostRoute, testId: btn.testId, preSteps: steps },
        result: { via: disabled ? "disabled" : "not-rendered", route: routeNow, clicked: false },
        error: disabled ? undefined : "not rendered: [data-testid=" + btn.testId + "] on " + hostRoute,
        elapsedMs: Math.max(1, Math.round(performance.now() - started)),
        preCheck: pre,
        postCheck: { sideEffects: [{ what: "click performed", detected: false }], newServiceStates: pre.serviceStates, stateChanged: false, at: new Date().toISOString() },
        serviceDependencies: probe.deps,
        verdict,
      });
    }
    // 3. pre-state
    running("capturing pre-state");
    const { pre } = await capturePreCheck();
    // 4 + 5. the real click, observed (the mark is taken AFTER the pre-probes)
    running("clicking " + btn.label);
    el = findTarget(btn) || el;
    const mark = ringMark();
    const capture: CaptureContext = { nested: [] };
    activeCapture = capture;
    let win: WindowResult;
    try {
      win = await observeClick(el, mark, btn.maxWaitMs ?? 8000);
    } finally {
      activeCapture = null;
    }
    // 6. post-state
    running("capturing post-state");
    const { post, probe: postProbe } = await capturePostCheck(pre, win.effects);
    // 7. verdict
    const verdict = classifyFromFetchLog({ appExchanges: win.appExchanges, effects: win.effects, nested: capture.nested, pre, timedOut: win.timedOut, waitedMs: win.elapsedMs });
    const primary = win.appExchanges.find((e) => e.request.method !== "GET") || win.appExchanges[0] || null;
    // 8. record
    return logButtonAction({
      feature: btn.feature,
      action: btn.action + ".clickNow",
      params: { knownButton: btn.id, hostRoute, testId: btn.testId, preSteps: steps },
      result: {
        via: "dom-click",
        route: routeNow,
        clicked: true,
        effects: win.effects,
        requests: win.appExchanges.map((e) => ({ method: e.request.method, url: pathOf(e.request.url), status: e.response?.status ?? 0, elapsedMs: e.response?.elapsedMs ?? null, failed: e.failed || undefined })),
        nested: capture.nested.map((n) => ({ feature: n.feature, action: n.action, verdict: n.verdict?.status ?? null, error: n.error })),
      },
      error: verdict.status === "fail" ? verdict.reason.slice(0, 200) : undefined,
      elapsedMs: win.elapsedMs,
      preCheck: pre,
      request: primary ? primary.request : undefined,
      response: primary ? primary.response ?? undefined : undefined,
      postCheck: post,
      serviceDependencies: postProbe.deps,
      verdict,
    });
  } finally {
    setRunning(null);
    if (opts.returnToOrigin !== false && currentPath() !== origin) {
      await navigateTo(origin);
    }
  }
}

/** [F102 §2.3] identical-error signature: the reason with the button-specific
 *  tokens (testId, route, label, method/path) removed, so "the server refused
 *  the dash token" five times in a row aborts while five different missing
 *  buttons do not. */
function errorSignature(rec: ButtonAction): string | null {
  if (rec.verdict?.status !== "fail") return null;
  const r = rec.verdict.reason;
  const core = r.includes(": ") && r.startsWith("real click → ") ? r.slice(r.indexOf(": ") + 2) : r;
  return core.replace(/\[data-testid=[^\]]*\]/g, "[el]").replace(/#\/[^\s)]*/g, "#/route");
}

export const IDENTICAL_ERROR_LIMIT = 5;
export const ABORT_MESSAGE = "Aborted after 5 identical errors — fix one button at a time.";

export interface BatchResult {
  records: ButtonAction[];
  skipped: string[];
  aborted: string | null;
}

/** [F102 §2.3] "Click every button": one REAL click per wired button, in
 *  order, aborting after 5 identical errors; unwired buttons are skipped and
 *  never recorded. Returns to the starting page once, at the end. */
export async function clickAllKnownButtons(buttons: KnownButton[] = KNOWN_BUTTONS): Promise<BatchResult> {
  const origin = currentPath();
  const records: ButtonAction[] = [];
  const skipped: string[] = [];
  let aborted: string | null = null;
  let lastSig: string | null = null;
  let streak = 0;
  useCollectorStore.setState({ notice: null });
  const wired = buttons.filter((b) => {
    if (isHandlerWired(b)) return true;
    skipped.push(b.id);
    return false;
  });
  try {
    for (let i = 0; i < wired.length; i++) {
      const rec = await clickKnownButton(wired[i], { returnToOrigin: false, index: i + 1, total: wired.length });
      records.push(rec);
      const sig = errorSignature(rec);
      if (sig && sig === lastSig) streak += 1;
      else streak = sig ? 1 : 0;
      lastSig = sig;
      if (streak >= IDENTICAL_ERROR_LIMIT) {
        aborted = ABORT_MESSAGE + " (" + String(sig).slice(0, 140) + ")";
        break;
      }
    }
  } finally {
    if (currentPath() !== origin) await navigateTo(origin);
  }
  const notice = aborted || (skipped.length ? "Skipped " + skipped.length + " button(s) with ⚠️ Handler pending: " + skipped.join(", ") : null);
  useCollectorStore.setState({ notice });
  return { records, skipped, aborted };
}

/** [F102] which known button a recorded row belongs to (new rows carry
 *  params.knownButton; organic rows match on feature:action). */
export function knownButtonOf(a: ButtonAction): KnownButton | undefined {
  const id = (a.params as { knownButton?: unknown } | undefined)?.knownButton;
  if (typeof id === "string") {
    const hit = KNOWN_BUTTONS.find((b) => b.id === id);
    if (hit) return hit;
  }
  const action = a.action.replace(/\.(clickNow|replay)$/, "");
  return KNOWN_BUTTONS.find((b) => b.feature === a.feature && b.action === action);
}

/**
 * [F100 → F102] "▶ Replay all" re-runs REAL clicks: each distinct known button
 * found in the history is clicked once. F100 handed this an empty handler map
 * and wrote one "no handler" error row per recorded action (the operator's 32
 * identical rows). Rows that map to no known button are skipped - counted,
 * never recorded as fake actions.
 */
export async function replayAllActions(): Promise<BatchResult> {
  const seen = new Set<string>();
  const targets: KnownButton[] = [];
  let unmatched = 0;
  for (const a of getRecordedActions()) {
    const b = knownButtonOf(a);
    if (!b) {
      unmatched += 1;
      continue;
    }
    if (!seen.has(b.id)) {
      seen.add(b.id);
      targets.push(b);
    }
  }
  const out = await clickAllKnownButtons(targets);
  if (unmatched && !out.aborted) {
    useCollectorStore.setState({ notice: "Replayed " + targets.length + " button(s); " + unmatched + " recorded row(s) map to no known button and were skipped (not recorded)." });
  }
  return out;
}

/** Last recorded outcome per known button, for the "All known buttons" table. */
export function lastOutcomePerButton(actions: ButtonAction[]): Record<string, ButtonAction> {
  const out: Record<string, ButtonAction> = {};
  for (const a of actions) {
    const key = a.feature + ":" + a.action.replace(/\.(clickNow|replay)$/, "");
    const prev = out[key];
    if (!prev || new Date(a.ts).getTime() >= new Date(prev.ts).getTime()) out[key] = a;
  }
  return out;
}
