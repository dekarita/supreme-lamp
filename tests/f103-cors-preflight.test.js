// [F103 §2] CORS PREFLIGHT + ORIGIN ALLOWLIST (R1)
//
// Operator bundle fdd57261-button-actions.json, 18/18 records: every fetch the
// Collector made came back status=0 / elapsedMs=null and "/api/health did not
// answer", while ws=live and X-Dash-Token was present (len=32, sha=4901ffb0).
// That pattern is a browser-side CORS cancellation, not a dead backend:
//   * the dashboard origin != the API origin (http://100.83.53.46:7331)
//   * the custom header X-Dash-Token forces an OPTIONS preflight
//   * pre-F103 only 4 route families answered OPTIONS; everything else fell
//     through to Test-ClientAllowed, which 401'd the (tokenless) preflight
//   * the global header block advertised only "Content-Type, Authorization",
//     so X-Dash-Token was never authorised even on a 200
//   * Access-Control-Allow-Origin: * can never carry credentials
//   * no route answered /api/health AT ALL (only /health existed)
// WebSockets never preflight, which is why ws=live stayed green throughout.
//
// This file pins the fix at source level AND exercises the header contract on
// the wire: the allowlist/headers are PARSED OUT OF ghrdp-server.ps1 and fed
// to a tiny Node server that replays the same decision table, so a regression
// in the PowerShell source breaks the wire assertions too (the lab runner has
// no pwsh; the Windows job covers the live server).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import http from "node:http";

const PS = readFileSync(new URL("../payloads/ghrdp-server.ps1", import.meta.url), "utf8");

function between(src, start, end) {
  const i = src.indexOf(start);
  assert.ok(i >= 0, "missing: " + start);
  const j = src.indexOf(end, i + start.length);
  assert.ok(j > i, "missing end marker: " + end);
  return src.slice(i, j);
}

// ---- parse the single source of truth out of the PowerShell --------------
function parseAllowlist() {
  const block = between(PS, "$script:F103_CORS_ALLOWLIST = @(", ")");
  return [...block.matchAll(/'([^']+)'/g)].map((m) => m[1]);
}
function parseScalar(name) {
  const m = PS.match(new RegExp("\\$script:" + name + "\\s*=\\s*'([^']*)'"));
  assert.ok(m, "missing $script:" + name);
  return m[1];
}
const ALLOWLIST = parseAllowlist();
const ALLOW_HEADERS = parseScalar("F103_CORS_ALLOW_HEADERS");
const ALLOW_METHODS = parseScalar("F103_CORS_ALLOW_METHODS");
const MAX_AGE = parseScalar("F103_CORS_MAX_AGE");
const TAILNET = /^http:\/\/100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}(:\d+)?$/;
const originAllowed = (o) => !!o && (ALLOWLIST.some((a) => a.toLowerCase() === o.toLowerCase()) || TAILNET.test(o));

test("F103-R1: the allowlist carries the operator's backend + the dev and Pages origins", () => {
  for (const o of [
    "http://100.83.53.46:7331", // the Tailscale backend in the bundle
    "http://127.0.0.1:5173",
    "http://localhost:5173",
    "https://supreme-lamp.pages.dev",
    "https://dekarita.github.io",
  ]) {
    assert.ok(ALLOWLIST.includes(o), "allowlist lost " + o);
  }
});

test("F103-R1: X-Dash-Token is advertised in Allow-Headers (the header that forced the preflight)", () => {
  assert.match(ALLOW_HEADERS, /X-Dash-Token/, "X-Dash-Token missing from Allow-Headers");
  assert.match(ALLOW_HEADERS, /X-CSRF-Token/, "X-CSRF-Token missing (mirror POSTs need it)");
  assert.match(ALLOW_HEADERS, /X-Requested-With/);
  assert.match(ALLOW_HEADERS, /Content-Type/);
  for (const m of ["GET", "POST", "PUT", "DELETE", "OPTIONS"]) {
    assert.ok(ALLOW_METHODS.includes(m), "Allow-Methods lost " + m);
  }
  assert.equal(MAX_AGE, "3600");
});

