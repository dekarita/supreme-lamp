// [F109 / Observatory step 8] Debug HUD - the DOM gate.
//
// The real App, mounted for real (jsdom), with the shipped HUD, the shipped
// FeatureBoundary and the shipped Settings page. Proves:
//   1. DEFAULT-OFF - nothing renders, the shortcut is inert, no f109 key is written;
//   2. Settings ▸ "Enable Debug HUD" writes f109:enabled=true, then Shift+F12 opens the
//      overlay with all five panels and the Features panel lists all 11 registry cards;
//   3. a toggle disables a section at the NEXT ROUTE CHANGE (never mid-render), and is
//      inert again once the HUD is switched off;
//   4. Network rows come from (fake) resource timing with query strings stripped; WS rows
//      are descriptors; "Share with AI" copies text with no credential in it;
//   5. a crashing HUD panel is fenced; HUD clicks never reach F104's capture;
//   6. §LAB-DISCOVERS-PROD-BUGS: the Collector mounted in the lab with the HUD open does
//      not cascade, and a forced lab scenario no longer outlives the lab.
// Playwright is not used (no Chromium in the sandbox - standing fact since step 4).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import App from "@/App";
import { FEATURE_IDS, mountedFeatureIds } from "@/lib/featureRegistry";
import { HudPanelBoundary } from "@/components/DebugHUD";
import { __resetDebugHudForTests, hudWsFrames, recordWsFrame, setHudEnabled } from "@/lib/debugHud";
import { HUD_ENABLED_KEY, HUD_PANEL_IDS, HUD_TOGGLES_KEY } from "@/lib/debugHudCore";
import { installGlobalClickCapture, __resetGlobalClickCaptureForTests } from "@/lib/globalClickCapture";
import { installLabFetchMock, __resetLabFetchMockForTests } from "@/lib/lab/mockBackend";
import { LAB_MOCK_HEADER } from "@/lib/lab/labCore";
import { __resetLabStoreForTests, useLabStore } from "@/lib/lab/labStore";
import { installFetchObserver } from "@/lib/collectorAgent";

type Any = any;
const TOKEN = "s3cr3t-dash-token-abcdef123456";

function renderAt(hash: string) {
  window.location.hash = hash;
  return render(<App />);
}

function pressShiftF12(extra: Record<string, unknown> = {}) {
  act(() => {
    fireEvent.keyDown(window, { key: "F12", shiftKey: true, ...extra });
  });
}

/** Navigate the way an operator does: click the sidebar link (react-router push). */
function clickNav(container: HTMLElement, path: string) {
  const link = container.querySelector('nav a[href="#' + path + '"]') as HTMLElement | null;
  expect(link, "sidebar link for " + path).not.toBeNull();
  act(() => {
    fireEvent.click(link!);
  });
}

beforeEach(() => {
  __resetDebugHudForTests();
  window.location.hash = "";
});

afterEach(() => {
  __resetDebugHudForTests();
  // NOT vi.unstubAllGlobals(): that would also remove setup.ts's offline fetch +
  // FakeWebSocket stubs, and every later test in this file would then run against
  // jsdom's REAL WebSocket (found by this gate: a real connect failure fired the
  // hook's onclose -> an extra close:1006 frame). Each test restores what it stubs.
  delete (window as Any).PerformanceObserver;
  window.location.hash = "";
});

describe("F109 default-off (prod-safe)", () => {
  it("renders nothing, ignores Shift+F12 and writes no f109 key until enabled", () => {
    renderAt("#/");
    pressShiftF12();
    expect(screen.queryByTestId("debug-hud")).toBeNull();
    expect(window.localStorage.getItem(HUD_ENABLED_KEY)).toBeNull();
    expect(window.localStorage.getItem(HUD_TOGGLES_KEY)).toBeNull();
    recordWsFrame("in", JSON.stringify({ type: "progress" }));
    expect(hudWsFrames()).toEqual([]); // the tap is inert while off
  });

  it("a toggle left in storage is INERT while the HUD is off", () => {
    window.localStorage.setItem(HUD_TOGGLES_KEY, JSON.stringify({ health: "off" }));
    renderAt("#/health");
    expect(screen.queryByTestId("feature-disabled-health")).toBeNull();
    expect(mountedFeatureIds()).toContain("health");
  });
});

