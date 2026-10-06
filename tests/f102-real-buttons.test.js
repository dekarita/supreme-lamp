// [F102] COLLECTOR "CLICK NOW" IS A REAL DOM CLICK + ROWS SURVIVE A REFRESH
//
// Operator report (issue #159): /#/collector "Click now" / "Click every button"
// produced 32 identical "add-site:openModal.clickNow … ERR: no replay handler"
// warn rows at 0ms, none of them a real click, and every row vanished on
// refresh. Root causes pinned here at source level so a later edit cannot
// quietly bring the fake back:
//   R1 clickKnownButton fell back to a route-probe GET / "not-mounted" row
//   R2 no button had a way to be reached (no host page, no preconditions)
//   R3 persistence was a hand-rolled array with swallowed quota errors and no
//      rehydration signal
//   R4 "Click every button" / "Replay all" iterated the same broken path
//      (Replay handed an EMPTY handler map → "no replay handler" rows)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";

const read = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8");
const AGENT = read("src/lib/collectorAgent.ts");
const COLLECTOR = read("src/pages/Collector.tsx");
const APP = read("src/App.tsx");
const BRIDGE = read("src/components/domain/CollectorRunBridge.tsx");
const MOCK = read("tests/e2e/fixtures/mock-backend.mjs");
const E2E_PATH = "tests/e2e/f102-all-buttons.spec.ts";

function between(src, start, end) {
  const i = src.indexOf(start);
  assert.ok(i >= 0, "missing: " + start);
  const j = src.indexOf(end, i + start.length);
  assert.ok(j > i, "missing end marker: " + end);
  return src.slice(i, j);
}

test("F102-R1: Click now has no route-probe / not-mounted fallback any more", () => {
  assert.ok(!AGENT.includes('via: "route-probe"'), "the route-probe fallback is back");
  assert.ok(!AGENT.includes('via: "not-mounted"'), "the not-mounted no-op row is back");
  assert.ok(!AGENT.includes("no replay handler for"), "the 'no replay handler' row writer is back");
  assert.ok(!COLLECTOR.includes("replayHandlers"), "Collector.tsx still passes a replay handler map");
});

test("F102-R1: clickKnownButton navigates, runs preconditions, DOM-clicks and observes", () => {
  assert.ok(AGENT.includes("export async function clickKnownButton("), "clickKnownButton export missing");
  const run = between(AGENT, "async function runClick(", "function errorSignature(");
  for (const needle of [
    "await navigateTo(hostRoute)",
    "runPreStep(step, steps)",
    "findTarget(btn)",
    "capturePreCheck()",
    "const mark = ringMark();",
    "observeClick(el, mark,",
    "capturePostCheck(pre, win.effects)",
    "classifyFromFetchLog(",
    'via: "dom-click"',
    '"DOM element [data-testid=" + btn.testId + "] not found on route " + hostRoute',
    "Button may be hidden by state. Check feature prerequisites",
    "relatedIssue: F102_ISSUE",
  ]) {
    assert.ok(run.includes(needle), "runClick lost: " + needle);
  }
  // the click itself is the element's own click() - the operator's code path
  const observe = between(AGENT, "async function observeClick(", "function pathOf(");
  assert.ok(observe.includes("el.click();"), "observeClick does not click the element");
  assert.ok(observe.includes("Math.max(1, Math.round("), "elapsedMs is not a measured, positive number");
  assert.ok(AGENT.includes('export const F102_ISSUE = "#159";'), "verdicts do not link issue #159");
});

