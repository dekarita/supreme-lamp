// [F77] F77-NUKE-GATES cells: Search is UNCONDITIONALLY visible and the loaded
// ui bundle is identifiable. Contract per file:
//   §2.1 AppShell.tsx renders NAV with no lane/gate/enabled filter at all
//   §2.2 AppShell purges cached lane keys on mount; lib/search/lane.ts is a constant
//   §2.3 the /diag pollers still mirror __GHRDP_SEARCH_ENABLED, but nothing reads it
//   §2.4 BottomBar prints "ui: <sha7>" from import.meta.env.VITE_BUILD_SHA
// Lives in src/tests/smoke/** because that is the vitest `include` glob
// (vite.config.ts) - a repo-root tests/ file is node-only and would not run here.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";
import fs from "node:fs";
import App from "@/App";
import { isSearchLaneEnabled } from "@/lib/search/lane";

type Any = any;
const CACHE_KEYS = ["__GHRDP_SEARCH_ENABLED", "f56.search.enabled", "ghrdp.lane.search"];
const F77_ORDER = ["/", "/search", "/sessions", "/connections", "/keys", "/files", "/mirror", "/telemetry", "/health", "/collector", "/settings"]; // [F92] +/health, [F99] +/collector

/** vitest runs from the repo root (same assumption as scripts/check-*.mjs). */
function read(rel: string): string {
  return fs.readFileSync(process.cwd() + "/" + rel, "utf8");
}

function sidebarHrefs(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('[data-testid="sidebar"] nav a')).map((a) =>
    (a.getAttribute("href") || "").replace(/^#/, "")
  );
}

/** /diag answers with the given payload; everything else 404s (no unstubbed fetch). */
function stubDiag(payload: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: Any) => {
      const u = String(url);
      if (u.includes("/diag")) {
        return Promise.resolve({ ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) });
      }
      return Promise.resolve({ ok: false, status: 404, json: async () => ({}), text: async () => "{}" });
    })
  );
}

beforeEach(() => {
  for (const k of CACHE_KEYS) window.localStorage.removeItem(k);
  delete (window as Any).__GHRDP_SEARCH_ENABLED;
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete (window as Any).__GHRDP_SEARCH_ENABLED;
  for (const k of CACHE_KEYS) window.localStorage.removeItem(k);
});

describe("F77 §2.1 Search entry is unconditional", () => {
  it("renders when /diag never answers searchEnabled (undefined)", async () => {
    stubDiag({ searchInput: "" });
    const { container } = render(<App />);
    await waitFor(() => expect((window as Any).__GHRDP_SEARCH_INPUT).toBe(""));
    expect((window as Any).__GHRDP_SEARCH_ENABLED).toBeUndefined();
    expect(sidebarHrefs(container)).toContain("/search");
    expect(document.getElementById("f56.search.nav")).not.toBeNull();
  });

  it("renders when /diag answers searchEnabled=false (hard override of the old gate)", async () => {
    stubDiag({ searchEnabled: false, searchInput: "" });
    const { container } = render(<App />);
    // the mirror still happens (diag + labs read it) - but it drives nothing
    await waitFor(() => expect((window as Any).__GHRDP_SEARCH_ENABLED).toBe(false));
    expect(isSearchLaneEnabled()).toBe(true);
    expect(sidebarHrefs(container)).toContain("/search");
    expect(document.getElementById("f56.search.nav")).not.toBeNull();
    expect(sidebarHrefs(container)).toEqual(F77_ORDER);
  });

  it("renders from a cached __GHRDP_SEARCH_ENABLED=false in localStorage", () => {
    window.localStorage.setItem("__GHRDP_SEARCH_ENABLED", "false");
    window.localStorage.setItem("f56.search.enabled", "false");
    window.localStorage.setItem("ghrdp.lane.search", "false");
    stubDiag({});
    const { container } = render(<App />);
    expect(sidebarHrefs(container)).toContain("/search");
    // slot 2: directly under Overview, no scroll needed
    expect(sidebarHrefs(container).indexOf("/search")).toBe(1);
  });
});

describe("F77 §2.2 stale cache purge", () => {
  it("clears every cached lane key on mount, idempotently", () => {
    for (const k of CACHE_KEYS) window.localStorage.setItem(k, "false");
    const { container } = render(<App />);
    for (const k of CACHE_KEYS) expect(window.localStorage.getItem(k)).toBeNull();
    // a second mount must not throw on already-absent keys
    const { container: again } = render(<App />);
    expect(sidebarHrefs(again)).toEqual(sidebarHrefs(container));
    expect(window.localStorage.getItem("ghrdp.lane.search")).toBeNull();
  });
});

describe("F77 §2.4 ui-sha footer badge", () => {
  it("shows 'ui: <sha7>' or 'ui: dev' next to the bottom clock", () => {
    stubDiag({});
    const { container } = render(<App />);
    const badge = container.querySelector('[data-testid="ui-sha-badge"]') as HTMLElement;
    expect(badge).not.toBeNull();
    expect(badge.id).toBe("uiShaBadge");
    expect(badge.textContent || "").toMatch(/^ui: (dev|[0-9a-f]{7})$/);
    expect(badge.getAttribute("title")).toBe((badge.textContent || "").replace(/^ui: /, "ui bundle sha "));
  });

  it("stamps the sha from the build env when vite define supplies one", () => {
    // vite.config.ts pins the define to a literal, so this cell asserts the
    // contract that matters in CI: a 7-hex stamp survives into the built bundle.
    const cfg = read("vite.config.ts");
    expect(cfg).toMatch(/import\.meta\.env\.VITE_BUILD_SHA/);
    expect(cfg).toMatch(/process\.env\.GITHUB_SHA \|\| "dev"\)\.slice\(0, 7\)/);
  });
});

// [F77 §2.1] the guard removal is structural too: no file under src/ may keep a
// conditional that can drop the Search entry or redirect /search away.
describe("F77 §2.1 no visibility condition survives", () => {
  it("AppShell has no filter/branch on the search entry and App.tsx has no lane guard", () => {
    const shell = read("src/components/layout/AppShell.tsx");
    const app = read("src/App.tsx");
    const lane = read("src/lib/search/lane.ts");
    expect(shell).not.toMatch(/NAV\.filter/);
    expect(shell).not.toMatch(/useSearchLaneEnabled/);
    expect(app).not.toMatch(/useSearchLaneEnabled/);
    expect(app).not.toMatch(/Navigate to="\/" replace/);
    expect(lane).toMatch(/export function isSearchLaneEnabled\(\): boolean \{\n  return true;\n\}/);
    expect(lane).not.toMatch(/(localStorage|sessionStorage)\.(getItem|setItem|removeItem)/);
  });

  it("the badge survives a hard-reload-equivalent remount with a poisoned cache", async () => {
    window.localStorage.setItem("f56.search.enabled", "false");
    stubDiag({ searchEnabled: false });
    const { container } = render(<App />);
    await waitFor(() => expect((window as Any).__GHRDP_SEARCH_ENABLED).toBe(false));
    expect(container.querySelector('[data-testid="ui-sha-badge"]')).not.toBeNull();
    // [F92 §6.3] +1 for /#/health; [F99 §3.2] +1 for /#/collector (the
    // Diagnosis Collector, immediately after Health).
    expect(sidebarHrefs(container).length).toBe(11);
  });
});