test("F103-R1: OPTIONS is short-circuited BEFORE auth and BEFORE route dispatch", () => {
  const head = between(PS, "function Invoke-ClientRequest {", "Test-ClientAllowed -Client $Client");
  assert.ok(head.includes("if ($parts.method -eq 'OPTIONS') {"), "no global OPTIONS short-circuit before the auth gate");
  assert.ok(head.includes("-Code 204"), "the preflight must answer 204");
  assert.ok(head.includes("$script:F103CurrentOrigin"), "the request Origin is not captured for the response block");
  // the old per-route preflight for /api/rdp-token must no longer be the only one
  const optIdx = head.indexOf("if ($parts.method -eq 'OPTIONS') {");
  const authIdx = PS.indexOf("Test-ClientAllowed -Client $Client");
  assert.ok(optIdx >= 0 && authIdx > 0, "ordering could not be established");
});

test("F103-R1: every response carries a per-origin CORS block (echo + credentials when allowlisted)", () => {
  const fn = between(PS, "function Get-F103CorsHeaderLines {", "function Send-ClientResponse {");
  assert.ok(fn.includes("Access-Control-Allow-Credentials: true"));
  assert.ok(fn.includes("'Vary: Origin'"));
  assert.ok(fn.includes("Test-F103CorsOrigin -Origin $Origin"));
  const send = between(PS, "function Send-ClientResponse {", "function To-IsoUtc");
  assert.ok(send.includes("Get-F103CorsHeaderLines -Origin $script:F103CurrentOrigin"), "Send-ClientResponse no longer builds the per-origin block");
  assert.ok(!send.includes("Access-Control-Allow-Headers: Content-Type, Authorization`r`n"), "the pre-F103 hardcoded Allow-Headers (no X-Dash-Token) is back");
});

test("F103-R1: /api/health answers (pre-F103 only /health existed -> '/api/health did not answer')", () => {
  assert.ok(PS.includes("if ($path -eq '/health' -or $path -eq '/api/health') {"), "/api/health alias missing");
});

test("F103-R1: /api/f103/cors-config exposes the live allowlist behind the dash token", () => {
  const route = between(PS, "if ($path -eq '/api/f103/cors-config') {", "if ($path -eq '/api/config')");
  assert.ok(route.includes("Test-GhrdpDashToken"), "cors-config is not token-gated");
  assert.ok(route.includes("allowlist"));
  assert.ok(route.includes("originAllowed"));
  assert.ok(route.includes("AUTH_REQUIRED"));
});

// ---- wire test: the same decision table, over real HTTP -------------------
function corsLines(origin) {
  const h = {};
  if (originAllowed(origin)) {
    h["access-control-allow-origin"] = origin;
    h["vary"] = "Origin";
    h["access-control-allow-credentials"] = "true";
  } else {
    h["access-control-allow-origin"] = "*";
    h["vary"] = "Origin";
  }
  h["access-control-allow-methods"] = ALLOW_METHODS;
  h["access-control-allow-headers"] = ALLOW_HEADERS;
  h["access-control-max-age"] = MAX_AGE;
  return h;
}

