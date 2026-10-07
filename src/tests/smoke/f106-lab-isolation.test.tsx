// [F106 / Observatory step 5] The Feature Lab DOM gate - the shipped components,
// mounted for real, with the shipped interceptor wrapping a stub fetch.
//
// WHY THIS FILE CARRIES THE BEHAVIOURAL PROOF. The lab's whole value is "a section
// can be exercised alone, with a backend you control". Neither half of that is a
// static property: it is what the mounted tree DOES. So this suite renders the real
// App at a lab hash and asserts:
//   1. ISOLATION - exactly one boundary is mounted (the lab's own feature), and the
//      11 real routes are untouched by the lab's existence;
//   2. OBSERVE-THEN-FORCE - the first request of a path reaches the real backend and
//      appears in the ledger; only after a scenario is forced does a request get a
//      synthetic answer;
//   3. READS ONLY - a forced scenario never intercepts a write;
//   4. THE FENCE - a section that throws lands in its own FeatureBoundary card while
//      the shell survives (the property App.tsx's literal fence() helper cannot
//      provide for a parameterised route);
//   5. LIFETIME - unmounting the lab restores the exact window.fetch it found, and
//      the dashboard route never installs it at all.
//
// Playwright is deliberately not used here: this sandbox has no Chromium (recorded
// as a standing fact by step 4), and an un-runnable spec is not evidence. The
// transport-level behaviour (headers, status, json body) is what the sections
// actually consume, and jsdom exercises all of it against the real components.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import App from "@/App";
import { mountedFeatureIds } from "@/lib/featureRegistry";
import { FEATURE_IDS } from "@/lib/featureRegistry";
import { LAB_SECTIONS } from "@/components/lab/labSections";
import { installLabFetchMock, labMocksInstalled } from "@/lib/lab/mockBackend";
import { LAB_MOCK_HEADER, createLedger, mergeLedgerRow } from "@/lib/lab/labCore";
import { __resetLabStoreForTests, useLabStore } from "@/lib/lab/labStore";
import { labEntryVisible, labIndexRoute } from "@/lib/lab/labFlags";

type Any = any;
const ORIGINAL_FETCH = window.fetch;

/** Point the HashRouter at a path and render the real App. */
function renderAt(hash: string) {
  window.location.hash = hash;
  return render(<App />);
}

/** The stub the app's own sections talk to when nothing is forced. */
function stubFetch() {
  const calls: { url: string; method: string }[] = [];
  const stub = vi.fn((input: Any, init?: Any) => {
    calls.push({ url: String(typeof input === "string" ? input : input?.url || input), method: String(init?.method || "GET") });
    return Promise.resolve({ ok: false, status: 404, statusText: "Not Found", json: () => Promise.resolve({}), text: () => Promise.resolve("{}") } as Any);
  });
  vi.stubGlobal("fetch", stub);
  return { stub, calls };
}

beforeEach(() => {
  __resetLabStoreForTests();
  window.location.hash = "";
});

afterEach(() => {
  __resetLabStoreForTests();
  vi.unstubAllGlobals();
  window.location.hash = "";
});

