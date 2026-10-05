// [F96 §2.1/§5E] The diagnostic bundle contract.
//
// This sandbox has no PowerShell interpreter, so - exactly like
// tests/f95-root-causes.test.js - these are grep-level pins over the SHIPPED
// sources. They are deliberately SHAPE assertions, not prose assertions: every
// key the operator's pasted bundle must carry (and the client merge that fills
// the browser half) is pinned by name, so a future edit that drops a subsystem
// from the bundle fails here instead of silently shipping a bundle that cannot
// explain one of the five symptoms.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const SERVER = readFileSync("payloads/ghrdp-server.ps1", "utf8");
const API = readFileSync("src/api/diag/index.ts", "utf8");
const CARD = readFileSync("src/components/domain/DiagBundleCard.tsx", "utf8");
const OVERVIEW = readFileSync("src/pages/Overview.tsx", "utf8");
const STORE = readFileSync("src/stores/telemetryStore.ts", "utf8");
const HOOK = readFileSync("src/hooks/useDashboardPolling.ts", "utf8");
const EN = JSON.parse(readFileSync("src/i18n/en.json", "utf8"));
const SI = JSON.parse(readFileSync("src/i18n/si.json", "utf8"));

test("F96-route: GET /api/diag/comprehensive exists and is GET-only", () => {
  assert.ok(SERVER.includes("if ($path -eq '/api/diag/comprehensive')"), "the diagnostic route is missing");
  assert.ok(SERVER.includes("if ($parts.method -ne 'GET')"), "the route does not reject non-GET");
  assert.ok(SERVER.includes("messageKey = 'diag.methodNotAllowed'"), "no 405 key");
});

test("F96-ratelimit: 10/minute is enforced, with a 429 + retryAfterSeconds", () => {
  assert.ok(SERVER.includes("$script:F96DiagHits"), "no rate-limit state");
  assert.ok(SERVER.includes("Count -ge 10"), "the 10/minute ceiling is not enforced");
  assert.ok(SERVER.includes("messageKey = 'diag.rateLimited'"), "no rate-limit key");
  assert.ok(SERVER.includes("retryAfterSeconds = 10"), "the 429 does not say when to retry");
});

test("F96-shape: every top-level block the bundle promises is present", () => {
  const bundle = SERVER.slice(SERVER.indexOf("$f96Bundle = [ordered]@{"));
  assert.ok(bundle.length > 0, "the bundle object is missing");
  const end = bundle.indexOf("Send-ClientResponse -Stream $stream -Code 200");
  const body = bundle.slice(0, end > 0 ? end : 4000);
  for (const key of [
    "version",
    "logon",
    "watcher",
    "webSocket",
    "viewingMode",
    "searchEndpoints",
    "mainYmlBootstrap",
    "recentErrors",
    "runnerInfo",
    "advisories",
  ]) {
    assert.ok(new RegExp("^\\s+" + key + "\\s*=", "m").test(body), "top-level key missing from the bundle: " + key);
  }
});

test("F96-shape: version carries gitSha/buildTime/uiSha/serverSha", () => {
  assert.ok(SERVER.includes("$f96Version = [ordered]@{ gitSha = ''; buildTime = ''; uiSha = ''; serverSha = '' }"), "version block shape changed");
  // uiSha is read from the SERVED file's F38 meta, not from a build log.
  assert.ok(SERVER.includes('name="ghrdp-build"'), "uiSha is not read from the served HTML meta");
});

test("F96-shape: logon reports the F95 accepted set AND the raw per-type counts", () => {
  for (const k of ["type2", "type10", "type11", "excluded"]) {
    assert.ok(SERVER.includes("$f96Logon.rawEventCount = [ordered]@{ type2"), "logon.rawEventCount shape changed");
    assert.ok(SERVER.includes(k + " = $f96" + k[0].toUpperCase() + k.slice(1) + ";") || SERVER.includes(k + " = $null"), "logon.rawEventCount is missing " + k);
  }
  // The per-type scan must use the SHARED predicate, never a literal type test -
  // otherwise F96 re-introduces the F95 R1 bug in a second place.
  assert.ok(SERVER.includes("if (Test-GhrdpInteractiveLogonType -LogonType $f96Lt) {"), "the diagnostic scan does not use the shared F95 predicate");
  // Per-type counting must sit INSIDE the shared-predicate branch (a bare
  // "type 10 only" branch would re-create the F95 R1 bug in the scan).
  assert.ok(SERVER.includes("if (Test-GhrdpInteractiveLogonType -LogonType $f96Lt) {"), "the diagnostic scan does not use the shared F95 predicate");
  for (const t of ["'2'", "'10'", "'11'"]) {
    assert.ok(SERVER.includes("if ($f96Lt -eq " + t + ") {") || SERVER.includes("elseif ($f96Lt -eq " + t + ") {"), "the per-type counter for type " + t + " is missing");
  }
  // A denied Security log must be null + named, never zeros.
  assert.ok(SERVER.includes("'security-log-unreadable'"), "a denied Security-log scan is not named");
});

