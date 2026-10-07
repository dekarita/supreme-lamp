// [F106 / Observatory step 5] Feature Lab CORE - the pure half of the mock controls.
//
// WHY THIS FILE EXISTS (and why it is plain JS). The lab's fetch interceptor
// (src/lib/lab/mockBackend.ts) touches window.fetch, so it can only be proven in
// jsdom. The half that decides WHAT a mocked request becomes - which requests may
// be mocked at all, how a URL is cut down to a ledger key, which scenario wins,
// what body a scenario returns, how the ledger consolidates - is pure data logic
// and lives here so the CI job that runs `node --test tests/*.test.js` can
// EXECUTE the shipped rules with no DOM and no build step. Same shape as
// src/lib/dvr-core.js (step 3) and src/search/custom-source-core.js (F58): one
// rule file, two consumers, no re-implementation in the gate.
//
// CONTRACT (static, enforced by tests/f106-lab-routes.test.js):
//   - NO I/O: no fetch, XHR, WebSocket, sendBeacon, storage, DOM, node fs.
//   - NO CLOCK, NO RANDOMNESS: no Date.now, new Date, Math.random, setTimeout.
//     Every ordering fact (ledger seq) is a counter the caller drives, so a
//     replay of the same requests always produces the same ledger - the
//     §DESIGN-VS-TEST-RACE rule from step 3 applied to the lab.
//   - NO ENDPOINT LITERALS: this file never names a route. It reacts to paths it
//     is handed, which is what keeps the lab from becoming a second, drifting
//     inventory of the API (the F105 registry owns endpoints).
//
// [F106 §1.1] THE ONE SAFETY RULE THAT MATTERS: the lab may fake a READ, never a
// WRITE. `LAB_MOCKABLE_METHODS` is GET/HEAD only, and resolveMock() returns
// passthrough for anything else before it even looks at the scenario map - so a
// forced scenario can never make POST /api/collector/run (or mirror enable, or a
// purge) look like it succeeded. That is the #168/#169 remediation class kept
// intact: no fabricated success on a write path, ever.

/** The envelope tag a copied lab report carries (F108/F109 can key off it). */
export const LAB_FORMAT = "mclab";
/** Bumped when the report shape changes in a way a reader must notice. */
export const LAB_VERSION = 1;
/** The scenarios the operator can force on one observed request path. */
export const LAB_SCENARIOS = ["passthrough", "empty200", "error500", "offline"];
/** Only these HTTP methods are ever mocked - reads. See §1.1 above. */
export const LAB_MOCKABLE_METHODS = ["GET", "HEAD"];
/** Every mocked response carries this header, so a fake is always visible. */
export const LAB_MOCK_HEADER = "x-lab-mock";
/** Ledger cap: observed paths, not requests - a section that polls one endpoint
 *  50 times still costs one row (the count lives on the row). */
export const LAB_MAX_LEDGER = 60;
/** What a path degrades to when the input cannot be parsed as a URL. */
export const LAB_PATH_FALLBACK = "/";

/** Scenario -> the response shape it forces. Kept data-only so the UI can render
 *  the same table it enforces (no second copy in the panel). */
const SCENARIO_STATUS = {
  empty200: 200,
  error500: 500,
};

/**
 * Cut ANY accepted fetch input down to a path-only ledger key.
 *
 * WHY path-only: the dashboard's every call rides a dash token in `?key=`
 * (src/lib/api.ts getKey() -> configUrl()). A ledger that kept the query string
 * would copy the operator's token into a lab report, into the DVR and into
 * whatever they paste it into - the exact F94 leak class the boundary sanitizer
 * and the DVR both cut. So: strip origin, query, hash. Absolute URLs
 * (http://host:7331/api/config?key=...) and relative ones (/api/config?key=...)
 * both land on "/api/config".
 */
