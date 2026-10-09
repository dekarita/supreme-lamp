// [F101] THE FOUR RESIDUAL BACKEND BUGS FROM THE F99 DIAGNOSTIC BUNDLE
// (2026-10-06T16:02:46Z), pinned at source level the same way every other
// server-side fix in this repo is pinned: the tests read the SHIPPED files and
// assert the exact contract, so a later edit that reverts one of the four fixes
// fails here instead of showing up as another operator bundle.
//
//   N1 /api/mirror/status answered 503 "module missing" 7+ times
//   N2 add-site recorded "ERR: addSite.authMissing" (48559ms)
//   N3 search refused with 403 (client-audit.log 15:59:23)
//   N4 websocket went idle, close=1005 (no status), reconnect stopped
//
// Tracking issue: #157.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

const SERVER = readFileSync(new URL("../payloads/ghrdp-server.ps1", import.meta.url), "utf8");
const HOOK = readFileSync(new URL("../src/hooks/useDashboardPolling.ts", import.meta.url), "utf8");
const STORE = readFileSync(new URL("../src/stores/telemetryStore.ts", import.meta.url), "utf8");
const MIRROR_LIB = readFileSync(new URL("../src/lib/mirror.ts", import.meta.url), "utf8");
const MIRROR_CARD = readFileSync(new URL("../src/components/domain/MirrorCard.tsx", import.meta.url), "utf8");
const AGENT = readFileSync(new URL("../src/lib/collectorAgent.ts", import.meta.url), "utf8");
const REDACT = readFileSync(new URL("../src/lib/diagRedact.ts", import.meta.url), "utf8");
const COLLECTOR = readFileSync(new URL("../src/pages/Collector.tsx", import.meta.url), "utf8");
const ADDSITE = readFileSync(new URL("../src/components/search/AddSiteQuick.tsx", import.meta.url), "utf8");

// ---------------------------------------------------------------------------
// N1 - mirror status must be a 200 "disabled" fact, never a 503 error
// ---------------------------------------------------------------------------
test("F101-N1: the status route answers 200 with a disabled envelope when the module is absent", () => {
  const block = SERVER.slice(SERVER.indexOf("if (-not $script:F46MirrorReady) {"));
  assert.ok(block.includes("if ($path -eq '/api/mirror/status')"), "the module-missing branch does not special-case the status read");
  assert.ok(
    block.includes("Send-ClientResponse -Stream $stream -Code 200 -CType 'application/json; charset=utf-8' -Body (ConvertTo-JsonBytes $mDisBody)"),
    "the disabled status read is not answered with 200"
  );
  assert.ok(block.includes("reason = $mDisabledReason"), "the response does not carry a reason");
  assert.ok(block.includes("'mirror-module-not-installed'"), "the machine reason drifted from mirror-module-not-installed");
  assert.ok(block.includes("advice = $mDisabledAdvice"), "the response does not carry advice");
  assert.ok(block.includes("available = $false"), "the response does not say the module is unavailable");
  assert.ok(block.includes("-> 200 (module not installed, disabled)"), "the audit line for the disabled read is missing");
});

test("F101-N1: enable/disable still refuse loudly (a missing module cannot converge)", () => {
  const block = SERVER.slice(SERVER.indexOf("if (-not $script:F46MirrorReady) {"));
  const after503 = block.slice(block.indexOf("-Code 503"));
  assert.ok(after503.includes("reason = $mDisabledReason"), "the 503 does not name the reason");
  assert.ok(after503.includes("advice = $mDisabledAdvice"), "the 503 does not carry the advice");
  assert.ok(after503.includes("-> 503 (module missing)"), "the 503 audit line drifted");
});

test("F101-N1: the dashboard renders a neutral banner and refuses to offer a doomed enable", () => {
  assert.ok(MIRROR_LIB.includes("available?: boolean;"), "the client status type has no `available`");
  assert.ok(MIRROR_LIB.includes("reason?: string;"), "the client status type has no `reason`");
  assert.ok(MIRROR_LIB.includes("if (r.status === 503)"), "a pre-F101 503 still collapses to null instead of a disabled state");
  assert.ok(MIRROR_LIB.includes('reason: e.reason || "mirror-module-not-installed"'), "the 503 body's reason is not carried through");
  assert.ok(MIRROR_CARD.includes('data-testid="mirror-module-missing-banner"'), "the module-missing banner is missing");
  assert.ok(MIRROR_CARD.includes("optIn.status.available === false"), "the card does not branch on `available`");
  assert.ok(
    MIRROR_CARD.includes("!optIn.status.enabled && optIn.status.available !== false"),
    "the F49 opt-in banner still shows when the module is absent (it offers an action that 503s)"
  );
  assert.ok(MIRROR_CARD.includes('toast.warn(t("mirror.moduleMissing"))'), "the Upload-now button still opens a modal that cannot succeed");
});

