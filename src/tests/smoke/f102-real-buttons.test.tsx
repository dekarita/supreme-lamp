// [F102 §2 / issue #159] Collector "Click now" is a REAL DOM click and its rows
// survive a refresh - runtime proof against the real recorder.
//
// The operator saw 32 identical "add-site:openModal.clickNow … ERR: no replay
// handler" warn rows (0ms) that vanished on refresh. These tests drive the new
// runner against real DOM elements + a stubbed transport and assert: the
// element's own click() runs, the request it fires (and only that request) is
// the recorded exchange, elapsedMs is measured, an unreachable button is a
// fail/warn with a reason (never a fake 2xx), rows land in the zustand persist
// envelope and come back on rehydrate (incl. the F101 legacy key), "Click every
// button" aborts after 5 identical errors, and unwired buttons are skipped.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const tokenState = { present: true, value: "tok-f102xyz" };
vi.mock("@/lib/api", () => ({
  apiBase: () => "",
  getDashToken: () => (tokenState.present ? tokenState.value : ""),
  hasDashToken: () => tokenState.present,
}));

import {
  ABORT_MESSAGE,
  COLLECTOR_STORE_KEY,
  KNOWN_BUTTONS,
  clearActions,
  clickAllKnownButtons,
  clickKnownButton,
  getRecordedActions,
  isHandlerWired,
  logButtonAction,
  replayAllActions,
  useCollectorStore,
  type KnownButton,
} from "@/lib/collectorAgent";

type Impl = (url: string, init?: RequestInit) => Promise<Response>;
let impl: Impl;
let calls: string[] = [];

function mkRes(status: number, body: unknown): Response {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  const res = {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ "content-type": "application/json" }),
    text: async () => text,
    json: async () => body,
    clone() {
      return res;
    },
  };
  return res as unknown as Response;
}

const PROBES: Record<string, unknown> = {
  "/api/health": { ok: true, ws: true },
  "/api/launcher/health": { serviceRunning: true, heartbeatAge: 1000, queueDepth: 0, taskExists: true },
  "/api/native-status": { watcher: { alive: true } },
  "/api/mirror/status": { ok: true, enabled: false, available: true },
};

beforeAll(() => {
  vi.stubGlobal("fetch", ((input: unknown, init?: RequestInit) => impl(String(input), init)) as unknown as typeof fetch);
});

beforeEach(() => {
  clearActions();
  calls = [];
  tokenState.present = true;
  impl = async (url) => {
    const path = url.split("?")[0];
    calls.push(path);
    if (Object.prototype.hasOwnProperty.call(PROBES, path)) return mkRes(200, PROBES[path]);
    if (path === "/api/collector/report") return mkRes(200, { ok: true, features: {} });
    if (path === "/api/collector/run") return mkRes(503, { error: "launcher service unavailable" });
    return mkRes(404, { code: "NOT_FOUND" });
  };
  document.body.innerHTML = "";
});

function mountButton(testId: string, onClick: () => void, disabled = false): HTMLButtonElement {
  const el = document.createElement("button");
  el.setAttribute("data-testid", testId);
  el.disabled = disabled;
  el.addEventListener("click", onClick);
  document.body.appendChild(el);
  return el;
}

const synthetic = (over: Partial<KnownButton>): KnownButton => ({
  id: "f102-synthetic",
  feature: "f102",
  action: "probe",
  label: "F102 synthetic",
  testId: "f102-not-on-any-page",
  hostRoute: "/#/collector",
  findTimeoutMs: 100,
  ...over,
});

describe("[F102 §2.1] Click now performs a REAL DOM click", () => {
  it("clicks the element, records the request IT fired, and measures elapsedMs", async () => {
    let clicked = 0;
    mountButton("collector-refresh", () => {
      clicked += 1;
      void fetch("/api/collector/report");
    });
    const rec = await clickKnownButton("collector-refresh");
    expect(clicked).toBe(1);
    expect(rec.action).toBe("refresh.clickNow");
    expect((rec.result as { via?: string }).via).toBe("dom-click");
    expect(rec.request?.url).toContain("/api/collector/report");
    expect(rec.response?.status).toBe(200);
    expect(rec.verdict?.status).toBe("ok");
    expect(rec.verdict?.reason).toContain("real click → GET /api/collector/report → HTTP 200");
    expect(rec.elapsedMs).toBeGreaterThan(0);
    // the recorder's own service probes are never mistaken for the click's request
    const reqs = (rec.result as { requests: { url: string }[] }).requests;
    expect(reqs.map((r) => r.url)).toEqual(["/api/collector/report"]);
    expect((rec.params as { knownButton?: string }).knownButton).toBe("collector-refresh");
  }, 15000);

  it("a failing request becomes a classified fail verdict (not a warn)", async () => {
    mountButton("collector-run", () => void fetch("/api/collector/run", { method: "POST" }));
    const rec = await clickKnownButton("collector-run");
    expect(rec.verdict?.status).toBe("fail");
    expect(rec.verdict?.reason).toContain("POST /api/collector/run → 503");
    expect(rec.error).toBeTruthy();
  }, 15000);

  it("a missing element is a fail with the route, a fix and issue #159 - and no route probe", async () => {
    const rec = await clickKnownButton(synthetic({}));
    expect((rec.result as { via?: string }).via).toBe("not-rendered");
    expect(rec.verdict?.status).toBe("fail");
    expect(rec.verdict?.reason).toContain("DOM element [data-testid=f102-not-on-any-page] not found on route /#/collector");
    expect(rec.verdict?.suggestedFix).toContain("Button may be hidden by state. Check feature prerequisites");
    expect(rec.verdict?.relatedIssue).toBe("#159");
    expect(rec.elapsedMs).toBeGreaterThan(0);
    expect(calls.every((c) => Object.prototype.hasOwnProperty.call(PROBES, c))).toBe(true);
  }, 15000);

  it("a disabled element is recorded as disabled (warn), and is NOT clicked", async () => {
    let clicked = 0;
    mountButton("f102-disabled", () => (clicked += 1), true);
    const rec = await clickKnownButton(synthetic({ testId: "f102-disabled", disabledHint: "rate limited" }));
    expect(clicked).toBe(0);
    expect((rec.result as { via?: string }).via).toBe("disabled");
    expect(rec.verdict?.status).toBe("warn");
    expect(rec.verdict?.reason).toContain("DISABLED");
  }, 15000);

  it("an unwired button is never clicked or recorded (Handler pending)", async () => {
    const unwired = synthetic({ hostRoute: undefined });
    expect(isHandlerWired(unwired)).toBe(false);
    await expect(clickKnownButton(unwired)).rejects.toThrow(/Handler pending/);
    const out = await clickAllKnownButtons([unwired]);
    expect(out.skipped).toEqual(["f102-synthetic"]);
    expect(getRecordedActions()).toHaveLength(0);
  });

  it("every one of the 18 registered buttons is wired (host page + testId)", () => {
    expect(KNOWN_BUTTONS).toHaveLength(18);
    for (const b of KNOWN_BUTTONS) expect(isHandlerWired(b)).toBe(true);
  });
});