export function normalizeRequestPath(input) {
  let raw = "";
  try {
    raw = typeof input === "string" ? input : String((input && input.url) || input || "");
  } catch {
    raw = "";
  }
  if (!raw) return LAB_PATH_FALLBACK;
  // Query/hash first (a token can live in either), then the origin.
  let s = raw;
  const q = s.indexOf("?");
  if (q >= 0) s = s.slice(0, q);
  const h = s.indexOf("#", 1); // index 1: a HashRouter path may legitimately start with "#"
  if (h >= 0) s = s.slice(0, h);
  try {
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(s)) s = new URL(s).pathname;
  } catch {
    /* not a parseable absolute URL: keep what the string gave us */
  }
  if (!s) return LAB_PATH_FALLBACK;
  if (s.charAt(0) !== "/") s = "/" + s;
  return s;
}

/** Uppercase, trimmed method. A missing method is GET, per the fetch spec. */
export function normalizeMethod(method) {
  const m = String(method == null ? "" : method).trim().toUpperCase();
  return m || "GET";
}

/** May a request with this method be mocked at all? (reads only) */
export function isMockableMethod(method) {
  return LAB_MOCKABLE_METHODS.indexOf(normalizeMethod(method)) >= 0;
}

/** A test-id-safe slug for a path ("/api/collector/run" -> "api-collector-run"). */
export function pathSlug(path) {
  const s = String(path == null ? "" : path)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s || "root";
}

/**
 * The lab INDEX path, derived from the registry's labRoutePattern. The registry
 * (F105) owns the pattern `"/lab/:featureId"`; this cuts the parameter off, so
 * "/lab" is never hand-written twice - if a future step renames the pattern,
 * the index route, the sidebar entry and the gate all move together.
 */
export function labIndexPath(pattern) {
  const p = String(pattern == null ? "" : pattern);
  const cut = p.replace(/\/:[^/]*$/, "");
  return cut || "/";
}

/** The forced scenario for a path, defaulting to passthrough (never a silent fake). */
export function scenarioFor(scenarios, path) {
  try {
    const want = scenarios && scenarios[path];
    return LAB_SCENARIOS.indexOf(want) >= 0 ? want : "passthrough";
  } catch {
    return "passthrough";
  }
}

/** The body a mocked response carries. Deliberately minimal: the label lives in
 *  the HEADER, so a body can never be mistaken for a real payload. */
export function mockBody(scenario) {
  if (scenario === "error500") return { error: "lab-mock", status: 500 };
  return {};
}

/**
 * [F106 §1.2] The decision for ONE request: mock it, reject it, or pass it through.
 *
 * Returns a plain object (never a Response): the caller (mockBackend.ts) turns it
 * into a fetch-shaped value, so this function stays executable in bare Node.
 *   { kind: "passthrough" | "response" | "network-error", method, path, scenario, ... }
 *
 * Passthrough is the default for EVERY reason except an explicit scenario:
 *  - a write method (never faked - §1.1),
 *  - no scenario set for the path (observe-then-force: the first request of a
 *    path always reaches the real backend, which is what makes the ledger an
 *    honest record of what the section actually asks for),
 *  - the explicit "passthrough" scenario.
 */
export function resolveMock(scenarios, method, url) {
  const m = normalizeMethod(method);
  const path = normalizeRequestPath(url);
  if (!isMockableMethod(m)) {
    return { kind: "passthrough", method: m, path, scenario: "passthrough", reason: "method" };
  }
  const scenario = scenarioFor(scenarios, path);
  if (scenario === "passthrough") {
    return { kind: "passthrough", method: m, path, scenario, reason: "scenario" };
  }
  if (scenario === "offline") {
    return { kind: "network-error", method: m, path, scenario, message: "lab-mock: offline (" + path + ")" };
  }
  return {
    kind: "response",
    method: m,
    path,
    scenario,
    status: SCENARIO_STATUS[scenario] || 200,
    statusText: scenario === "error500" ? "Internal Server Error" : "OK",
    body: mockBody(scenario),
  };
}

/**
 * Consolidated, BOUNDED ledger.
 *
 * One row per method+path (a polling section must not flood the panel), with an
 * occurrence count and the last kind/scenario seen. Ordered by first sighting, so
 * the panel reads like the section's actual startup sequence. Eviction is oldest
 * first, never random - determinism is what makes the vitest gate stable and the
 * copied report comparable between two runs.
 */
