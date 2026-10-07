// [F103 §3/§4/§6] Reachability banner, status=0 classifier and the
// sync-before-paint snapshot — runtime proof, not grep.
//
// Operator bundle fdd57261-button-actions.json: 18/18 button rows came back
// status=0 / elapsedMs=null with "/api/health did not answer" while ws=live.
// Those three facts together are the signature of a CORS preflight denial, and
// the UI said none of it. These tests drive the real components.
import { beforeEach, describe, expect, it, vi, afterEach } from "vitest";

vi.mock("@/lib/api", () => ({
  apiBase: () => "http://100.83.53.46:7331",
  getDashToken: () => "t".repeat(32),
  hasDashToken: () => true,
}));

import { render, screen, waitFor, cleanup } from "@testing-library/react";
import { ReachabilityBanner } from "@/components/ReachabilityBanner";
import {
  classifyStatus0Sync,
  classifyStatus0,
  isMixedContent,
  resetReachabilityCache,
  probeHealth,
  backendOrigin,
} from "@/lib/reachability";
import { COLLECTOR_STORE_KEY, loadActionsFromLocalStorage, type ButtonAction } from "@/lib/collectorAgent";

const realFetch = global.fetch;

afterEach(() => {
  cleanup();
  global.fetch = realFetch;
  resetReachabilityCache();
});

describe("F103 §4 status=0 classifier", () => {
  it("names mixed content when an HTTPS page points at an HTTP backend", () => {
    const c = classifyStatus0Sync({ origin: "https://dekarita.github.io", backendOrigin: "http://100.83.53.46:7331", optionsOk: null });
    expect(c.category).toBe("mixed-content");
    expect(c.reason).toMatch(/Mixed content/i);
    expect(c.suggestedFix).toMatch(/HTTPS|reverse proxy/i);
    expect(isMixedContent("https://a.test", "http://b.test")).toBe(true);
  });

  it("names the CORS preflight when OPTIONS failed (the operator's 18 records)", () => {
    const c = classifyStatus0Sync({ origin: "http://127.0.0.1:5173", backendOrigin: "http://100.83.53.46:7331", optionsOk: false, wsLive: true });
    expect(c.category).toBe("cors-preflight");
    expect(c.reason).toMatch(/preflight/i);
    expect(c.suggestedFix).toMatch(/X-Dash-Token/);
  });

  it("falls back to network, and says ws=live is expected", () => {
    const c = classifyStatus0Sync({ origin: "http://127.0.0.1:5173", backendOrigin: "http://100.83.53.46:7331", optionsOk: true, wsLive: true });
    expect(c.category).toBe("network");
    expect(c.reason).toMatch(/WebSocket is live/);
    expect(c.suggestedFix).toMatch(/Tailscale/i);
  });

  it("classifyStatus0 probes OPTIONS and reports cors-preflight when it is refused", async () => {
    global.fetch = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    const c = await classifyStatus0({ origin: "http://127.0.0.1:5173", backend: "http://100.83.53.46:7331" });
    expect(c.category).toBe("cors-preflight");
  });

  it("a status=0 probe records elapsedMs=null and the error, exactly like the bundle", async () => {
    global.fetch = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    const r = await probeHealth(50);
    expect(r.status).toBe(0);
    expect(r.elapsedMs).toBeNull();
    expect(r.error).toMatch(/Failed to fetch/);
    expect(backendOrigin()).toBe("http://100.83.53.46:7331");
  });
});

describe("F103 §3 reachability banner", () => {
  it("appears when /api/health does not answer, and names both origins", async () => {
    global.fetch = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    render(<ReachabilityBanner />);
    const el = await screen.findByTestId("reachability-banner");
    expect(el.textContent).toMatch(/Backend unreachable from this origin/);
    expect(el.textContent).toMatch(/status=0/);
    expect(screen.getByTestId("reachability-banner-pair").textContent).toContain("http://100.83.53.46:7331");
    expect(screen.getByTestId("reachability-troubleshoot").getAttribute("href")).toBe("#/collector?troubleshoot=reachability");
  });

  it("stays invisible while /api/health answers", async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })) as unknown as typeof fetch;
    render(<ReachabilityBanner />);
    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    expect(screen.queryByTestId("reachability-banner")).toBeNull();
  });
});

describe("F103 §6 persistence before paint", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("loadActionsFromLocalStorage returns the persisted rows synchronously", () => {
    const rows: ButtonAction[] = [
      { id: "act_1", ts: new Date().toISOString(), feature: "add-site", action: "openModal", params: {}, result: { ok: true }, elapsedMs: 12 } as unknown as ButtonAction,
    ];
    localStorage.setItem(COLLECTOR_STORE_KEY, JSON.stringify({ state: { actions: rows }, version: 0 }));
    const out = loadActionsFromLocalStorage();
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe("act_1");
  });

  it("never throws on a malformed envelope (it must not blank the page)", () => {
    localStorage.setItem(COLLECTOR_STORE_KEY, "{not json");
    expect(() => loadActionsFromLocalStorage()).not.toThrow();
    expect(Array.isArray(loadActionsFromLocalStorage())).toBe(true);
  });
});
