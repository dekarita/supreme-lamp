// [WP-13 / #193 + WP-13b / MC-P24] PRIVACY REPAIR — static pins for the
// redaction contract. The behavioral half (the shipped code actually running)
// lives in src/tests/smoke/wp13-privacy-redaction.test.tsx and
// src/tests/smoke/wp13b-dvr-shot-privacy.test.tsx; this file pins the WIRING so
// a later edit cannot quietly unwire a fence.
//
// What is pinned, per sink:
//   - the shared redaction core exists and owns every transform (one scrubber,
//     no second implementation to drift);
//   - the capture path sanitizes at production (path-only URLs, scrubbed
//     bodies, length-only masked headers, route templates, no `value` reads);
//   - the attribution fix (background polls never become a button's request);
//   - BOTH hydration paths run the redaction pass; the write + export sinks
//     are fenced; no secret-derived fingerprint survives anywhere;
//   - the screenshot consent gate, the clone exclusion pass, the storage purge
//     migration, and the data-dvr-exclude markers on every credential surface.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n?/g, "\n");

const REDACT = read("src/lib/diagRedact.ts");
const AGENT = read("src/lib/collectorAgent.ts");
const CAP = read("src/lib/globalClickCapture.ts");
const COLLECTOR = read("src/pages/Collector.tsx");
const SCREENSHOTS = read("src/lib/dvr/screenshots.ts");
const SESSION = read("src/lib/dvr/session.ts");
const STORAGE = read("src/lib/dvr/storage.ts");
const FAB = read("src/components/domain/DvrFab.tsx");
const MASKED_FIELD = read("src/components/primitives/Data.tsx");
const DASH_GATE = read("src/components/domain/DashTokenGate.tsx");
const WEB_DESKTOP = read("src/components/domain/WebDesktopCard.tsx");
const OWN_CRED = read("src/pages/search/v2/OwnCredentialModal.tsx");
const DIAG_DRAWER = read("src/components/domain/DiagnosticsDrawer.tsx");
const EN = JSON.parse(read("src/i18n/en.json"));
const SI = JSON.parse(read("src/i18n/si.json"));

/** Strip comments so a prose mention cannot satisfy a code pin. */
function code(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => (line.trim().startsWith("//") ? "" : line.replace(/(^|[^:])\/\/.*$/, "$1")))
    .join("\n");
}

test("WP13-1: the shared redaction core owns every transform", () => {
  for (const fn of [
    "export function sanitizeRoute(",
    "export function sanitizeRequestUrl(",
    "export function sanitizeExchangeUrl(",
    "export function maskSecretHeaders(",
    "export function redactJsonSecrets<",
    "export function scrubSecretText(",
    "export function scrubBodyText(",
    "export function redactButtonAction<",
    "export const CREDENTIAL_INPUT_TESTIDS",
  ]) {
    assert.ok(REDACT.includes(fn), "diagRedact lost " + fn);
  }
  // the core never DERIVES a secret fingerprint. Its `sha=` regex is the
  // STRIPPER for legacy fingerprints (removal, not derivation) — pinned both ways.
  assert.ok(code(REDACT).includes("SECRET_FINGERPRINT"), "the legacy-fingerprint stripper is missing");
  assert.ok(!code(REDACT).includes("fingerprint("), "diagRedact derives a fingerprint from a secret");
  assert.ok(!code(AGENT).includes("fingerprint("), "collectorAgent derives a fingerprint from a secret");
  assert.ok(!code(AGENT).includes('",sha="'), "collectorAgent constructs a fingerprinted mask (MC-P13)");
  // and it is pure: no DOM, no storage, no network
  for (const banned of ["document.", "window.", "localStorage", "sessionStorage", "indexedDB", "fetch("]) {
    assert.ok(!code(REDACT).includes(banned), "diagRedact must stay pure (found " + banned + ")");
  }
});