describe("[F102 §2.3] Click every button", () => {
  it("aborts after 5 identical errors", async () => {
    const six = [1, 2, 3, 4, 5, 6].map((i) => synthetic({ id: "f102-dead-" + i, testId: "f102-dead-" + i }));
    const out = await clickAllKnownButtons(six);
    expect(out.records).toHaveLength(5);
    expect(out.aborted).toContain(ABORT_MESSAGE);
    expect(useCollectorStore.getState().notice).toContain("Aborted after 5 identical errors — fix one button at a time.");
  }, 30000);

  it("Replay all re-runs real clicks once per distinct button - no 'no replay handler' rows", async () => {
    let clicked = 0;
    mountButton("collector-refresh", () => {
      clicked += 1;
      void fetch("/api/collector/report");
    });
    logButtonAction({ feature: "collector", action: "refresh", params: {} });
    logButtonAction({ feature: "collector", action: "refresh", params: {} });
    logButtonAction({ feature: "unknown", action: "thing", params: {} });
    await replayAllActions();
    expect(clicked).toBe(1);
    const rows = getRecordedActions();
    expect(rows.some((r) => String(r.error || "").includes("no replay handler"))).toBe(false);
    expect(rows.filter((r) => r.action === "refresh.clickNow")).toHaveLength(1);
    expect(useCollectorStore.getState().notice).toContain("skipped (not recorded)");
  }, 15000);
});

describe("[F102 §2.2] rows survive a refresh (zustand persist)", () => {
  it("writes the persist envelope under f102-collector-actions-v1 with unique ids", () => {
    const a = logButtonAction({ feature: "t", action: "one", params: {} });
    const b = logButtonAction({ feature: "t", action: "two", params: {} });
    expect(a.id).not.toBe(b.id);
    const raw = window.localStorage.getItem(COLLECTOR_STORE_KEY);
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw as string);
    expect(parsed.state.actions.map((x: { id: string }) => x.id)).toEqual([a.id, b.id]);
    // runner state is per-tab, never persisted
    expect(parsed.state.running).toBeUndefined();
  });

  it("rehydrates the stored rows and reports it (Rehydrated from localStorage)", async () => {
    const row = { id: "act_saved_1", ts: "2026-10-06T18:00:00.000Z", feature: "add-site", action: "save.clickNow", params: {} };
    window.localStorage.setItem(COLLECTOR_STORE_KEY, JSON.stringify({ state: { actions: [row] }, version: 0 }));
    await useCollectorStore.persist.rehydrate();
    expect(getRecordedActions().map((r) => r.id)).toEqual(["act_saved_1"]);
    expect(useCollectorStore.getState().hydration?.count).toBe(1);
    expect(useCollectorStore.getState().hydration?.source).toBe("localStorage");
  });

  it("migrates the F100/F101 legacy array key once", async () => {
    window.localStorage.removeItem(COLLECTOR_STORE_KEY);
    const legacy = [{ id: "act_legacy_1", ts: "2026-10-06T17:00:00.000Z", feature: "x", action: "y", params: {} }];
    window.localStorage.setItem("ghrdp.collector.actions.v1", JSON.stringify(legacy));
    await useCollectorStore.persist.rehydrate();
    expect(getRecordedActions().map((r) => r.id)).toEqual(["act_legacy_1"]);
    expect(useCollectorStore.getState().hydration?.source).toBe("legacy-migration");
    expect(window.localStorage.getItem("ghrdp.collector.actions.v1")).toBeNull();
  });

  it("caps the store at 500 rows", () => {
    for (let i = 0; i < 510; i++) logButtonAction({ feature: "cap", action: "a" + i, params: {} });
    const rows = getRecordedActions();
    expect(rows).toHaveLength(500);
    expect(rows[rows.length - 1].action).toBe("a509");
  });
});