export function createLedger(max) {
  const cap = Number.isFinite(max) && max > 0 ? Math.floor(max) : LAB_MAX_LEDGER;
  const rows = [];
  let seq = 0;
  return {
    max: cap,
    record(row) {
      const method = normalizeMethod(row && row.method);
      const path = normalizeRequestPath(row && row.path);
      const kind = String((row && row.kind) || "passthrough");
      const scenario = String((row && row.scenario) || "passthrough");
      seq += 1;
      const hit = rows.find((r) => r.method === method && r.path === path);
      if (hit) {
        hit.count += 1;
        hit.lastSeq = seq;
        hit.kind = kind;
        hit.scenario = scenario;
        return hit;
      }
      const fresh = { method, path, kind, scenario, count: 1, firstSeq: seq, lastSeq: seq };
      rows.push(fresh);
      while (rows.length > cap) rows.shift();
      return fresh;
    },
    list() {
      return rows.map((r) => ({ ...r }));
    },
    size() {
      return rows.length;
    },
    seq() {
      return seq;
    },
    clear() {
      const n = rows.length;
      rows.length = 0;
      return n;
    },
  };
}

/** The pure half of the store's record(): merge one observation into a list. */
export function mergeLedgerRow(list, row, max) {
  const out = Array.isArray(list) ? list.map((r) => ({ ...r })) : [];
  const cap = Number.isFinite(max) && max > 0 ? Math.floor(max) : LAB_MAX_LEDGER;
  const method = normalizeMethod(row && row.method);
  const path = normalizeRequestPath(row && row.path);
  const kind = String((row && row.kind) || "passthrough");
  const scenario = String((row && row.scenario) || "passthrough");
  const nextSeq = out.reduce((n, r) => Math.max(n, Number(r.lastSeq) || 0), 0) + 1;
  const hit = out.find((r) => r.method === method && r.path === path);
  if (hit) {
    hit.count = (Number(hit.count) || 0) + 1;
    hit.lastSeq = nextSeq;
    hit.kind = kind;
    hit.scenario = scenario;
    return out;
  }
  out.push({ method, path, kind, scenario, count: 1, firstSeq: nextSeq, lastSeq: nextSeq });
  while (out.length > cap) out.shift();
  return out;
}

/**
 * Counts for the panel header (pure; no clock, no formatting).
 *
 * `mockedLastSeen` is deliberately named for what it is: a row only remembers the
 * LAST outcome of its method+path, so a path that was mocked once and then set
 * back to passthrough is not counted as still-fake. The panel shows `paths` and
 * `requests`; this third number exists so the gate can prove the attribution rule
 * instead of trusting the label.
 */
export function ledgerSummary(list) {
  const rows = Array.isArray(list) ? list : [];
  let requests = 0;
  let mockedLastSeen = 0;
  for (const r of rows) {
    requests += Number(r.count) || 0;
    if (r.kind && r.kind !== "passthrough") mockedLastSeen += Number(r.count) || 0;
  }
  return { paths: rows.length, requests, mockedLastSeen };
}

/**
 * The copyable lab report. `ts` is passed IN (this module has no clock), so the
 * same input always yields the same report - a diff between two reports is a
 * real behavioural diff, not a timestamp artifact.
 */
export function labReport(state) {
  const s = state || {};
  return {
    format: LAB_FORMAT,
    version: LAB_VERSION,
    ts: String(s.ts || ""),
    feature: String(s.feature || ""),
    route: normalizeRequestPath(s.route),
    build: String(s.build || ""),
    mocks: s.enabled === false ? "off" : "on",
    scenarios: { ...(s.scenarios || {}) },
    summary: ledgerSummary(s.ledger),
    ledger: Array.isArray(s.ledger) ? s.ledger.map((r) => ({ ...r })) : [],
    mounted: Array.isArray(s.mounted) ? s.mounted.slice() : [],
  };
}
