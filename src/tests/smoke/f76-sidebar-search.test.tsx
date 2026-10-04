// [F76] Regression cells for F76-UI-WIRING-FIX:
//  §2.1 Search is a visible sidebar entry in slot 2 (Overview, Search, Sessions, ...)
//  §2.2 sidebar.search / sidebar.searchLab exist in BOTH catalogs (en + si parity)
//  §1.2 /diag.searchEnabled is informational only; every response keeps Search visible
//  §1.3/S2.3 /search + /search/lab/:targetId stay registered (App.tsx)
// NOTE: vitest `include` is src/tests/smoke/** (vite.config.ts:48), so this F76
// suite lives here rather than at repo-root tests/ to actually run in CI.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import fs from "node:fs";
import path from "node:path";
import App from "@/App";
import Lab from "@/pages/search/Lab";
import SearchPage from "@/pages/Search";
import en from "@/i18n/en.json";
import si from "@/i18n/si.json";

type Any = any;
const SINHALA = /[\u0D80-\u0DFF]/;

// [F76 §3.E] exact sidebar order demanded by the ticket.
const F76_ORDER = ["/", "/search", "/sessions", "/connections", "/keys", "/files", "/mirror", "/telemetry", "/settings"];

function sidebarHrefs(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('[data-testid="sidebar"] nav a')).map((a) =>
    (a.getAttribute("href") || "").replace(/^#/, "")
  );
}

function jsonResponse(data: unknown, ok = true) {
  return { ok, status: ok ? 200 : 500, json: async () => data, text: async () => JSON.stringify(data) };
}

/** fetch stub: /diag answers with the given payload, everything else 404s. */
function stubDiag(payload: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: Any) => {
      const u = String(url);
      if (u.includes("/diag")) return Promise.resolve(jsonResponse(payload));
      return Promise.resolve(jsonResponse({}, false));
    })
  );
}

beforeEach(() => {
  delete (window as Any).__GHRDP_SEARCH_ENABLED;
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete (window as Any).__GHRDP_SEARCH_ENABLED;
});

describe("F76 §2.1 sidebar Search entry", () => {
  it("renders 9 entries in the F76 order with Search directly under Overview", () => {
    const { container } = render(<App />);
    expect(sidebarHrefs(container)).toEqual(F76_ORDER);
    // label comes from the dedicated sidebar.search key (definitive English string)
    const searchLink = document.getElementById("f56.search.nav") as HTMLAnchorElement;
    expect(searchLink).not.toBeNull();
    expect(searchLink.textContent).toContain("Search");
    // the entry is upstream of Sessions in DOM order as well as visually
    const links = sidebarHrefs(container);
    expect(links.indexOf("/search")).toBeLessThan(links.indexOf("/sessions"));
  });

  it("clicking Search navigates to /search and renders the CommandBar", async () => {
    const { container } = render(<App />);
    const link = document.getElementById("f56.search.nav") as HTMLElement;
    await act(async () => {
      fireEvent.click(link);
    });
    expect(screen.getByTestId("search-page")).toBeInTheDocument();
    // Search.tsx:114 renders <CommandBar/>; CommandBar.tsx:67 is its root testid
    expect(screen.getByTestId("hero-bar")).toBeInTheDocument();
    expect(document.getElementById("f56.search.query")).not.toBeNull();
    // the sidebar Search entry is flagged active
    expect((container.querySelector('[aria-current="page"]') as HTMLElement)?.id).toBe("f56.search.nav");
  });
});

describe("F76 §1.3 route registration (source-pinned + rendered)", () => {
  it("App.tsx registers /search and /search/lab/:targetId with the Lab import", () => {
    const app = fs.readFileSync(path.resolve(__dirname, "../../App.tsx"), "utf8");
    expect(app).toContain('import LabPage from "@/pages/search/Lab"');
    expect(app).toMatch(/<Route path="\/search" element=\{<SearchPage \/>\} \/>/);
    expect(app).toMatch(/<Route path="\/search\/lab\/:targetId" element=\{<LabPage \/>\} \/>/);
  });

  it("/search/lab/:targetId renders the Lab scaffold", () => {
    render(
      <MemoryRouter initialEntries={["/search/lab/g1"]}>
        <Routes>
          <Route path="/search" element={<SearchPage />} />
          <Route path="/search/lab/:targetId" element={<Lab />} />
        </Routes>
      </MemoryRouter>
    );
    expect(screen.getByTestId("lab-back-button")).toBeInTheDocument();
    expect(document.getElementById("f56.search.lab.title")).not.toBeNull();
  });
});

describe("F76 §2.2 i18n parity for the new sidebar keys", () => {
  it("en.json AND si.json carry non-empty sidebar.search + sidebar.searchLab", () => {
    for (const cat of [en as Any, si as Any]) {
      expect(typeof cat.sidebar.search).toBe("string");
      expect(cat.sidebar.search.trim().length).toBeGreaterThan(0);
      expect(typeof cat.sidebar.searchLab).toBe("string");
      expect(cat.sidebar.searchLab.trim().length).toBeGreaterThan(0);
    }
    expect((en as Any).sidebar.search).toBe("Search");
    // Sinhala catalog: byte-stable, real Sinhala codepoints
    expect(Buffer.from((si as Any).sidebar.search, "utf8").toString("utf8")).toBe((si as Any).sidebar.search);
    expect(SINHALA.test((si as Any).sidebar.search)).toBe(true);
    expect(SINHALA.test((si as Any).sidebar.searchLab)).toBe(true);
  });
});

describe("F77 /diag.searchEnabled is informational only", () => {
  it("a /diag payload without searchEnabled leaves Search visible", async () => {
    stubDiag({ searchInput: "" });
    const { container } = render(<App />);
    await waitFor(() => expect((window as Any).__GHRDP_SEARCH_INPUT).toBe(""));
    expect((window as Any).__GHRDP_SEARCH_ENABLED).toBeUndefined();
    expect(sidebarHrefs(container)).toContain("/search");
  });

  it("an explicit searchEnabled=false still leaves Search visible", async () => {
    stubDiag({ searchEnabled: false, searchInput: "" });
    const { container } = render(<App />);
    await waitFor(() => expect((window as Any).__GHRDP_SEARCH_INPUT).toBe(""));
    expect((window as Any).__GHRDP_SEARCH_ENABLED).toBeUndefined();
    expect(sidebarHrefs(container)).toContain("/search");
    expect(document.getElementById("f56.search.nav")).not.toBeNull();
  });
});