test("F102-R2: all 18 known buttons are wired with a host page", () => {
  const reg = between(AGENT, "export const KNOWN_BUTTONS: KnownButton[] = [", "\n];\n");
  const ids = [...reg.matchAll(/\{ id: "([a-z0-9-]+)"/g)].map((m) => m[1]);
  assert.equal(ids.length, 18, "expected 18 known buttons, found " + ids.length);
  assert.equal(new Set(ids).size, 18, "duplicate known-button ids");
  const hostRoutes = [...reg.matchAll(/hostRoute: "(\/#\/[^"]*)"/g)].map((m) => m[1]);
  assert.equal(hostRoutes.length, 18, "every known button needs a hostRoute");
  for (const id of ["add-site-save", "search-cancel", "card-download-rdp", "preview-open-source", "lab-refetch", "stream-watch-rdp"]) {
    const entry = reg.slice(reg.indexOf('{ id: "' + id + '"'));
    assert.ok(/preSteps:/.test(entry.slice(0, 1400)), id + " has no precondition steps");
  }
  assert.ok(AGENT.includes("export function isHandlerWired("), "isHandlerWired missing");
});

test("F102-R3: rows persist through zustand persist under f102-collector-actions-v1", () => {
  assert.ok(AGENT.includes('import { persist, createJSONStorage, type StateStorage } from "zustand/middleware";'));
  assert.ok(AGENT.includes('export const COLLECTOR_STORE_KEY = "f102-collector-actions-v1";'));
  assert.ok(AGENT.includes("export const MAX_ACTIONS = 500;"));
  assert.ok(AGENT.includes("storage: createJSONStorage(() => safeLocalStorage)"));
  assert.ok(AGENT.includes("onRehydrateStorage: () => (state, error) =>"));
  assert.ok(AGENT.includes("partialize: (s) => ({ actions: s.actions })"), "runner state must not be persisted");
  // legacy rows are migrated, quota errors are surfaced instead of swallowed
  assert.ok(AGENT.includes('const LEGACY_STORAGE_KEY = "ghrdp.collector.actions.v1";'));
  assert.ok(AGENT.includes('hydrationSource = "legacy-migration"'));
  assert.ok(AGENT.includes("isQuotaError(e)"));
  assert.ok(AGENT.includes("collector rows are NOT persisted"));
  // replay/clickNow ids can no longer collide inside one millisecond
  assert.ok(!AGENT.includes('"_r"'), "the colliding F100 replay id is back");
  // the page reads the store and shows the rehydration chip
  assert.ok(COLLECTOR.includes("const actions = useCollectorStore((s) => s.actions);"));
  assert.ok(COLLECTOR.includes('data-testid="collector-rehydrated"'));
  assert.ok(COLLECTOR.includes("Rehydrated from localStorage"));
  assert.ok(COLLECTOR.includes('data-testid="collector-persist-error"'));
});

test("F102-R4: Click every button aborts after 5 identical errors; unwired = Handler pending", () => {
  assert.ok(AGENT.includes("export const IDENTICAL_ERROR_LIMIT = 5;"));
  assert.ok(AGENT.includes('export const ABORT_MESSAGE = "Aborted after 5 identical errors — fix one button at a time.";'));
  const batch = between(AGENT, "export async function clickAllKnownButtons(", "export function knownButtonOf(");
  assert.ok(batch.includes("streak >= IDENTICAL_ERROR_LIMIT"), "the identical-error abort is gone");
  assert.ok(batch.includes("isHandlerWired(b)"), "unwired buttons are not skipped");
  const replay = between(AGENT, "export async function replayAllActions(", "export function lastOutcomePerButton(");
  assert.ok(replay.includes("clickAllKnownButtons(targets)"), "Replay all does not re-run real clicks");
  assert.ok(COLLECTOR.includes("⚠️ Handler pending"));
  assert.ok(COLLECTOR.includes('data-testid="collector-notice"'));
});

test("F102 §2.4 + §3 testids: Open page, click-now alias, verdict, elapsed-ms", () => {
  assert.ok(COLLECTOR.includes('data-testid={"click-now-" + btn.id}'));
  assert.ok(COLLECTOR.includes('data-testid={"collector-click-now-" + btn.id}'), "F101 testid must stay");
  assert.ok(COLLECTOR.includes('data-testid={"collector-open-page-" + btn.id}'));
  assert.ok(COLLECTOR.includes("onClick={() => void navigateTo(btn.hostRoute"));
  assert.ok(COLLECTOR.includes('data-testid="collector-action-row"'));
  assert.ok(COLLECTOR.includes('data-testid="verdict"'));
  assert.ok(COLLECTOR.includes('data-testid="elapsed-ms"'));
});

test("F102: the router bridge is mounted inside the HashRouter", () => {
  assert.ok(APP.includes('import { CollectorRunBridge } from "@/components/domain/CollectorRunBridge";'));
  const router = between(APP, "<HashRouter>", "</HashRouter>");
  assert.ok(router.includes("<CollectorRunBridge />"), "CollectorRunBridge must render inside <HashRouter>");
  assert.ok(BRIDGE.includes("registerCollectorNavigator((path) => navigate(path))"));
  assert.ok(BRIDGE.includes("pointer-events-none"), "the status pill must never intercept clicks");
});

test("F102 §3: the E2E covers all 18 buttons + refresh survival", () => {
  assert.ok(existsSync(new URL("../" + E2E_PATH, import.meta.url)), E2E_PATH + " missing");
  const spec = read(E2E_PATH);
  const list = between(spec, "const BUTTONS = [", "] as const;");
  assert.equal([...list.matchAll(/"([a-z0-9-]+)"/g)].length, 18);
  assert.ok(spec.includes("records survive page refresh"));
  assert.ok(spec.includes("Click every button records 18 DIFFERENT real rows"));
  assert.ok(spec.includes('not.toContain("no replay handler")'));
  assert.ok(MOCK.includes('"public domain film"'), "the mock does not answer the collector probe query");
  assert.ok(AGENT.includes('export const COLLECTOR_PROBE_QUERY = "public domain film";'));
});