test("WP13-2: the capture path sanitizes at production", () => {
  const agent = code(AGENT);
  // the observer stores path-only URLs and scrubbed bodies
  assert.ok(agent.includes("url: sanitizeRequestUrl(url)"), "the observer stores a raw request URL (?key= would persist)");
  assert.ok(agent.includes("body: scrubBodyText(body, BODY_CAPTURE_CHARS)"), "the observer stores an unscrubbed request body");
  assert.ok(agent.includes("text = scrubBodyText(await clone.text(), BODY_CAPTURE_CHARS)"), "the observer stores an unscrubbed response body");
  // masked headers come from the shared core (length only, no fingerprint)
  assert.ok(agent.includes("const maskHeaders = maskSecretHeaders;"), "maskHeaders no longer delegates to the shared core");
  assert.ok(!agent.includes("sha="), "collectorAgent may not derive a secret fingerprint");
  // routes are templates at both production sites
  assert.ok(agent.includes("const routeNow = sanitizeRoute("), "runClick stores the raw hash as routeNow");
  const sigAt = agent.indexOf("const signature = () =>");
  assert.ok(sigAt >= 0, "the effect-probe signature is missing");
  const sig = agent.slice(sigAt, sigAt + 900);
  assert.ok(sig.includes("sanitizeRoute("), "the effect-probe signature embeds the raw hash");
  // popup/download URLs are cut
  assert.ok(agent.includes("popups.push(sanitizeExchangeUrl("), "a raw popup URL (with ?key=) is recorded");
  // pathOf is path-only
  const pathOf = agent.slice(agent.indexOf("function pathOf("), agent.indexOf("function waitForEl("));
  assert.ok(!pathOf.includes("u.search"), "pathOf keeps the query string");
});

test("WP13-3: background polls are never a button's request (MC-P12)", () => {
  const agent = code(AGENT);
  const start = agent.indexOf("export async function instrumentButton<");
  assert.ok(start >= 0, "instrumentButton is missing");
  const instr = agent.slice(start, agent.indexOf("export type PreStep =", start));
  assert.ok(instr.includes('filter((e) => e.origin === "app")'), "instrumentButton must attribute ONLY app traffic to a click");
  assert.ok(!instr.includes('filter((e) => e.origin !== "probe")'), "instrumentButton still persists background polls as the button's request");
});

test("WP13-4: BOTH hydration paths run the redaction pass; write + export sinks are fenced", () => {
  const agent = code(AGENT);
  // the pass is called from onRehydrateStorage (initial load AND cross-tab
  // storage-event rehydrate both flow through it)
  const at = agent.indexOf("onRehydrateStorage: () => (state, error) =>");
  assert.ok(at >= 0, "onRehydrateStorage is missing");
  const rehydrate = agent.slice(at, at + 1100);
  assert.ok(rehydrate.includes("redactPersistedRows(state?.actions)"), "onRehydrateStorage does not run the redaction pass");
  // the write sink: every row passes through redactButtonAction in logButtonAction
  const log = agent.slice(agent.indexOf("export function logButtonAction("), agent.indexOf("function addAction("));
  assert.ok(log.includes("redactButtonAction({"), "logButtonAction persists an unsanitized row");
  // the export sink
  assert.ok(agent.includes("export function exportableActions(): ButtonAction[]"), "exportableActions missing");
  assert.ok(agent.includes("getRecordedActions().map((a) => redactButtonAction(a))"), "exportableActions does not re-redact");
  assert.ok(COLLECTOR.includes("recordedUserActions: exportableActions()"), "the button-actions.json export does not use the redacted view");
});

test("WP13-5: globalClickCapture never reads value and sanitizes the route", () => {
  const cap = code(CAP);
  const desc = cap.slice(cap.indexOf("export function describeClick("), cap.indexOf("function dedupeKey("));
  assert.ok(!desc.includes('g("value")'), "describeClick reads the value attribute (MC-P8)");
  const route = cap.slice(cap.indexOf("function currentRoute("), cap.indexOf("export function describePath("));
  assert.ok(route.includes("sanitizeRoute("), "currentRoute stores the raw hash (MC-P11)");
});

