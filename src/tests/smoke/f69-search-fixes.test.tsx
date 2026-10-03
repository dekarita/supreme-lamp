// [F69-FIX] Regression cells for the F68-SEARCH-AUDIT fixes:
//  §1.3 DEV fixture stream also fires on phase "failed" (F68 §H.2)
//  §1.4 search_enable flag hides the sidebar entry + redirects /search (F68 §H.5)
//  §1.5 "Fetch started" text only after an accepted fetch (F68 §H.6)
//  §2.1 default adapter pre-selected (F68 Extension Rank 1)
//  §2.2 file-type badge derivation + rendering (F68 Extension Rank 2)
//  §2.5 progress rail renders transport / status / cancel from FetchAccepted (Rank 7)
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import "@/i18n";
import App from "@/App";
import Search from "@/pages/Search";
import { shouldStreamDevFixture } from "@/pages/search/devFixture";
import { fileExtension } from "@/pages/search/tokens";
import { announceSearchLane, isSearchLaneEnabled } from "@/lib/search/lane";
import { DEFAULT_ADAPTER_ID, useSearchStore } from "@/stores/searchStore";
import { useSearchUiStore } from "@/stores/searchUiStore";

type Any = any;

const RESULT: Any = {
  resultId: "g1",
  adapterId: "project-gutenberg",
  nameKey: "search.sources.projectGutenberg",
  category: "books",
  title: "Pride and Prejudice",
  creator: "Jane Austen",
  sizeBytes: 724657,
  licenceTag: "public-domain",
  sourceSnapshotId: "snap-1",
  sourceUrl: "https://www.gutenberg.org/ebooks/1342",
  mimeType: "application/epub+zip",
  date: "2026-01-12",
};

function jsonResponse(data: unknown, ok = true, status = 200) {
  // requestFetch (src/api/fetch) reads res.text(); the search client reads res.json()
  return { ok, status, json: async () => data, text: async () => JSON.stringify(data) };
}

function renderSearch() {
  return render(
    <MemoryRouter>
      <Search />
    </MemoryRouter>
  );
}

beforeEach(() => {
  delete (window as Any).__GHRDP_SEARCH_ENABLED;
  useSearchStore.setState({
    phase: "idle",
    results: {},
    resultOrder: [],
    selectedIds: [],
    fetches: {},
    adapters: {},
    queryGeneration: 0,
    lastErrorCode: "",
  });
  useSearchUiStore.setState({ view: "landing", advancedOpen: false, devFixtureGen: 0 } as Any);
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete (window as Any).__GHRDP_SEARCH_ENABLED;
});

describe("F69 §1.3 dev fixture stream on failed dispatch", () => {
  it("fires for phase failed exactly like complete/empty (once per generation)", () => {
    const base = { totalResults: 0, queryGeneration: 1, devFixtureGen: 0 };
    expect(shouldStreamDevFixture({ ...base, phase: "failed" })).toBe(true);
    expect(shouldStreamDevFixture({ ...base, phase: "empty" })).toBe(true);
    expect(shouldStreamDevFixture({ ...base, phase: "running" })).toBe(false);
    expect(shouldStreamDevFixture({ ...base, phase: "failed", devFixtureGen: 1 })).toBe(false);
    expect(shouldStreamDevFixture({ ...base, phase: "failed", totalResults: 2 })).toBe(false);
  });
});