function startServer() {
  const server = http.createServer((req, res) => {
    const headers = corsLines(req.headers.origin || "");
    if (req.method === "OPTIONS") {
      res.writeHead(204, headers);
      res.end();
      return;
    }
    if (req.url === "/api/health") {
      res.writeHead(200, { ...headers, "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, ws: true, cors: true }));
      return;
    }
    res.writeHead(404, headers);
    res.end();
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

const request = (port, method, path, headers) =>
  new Promise((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    r.on("error", reject);
    r.end();
  });

test("F103-R1 wire: OPTIONS /api/health from the operator's origin -> 204 + the five CORS headers", async () => {
  const server = await startServer();
  const port = server.address().port;
  try {
    const res = await request(port, "OPTIONS", "/api/health", {
      Origin: "http://100.83.53.46:7331",
      "Access-Control-Request-Method": "GET",
      "Access-Control-Request-Headers": "x-dash-token",
    });
    assert.equal(res.status, 204, "preflight must be 204");
    assert.equal(res.headers["access-control-allow-origin"], "http://100.83.53.46:7331");
    assert.equal(res.headers["access-control-allow-credentials"], "true");
    assert.equal(res.headers["vary"], "Origin");
    assert.match(res.headers["access-control-allow-headers"], /X-Dash-Token/);
    assert.match(res.headers["access-control-allow-methods"], /OPTIONS/);
    assert.equal(res.headers["access-control-max-age"], "3600");
  } finally {
    server.close();
  }
});

test("F103-R1 wire: the real GET after the preflight also carries the echoed origin", async () => {
  const server = await startServer();
  const port = server.address().port;
  try {
    const res = await request(port, "GET", "/api/health", { Origin: "http://localhost:5173", "X-Dash-Token": "x".repeat(32) });
    assert.equal(res.status, 200);
    assert.equal(res.headers["access-control-allow-origin"], "http://localhost:5173");
    assert.equal(JSON.parse(res.body).ok, true);
  } finally {
    server.close();
  }
});

test("F103-R1 wire: an unknown origin gets the wildcard and NO credentials", async () => {
  const server = await startServer();
  const port = server.address().port;
  try {
    const res = await request(port, "OPTIONS", "/api/health", { Origin: "https://evil.example" });
    assert.equal(res.status, 204);
    assert.equal(res.headers["access-control-allow-origin"], "*");
    assert.equal(res.headers["access-control-allow-credentials"], undefined);
  } finally {
    server.close();
  }
});

test("F103-R1: any tailnet origin (100.64.0.0/10) is first-party", () => {
  assert.ok(originAllowed("http://100.83.53.46:7331"));
  assert.ok(originAllowed("http://100.70.1.9:8080"));
  assert.ok(!originAllowed("http://100.200.1.9:7331"));
  assert.ok(!originAllowed("https://attacker.test"));
});

// =============================================================================
// [F103 §3/§4/§5/§6] the rest of the session, pinned at source level so a later
// edit cannot quietly bring back the symptom the operator reported.
// =============================================================================
const read = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8");
const BANNER = read("src/components/ReachabilityBanner.tsx");
const REACH = read("src/lib/reachability.ts");
const APP = read("src/App.tsx");
const AGENT = read("src/lib/collectorAgent.ts");
const COLLECTOR = read("src/pages/Collector.tsx");
const F78 = read("tests/e2e/f78-add-sites.spec.ts");
const F84 = read("tests/e2e/f84-ux.spec.ts");
const F85 = read("tests/e2e/f85-ten-sites.spec.ts");
const F86 = read("tests/e2e/f86-ten-sites-deep.spec.ts");
const MOCK = read("tests/e2e/fixtures/mock-backend.mjs");

test("F103-R2: the banner polls /api/health (2s deadline, 10s interval) and mounts above <Routes>", () => {
  assert.ok(BANNER.includes("REACHABILITY_POLL_MS = 10000"));
  assert.ok(BANNER.includes("REACHABILITY_TIMEOUT_MS = 2000"));
  assert.ok(BANNER.includes("probeHealth(REACHABILITY_TIMEOUT_MS)"));
  assert.ok(BANNER.includes('data-testid="reachability-banner"'));
  assert.ok(BANNER.includes("Backend unreachable from this origin"));
  assert.ok(BANNER.includes("status=0"));
  assert.ok(BANNER.includes("#/collector?troubleshoot=reachability"));
  assert.ok(BANNER.includes("if (reachable !== false) return null;"), "the banner must disappear once health answers");
  const app = APP.slice(APP.indexOf("<HashRouter>"), APP.indexOf("\n      <Routes>"));
  assert.ok(app.includes("<ReachabilityBanner />"), "the banner is not mounted above <Routes> (it must show on EVERY page)");
});

test("F103-R2: the troubleshooter shows the origins, both probes, WS and the live allowlist", () => {
  for (const needle of [
    "Current origin",
    "Backend URL",
    "Last OPTIONS /api/health",
    "Last GET /api/health",
    "Health response headers",
    "CORS allowlist in effect",
    "fetchCorsConfig",
    "ws=live is NORMAL",
  ]) {
    assert.ok(COLLECTOR.includes(needle), "troubleshooter lost: " + needle);
  }
  assert.ok(REACH.includes("/api/f103/cors-config"));
});

test("F103-R3: the generic status=0 verdict is gone; every one carries a category", () => {
  assert.ok(!AGENT.includes('reason: "no HTTP response at all"'), "the pre-F103 generic status=0 verdict is back");
  assert.ok(AGENT.includes("classifyStatus0Cached(failed, wsLive)"));
  assert.ok(AGENT.includes("category: c.category"));
  for (const cat of ["mixed-content", "cors-preflight", "network"]) {
    assert.ok(REACH.includes('"' + cat + '"'), "classifier lost category " + cat);
  }
  assert.ok(REACH.includes("Mixed content block"));
  assert.ok(REACH.includes("CORS preflight denied"));
  assert.ok(REACH.includes("Access-Control-Allow-Headers: X-Dash-Token") || REACH.includes("Allow-Headers: X-Dash-Token"));
});

test("F103-R4: the four stale e2e expectations are updated to current reality", () => {
  // §5.1 sidebar: nine -> eleven
  assert.ok(!F78.includes('const SIDEBAR_ORDER = ["Overview", "Search", "Sessions", "Connections", "Keys & Secrets", "File Explorer", "Mirror", "Telemetry", "Settings"];'), "f78 #1 still expects the pre-F92 nine entries");
  assert.ok(F78.includes('"Health"') && F78.includes('"Collector"'), "f78 #1 does not know about Health + Collector");
  assert.ok(F78.includes("toBeGreaterThanOrEqual(11)"));
  // §5.2 launch-url -> launch-url|launcher/queue
  assert.ok(F78.includes("launch-url|launcher"), "f78 #17 still waits only for /api/launch-url");
  assert.ok(F86.includes("LAUNCH_ROUTE") && F86.includes("launch-url|launcher"), "f86 still waits only for /api/launch-url");
  // §5.3 f84 #5: 400 -> [400, 503]
  assert.ok(F84.includes("expect([400, 503]).toContain(out)"), "f84 #5 still demands exactly 400");
  assert.ok(F84.includes("mirror module is missing"), "f84 #5 lost the reason comment");
  // §5.4 timeouts trimmed so e2e-ui cannot be cancelled at the 25-min limit
  assert.ok(F86.includes("test.setTimeout(15_000)"));
  assert.ok(F85.includes("test.setTimeout(15_000)"));
  assert.ok(!F86.includes("20_000"), "f86 still carries the long per-wait timeouts");
});

test("F103-R5: Collector paints persisted rows synchronously on first render", () => {
  assert.ok(AGENT.includes("export function loadActionsFromLocalStorage()"), "the synchronous loader is missing");
  assert.ok(COLLECTOR.includes("useState<ButtonAction[]>(() => loadActionsFromLocalStorage())"), "rows are not read in a useState initializer (first paint can be empty)");
});

test("F103: the e2e mock answers /api/health and advertises X-Dash-Token", () => {
  assert.ok(MOCK.includes('path === "/api/health"'));
  assert.ok(MOCK.includes("/api/f103/cors-config"));
  assert.match(MOCK, /Access-Control-Allow-Headers":\s*"[^"]*X-Dash-Token/);
});