// ---------------------------------------------------------------------------
// N2 - add-site auth: the shared refresh-aware comparator
// ---------------------------------------------------------------------------
test("F101-N2: the Lab block (POST /api/f58/sources) uses the F99 refresh-aware validator", () => {
  const gate = SERVER.slice(SERVER.indexOf("if ($f78Presented) {"), SERVER.indexOf("if ($path -eq '/api/f58/sources' -and $parts.method -eq 'GET')"));
  assert.ok(gate.includes("Test-GhrdpDashToken -Presented $f78Presented -SnapshotToken $script:Token"), "the add-site lane is not on the shared validator");
  assert.ok(!gate.includes("Test-TicketBearer $f78Recv $f78Exp"), "the stale boot-snapshot-only compare is still in the add-site lane");
  assert.ok(gate.includes("Add-F99TokenTelemetry -Route $path"), "the add-site lane does not record F99 token telemetry");
  assert.ok(gate.includes("-Code 'AUTH_REQUIRED'"), "an auth refusal still masquerades as VALIDATION_ERROR");
  assert.ok(gate.includes("-MessageKey 'addSite.authMissing'"), "the message key the modal renders drifted");
  assert.ok(gate.includes("presentedHash"), "the refusal does not carry the masked presented hash");
  assert.ok(!gate.includes("presentedToken"), "a raw token value leaked into the refusal envelope");
});

test("F101-N2: only ONE dash-token comparator shape survives, and it is the refresh-aware one", () => {
  // The F99 bundle's asymmetry was mirror=valid / add-site=refused for the SAME
  // token. That can only happen with two comparators, so the count is pinned.
  const shared = SERVER.split("Test-GhrdpDashToken -Presented").length - 1;
  assert.ok(shared >= 3, "expected the mirror, Lab and search lanes on the shared validator, found " + shared);
  assert.ok(
    SERVER.includes("function Test-GhrdpDashToken"),
    "the shared validator is gone"
  );
  assert.ok(SERVER.includes("dash-token.txt"), "the validator no longer reads the rotated token file");
});

// ---------------------------------------------------------------------------
// N3 - search 403
// ---------------------------------------------------------------------------
test("F101-N3: the search lane uses the same comparator and names the real cause", () => {
  const lane = SERVER.slice(SERVER.indexOf("# [F70 §1.1 + F101 §2.3 / N3]"), SERVER.indexOf("if (-not $script:F56dSearchMap)"));
  assert.ok(lane.includes("Test-GhrdpDashToken -Presented $f70Tok -SnapshotToken $Token"), "the search lane is not on the shared validator");
  assert.ok(!lane.includes("Test-TicketBearer $f70Recv $f70Exp"), "the search lane kept its own literal compare");
  assert.ok(lane.includes("-Code 403"), "the frozen 403 status of this lane changed");
  assert.ok(lane.includes("reason = 'dash token required'"), "the frozen reason string drifted (the mock + client contract)");
  assert.ok(lane.includes("detail = $f70Why"), "the specific cause is not exposed");
  assert.ok(lane.includes("token-mismatch-after-refresh-aware-compare"), "a rotated token is still indistinguishable from a missing one");
  assert.ok(lane.includes("Add-F99TokenTelemetry -Route $path"), "the search lane does not record telemetry");
  assert.ok(lane.includes("search auth refused"), "the audit line drifted");
});

// ---------------------------------------------------------------------------
// N4 - websocket keepalive
// ---------------------------------------------------------------------------
test("F101-N4: the server PINGs every 20s, idles out at 90s and closes WITH a status code", () => {
  assert.ok(SERVER.includes("$script:F99WsPingIntervalSec = 20"), "the ping interval is not 20s");
  assert.ok(SERVER.includes("$script:F99WsIdleTimeoutSec = 90"), "the idle bound is not 90s");
  assert.ok(SERVER.includes("$script:F99WsMaxLifetimeSec = 1800"), "the lifetime ceiling is missing");
  assert.ok(!SERVER.includes("while (((Get-Date) - $start).TotalSeconds -lt 45)"), "the 45s hard cap that produced the idle/1005 close is still there");
  assert.ok(SERVER.includes("function Send-F99WsPing"), "there is no PING frame sender");
  assert.ok(SERVER.includes("[byte[]]@(0x89,0x00)"), "the PING frame is not opcode 0x9 with an empty payload");
  assert.ok(SERVER.includes("$opcode -eq 10"), "client PONG frames are not accounted for");
  assert.ok(SERVER.includes("type='ping'"), "no application-level ping (the only liveness signal JS can see)");
  assert.ok(SERVER.includes('"type"\\s*:\\s*"pong"'), "the app-level PONG is echoed back instead of counted");
  assert.ok(SERVER.includes("$f99CloseStatus = 1000"), "there is no normal-closure status");
  assert.ok(!SERVER.includes("[byte[]]@(0x88,0x00)"), "the bare close frame that browsers report as 1005 is still sent");
  assert.ok(SERVER.includes("$close = [byte[]](@([byte]0x88, [byte]0x02) + @($sc))"), "the close frame does not carry a 2-byte status payload");
  assert.ok(SERVER.includes("ws closed status="), "the close is not audited");
});