describe("F69 §1.4 search_enable lane flag", () => {
  it("undefined keeps the locked 9-entry sidebar; explicit false hides /search and redirects", async () => {
    expect(isSearchLaneEnabled()).toBe(true);
    const { container } = render(<App />);
    const links = () => Array.from(container.querySelectorAll('[data-testid="sidebar"] nav a')).map((a) => (a.getAttribute("href") || "").replace(/^#/, ""));
    expect(links().length).toBe(9);
    expect(links()).toContain("/search");

    // poller reports search_enable=false -> entry disappears without a remount
    await act(async () => {
      (window as Any).__GHRDP_SEARCH_ENABLED = false;
      announceSearchLane();
    });
    expect(isSearchLaneEnabled()).toBe(false);
    expect(links().length).toBe(8);
    expect(links()).not.toContain("/search");
    expect(document.getElementById("f56.search.nav")).toBeNull();

    // Alt+F deep link degrades to the Overview redirect, never a search surface
    await act(async () => {
      fireEvent.keyDown(window, { key: "f", altKey: true });
    });
    expect(screen.queryByTestId("search-page")).toBeNull();

    // flag flips back -> entry returns
    await act(async () => {
      (window as Any).__GHRDP_SEARCH_ENABLED = true;
      announceSearchLane();
    });
    expect(links().length).toBe(9);
  });
});

describe("F69 §2.1 default adapter", () => {
  it("pre-selects internet-archive and resetFilters restores it", () => {
    expect(DEFAULT_ADAPTER_ID).toBe("internet-archive");
    useSearchStore.getState().toggleAdapter("arxiv");
    useSearchStore.getState().resetFilters();
    expect(useSearchStore.getState().adapterIds).toEqual([DEFAULT_ADAPTER_ID]);
  });
});

describe("F69 §2.2 file-type badge derivation", () => {
  it("prefers mimeType, then the URL basename, then the title; landing pages yield null", () => {
    expect(fileExtension({ mimeType: "application/pdf", sourceUrl: "", title: "x" })).toBe("pdf");
    expect(fileExtension({ mimeType: "audio/mpeg; charset=binary", sourceUrl: "", title: "x" })).toBe("mp3");
    expect(fileExtension({ mimeType: "", sourceUrl: "https://download.blender.org/demo/movie.MP4", title: "x" })).toBe("mp4");
    expect(fileExtension({ mimeType: "", sourceUrl: "", title: "operator-notebook-2026.md" })).toBe("md");
    expect(fileExtension({ mimeType: "", sourceUrl: "https://arxiv.org/abs/2606.01342", title: "A paper" })).toBe(null);
    expect(fileExtension({ mimeType: "", sourceUrl: "http://insecure.example/file.zip", title: "No ext" })).toBe(null);
  });
});

describe("F69 §1.5 + §2.5 fetch-started text and progress rail", () => {
  it("shows no fetch text before a fetch; after an accepted fetch the card, rail transport/status and cancel appear", async () => {
    const calls: Array<{ url: string; body: Any }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((url: Any, init?: Any) => {
        const u = String(url);
        let body: Any = null;
        try {
          body = init?.body ? JSON.parse(String(init.body)) : null;
        } catch {
          body = null;
        }
        calls.push({ url: u, body });
        if (u.includes("/api/fetch")) {
          if (body?.operation === "cancel") return Promise.resolve(jsonResponse({ fetchId: "fetch123", gid: "gid123", status: "cancelled" }, true, 200));
          return Promise.resolve(jsonResponse({ fetchId: "fetch123", gid: "gid123", progressRef: "fetch-fetch123", sourceSnapshotId: "snap-1", status: "queued" }, true, 202));
        }
        if (u.includes("/api/config")) return Promise.resolve(jsonResponse({ mirrorKey: btoa(String.fromCharCode(...new Uint8Array(32))) }));
        return Promise.resolve(jsonResponse({}, false, 404));
      })
    );
    useSearchStore.setState({ phase: "complete", results: { g1: RESULT }, resultOrder: ["g1"] });
    useSearchUiStore.setState({ view: "results" } as Any);
    renderSearch();

    // §2.2 badge rendered from mimeType
    expect(screen.getByTestId("card-file-ext").textContent).toBe(".epub");
    // §1.5 nothing claims a fetch yet
    expect(screen.queryByTestId("card-fetch-started")).toBeNull();
    expect(screen.queryByTestId("progress-row")).toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByTestId("card-fetch"));
    });
    await waitFor(() => expect(screen.getByTestId("card-fetch-started")).toBeInTheDocument());
    expect(screen.getByTestId("card-fetch-started").textContent).toContain("fetch123");

    // §2.5 the rail reflects the FetchAccepted record (still keyed by resultId)
    const rec = useSearchStore.getState().fetches.g1;
    expect(rec).toMatchObject({ fetchId: "fetch123", gid: "gid123", transport: "aria2c", status: "queued", resultId: "g1" });
    expect(screen.getByTestId("progress-transport").textContent).toBe("aria2c");
    expect(screen.getByTestId("progress-gid").textContent).toContain("gid123");
    expect(screen.getByTestId("progress-status").textContent).toBe("Queued");

    await act(async () => {
      fireEvent.click(screen.getByTestId("progress-cancel"));
    });
    await waitFor(() => expect(useSearchStore.getState().fetches.g1.status).toBe("cancelled"));
    const cancel = calls.find((c) => c.url.includes("/api/fetch") && c.body?.operation === "cancel");
    expect(cancel?.body).toMatchObject({ fetchId: "fetch123", gid: "gid123" });
    expect(screen.getByTestId("progress-status").textContent).toBe("Cancelled");
    expect(screen.queryByTestId("progress-cancel")).toBeNull();
  });
});
