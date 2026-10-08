// [F106 §3] The fetch interceptor - the ONLY part of the lab that touches a
// platform API.
//
// WHAT IT DOES. While a lab route is mounted, window.fetch is wrapped: every
// request is offered to the pure core (resolveMock), which answers with
// passthrough, a synthetic response, or a synthetic network error. The wrapper
// then either calls the ORIGINAL fetch (passthrough) or answers in-process (a
// mocked read). Nothing else in the app is touched: no endpoint is added, no
// server route is created, no request is redirected.
//
// THE FOUR INVARIANTS (each has a gate):
//   1. SCOPE. Installation happens from the lab component's effect, never from
//      main.tsx/App.tsx - so the dashboard routes run with the stock fetch. The
//      #/lab route is a deep link; if the operator never opens it, this module
//      never runs.
//   2. READS ONLY. resolveMock() passes every non-GET/HEAD through before it
//      consults the scenario map (labCore §1.1), so a forced scenario can never
//      fake a write - no mirror enable, no collector run, no purge pretends to
//      succeed.
//   3. RESTORED, NOT REPLACED. The exact function object found on window.fetch at
//      install time is put back at uninstall time, and only if window.fetch is
//      still OUR wrapper (a test stub or a later patch is never clobbered). The
//      reference count makes React 18 StrictMode's double effect a no-op cycle.
//   4. LABELLED. A mocked response carries `x-lab-mock: <scenario>` plus the
//      path it stood in for, so a fake is always distinguishable from the real
//      thing - by a human reading the panel, by the DVR, or by a future gate.
//
// The dash token can never leak through this path: the core's ledger key is
// path-only (normalizeRequestPath strips ?key=), and the request itself is
// untouched because passthrough hands the original args to the original fetch.
import { LAB_MOCK_HEADER, resolveMock } from "./labCore";
import type { LabDecision } from "./labCore";
import { useLabStore } from "./labStore";

/** A Response-shaped object. Only what this app's clients actually read is
 *  implemented (ok/status/json - see src/lib/api.ts getJson, lib/f92.ts,
 *  api/search). `clone()` exists so a caller that tees a body does not explode. */
function labResponse(decision: LabDecision): Record<string, unknown> {
  const body = decision.body === undefined ? {} : decision.body;
  const text = JSON.stringify(body);
  const headers = {
    get(name: string): string | null {
      const n = String(name || "").toLowerCase();
      if (n === LAB_MOCK_HEADER) return decision.scenario;
      if (n === "content-type") return "application/json";
      return null;
    },
  };
  const response: Record<string, unknown> = {
    ok: decision.status! >= 200 && decision.status! < 300,
    status: decision.status,
    statusText: decision.statusText || "",
    url: decision.path,
    headers,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(text),
  };
  response.clone = () => ({ ...response });
  return response;
}

let installs = 0;
let patchedFetch: typeof fetch | null = null;
let originalFetch: typeof fetch | null = null;
// [F109 §LAB-DISCOVERS-PROD-BUGS] One flag per install generation. The restore guard
// below (`window.fetch === patchedFetch`) correctly refuses to clobber a LATER patch -
// but the shipped Collector page installs F101's PERMANENT observer on mount
// (Collector.tsx -> installFetchObserver), and the lab mounts the shipped Collector.
// So on /#/lab/collector the lab wrapper ends up UNDER F101's, the guard declines to
// unwrap it, and - before this flag existed - it kept answering forced scenarios after
// the lab unmounted: the real dashboard got a synthetic `500` + `x-lab-mock: error500`
// for the rest of the tab's life (reproduced in src/tests/smoke/f109-debug-hud.test.tsx).
// A retired wrapper that cannot be unwrapped now becomes a pure forwarder - the same
// "stay in the chain, stop acting" rule F104's click windows already follow.
let generation: { live: boolean } | null = null;

/** Is the interceptor currently installed? (read by the panel + gates) */
export function labMocksInstalled(): boolean {
  return installs > 0;
}

/**
 * Install the lab interceptor. Returns the uninstaller; safe to call twice
 * (React StrictMode) and safe to call when already uninstalled.
 */
export function installLabFetchMock(): () => void {
  if (typeof window === "undefined" || typeof window.fetch !== "function") return () => undefined;
  installs += 1;
  if (installs === 1) {
    const before = window.fetch;
    // A bare `fetch(...)` call is an illegal invocation in a real browser: the
    // captured function must stay bound to its window.
    const bound = before.bind(window);
    const gen = { live: true };
    generation = gen;
    const wrapper = function labFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      // retired but still in the chain (something wrapped on top): forward, never mock
      if (!gen.live) return bound(input, init);
      const method = String((init && init.method) || (input as Request)?.method || "GET");
      const url = typeof input === "string" ? input : String((input as Request)?.url ?? input);
      const state = useLabStore.getState();
      const decision = resolveMock(state.scenarios, method, url);
      state.record({ method: decision.method, path: decision.path, kind: decision.kind, scenario: decision.scenario });
      if (decision.kind === "passthrough") return bound(input, init);
      if (decision.kind === "network-error") return Promise.reject(new TypeError(decision.message || "lab-mock: offline"));
      return Promise.resolve(labResponse(decision) as unknown as Response);
    };
    patchedFetch = wrapper as unknown as typeof fetch;
    originalFetch = before;
    window.fetch = patchedFetch;
  }
  return () => {
    installs = Math.max(0, installs - 1);
    if (installs === 0 && generation) {
      // Stop mocking FIRST, whether or not the wrapper can be unwrapped below.
      generation.live = false;
      generation = null;
    }
    if (installs === 0 && patchedFetch && window.fetch === patchedFetch) {
      window.fetch = originalFetch as typeof fetch;
      patchedFetch = null;
      originalFetch = null;
    } else if (installs === 0 && patchedFetch) {
      // Not outermost: leave the (now forwarding) wrapper in place, forget it, and
      // let the next install wrap whatever is outermost at that time.
      patchedFetch = null;
      originalFetch = null;
    }
  };
}

/** Test-only: force the module back to its pre-install state. */
export function __resetLabFetchMockForTests(): void {
  if (generation) generation.live = false;
  generation = null;
  installs = 0;
  patchedFetch = null;
  originalFetch = null;
}