describe("F109 enable + open", () => {
  it("Settings ▸ Enable Debug HUD writes f109:enabled=true; Shift+F12 opens 5 panels; Escape closes", async () => {
    renderAt("#/settings");
    const toggle = screen.getByTestId("settings-debug-hud-toggle");
    expect(toggle).toHaveAttribute("aria-checked", "false");
    act(() => {
      fireEvent.click(toggle);
    });
    expect(window.localStorage.getItem("f109:enabled")).toBe("true");
    expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(screen.queryByTestId("debug-hud")).toBeNull(); // enabled is not open
    pressShiftF12({ ctrlKey: true }); // Ctrl+Shift+F12 is the browser's
    expect(screen.queryByTestId("debug-hud")).toBeNull();
    pressShiftF12();
    const hud = await screen.findByTestId("debug-hud");
    expect(hud.parentElement).toBe(document.body); // portalled
    expect(hud).toHaveAttribute("data-collector-ignore");
    for (const id of HUD_PANEL_IDS) expect(screen.getByTestId("debug-hud-tab-" + id)).toBeInTheDocument();
    expect(HUD_PANEL_IDS).toEqual(["features", "network", "websocket", "toggles", "actions"]);
    // Features: 11 registry cards; the section on screen is healthy (its boundary is mounted)
    expect(screen.getByTestId("debug-hud-panel-features")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId("debug-hud-feature-settings")).toHaveAttribute("data-state", "healthy"));
    expect(FEATURE_IDS.map((id) => screen.getByTestId("debug-hud-feature-" + id)).length).toBe(11);
    expect(screen.getByTestId("debug-hud-feature-files")).toHaveAttribute("data-state", "idle");
    // every panel renders without crashing
    for (const id of HUD_PANEL_IDS) {
      act(() => {
        fireEvent.click(screen.getByTestId("debug-hud-tab-" + id));
      });
      expect(screen.getByTestId("debug-hud-panel-" + id)).toBeInTheDocument();
      expect(screen.queryByTestId("debug-hud-panel-error-" + id)).toBeNull();
    }
    act(() => {
      fireEvent.keyDown(window, { key: "Escape" });
    });
    expect(screen.queryByTestId("debug-hud")).toBeNull();
    // switching the HUD off in Settings removes the key (no residue)
    act(() => {
      fireEvent.click(screen.getByTestId("settings-debug-hud-toggle"));
    });
    expect(window.localStorage.getItem("f109:enabled")).toBeNull();
    pressShiftF12();
    expect(screen.queryByTestId("debug-hud")).toBeNull();
  });

  it("a toggle disables a feature at the NEXT route change, and Re-enable brings it back", async () => {
    window.localStorage.setItem(HUD_ENABLED_KEY, "true");
    const { container } = renderAt("#/health");
    pressShiftF12();
    act(() => {
      fireEvent.click(screen.getByTestId("debug-hud-tab-toggles"));
    });
    const sw = screen.getByTestId("debug-hud-toggle-health");
    expect(sw).toHaveAttribute("aria-checked", "true");
    act(() => {
      fireEvent.click(sw);
    });
    expect(JSON.parse(window.localStorage.getItem(HUD_TOGGLES_KEY) || "{}")).toEqual({ health: "off" });
    // the section on screen is NOT yanked mid-render
    expect(screen.queryByTestId("feature-disabled-health")).toBeNull();
    clickNav(container, "/settings");
    await waitFor(() => expect(mountedFeatureIds()).toContain("settings"));
    clickNav(container, "/health");
    expect(await screen.findByTestId("feature-disabled-health")).toBeInTheDocument();
    act(() => {
      fireEvent.click(screen.getByTestId("debug-hud-tab-features"));
    });
    expect(screen.getByTestId("debug-hud-feature-health")).toHaveAttribute("data-state", "disabled");
    // the other ten sections are untouched
    clickNav(container, "/settings");
    await waitFor(() => expect(screen.queryByTestId("feature-disabled-settings")).toBeNull());
    clickNav(container, "/health");
    act(() => {
      fireEvent.click(screen.getByTestId("feature-disabled-health-enable"));
    });
    await waitFor(() => expect(screen.queryByTestId("feature-disabled-health")).toBeNull());
    expect(window.localStorage.getItem(HUD_TOGGLES_KEY)).toBeNull(); // nothing off = key removed
  });

  it("switching the HUD off re-enables a toggled-off section on the next mount", async () => {
    window.localStorage.setItem(HUD_ENABLED_KEY, "true");
    window.localStorage.setItem(HUD_TOGGLES_KEY, JSON.stringify({ mirror: "off" }));
    const { container } = renderAt("#/mirror");
    expect(screen.getByTestId("feature-disabled-mirror")).toBeInTheDocument();
    act(() => setHudEnabled(false));
    clickNav(container, "/settings");
    clickNav(container, "/mirror");
    await waitFor(() => expect(screen.queryByTestId("feature-disabled-mirror")).toBeNull());
    expect(window.localStorage.getItem(HUD_TOGGLES_KEY)).toBe('{"mirror":"off"}'); // still stored, inert
  });
});

