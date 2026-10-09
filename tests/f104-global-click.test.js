// [F104 §3] Global click telemetry, pinned in bytes:
//  - ONE document-level capture-phase listener auto-records every real click;
//  - the collector's own UI is invisible to the capture (the F102 feedback
//    guard - recording "Click now" would feed the store from its own reader);
//  - fetch + window.open are observed per click for 10 s, then restored
//    WITHOUT disturbing F101's permanent fetch observer (restore-if-ours);
//  - rows carry source="global-click-capture" and render in their own section;
//  - no query string, token, or fragment can reach a row.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n?/g, "\n");
const CAP = read("src/lib/globalClickCapture.ts");
const AGENT = read("src/lib/collectorAgent.ts");
const MAIN = read("src/main.tsx");
const COLL = read("src/pages/Collector.tsx");

test("F104-a: the capture module exports the installer, the source tag, and the tuned constants", () => {
  assert.ok(CAP.includes("export function installGlobalClickCapture("), "installer missing");
  assert.ok(CAP.includes('export const GLOBAL_CLICK_SOURCE = "global-click-capture"'), "source tag missing/drifted");
  assert.ok(CAP.includes("export const GLOBAL_CLICK_WINDOW_MS = 10_000"), "observation window must be 10 s");
  assert.ok(CAP.includes("export const GLOBAL_CLICK_DEDUP_MS = 500"), "dedupe window must be 500 ms");
  assert.ok(CAP.includes("export const GLOBAL_CLICK_MAX_EXCHANGES = 50"), "per-row exchange cap missing");
});

test("F104-b: the ignore list names all five F102 feedback guards", () => {
  const i = CAP.indexOf("export const GLOBAL_CLICK_IGNORE");
  assert.ok(i > 0, "GLOBAL_CLICK_IGNORE missing");
  const body = CAP.slice(i, i + 600);
  for (const sel of ["[data-collector-ignore]", "[data-testid^='collector-']", "[data-testid^='click-now-']", "nav a", ".pagination button"]) {
    assert.ok(body.includes(sel), "ignore selector missing: " + sel);
  }
});

test("F104-c: capture-phase document listener, clickable matching, trusted-only by default", () => {
  assert.ok(CAP.includes('document.addEventListener("click", onClick, true)'), "the listener must run in the capture phase");
  assert.ok(CAP.includes("closest(CLICKABLE)") || CAP.includes("closest(\"button"), "clickable matching via closest() missing");
  assert.ok(CAP.includes("button, a[role='button']"), "button/a[role=button] matching drifted");
  assert.ok(CAP.includes("[data-testid]"), "testid'd elements must be capturable");
  assert.ok(CAP.includes("closest(ignoreSel)"), "the ignore check must run before any recording");
  assert.ok(CAP.includes("isTrusted === false"), "programmatic clicks (F102 runner) must be dropped by default");
  assert.ok(CAP.includes("trustCheck"), "the trust check must be a named option");
  assert.ok(CAP.includes('document.removeEventListener("click", onClick, true)'), "uninstall must remove the listener");
});

test("F104-d: fetch + window.open observed per window, restored only while still outermost", () => {
  assert.ok(CAP.includes("window.fetch = wrappedFetch"), "fetch is not wrapped");
  assert.ok(CAP.includes("window.open = wrappedOpen"), "window.open is not wrapped");
  assert.ok(CAP.includes("window.fetch === w.wrapped"), "fetch restore must be conditional (F101 chain guard)");
  assert.ok(CAP.includes("window.open as unknown) === w.wrapped"), "window.open restore must be conditional");
  assert.ok(CAP.includes("setTimeout(") && CAP.includes("windowMs"), "the observation window must be a bounded timer");
  assert.ok(CAP.includes("blocked: ret ==="), "window.open must record its blocked signal");
  assert.ok(CAP.includes("status: res.status"), "fetch must record its status");
  assert.ok(CAP.includes("elapsedMs: Date.now() - started"), "fetch must record its elapsed time");
});

test("F104-e: the store grew source + updateAction, and id/ts can never be patched", () => {
  assert.ok(AGENT.includes("source?: string;"), "ButtonAction.source missing");
  assert.ok(AGENT.includes("updateAction: (id: string, patch: Partial<ButtonAction>) => void;"), "store updateAction missing");
  assert.ok(AGENT.includes("export function updateRecordedAction(id: string, patch: Partial<ButtonAction>): void"), "updateRecordedAction export missing");
  assert.ok(AGENT.includes("id: next[idx].id, ts: next[idx].ts"), "id/ts must be pinned through a patch");
  assert.ok(AGENT.includes("if (idx < 0) return {};"), "unknown ids must be a no-op");
});