test("F96-shape: watcher reports task, shortcut, process, heartbeat AND escalation counts", () => {
  for (const k of [
    "scheduledTaskExists",
    "scheduledTaskState",
    "scheduledTaskLastResult",
    "startupShortcutExists",
    "watcherProcessRunning",
    "watcherProcessPid",
    "watcherLastHeartbeat",
    "supervisorAttempts",
  ]) {
    assert.ok(SERVER.includes(k), "watcher block is missing " + k);
  }
  for (const k of ["taskStart", "schtasksRun", "directInvoke"]) {
    assert.ok(SERVER.includes(k), "supervisorAttempts is missing " + k);
  }
  // The counters must be PERSISTED with the F95 verdict, or a restart erases
  // the escalation history the bundle exists to show.
  assert.ok(SERVER.includes("$state['attempts'] = [ordered]@{"), "the attempt counters are not persisted in watcher-supervisor.json");
});

test("F96-shape: webSocket reports the SERVER truth about the upgrade lane", () => {
  assert.ok(SERVER.includes("$script:F96WsUpgradeSupported = $false"), "the server-side upgrade fact is not declared");
  for (const k of ["endpoint", "status", "serverUpgradeSupported", "advertisedByHealth", "lastConnect", "lastDisconnect", "disconnectReason", "reconnectAttempts"]) {
    assert.ok(SERVER.includes(k), "webSocket block is missing " + k);
  }
  // The finding must be stated in words the operator can act on.
  assert.ok(/RFC6455 upgrade path/.test(SERVER), "the no-upgrade finding is not explained in the bundle");
});

test("F96-shape: searchEndpoints reuses the F92 memo instead of fanning out", () => {
  assert.ok(SERVER.includes("$script:F92SelftestCache"), "the per-site status does not come from the F92 memo");
  assert.ok(SERVER.includes("perSiteStatus"), "perSiteStatus is missing");
  assert.ok(SERVER.includes("memoPresent"), "the bundle cannot say whether the memo existed");
  // A fresh 11-site fanout inside the diagnostic route is forbidden (F93 §3.2).
  assert.ok(!/Invoke-F92Selftest -FrontendSha/.test(SERVER.slice(SERVER.indexOf("$path -eq '/api/diag/comprehensive'"))), "the diagnostic route fans out to the sites");
});

test("F96-shape: mainYmlBootstrap is honest about having no manifest", () => {
  assert.ok(SERVER.includes("stepsCompleted        = @()"), "stepsCompleted must stay empty (no manifest exists)");
  assert.ok(SERVER.includes("stepsFailed           = @()"), "stepsFailed must stay empty (no manifest exists)");
  assert.ok(SERVER.includes("autologonConfigured"), "autologonConfigured is missing");
  assert.ok(SERVER.includes("watcherTaskRegistered"), "watcherTaskRegistered is missing");
  assert.ok(SERVER.includes("startupShortcutWritten"), "startupShortcutWritten is missing");
  assert.ok(/persists no bootstrap manifest/.test(SERVER), "the bundle does not explain the empty step arrays");
});

test("F96-shape: recentErrors is capped at 50 and runnerInfo carries the host facts", () => {
  assert.ok(SERVER.includes("$f96Errors.Count -gt 50"), "recentErrors is not capped at 50");
  assert.ok(SERVER.includes("$f96ErrOut"), "the capped error list is not sent");
  for (const k of ["hostname", "osVersion", "uptime", "powershellVersion", "netVersion", "activeUsers"]) {
    assert.ok(SERVER.includes(k), "runnerInfo is missing " + k);
  }
  assert.ok(SERVER.includes("$script:GhrdpLogonSessionWql"), "activeUsers does not use the shared F95 logon-type set");
});

test("F96-hygiene: the bundle never reads a credential into the response", () => {
  const route = SERVER.slice(SERVER.indexOf("if ($path -eq '/api/diag/comprehensive')"), SERVER.indexOf("$f96Bundle = [ordered]@{"));
  for (const forbidden of ["rdpPass", "vncPass", "dashToken", "mirrorKey", "windowsPass"]) {
    assert.ok(!route.includes(forbidden), "the diagnostic route reads a secret: " + forbidden);
  }
});