describe("F109 panels: network, websocket, actions", () => {
  it("Network rows come from passive resource timing with query strings stripped", async () => {
    let feed: ((list: { getEntries: () => unknown[] }) => void) | null = null;
    const observed: unknown[] = [];
    class FakePO {
      constructor(cb: Any) {
        feed = cb;
      }
      observe(o: unknown) {
        observed.push(o);
      }
      disconnect() {
        feed = null;
      }
    }
    (window as Any).PerformanceObserver = FakePO; // removed again in afterEach
    window.localStorage.setItem(HUD_ENABLED_KEY, "true");
    renderAt("#/");
    pressShiftF12();
    act(() => {
      fireEvent.click(screen.getByTestId("debug-hud-tab-network"));
    });
    expect(screen.getByTestId("debug-hud-net-empty")).toBeInTheDocument();
    expect(observed).toEqual([{ type: "resource", buffered: true }]);
    act(() => {
      feed!({
        getEntries: () => [
          { name: "http://x/api/progress?key=" + TOKEN, initiatorType: "fetch", duration: 4, responseStatus: 200, transferSize: 10 },
          { name: "http://x/logo.png", initiatorType: "img", duration: 1 },
          { name: "http://x/api/diag?key=" + TOKEN, initiatorType: "xmlhttprequest", duration: 9, responseStatus: 503 },
        ],
      });
    });
    const rows = await screen.findAllByTestId("debug-hud-net-row");
    expect(rows.length).toBe(2); // the image is not network traffic the HUD lists
    const text = screen.getByTestId("debug-hud-net-list").textContent || "";
    expect(text).toContain("http://x/api/progress");
    expect(text).toContain("503");
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain("?");
  });

  it("WebSocket rows are descriptors (type + bytes), never payloads", async () => {
    window.localStorage.setItem(HUD_ENABLED_KEY, "true");
    renderAt("#/");
    pressShiftF12();
    act(() => {
      fireEvent.click(screen.getByTestId("debug-hud-tab-websocket"));
    });
    expect(screen.getByTestId("debug-hud-ws-empty")).toBeInTheDocument();
    act(() => {
      recordWsFrame("open");
      recordWsFrame("in", JSON.stringify({ type: "progress", key: TOKEN, files: ["C:/secret.txt"] }));
      recordWsFrame("out", "hello");
      recordWsFrame("close", 1006);
    });
    const list = await screen.findByTestId("debug-hud-ws-list");
    expect(screen.getAllByTestId("debug-hud-ws-row").length).toBe(4);
    const text = list.textContent || "";
    expect(text).toContain("progress");
    expect(text).toContain("close:1006");
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain("secret.txt");
    expect(screen.getByTestId("debug-hud-ws-state").textContent).toContain("socket:");
  });

  it("Actions: full-capture switch reuses the dvr.full* keys; Share copies redacted text; Clear empties buffers", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    window.localStorage.setItem(HUD_ENABLED_KEY, "true");
    renderAt("#/");
    pressShiftF12();
    act(() => {
      recordWsFrame("in", JSON.stringify({ type: "progress", key: TOKEN }));
      fireEvent.click(screen.getByTestId("debug-hud-tab-actions"));
    });
    // handoff #11: the three orphan keys render through i18n (no raw key leaks)
    expect(screen.getByTestId("debug-hud-action-full").textContent).toBe("Start full capture (local only)");
    expect(screen.getByTestId("debug-hud-full-warning").textContent).toMatch(/^Optional full capture stores/);
    expect(screen.getByTestId("debug-hud-action-export")).toBeDisabled(); // nothing to export without a session
    await act(async () => {
      fireEvent.click(screen.getByTestId("debug-hud-action-share"));
    });
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const copied = String((writeText.mock.calls[0] as unknown[])[0]);
    expect(copied).toContain("Mission Control Debug HUD (F109)");
    expect(copied).toContain("features: 11 registered");
    expect(copied).toContain("websocket:");
    expect(copied).not.toContain(TOKEN);
    expect(hudWsFrames().length).toBe(1);
    act(() => {
      fireEvent.click(screen.getByTestId("debug-hud-action-clear"));
    });
    expect(hudWsFrames()).toEqual([]);
    expect(screen.getByTestId("debug-hud-action-note").textContent).toContain("cleared");
  });
});