test("F104-f: main.tsx bootstraps the capture behind the F104 kill flag", () => {
  assert.ok(MAIN.includes('import { installGlobalClickCapture } from "@/lib/globalClickCapture";'), "main.tsx does not import the installer");
  assert.ok(MAIN.includes('VITE_F104_GLOBAL_CAPTURE !== "false"'), "the kill flag is missing");
  assert.ok(MAIN.includes("installGlobalClickCapture("), "the installer is never called");
  // [F-DVR-LITE / Observatory step 3] SAME-PR pin update ($CI-PIN-DETECTION). The
  // original pin here was the literal `installGlobalClickCapture({` - an inline
  // object argument. Step 3 gives that recorder a name so the DVR can DECORATE it
  // (installDvr returns a recorder of the same shape), which is exactly the
  // "extend, never replace" rule #168 derived. The pin is replaced, never dropped,
  // and is now STRICTER than before: the two method bodies are still pinned
  // verbatim, the argument must be the DVR-decorated recorder, and nothing else may
  // be passed to the installer - so a future wrapper that swallows rows fails here.
  assert.ok(MAIN.includes("const recorder: GlobalClickRecorder = {"), "the recorder must stay a named, typed object literal");
  assert.ok(MAIN.includes("record: (rec) => logButtonAction(rec)"), "records must flow through logButtonAction");
  assert.ok(MAIN.includes("update: (id, patch) => updateRecordedAction(id, patch)"), "window-close must flow through updateRecordedAction");
  assert.ok(MAIN.includes("installGlobalClickCapture(installDvr(recorder, { enabled:"), "the installer must receive the DVR-decorated recorder");
  assert.ok(!/installGlobalClickCapture\((?!installDvr\(recorder)/.test(MAIN), "no expression other than the decorated recorder may reach the installer");
});

test("F104-g: the Collector renders Global clicks below Recent actions, and its own root is ignored", () => {
  assert.ok(COLL.includes('data-testid="collector-page" data-collector-ignore'), "the collector page must ignore itself");
  assert.ok(COLL.includes("a.source !== GLOBAL_CLICK_SOURCE"), "Recent actions must exclude global rows");
  assert.ok(COLL.includes("a.source === GLOBAL_CLICK_SOURCE"), "Global clicks must include only global rows");
  for (const t of ["collector-global-row", "collector-global-empty", "collector-global-table", "collector-global-count"]) {
    assert.ok(COLL.includes('data-testid="' + t + '"'), "Global clicks testid missing: " + t);
  }
  assert.ok(COLL.includes("Global clicks (auto-captured)"), "section title drifted");
  const recent = COLL.indexOf("Recent user actions (recorded)");
  const global = COLL.indexOf("Global clicks (auto-captured)");
  assert.ok(recent > 0 && global > recent, "Global clicks must render BELOW Recent user actions");
});

test("F104-h: privacy - URLs are cut at ?/# and capped; bodies/headers never captured", () => {
  assert.ok(CAP.includes('split(/[?#]/, 1)'), "URLs must be cut at the first ? or #");
  assert.ok(CAP.includes("slice(0, 200)"), "URLs must be length-capped");
  assert.ok(!/init\.body|clone\(\)\.text|res\.headers\.forEach/.test(CAP), "the global observer must not capture bodies or headers");
});

// [WP-13 / #193 — F104-h EXTENDED in place] the route is a route TEMPLATE and
// the label never reads the `value` attribute. Both halves are falsified by
// src/tests/smoke/wp13-privacy-redaction.test.tsx against the shipped code.
test("F104-h2: WP-13 privacy - currentRoute is sanitized and describeClick never reads value", () => {
  const slice = (src, start, end) => {
    const i = src.indexOf(start);
    assert.ok(i >= 0, "missing: " + start);
    const j = src.indexOf(end, i + start.length);
    assert.ok(j > i, "missing end marker: " + end);
    return src.slice(i, j);
  };
  const route = slice(CAP, "function currentRoute(", "export function describePath(");
  assert.ok(route.includes("sanitizeRoute("), "currentRoute must store a route template (cut ?/#), never the raw hash with ?key=");
  const desc = slice(CAP, "export function describeClick(", "function dedupeKey(");
  assert.ok(!desc.includes('g("value")'), "describeClick reads the value attribute — a typed password would become the label (MC-P8)");
  assert.ok(desc.includes("scrubSecretText("), "the label is not pattern-scrubbed (a credential-shaped aria-label would persist)");
});
