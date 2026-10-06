// [F99 §3] THE DIAGNOSIS COLLECTOR - server routes, engine contract, page wiring.
//
// The operator's requirement was explicit: ONE button that exercises EVERY
// dashboard feature end to end, takes as long as it needs, and reports
// per-feature pass/fail with the diagnostics behind each verdict. That means
// the run cannot live inside the server's single-threaded accept loop, the
// result cannot be a screenshot, and a missing script must be a NAMED 503
// instead of a silent no-op - all three are pinned below.
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const SERVER = fs.readFileSync("payloads/ghrdp-server.ps1", "utf8");
const COLLECTOR = fs.readFileSync("payloads/ghrdp-collector.ps1", "utf8");
const MAIN = fs.readFileSync(".github/workflows/main.yml", "utf8");
const PAGE = fs.readFileSync("src/pages/Collector.tsx", "utf8");
const APP = fs.readFileSync("src/App.tsx", "utf8");
const SHELL = fs.readFileSync("src/components/layout/AppShell.tsx", "utf8");
const EN = JSON.parse(fs.readFileSync("src/i18n/en.json", "utf8"));
const SI = JSON.parse(fs.readFileSync("src/i18n/si.json", "utf8"));

test("F99-C1: the four routes exist, are token gated and never echo the token", () => {
  for (const r of ["/api/collector/run", "/api/collector/status", "/api/collector/report", "/api/collector/report.md"]) {
    assert.ok(SERVER.includes("'" + r + "'"), "route missing: " + r);
  }
  const i = SERVER.indexOf("if ($path -eq '/api/collector/run'");
  const block = SERVER.slice(i, SERVER.indexOf("# [F96 §2.1] GET /api/diag/comprehensive", i));
  assert.ok(block.includes("Test-GhrdpDashToken -Presented $f99cPresented"), "the collector routes do not use the shared F99 validator");
  assert.ok(block.includes("-Code 401"), "an unauthenticated call must answer 401");
  assert.ok(!/headers\['x-dash-token'\]\)/.test(block.replace("$f99cPresented = [string]$parts.headers['x-dash-token']", "")), "the token value leaks into a response");
});

test("F99-C2: the run is a CHILD process, hidden, and the token stays out of argv", () => {
  const i = SERVER.indexOf("if ($path -eq '/api/collector/run'");
  const block = SERVER.slice(i, i + 6000);
  // F11-5.3: every Start-Process line in this file must carry the hidden flag
  // ON THE SAME LINE, so the spawn is deliberately single-line.
  const spawn = block.split("\n").find((l) => l.includes("Start-Process") && l.includes("ghrdp-collector.ps1") === false && l.includes("$f99cScript"));
  assert.ok(spawn, "the collector spawn line is missing");
  assert.ok(/WindowStyle/.test(spawn) && /Hidden/.test(spawn), "the spawn is not hidden");
  assert.ok(!/\$f99cPresented|\$script:Token|\$f99cTok/.test(spawn), "a credential is passed on the child's command line");
  // The engine reads the token from disk itself.
  assert.ok(COLLECTOR.includes("Join-Path $Root 'dash-token.txt'"), "the engine does not read the token from disk");
  assert.ok(COLLECTOR.includes("$hdr['X-Dash-Token'] = $script:Token"), "the engine does not present the token as a header");
  assert.ok(!/dash-token\.txt\?|\?key=\$script:Token/.test(COLLECTOR), "the engine puts the token in a URL");
});

