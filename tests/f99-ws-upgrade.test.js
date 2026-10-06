// [F99 §2.1 / B1] THE /ws UPGRADE LANE.
//
// EVIDENCE this file fences: the F96 bundle reported webSocket.status=idle,
// serverUpgradeSupported=false and 24 client closes with code 1006. The client
// lane (src/hooks/useDashboardPolling.ts) had already been fixed by F95/R4 to
// send ?key= + a {type:'hello'} first frame - but no server route existed, so
// every handshake was refused and the pill could never leave "idle".
//
// These assertions are deliberately grep-level: the repository has no
// PowerShell interpreter in CI for the sandbox, so the contract is pinned by
// re-extracting the symbols from the shipped bytes (the same technique the F95
// and F96 gates use). Delete a symbol and the flag that advertises it fails
// with it - that is the point.
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const SERVER = fs.readFileSync("payloads/ghrdp-server.ps1", "utf8");
const CLIENT = fs.readFileSync("src/hooks/useDashboardPolling.ts", "utf8");
const COLLECTOR = fs.readFileSync("payloads/ghrdp-collector.ps1", "utf8");
const VITE = fs.readFileSync("vite.config.ts", "utf8");

test("F99-B1-1: the upgrade lane is declared and dispatched at /ws", () => {
  assert.ok(SERVER.includes("$script:F96WsUpgradeSupported = $true"), "the upgrade lane is not declared supported");
  assert.ok(SERVER.includes("$script:F99WsUpgradePath = '/ws'"), "the upgrade path constant is missing");
  assert.ok(SERVER.includes("function Invoke-F99WsRoute"), "the route handler is missing");
  const dispatch = SERVER.indexOf("if ($path -eq $script:F99WsUpgradePath)");
  assert.ok(dispatch > 0, "the request dispatcher does not route /ws");
  // The upgrade must be decided BEFORE Test-ClientAllowed: its snapshot compare
  // answers a rotated-but-valid ?key= with a plain 401, which the browser sees
  // as an opaque close 1006 - the exact symptom the bundle recorded.
  const allowed = SERVER.indexOf("if (-not (Test-ClientAllowed -Client $Client -Query $parts.query -Token $Token))");
  assert.ok(allowed > dispatch, "the /ws decision must precede Test-ClientAllowed");
  assert.ok(SERVER.includes("Invoke-F99WsRoute -Client $Client -Stream $stream -Parts $parts -Token $Token"), "the dispatcher does not call the route handler");
});

test("F99-B1-2: RFC 6455 handshake (101 + Sec-WebSocket-Accept), never a fake 200", () => {
  assert.ok(SERVER.includes("258EAFA5-E914-47DA-95CA-C5AB0DC85B11"), "the RFC 6455 magic GUID is missing");
  assert.ok(SERVER.includes("Sec-WebSocket-Accept"), "the accept header is never written");
  assert.ok(SERVER.includes("101 Switching Protocols"), "the 101 status line is missing");
  // PowerShell header keys are lower-cased by the request splitter.
  assert.ok(SERVER.toLowerCase().includes("sec-websocket-key"), "the client key is never read");
  assert.ok(/SHA1/.test(SERVER), "the accept key is not SHA1-based");
  assert.ok(/ToBase64String/.test(SERVER), "the accept key is not base64 encoded");
  // A refused upgrade must carry a code the browser can name, not a silent drop.
  assert.ok(/Sec-WebSocket-Version|426/.test(SERVER), "a non-upgrade probe must be answerable (426/version hint)");
});