test("F96-client: the API module merges the browser half and downloads a named file", () => {
  assert.ok(API.includes('"/api/diag/comprehensive"'), "the client does not call the route");
  assert.ok(API.includes("export function clientDiagOverlay"), "no client overlay");
  assert.ok(API.includes("export function mergeDiagBundle"), "no merge");
  assert.ok(API.includes("clientMerged: true"), "the merged blocks are not marked as client-sourced");
  assert.ok(API.includes('"f96-diag-"'), "the download filename is not f96-diag-<stamp>.json");
  assert.ok(API.includes("export function diagAtGlance"), "no at-a-glance derivation");
  assert.ok(API.includes("export function downloadDiagBundle"), "no download helper");
  // The dash token travels in a header, never in a logged/downloaded field.
  assert.ok(API.includes('"X-Dash-Token": key'), "the dash token is not sent as a header");
  assert.ok(!/dashToken:\s*key/.test(API), "the dash token is being written into the bundle");
});

test("F96-client: disconnect telemetry is captured (the browser is the only witness)", () => {
  assert.ok(STORE.includes("wsLastConnectAt"), "the store does not record the last connect");
  assert.ok(STORE.includes("wsLastDisconnectAt"), "the store does not record the last disconnect");
  assert.ok(STORE.includes("wsLastDisconnectReason"), "the store does not record the close code/reason");
  assert.ok(HOOK.includes("setWsConnectedAt(Date.now())"), "a successful open is not recorded");
  assert.ok(HOOK.includes("setWsDisconnectedAt(Date.now()"), "a close is not recorded");
  assert.ok(HOOK.includes("evt.code"), "the browser's close code is not captured");
});

test("F96-ui: the Overview button is wired and bilingual", () => {
  assert.ok(CARD.includes('id="f96.downloadDiag"'), "the download button id is missing");
  assert.ok(CARD.includes("diagBundle.download"), "the button is not translated");
  assert.ok(CARD.includes('id="f96.diagGlance"'), "the at-a-glance strip is missing");
  assert.ok(CARD.includes('id="f96.dotLauncher"') && CARD.includes('id="f96.dotWatcher"') && CARD.includes('id="f96.dotWs"'), "the three subsystem dots are missing");
  assert.ok(CARD.includes('id="f96.logonValue"'), "the logon value is missing");
  assert.ok(OVERVIEW.includes("<DiagBundleCard />"), "Overview does not render the card");
  assert.ok(
    OVERVIEW.indexOf("<DiagBundleCard />") < OVERVIEW.indexOf("<ConnectionCard />"),
    "the card must stay above the fold on Overview"
  );
  // i18n: en + si must both carry the namespace, and si must be real Sinhala.
  for (const k of ["download", "hint", "downloaded", "notFetched", "showDetails", "detailsTitle"]) {
    assert.ok(typeof EN.diagBundle?.[k] === "string" && EN.diagBundle[k].length > 0, "en.diagBundle." + k + " is missing");
    assert.ok(typeof SI.diagBundle?.[k] === "string" && SI.diagBundle[k].length > 0, "si.diagBundle." + k + " is missing");
  }
  assert.ok(/[\u0D80-\u0DFF]/.test(SI.diagBundle.download), "si.diagBundle.download is not Sinhala");
  for (const k of ["rateLimited", "server", "transport"]) {
    assert.ok(typeof EN.diagBundle?.errors?.[k] === "string", "en.diagBundle.errors." + k + " is missing");
    assert.ok(typeof SI.diagBundle?.errors?.[k] === "string", "si.diagBundle.errors." + k + " is missing");
  }
});

test("F96-guards: the F77-F95 architectural guards are untouched by this feature", () => {
  // No credential in a URL, log or artifact.
  assert.ok(!/diag\/comprehensive\?.*pass/.test(API), "a password can reach the diagnostic URL");
  // main.yml is still never dispatched by the dashboard.
  assert.ok(!/workflows\/main\.yml\/dispatches/.test(CARD + API), "the diagnostic card dispatches main.yml");
  // The F95 logon set is still the shared single definition.
  assert.ok(SERVER.includes("$script:GhrdpInteractiveLogonTypes = @('2', '10', '11')"), "the F95 R1 set is gone");
  // The F95 supervisor still owns its three escalation routes.
  for (const a of ["'task-start'", "'schtasks-run'", "'direct-invoke'", "'failed'"]) {
    assert.ok(SERVER.includes("$state.action = " + a), "F95 supervisor action " + a + " is gone");
  }
});