describe("F109 fences and non-regression", () => {
  it("a crashing HUD panel is fenced to one line + Retry; the page survives", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    function Boom(): JSX.Element {
      throw new Error("panel exploded ?key=" + TOKEN);
    }
    render(
      <div>
        <span data-testid="survivor">still here</span>
        <HudPanelBoundary id="network">
          <Boom />
        </HudPanelBoundary>
      </div>,
    );
    expect(screen.getByTestId("debug-hud-panel-error-network")).toBeInTheDocument();
    expect(screen.getByTestId("debug-hud-panel-retry-network")).toBeInTheDocument();
    expect(screen.getByTestId("survivor")).toBeInTheDocument();
    spy.mockRestore();
  });

  it("HUD clicks never reach F104's global capture; ordinary clicks still do", () => {
    window.localStorage.setItem(HUD_ENABLED_KEY, "true");
    const record = vi.fn((rec: Any) => ({ ...rec, id: "r" + record.mock.calls.length, ts: "t" }));
    const update = vi.fn();
    __resetGlobalClickCaptureForTests();
    const uninstall = installGlobalClickCapture({ record, update } as Any, { trustCheck: false, windowMs: 0 });
    try {
      renderAt("#/settings");
      pressShiftF12();
      act(() => {
        fireEvent.click(screen.getByTestId("debug-hud-tab-network"));
        fireEvent.click(screen.getByTestId("debug-hud-close"));
      });
      expect(record).not.toHaveBeenCalled();
      act(() => {
        fireEvent.click(screen.getByTestId("settings-theme-dark"));
      });
      expect(record).toHaveBeenCalledTimes(1);
      expect(String((record.mock.calls[0] as Any[])[0].action)).toContain("settings-theme-dark");
    } finally {
      uninstall();
    }
  });

  it("§LAB check: Collector mounted in the lab with the HUD open - one fence, no cascade, no crash card", async () => {
    window.localStorage.setItem(HUD_ENABLED_KEY, "true");
    renderAt("#/lab/collector");
    pressShiftF12();
    expect(await screen.findByTestId("feature-lab-collector")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId("debug-hud-feature-collector")).toHaveAttribute("data-state", "healthy"));
    expect(mountedFeatureIds()).toEqual(["collector"]);
    expect(screen.queryByTestId("feature-boundary-collector")).toBeNull();
    for (const id of FEATURE_IDS.filter((x) => x !== "collector")) {
      expect(screen.getByTestId("debug-hud-feature-" + id)).toHaveAttribute("data-state", "idle");
    }
  });

  it("§LAB-DISCOVERS-PROD-BUGS regression: a forced lab scenario does not outlive the lab when F101 wrapped on top", async () => {
    __resetLabStoreForTests();
    __resetLabFetchMockForTests();
    const base = vi.fn(() =>
      Promise.resolve({ ok: true, status: 200, headers: { get: () => null, forEach: () => undefined }, clone() { return this; }, text: () => Promise.resolve("{}"), json: () => Promise.resolve({}) } as Any),
    );
    const setupFetch = window.fetch;
    window.fetch = base as Any;
    try {
    const off = installLabFetchMock(); // the lab route mounts
    await window.fetch("/api/collector/state"); // observe first (passthrough)
    useLabStore.getState().setScenario("/api/collector/state", "error500"); // operator forces a failure
    const mocked: Any = await window.fetch("/api/collector/state");
    expect(mocked.status).toBe(500); // positive control: the lab really was mocking
    installFetchObserver(); // the SHIPPED Collector page mounts inside the lab (Collector.tsx)
    off(); // operator leaves the lab
    const after: Any = await window.fetch("/api/collector/state");
    expect(after.status).toBe(200);
    expect(after.headers.get(LAB_MOCK_HEADER)).toBeNull();
    expect(base).toHaveBeenCalledTimes(2); // observe + the post-lab request reached the real backend
    } finally {
      // F101's observer is permanent by design; put back the exact setup.ts stub
      window.fetch = setupFetch;
      __resetLabStoreForTests();
      __resetLabFetchMockForTests();
    }
  });
});