test("F99-B1-3: frames are real (masking in, FIN unmasked out, ping/pong/close)", () => {
  assert.ok(SERVER.includes("-bxor"), "client frames are never unmasked");
  assert.ok(/op -eq 8/.test(SERVER), "close frames are not handled");
  assert.ok(/op -eq 9/.test(SERVER) && /Send-Bytes \$f.payload 10/.test(SERVER), "ping frames are not answered with a pong");
  assert.ok(/Send-Bytes \(\[byte\[\]\]@\(3, 0xF0\)\) 8/.test(SERVER), "the auth refusal is not a clean 1008 close");
  assert.ok(SERVER.includes("$script:F99WsPumpSource"), "the per-socket frame pump is missing");
  assert.ok(SERVER.includes("$script:F99WsSendIntervalSec"), "the push interval is not a named constant");
  // The token must be accepted from the query AND from the first hello frame:
  // a browser WebSocket cannot set request headers.
  assert.ok(/hello/.test(SERVER), "the first-frame hello handshake is not understood");
  assert.ok(/dash-token\.txt|test-F99Ws|Test-GhrdpDashToken|Get-F99WsTokenOk/i.test(SERVER), "the socket token is not resolved from the rotation-aware source");
});

test("F99-B1-4: /health and the bundle report COMPUTED ws facts, not the old constants", () => {
  assert.ok(SERVER.includes("ws = $wsFlag"), "/health does not compute the ws flag");
  assert.ok(SERVER.includes("wsPath = $script:F99WsUpgradePath"), "/health does not publish the upgrade path");
  assert.ok(SERVER.includes("wsProtocol = 'RFC6455'"), "/health does not publish the protocol");
  assert.ok(SERVER.includes("wsClients = "), "/health does not publish the live client count");
  // Only a CODE assignment counts: the F99 comments legitimately quote the old
  // `ws = $false` literal when explaining what was fixed.
  const codeOnly = SERVER.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");
  assert.ok(!/ws\s*=\s*\$false/.test(codeOnly), "a hardcoded ws=$false is back");
  assert.ok(/upgrade lane live at \/ws/.test(SERVER), "the bundle does not state the lane is live");
  assert.ok(SERVER.includes("serverUpgradeSupported = [bool]$script:F96WsUpgradeSupported"), "the bundle no longer reports the server truth");
});

test("F99-B1-5: the run list and ws-clients/ are PRUNED (no unbounded growth)", () => {
  assert.ok(SERVER.includes("function Remove-F99WsRuns"), "the prune function is missing");
  assert.ok(SERVER.includes("Remove-F99WsRuns | Out-Null"), "the census never prunes");
  assert.ok(/MaxKeep/.test(SERVER), "the run list has no cap");
  assert.ok(/RemoveAt\(/.test(SERVER), "finished runs are never removed from the list");
  assert.ok(/ws-\*\.json/.test(SERVER), "orphaned ws-clients state files are never swept");
});

test("F99-B1-6: /api/version advertises the lane and the collector", () => {
  const i = SERVER.indexOf("if ($path -eq '/api/version')");
  assert.ok(i > 0, "/api/version route is missing");
  const block = SERVER.slice(i, SERVER.indexOf("if ($path -eq '/api/ping')", i));
  assert.match(block, /webSocketUpgrade = \$true/, "the upgrade lane is not advertised");
  assert.match(block, /diagnosisCollector = \$true/, "the collector is not advertised");
  assert.ok(!/rdpPass|mirrorKey|dashToken/i.test(block), "/api/version must not touch secrets");
});

test("F99-B1-7: the client lane's contract is untouched (the server now satisfies it)", () => {
  assert.ok(CLIENT.includes('"/ws"'), "the client no longer targets /ws");
  assert.ok(CLIENT.includes("?key="), "the client stopped presenting the token in the query");
  assert.ok(CLIENT.includes('type: "hello"'), "the client stopped sending the first-frame hello");
  assert.ok(CLIENT.includes("setWsLive(true)"), "the client no longer flips the live flag on open");
  assert.ok(CLIENT.includes("RECONNECT_LADDER"), "the reconnect ladder is gone");
});

test("F99-B1-8: the collector proves the lane END TO END (agent-style handshake)", () => {
  assert.ok(COLLECTOR.includes("'webSocket'"), "the collector has no webSocket feature");
  assert.ok(/Sec-WebSocket-Key/.test(COLLECTOR), "the collector does not perform a real handshake");
  assert.ok(/101/.test(COLLECTOR), "the collector does not require a 101");
  assert.ok(/acceptOk/.test(COLLECTOR), "the collector does not record the accept verdict");
  assert.ok(VITE.includes("tests/f99-*.test.ts"), "the f99 page test is not wired into vitest");
});