test("WP13b-1: the screenshot consent gate is wired (off by default, explicit opt-in)", () => {
  const shots = code(SCREENSHOTS);
  assert.ok(shots.includes("export function setShotsConsented("), "the consent setter is missing");
  assert.ok(shots.includes("export function shotsConsented(): boolean"), "the consent getter is missing");
  assert.ok(shots.includes("let shotsOn = false;"), "shots must default to OFF");
  const session = code(SESSION);
  const takeShot = session.slice(session.indexOf("async function takeShot("), session.indexOf("// The production subscriber"));
  assert.ok(takeShot.includes("if (!shotsConsented()) return;"), "takeShot does not check consent — the optional capture path is not gated");
  // the FAB exposes the explicit toggle
  assert.ok(FAB.includes('data-testid="dvr-shots-toggle"'), "the FAB has no screenshot consent toggle");
  assert.ok(FAB.includes("setShotsConsented("), "the FAB toggle does not drive the consent gate");
  // the i18n keys exist in both catalogs
  for (const k of ["shotsOff", "shotsOn", "shotsNote"]) {
    assert.ok(typeof EN.dvr[k] === "string" && EN.dvr[k].length > 0, "en.json dvr." + k + " missing");
    assert.ok(typeof SI.dvr[k] === "string" && SI.dvr[k].length > 0, "si.json dvr." + k + " missing");
  }
});

test("WP13b-2: the clone exclusion pass runs before serialization (MC-P24)", () => {
  const shots = code(SCREENSHOTS);
  assert.ok(shots.includes('export const DVR_EXCLUDE_ATTR = "data-dvr-exclude"'), "the exclusion attribute is missing");
  assert.ok(shots.includes("export function prepareShotClone("), "prepareShotClone is missing");
  assert.ok(shots.includes('clone.querySelectorAll("[" + DVR_EXCLUDE_ATTR + "]")'), "excluded subtrees are not removed from the clone");
  assert.ok(shots.includes('el.removeAttribute("value")'), "typed input values are not stripped from the clone");
  assert.ok(shots.includes("holder.appendChild(prepareShotClone(root))"), "the default rasterizer does not use the exclusion pass");
});

test("WP13b-3: every credential surface carries the exclusion attribute", () => {
  // MaskedField renders the raw secret as text when revealed — the primitive
  // itself is marked, so every instance (mirrorKey, credWinPass, credVncPass) is covered.
  const masked = code(MASKED_FIELD);
  const field = masked.slice(masked.indexOf("export function MaskedField("), masked.indexOf("export function Card("));
  assert.ok(field.includes("data-dvr-exclude"), "MaskedField is not marked data-dvr-exclude");
  assert.ok(code(DASH_GATE).includes("data-dvr-exclude"), "the dash-token password input is not marked");
  assert.ok(code(WEB_DESKTOP).includes("data-dvr-exclude"), "the VNC password input is not marked");
  assert.ok(code(OWN_CRED).includes("data-dvr-exclude"), "the own-credential password input is not marked");
  assert.ok(code(DIAG_DRAWER).includes("data-dvr-exclude"), "the copy-current-password affordance is not marked");
});

test("WP13b-4: the storage migration purges legacy shots and is idempotent", () => {
  const storage = code(STORAGE);
  assert.ok(storage.includes("export async function migratePurgeLegacyShots("), "the purge migration is missing");
  assert.ok(storage.includes('const SHOTS_PURGE_MARKER_KEY = "migration/shots-purged-v1"'), "the idempotency marker is missing");
  assert.ok(storage.includes("already-migrated"), "the second run is not a no-op");
  const session = code(SESSION);
  const open = session.slice(session.indexOf("void openDvrDb().then("), session.indexOf("async function persistMeta("));
  assert.ok(open.includes("migratePurgeLegacyShots(db)"), "the migration does not run at DB-open time");
  // the purge deletes, it never copies: no read-then-write of shot payloads
  const pStart = storage.indexOf("export async function migratePurgeLegacyShots(");
  assert.ok(pStart >= 0, "the migration is missing");
  const purge = storage.slice(pStart, storage.indexOf("export async function saveShots(", pStart));
  assert.ok(purge.includes("shotStore.delete(s.key)"), "legacy shots are not deleted");
  assert.ok(!purge.includes("{ ...s,"), "the purge must not copy shot records anywhere");
});