test("F99-C3: rate limit + in-flight guard + NAMED failure codes", () => {
  const i = SERVER.indexOf("if ($path -eq '/api/collector/run'");
  const block = SERVER.slice(i, i + 7000);
  assert.ok(block.includes("COLLECTOR_MISSING"), "a missing script must answer COLLECTOR_MISSING");
  assert.ok(block.includes("expectedPath = $f99cScript"), "the 503 must name the path it wanted");
  assert.ok(block.includes("RUN_IN_PROGRESS"), "a live run must answer RUN_IN_PROGRESS");
  assert.ok(block.includes("RATE_LIMITED") && block.includes("retryAfterSeconds"), "the 5-minute limit must name the retry delay");
  assert.ok(/TotalSeconds -lt 300/.test(block), "the 1-per-5-minutes window is missing");
  assert.ok(block.includes("-Code 405"), "a non-POST must answer 405");
  assert.ok(block.includes("-Code 202"), "a successful start must answer 202");
  assert.ok(block.includes("expectedDurationSec = '60-120'"), "the accepted duration is not published");
  assert.ok(block.includes("statusPath = '/api/collector/status'"), "the status path is not published");
});

test("F99-C4: the engine writes progress AFTER EACH feature and a final report pair", () => {
  assert.ok(COLLECTOR.includes("param(\n    [string]$Base = 'http://127.0.0.1:7331',"), "the engine does not take -Base");
  assert.ok(COLLECTOR.includes("[string]$Root = 'C:\\ghrdp',"), "the engine does not take -Root");
  assert.ok(COLLECTOR.includes("[string]$RunId = ''"), "the engine does not take -RunId");
  assert.ok(COLLECTOR.includes("collector-progress.json"), "the progress file is missing");
  assert.ok(COLLECTOR.includes("collector-report.json"), "the JSON report file is missing");
  assert.ok(COLLECTOR.includes("collector-report.md"), "the Markdown report file is missing");
  assert.ok(/Write-CollectorProgress 'running'/.test(COLLECTOR), "progress is not written per feature");
  // The progress document carries the exact keys the status route republishes.
  for (const k of ["runId", "state", "startedAt", "updatedAt", "durationSec", "base", "order", "features", "summary", "advisories"]) {
    assert.ok(COLLECTOR.includes(k + " "), "the progress document lacks " + k);
  }
  // Per-feature row shape the page renders.
  for (const k of ["name", "status", "detail", "issue", "ms", "at", "data"]) {
    assert.ok(new RegExp("\\b" + k + "\\s*=").test(COLLECTOR), "the feature row lacks " + k);
  }
  assert.ok(COLLECTOR.includes("totalFeatures") && COLLECTOR.includes("criticalIssues") && COLLECTOR.includes("recommendations"), "the summary contract is incomplete");
  // A throwing probe is itself a fail row - the run never aborts.
  assert.ok(/Add-Feature '\w+' 'fail' \$null \('probe threw: '/.test(COLLECTOR), "a throwing probe is not recorded as a fail row");
});

test("F99-C5: every feature the operator asked for is probed FOR REAL", () => {
  const probes = [
    ["launcher", "/api/launcher/health"],
    ["watcher", "/api/diag"],
    ["mirrorApi", "/api/mirror/status"],
    ["logon", "/api/native-status"],
    ["telemetry", "/api/progress"],
    ["healthEndpoint", "/health"],
    ["versionFeatures", "/api/version"],
  ];
  for (const [feature, path] of probes) {
    assert.ok(COLLECTOR.includes("Add-Feature '" + feature + "'"), "no probe for feature " + feature);
    assert.ok(COLLECTOR.includes("'" + path + "'"), "feature " + feature + " does not hit " + path);
  }
  // The websocket probe is a REAL RFC 6455 handshake, not a HEAD request.
  assert.ok(COLLECTOR.includes("258EAFA5-E914-47DA-95CA-C5AB0DC85B11"), "the websocket probe does not verify Sec-WebSocket-Accept");
  assert.ok(COLLECTOR.includes("GET /ws$q HTTP/1.1"), "the websocket probe does not speak HTTP/1.1 upgrade");
  assert.ok(COLLECTOR.includes("$ws.handshakeOk = ($ws.status -eq 101)"), "the websocket probe does not require a 101");
  // A masked hello frame must be sent (browsers always mask).
  assert.ok(/\$masked\[\$i\] = \[byte\]\(\$hello\[\$i\] -bxor \$mask\[\$i % 4\]\)/.test(COLLECTOR), "the hello frame is not masked");
  // A real download + a real search + the lab inspector.
  assert.ok(COLLECTOR.includes("'{\"url\":\"https://www.gutenberg.org/robots.txt\",\"download\":true}'"), "downloadToRdp is not a real download");
  assert.ok(COLLECTOR.includes("'{\"query\":\"open source audiobooks\",\"scope\":\"federated\",\"limit\":10}'"), "the search probe is not a real federated search");
  // The 11 export sites, from the runner's own network.
  assert.ok(/awesome\.re/.test(COLLECTOR), "the site fan-out is missing (export sites)");
  assert.ok(COLLECTOR.includes("f88-site-hints.json"), "the site fan-out ignores the shipped hints");
  // The viewing mode must NOT be invented server-side.
  assert.ok(COLLECTOR.includes("CLIENT_ONLY"), "the viewing-mode probe claims a browser fact");
});

test("F99-C6: the three collector files are staged onto the box at dispatch", () => {
  for (const f of ["scripts/f60-bootstrap.ps1", "scripts/f60-stage-and-start.ps1"]) {
    const s = fs.readFileSync(f, "utf8");
    assert.ok(s.includes("'payloads/ghrdp-collector.ps1'"), f + " does not stage the collector");
  }
  assert.ok(MAIN.includes("cp \"$GITHUB_WORKSPACE/payloads/ghrdp-collector.ps1\""), "main.yml does not stage the collector into RUNNER_TEMP");
  assert.ok(/ghrdp-collector\.ps1' \+ \[char\]|Copy-Item -LiteralPath \$stageCollector -Destination \$collectorScript/.test(MAIN), "main.yml does not deploy the collector to C:\\ghrdp");
  assert.ok(MAIN.includes("$collectorScript = 'C:\\ghrdp\\ghrdp-collector.ps1'"), "the deploy target is not the server's root");
  assert.ok(MAIN.includes("'payloads/ghrdp-collector.ps1')"), "the F59 parse-check list does not include the collector");
});

test("F99-C7: the page is wired - route, sidebar (after Health), i18n en+si, downloads", () => {
  assert.ok(APP.includes('import CollectorPage from "@/pages/Collector"'), "App.tsx does not import the page");
  assert.ok(APP.includes('<Route path="/collector" element={<CollectorPage />} />'), "the /collector route is missing");
  const healthNav = SHELL.indexOf('to: "/health"');
  const colNav = SHELL.indexOf('to: "/collector"');
  const settingsNav = SHELL.indexOf('to: "/settings"');
  assert.ok(healthNav > 0 && colNav > healthNav && colNav < settingsNav, "the sidebar entry must sit right after Health");
  assert.ok(SHELL.includes('id: "f99.collector.nav"'), "the sidebar entry has no stable id");
  for (const k of ["collector.run", "collector.neverRun", "collector.issue", "collector.errors.auth", "collector.errors.missing", "collector.errors.rate_limited", "collector.feature.webSocket"]) {
    const parts = k.split(".");
    let d = EN;
    for (const p of parts) d = d ? d[p] : undefined;
    assert.ok(typeof d === "string" && d.length > 0, "en.json lacks " + k);
    let s = SI;
    for (const p of parts) s = s ? s[p] : undefined;
    assert.ok(typeof s === "string" && s.length > 0, "si.json lacks " + k);
  }
  for (const t of ["collector-run", "collector-state", "collector-summary", "collector-features", "collector-download-json", "collector-download-md"]) {
    assert.ok(PAGE.includes('data-testid="' + t + '"'), "the page lacks data-testid=" + t);
  }
  assert.ok(PAGE.includes('POST') || PAGE.includes('method: "POST"'), "the page never POSTs the run");
  assert.ok(PAGE.includes("/api/collector/run") && PAGE.includes("/api/collector/status"), "the page does not call the collector routes");
  assert.ok(PAGE.includes("/api/collector/report.md"), "the Markdown download is missing");
  assert.ok(PAGE.includes("issueUrl"), "red rows do not link to their Issue");
  assert.ok(PAGE.includes("60-120"), "the button does not state the accepted duration");
});