test("F101-N4: the client answers PONG and force-reconnects after 30s of silence", () => {
  assert.ok(HOOK.includes('const WS_PING_TIMEOUT_MS = 30000'), "the 30s watchdog bound drifted");
  assert.ok(HOOK.includes('JSON.stringify({ type: "pong", ts: Date.now() })'), "the client never answers the app-level ping");
  assert.ok(HOOK.includes("setWsLastPingAt(Date.now())"), "the client does not stamp ping receipts");
  assert.ok(HOOK.includes('resetWs("no-ping-30s")'), "a half-open socket is still never recovered");
  assert.ok(HOOK.includes('setWsDead(true, "no-ping-30s")'), "the forced reconnect is not published as a dead socket with a reason");
  assert.ok(HOOK.includes("const pingWatchdog = window.setInterval"), "there is no watchdog interval");
  assert.ok(HOOK.includes("timers.push(pingWatchdog)"), "the watchdog is not cleaned up with the effect");
  assert.ok(STORE.includes("wsLastPingAt: number | null;"), "the store has no last-ping field");
  assert.ok(STORE.includes("setWsLastPingAt:"), "the store has no last-ping setter");
});

// ---------------------------------------------------------------------------
// N5 - deep per-button Collector instrumentation
// ---------------------------------------------------------------------------
test("F101-N5: the action record carries the six deep sections", () => {
  for (const field of ["preCheck?: PreCheck", "request?: RequestRecord", "response?: ResponseRecord", "postCheck?: PostCheck", "serviceDependencies?: ServiceDependency[]", "verdict?: Verdict"]) {
    assert.ok(AGENT.includes(field), "the ButtonAction record lost " + field);
  }
  for (const field of ["serviceStates", "tokenPresence", "routeReachable", "prerequisites"]) {
    assert.ok(new RegExp("export interface PreCheck \\{[\\s\\S]*?" + field).test(AGENT), "PreCheck lost " + field);
  }
  for (const field of ["sideEffects", "newServiceStates", "stateChanged"]) {
    assert.ok(AGENT.includes(field), "PostCheck lost " + field);
  }
  assert.ok(/export interface Verdict \{[\s\S]*?status: VerdictStatus;[\s\S]*?reason: string;[\s\S]*?suggestedFix: string;[\s\S]*?relatedIssue: string \| null;/.test(AGENT), "Verdict lost a field");
  assert.ok(/export interface ServiceDependency \{[\s\S]*?latencyMs: number \| null;[\s\S]*?errorRate: number \| null;/.test(AGENT), "ServiceDependency lost a field");
});

test("F101-N5: instrumentButton captures pre -> request -> response -> post -> verdict", () => {
  assert.ok(AGENT.includes("export async function instrumentButton<T>("), "the wrapper is missing");
  const body = AGENT.slice(AGENT.indexOf("export async function instrumentButton<T>("));
  const order = [
    body.indexOf("await captureServiceStates()"),
    body.indexOf("const mark = ringMark()"),
    body.indexOf("result = await action()"),
    body.indexOf("ringBetween(mark, ringMark())"),
    body.indexOf("opts.skipPostCheck ? null : await captureServiceStates()"),
    body.indexOf("verdictFor({ threw, exchange, pre, post })"),
    body.indexOf("const record = logButtonAction({"),
  ];
  for (let i = 0; i < order.length; i++) assert.ok(order[i] > -1, "step " + i + " of instrumentButton is missing");
  for (let i = 1; i < order.length; i++) assert.ok(order[i] > order[i - 1], "instrumentButton step order regressed at " + i);
  assert.ok(AGENT.includes("installFetchObserver"), "there is no fetch observer");
  assert.ok(AGENT.includes("window.fetch = async"), "the observer does not wrap window.fetch");
  // [WP-13 / MC-P13 rewritten in place] header masking is delegated to the shared
  // core (diagRedact.maskSecretHeaders): a secret-named header keeps only its
  // LENGTH. The old `sha=<FNV-1a>` fingerprint was secret-derived and is gone.
  assert.ok(AGENT.includes("maskSecretHeaders"), "credentials are not masked in the captured headers (shared core)");
  assert.ok(REDACT.includes('"present(len="'), "a masked credential lost its length marker (shared core)");
  // no fingerprint DERIVATION anywhere (the shared core's `sha=` regex only
  // STRIPS legacy fingerprints — a construction would re-add the oracle)
  assert.ok(!AGENT.includes('",sha="'), "a secret-derived fingerprint is being constructed (MC-P13)");
  assert.ok(!AGENT.includes("fingerprint("), "the fingerprint helper is back (MC-P13)");
  assert.ok(!/headers\[k\] = v;[\s\S]{0,40}token/i.test(AGENT.replace(/maskHeaders[\s\S]{0,400}/, "")), "a raw token may be stored");
});

test("F101-N5: the verdict always carries a fix, and the four F101 bugs point at #157", () => {
  assert.ok(AGENT.includes("export function classifyFailure("), "the failure classifier is missing");
  assert.ok(AGENT.includes('relatedIssue: "#157"'), "no verdict links the tracking issue");
  const cf = AGENT.slice(AGENT.indexOf("export function classifyFailure("), AGENT.indexOf("function verdictFor("));
  for (const status of ["401", "503", "429", "404"]) {
    assert.ok(cf.includes("status === " + status), "HTTP " + status + " is not classified");
  }
  assert.ok(cf.includes("status === 0"), "an unreachable server is not classified");
  assert.ok(cf.includes("Re-open the dashboard with ?key="), "the auth failure has no actionable fix");
  assert.ok(cf.includes("MIRROR=1"), "the mirror failure does not say how to install the module");
});

test("F101-N5: every known button is registered and clickable from the Collector page", () => {
  const n = (AGENT.match(/\{ id: "/g) || []).length;
  assert.ok(n >= 10, "the button registry shrank below 10 entries (found " + n + ")");
  assert.ok(AGENT.includes("export const KNOWN_BUTTONS: KnownButton[]"), "the registry is not exported");
  assert.ok(AGENT.includes("export async function clickKnownButton("), "'Click now' has no implementation");
  assert.ok(AGENT.includes('document.querySelector(\'[data-testid="\' + btn.testId + \'"]\')'), "'Click now' does not drive the real DOM element");
  assert.ok(AGENT.includes("export function lastOutcomePerButton("), "the table cannot show the last outcome per button");
  for (const marker of [
    'data-testid="collector-known-buttons"',
    'data-testid="collector-click-all"',
    'data-testid={"collector-click-now-" + btn.id}',
    'data-testid={"collector-action-detail-" + a.id}',
    'const DEEP_TABS = ["preCheck", "request", "response", "postCheck", "services", "verdict"] as const;',
    'data-testid={"collector-tab-" + tb}',
    'data-testid="collector-verdict"',
  ]) {
    assert.ok(COLLECTOR.includes(marker), "the Collector page lost " + marker);
  }
  assert.ok(COLLECTOR.includes("installFetchObserver()"), "the observer is not armed on the Collector page");
  // every registry entry must name a data-testid some SHIPPED component
  // actually renders, otherwise "Click now" silently falls back to a probe and
  // the operator thinks they exercised a button they never touched.
  const ids = [...AGENT.matchAll(/testId: "([a-z0-9-]+)"/g)].map((m) => m[1]);
  assert.ok(ids.length >= 10, "registry entries lost their testIds");
  const roots = [new URL("../src/components/", import.meta.url), new URL("../src/pages/", import.meta.url)];
  const all = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const u = new URL(e.name + (e.isDirectory() ? "/" : ""), dir);
      if (e.isDirectory()) walk(u);
      else if (/\.tsx?$/.test(e.name)) all.push(readFileSync(u, "utf8"));
    }
  };
  for (const r of roots) walk(r);
  const hay = all.join("\n");
  for (const id of ids) {
    assert.ok(hay.includes('data-testid="' + id + '"'), "registry entry points at a data-testid no shipped component renders: " + id);
  }
});

test("F101-N5: the operator's primary workflow (Add site) is wrapped in the deep recorder", () => {
  assert.ok(ADDSITE.includes('instrumentButton("add-site", "save"'), "Add site save is no longer deeply instrumented");
  assert.ok(!ADDSITE.includes("logButtonAction({"), "the shallow F100 record is still what Add site writes");
  assert.ok(ADDSITE.includes("sideEffects: [\"customSourceSaved\""), "the add-site post-check has nothing to look for");
});