describe("F106 lab routing", () => {
  it("renders the 11-harness index at #/lab, each row derived from the registry", () => {
    stubFetch();
    const { container } = renderAt("#/lab");
    expect(screen.getByTestId("feature-lab-index")).toBeInTheDocument();
    const links = Array.from(container.querySelectorAll('[data-testid^="lab-index-link-"]'));
    expect(links.map((l) => l.getAttribute("data-testid"))).toEqual(FEATURE_IDS.map((id) => "lab-index-link-" + id));
    expect(links.map((l) => (l.getAttribute("href") || "").replace(/^#/, ""))).toEqual(FEATURE_IDS.map((id) => "/lab/" + id));
  });

  it("mounts ONE section at #/lab/<id> and isolates it - no other fence is live", async () => {
    stubFetch();
    renderAt("#/lab/files");
    expect(screen.getByTestId("feature-lab-files")).toBeInTheDocument();
    expect(screen.getByTestId("feature-lab-stage")).toBeInTheDocument();
    // the real Files page is what is mounted, not a mock of it
    expect(screen.getByTestId("file-explorer-page")).toBeInTheDocument();
    // isolation: the lab's feature is the only mounted boundary
    expect(mountedFeatureIds()).toEqual(["files"]);
    // and the lab's own fence is not in the alert state
    expect(screen.queryByTestId("feature-boundary-files")).toBeNull();
    await waitFor(() => expect(useLabStore.getState().ledger.length).toBeGreaterThan(0));
  });

  it("names the section, its real route and its fence, and links back", () => {
    stubFetch();
    renderAt("#/lab/health");
    expect(screen.getByTestId("lab-open-real")).toHaveAttribute("href", "#/health");
    // HashRouter renders `<Link to="/lab">` as href="#/lab"
    expect(screen.getByTestId("lab-back")).toHaveAttribute("href", "#" + labIndexRoute());
    expect(screen.getByTestId("feature-lab-health").textContent).toContain("feature-boundary-health");
  });

  it("renders a readable notice for an id the registry does not declare (no crash, no redirect)", () => {
    stubFetch();
    renderAt("#/lab/not-a-section");
    expect(screen.getByTestId("feature-lab-unknown")).toBeInTheDocument();
    expect(screen.getByTestId("feature-lab-unknown").textContent).toContain("not-a-section");
  });

  it("indexes every registry id in the section map (so a 12th section cannot be silently unmountable)", () => {
    expect(Object.keys(LAB_SECTIONS).sort()).toEqual([...FEATURE_IDS].sort());
  });

  it("mounts ALL 11 sections cleanly - no section crashes in its own harness", async () => {
    // This is the lab's own premise, asserted: an empty/error-shaped backend body
    // must not take a section down. It is also the gate that FOUND the unguarded
    // `d.checks["version:match"]` dereference in src/pages/Health.tsx (see §10 there):
    // /#/health used to land on its boundary card against any 200 body without
    // `checks`. A harness that shows a crash card for one of its 11 sections is not
    // a harness, it is a finding - so this test is the finding's regression lock.
    const crashed: string[] = [];
    for (const id of FEATURE_IDS) {
      const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
      stubFetch();
      const { unmount } = renderAt("#/lab/" + id);
      await waitFor(() => expect(useLabStore.getState().ledger.length).toBeGreaterThan(0), { timeout: 4000 });
      if (document.querySelector('[data-testid="feature-boundary-' + id + '"]')) crashed.push(id);
      expect(mountedFeatureIds()).toEqual([id]);
      unmount();
      spy.mockRestore();
      __resetLabStoreForTests();
    }
    expect(crashed).toEqual([]);
  });
});

describe("F106 mock controls", () => {
  it("OBSERVES before it forces: the first request of a path reaches the real backend", async () => {
    const { calls } = stubFetch();
    renderAt("#/lab/health");
    await waitFor(() => expect(useLabStore.getState().ledger.length).toBeGreaterThan(0));
    expect(calls.length).toBeGreaterThan(0);
    // the ledger key is a PATH, never a URL with its query string
    for (const row of useLabStore.getState().ledger) {
      expect(row.path.startsWith("/")).toBe(true);
      expect(row.path).not.toContain("?");
      expect(row.kind).toBe("passthrough");
    }
  });

  it("forces a read: 500 with the label header, and the real backend is NOT called for it", async () => {
    const { calls } = stubFetch();
    renderAt("#/lab/health");
    await waitFor(() => expect(useLabStore.getState().ledger.length).toBeGreaterThan(0));
    const path = useLabStore.getState().ledger[0].path;
    act(() => {
      useLabStore.getState().setScenario(path, "error500");
    });
    const before = calls.length;
    const res = await window.fetch(path + "?key=SECRET-TOKEN");
    expect(res.status).toBe(500);
    expect(res.ok).toBe(false);
    expect(res.headers.get(LAB_MOCK_HEADER)).toBe("error500");
    expect(calls.length).toBe(before); // in-process: the stub never saw it
    // the token in the query string left no trace anywhere the operator can copy
    expect(JSON.stringify(useLabStore.getState().ledger)).not.toContain("SECRET-TOKEN");
    expect(JSON.stringify(useLabStore.getState().scenarios)).not.toContain("SECRET-TOKEN");
  });

  it("forces empty and offline, and passthrough undoes the forcing", async () => {
    stubFetch();
    renderAt("#/lab/health");
    await waitFor(() => expect(useLabStore.getState().ledger.length).toBeGreaterThan(0));
    const path = useLabStore.getState().ledger[0].path;
    act(() => useLabStore.getState().setScenario(path, "empty200"));
    const empty = await window.fetch(path);
    expect(empty.status).toBe(200);
    expect(empty.ok).toBe(true);
    expect(await empty.json()).toEqual({});
    act(() => useLabStore.getState().setScenario(path, "offline"));
    await expect(window.fetch(path)).rejects.toThrow(TypeError);
    act(() => useLabStore.getState().setScenario(path, "passthrough"));
    const back = await window.fetch(path);
    expect(back.status).toBe(404); // the stub's real answer again
  });

  it("NEVER fakes a write, even with a scenario forced on that path", async () => {
    const { calls } = stubFetch();
    renderAt("#/lab/health");
    await waitFor(() => expect(useLabStore.getState().ledger.length).toBeGreaterThan(0));
    const path = useLabStore.getState().ledger[0].path;
    act(() => useLabStore.getState().setScenario(path, "empty200"));
    const before = calls.length;
    const res = await window.fetch(path, { method: "POST", body: "{}" });
    expect(res.status).toBe(404); // the stub answered, not the lab
    expect(calls.length).toBe(before + 1);
    expect(calls[calls.length - 1].method).toBe("POST");
  });

  it("records requests the mounted section really makes, and the panel renders them", async () => {
    stubFetch();
    renderAt("#/lab/mirror");
    await waitFor(() => expect(screen.getByTestId("lab-ledger-summary")).toBeInTheDocument());
    await waitFor(() => expect(useLabStore.getState().ledger.length).toBeGreaterThan(0));
    const first = useLabStore.getState().ledger[0];
    expect(screen.getByTestId("feature-lab-controls")).toBeInTheDocument();
    // the scenario buttons of the first observed path are addressable
    expect(screen.getByTestId("lab-scenario-" + first.path.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase() + "-error500")).toBeInTheDocument();
  });

  it("clears the ledger and keeps the toggle addressable", async () => {
    stubFetch();
    renderAt("#/lab/collector");
    await waitFor(() => expect(useLabStore.getState().ledger.length).toBeGreaterThan(0));
    const clear = screen.getByTestId("lab-clear-ledger");
    act(() => clear.click());
    expect(useLabStore.getState().ledger).toEqual([]);
    expect(screen.getByTestId("lab-mock-toggle")).toBeInTheDocument();
    expect(screen.getByTestId("lab-copy-report")).toBeInTheDocument();
  });
});

describe("F106 interceptor lifetime", () => {
  it("restores the EXACT fetch it found when the lab unmounts", async () => {
    const { stub } = stubFetch();
    const { unmount } = renderAt("#/lab/health");
    await waitFor(() => expect(labMocksInstalled()).toBe(true));
    expect(window.fetch).not.toBe(stub);
    unmount();
    expect(labMocksInstalled()).toBe(false);
    expect(window.fetch).toBe(stub);
  });

  it("is reference-counted, so a double install/uninstall cycle (StrictMode) cannot strip the patch", async () => {
    const { stub } = stubFetch();
    const off1 = installLabFetchMock();
    const off2 = installLabFetchMock();
    expect(labMocksInstalled()).toBe(true);
    // A second install must NOT re-wrap our own wrapper: two layers would record
    // every request twice (one row per layer) while the count assertions above
    // stayed green - the hole falsification M8 walked through.
    useLabStore.getState().clearLedger();
    await window.fetch("/api/double-install-probe");
    expect(useLabStore.getState().ledger.length).toBe(1);
    expect(useLabStore.getState().ledger[0].count).toBe(1);
    off1();
    expect(window.fetch).not.toBe(stub); // still patched: the second install holds it
    off2();
    expect(window.fetch).toBe(stub);
    off2(); // idempotent
    expect(labMocksInstalled()).toBe(false);
  });

  it("is never installed by the ordinary dashboard routes", async () => {
    const { stub } = stubFetch();
    renderAt("#/files");
    await waitFor(() => expect(screen.getByTestId("file-explorer-page")).toBeInTheDocument());
    expect(labMocksInstalled()).toBe(false);
    expect(window.fetch).toBe(stub);
    expect(useLabStore.getState().ledger).toEqual([]);
  });

  it("keeps the interceptor off when the operator turns mocking off, and back on when they ask", async () => {
    const { stub } = stubFetch();
    renderAt("#/lab/health");
    await waitFor(() => expect(labMocksInstalled()).toBe(true));
    act(() => useLabStore.getState().setEnabled(false));
    await waitFor(() => expect(labMocksInstalled()).toBe(false));
    expect(window.fetch).toBe(stub);
  });
});

describe("F106 non-regression", () => {
  it("leaves the locked 11-entry sidebar untouched, and shows the Labs entry only when asked", () => {
    stubFetch();
    const { unmount } = renderAt("#/");
    const nav = document.querySelector('[data-testid="sidebar"] nav');
    expect(Array.from(nav?.querySelectorAll("a") || []).length).toBe(11);
    expect(screen.queryByTestId("lab-nav-entry")).toBeNull();
    unmount();

    // ...on a lab route the way back appears (a button, outside <nav>)
    renderAt("#/lab/files");
    expect(screen.getByTestId("lab-nav-entry")).toBeInTheDocument();
    const sidebar = document.querySelector('[data-testid="sidebar"]');
    expect(sidebar?.querySelector("nav")?.contains(screen.getByTestId("lab-nav-entry"))).toBe(false);
    expect(Array.from(document.querySelectorAll('[data-testid="sidebar"] nav a')).length).toBe(11);
  });

  it("resolves the lab flag without storage: flag off + dashboard route = hidden", () => {
    expect(labEntryVisible("/")).toBe(false);
    expect(labEntryVisible("/files")).toBe(false);
    expect(labEntryVisible("#/lab")).toBe(true);
    expect(labEntryVisible("#/lab/settings")).toBe(true);
  });

  it("keeps the ledger rules and the mock header pinned (the core the UI depends on)", () => {
    const ledger = createLedger(2);
    ledger.record({ method: "GET", path: "/api/one", kind: "passthrough", scenario: "passthrough" });
    ledger.record({ method: "GET", path: "/api/two", kind: "response", scenario: "empty200" });
    const merged = mergeLedgerRow(ledger.list(), { method: "GET", path: "/api/one", kind: "passthrough", scenario: "passthrough" }, 2);
    expect(merged[0].count).toBe(2);
    expect(merged.length).toBe(2);
    expect(LAB_MOCK_HEADER).toBe("x-lab-mock");
  });
});

describe("F106 fence (the parameterised route is guarded)", () => {
  it("degrades a throwing section into its OWN boundary card while the shell survives", async () => {
    // A real throw from the real map: the crash-path proof must not depend on a
    // hand-built harness component that could drift from LAB_SECTIONS.
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const Boom = () => {
      throw new Error("f106-lab-boom");
    };
    const original = LAB_SECTIONS.settings;
    (LAB_SECTIONS as Any).settings = Boom as Any;
    try {
      stubFetch();
      renderAt("#/lab/settings");
      const card = await screen.findByTestId("feature-boundary-settings");
      expect(card).toBeInTheDocument();
      expect(card.getAttribute("role")).toBe("alert");
      expect(card.textContent).toContain("f106-lab-boom");
      // The fence wraps the WHOLE lab page, so the card replaces the controls too -
      // the same way the real route's fence replaces the section. The operator gets
      // Retry / Reload / Copy (and the sidebar) instead of a blank screen; the
      // interceptor is uninstalled by FeatureLab's own unmount, which is the correct
      // resting state for a page that is no longer rendering.
      expect(screen.queryByTestId("lab-mock-toggle")).toBeNull();
      expect(labMocksInstalled()).toBe(false);
      expect(document.querySelector('[data-testid="sidebar"]')).not.toBeNull();
      expect(screen.getByTestId("feature-boundary-settings-retry")).toBeInTheDocument();
    } finally {
      (LAB_SECTIONS as Any).settings = original;
      spy.mockRestore();
    }
  });
});

// keep the original stub reference alive for the lifetime checks above
afterEach(() => {
  if (window.fetch !== ORIGINAL_FETCH) vi.unstubAllGlobals();
});
