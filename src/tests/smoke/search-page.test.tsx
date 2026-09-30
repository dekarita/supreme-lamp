// [F56-c] Search page (session §4): query dispatch against the frozen
// /api/search contract, local filter chips, empty + error states, and ARIA
// grid semantics over the react-window virtualized rows. All fetches are
// mocked - no network, no /api/fetch (F56-d owns fetch).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import "@/i18n";
import Search from "@/pages/Search";
import { useSearchStore, DEFAULT_MAX_SIZE_BYTES } from "@/stores/searchStore";
import { useSearchUiStore } from "@/stores/searchUiStore";
import { useToastStore } from "@/stores/toastStore";

type Any = any;

const RESULTS: Any[] = [
  {
    resultId: "g1",
    adapterId: "project-gutenberg",
    nameKey: "search.sources.projectGutenberg",
    category: "books",
    title: "Pride and Prejudice",
    creator: "Jane Austen",
    sizeBytes: 412000,
    licenceTag: "public-domain",
    sourceSnapshotId: "snap-1",
    sourceUrl: "https://www.gutenberg.org/ebooks/1342",
    date: "2026-01-02",
  },
  {
    resultId: "s1",
    adapterId: "sourceforge",
    nameKey: "search.sources.sourceforge",
    category: "software",
    title: "NeatDM 2.1",
    creator: "NeatSoft",
    sizeBytes: 917340,
    licenceTag: "open-access",
    sourceSnapshotId: "snap-2",
    sourceUrl: "https://sourceforge.net/projects/neatdm",
    purchaseUrl: "https://buy.example/neatdm",
    date: "2026-02-03",
  },
];

const ACCEPTED = {
  requestId: "req-1",
  searchId: "search-1",
  phase: "running",
  acceptedAdapterIds: ["project-gutenberg", "sourceforge"],
  statusRef: "/api/search/status?searchId=search-1",
  queryGeneration: 1,
  adapterStatuses: [
    { adapterId: "project-gutenberg", nameKey: "search.sources.projectGutenberg", status: "complete", resultCount: 1 },
    { adapterId: "sourceforge", nameKey: "search.sources.sourceforge", status: "complete", resultCount: 1 },
  ],
};

const STATUS = {
  searchId: "search-1",
  phase: "complete",
  queryGeneration: 1,
  adapterStatuses: ACCEPTED.adapterStatuses,
  results: RESULTS,
  hasMore: false,
  serverTs: "2026-09-30T10:00:00Z",
};

function mockFetch(impl: (url: string, init?: Any) => Any) {
  vi.stubGlobal("fetch", vi.fn((url: Any, init?: Any) => Promise.resolve(impl(String(url), init))));
}

function jsonResponse(data: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => data };
}

function resetStore() {
  useSearchStore.setState({
    rawQuery: "",
    normalizedQuery: "",
    inputKind: "empty",
    lastSubmittedQuery: "",
    queryGeneration: 0,
    phase: "idle",
    searchId: "",
    adapters: {},
    results: {},
    resultOrder: [],
    selectedIds: [],
    activeRowIndex: -1,
    previewResultId: "",
    categories: [],
    licenceTags: [],
    maxSizeBytes: DEFAULT_MAX_SIZE_BYTES,
    sort: "relevance",
    lastErrorCode: "",
  });
  // [F56-c v2] The page now opens on the Google-style landing surface; every
  // cell below states explicitly which view it wants, and the UI store is reset
  // so a previous cell's submit cannot leak the results view into the next one.
  useSearchUiStore.setState({
    view: "landing",
    animating: false,
    advancedOpen: false,
    importMode: false,
    recentQueries: [],
    labStartedAt: 0,
    credModalOpen: false,
    cred: { host: "", user: "", password: "" },
    credError: "",
  });
  useToastStore.setState({ toasts: [] });
}

function renderSearch() {
  return render(
    <MemoryRouter initialEntries={["/search"]}>
      <Search />
    </MemoryRouter>
  );
}

beforeEach(() => resetStore());
afterEach(() => vi.unstubAllGlobals());

describe("Search page (F56-c)", () => {
  it("dispatches the query to /api/search on submit and renders results", async () => {
    mockFetch((url, init) => {
      if (url.includes("/api/search/status")) return jsonResponse(STATUS);
      if (url.includes("/api/search")) {
        const body = JSON.parse(init.body);
        expect(body.query).toBe("gutenberg");
        expect(body.scope).toBe("federated");
        return jsonResponse(ACCEPTED, true, 202);
      }
      return jsonResponse({}, false, 404);
    });
    renderSearch();
    fireEvent.change(screen.getByTestId("search-query"), { target: { value: "gutenberg" } });
    await act(async () => {
      fireEvent.click(screen.getByTestId("search-submit"));
    });
    await waitFor(() => expect(screen.getAllByTestId("result-row").length).toBe(2));
    expect(useSearchStore.getState().lastSubmittedQuery).toBe("gutenberg");
  });

  it("filters current results locally when licence chips toggle", async () => {
    useSearchStore.setState({
      phase: "complete",
      results: { g1: RESULTS[0], s1: RESULTS[1] },
      resultOrder: ["g1", "s1"],
    });
    useSearchUiStore.setState({ view: "results" });
    renderSearch();
    expect(screen.getAllByTestId("result-row").length).toBe(2);
    // [F56-c v3] filter chips live only inside the ⋯ inline drawer
    await act(async () => {
      fireEvent.click(screen.getByTestId("bar-icon-drawer"));
    });
    await act(async () => {
      fireEvent.click(document.getElementById("f56.search.licenceChip.public-domain") as HTMLElement);
    });
    expect(screen.getAllByTestId("result-row").length).toBe(1);
    expect(screen.getAllByTestId("result-row")[0].getAttribute("data-result-id")).toBe("g1");
    await act(async () => {
      fireEvent.click(document.getElementById("f56.search.licenceChip.public-domain") as HTMLElement);
    });
    expect(screen.getAllByTestId("result-row").length).toBe(2);
  });

  it("shows the empty state when a completed search has no results", () => {
    useSearchStore.setState({ phase: "empty", lastSubmittedQuery: "nothing", normalizedQuery: "nothing" });
    useSearchUiStore.setState({ view: "results" });
    renderSearch();
    expect(screen.getByTestId("results-empty")).toBeInTheDocument();
  });

  it("shows the error state with retry when the dispatch fails", async () => {
    mockFetch(() =>
      jsonResponse({ requestId: "req-1", traceId: "", code: "INTERNAL_ERROR", messageKey: "search.errors.generic", retryable: true }, false, 500)
    );
    useSearchUiStore.setState({ view: "results" });
    renderSearch();
    fireEvent.change(screen.getByTestId("search-query"), { target: { value: "boom" } });
    await act(async () => {
      fireEvent.click(screen.getByTestId("search-submit"));
    });
    await waitFor(() => expect(screen.getByTestId("results-error")).toBeInTheDocument());
    expect(screen.getByTestId("error-retry")).toBeInTheDocument();
    expect(useSearchStore.getState().phase).toBe("failed");
  });

  it("renders ARIA grid semantics with roving tabindex over virtualized rows", () => {
    useSearchStore.setState({
      phase: "complete",
      results: { g1: RESULTS[0], s1: RESULTS[1] },
      resultOrder: ["g1", "s1"],
    });
    useSearchUiStore.setState({ view: "results" });
    renderSearch();
    const grid = screen.getByTestId("results-grid");
    expect(grid.getAttribute("role")).toBe("grid");
    expect(grid.getAttribute("aria-rowcount")).toBe("2");
    const rows = screen.getAllByTestId("result-row");
    expect(rows.length).toBe(2);
    for (const r of rows) expect(r.getAttribute("role")).toBe("row");
    const cells = grid.querySelectorAll('[role="gridcell"]');
    expect(cells.length).toBeGreaterThan(0);
    // roving tabindex: ArrowDown from the grid sets the second row active
    fireEvent.keyDown(grid, { key: "ArrowDown" });
    expect(useSearchStore.getState().activeRowIndex).toBe(0);
    fireEvent.keyDown(grid, { key: "ArrowDown" });
    expect(useSearchStore.getState().activeRowIndex).toBe(1);
    fireEvent.keyDown(grid, { key: "Home" });
    expect(useSearchStore.getState().activeRowIndex).toBe(0);
  });

  it("racks the F56-c v2 fetch stub: enabled card button, toast, ZERO network", async () => {
    const calls: string[] = [];
    mockFetch((url) => {
      calls.push(url);
      return jsonResponse({}, false, 404);
    });
    useSearchStore.setState({
      phase: "complete",
      results: { g1: RESULTS[0] },
      resultOrder: ["g1"],
    });
    useSearchUiStore.setState({ view: "results" });
    renderSearch();
    const fetchBtn = document.getElementById("f56.search.resultFetch.project-gutenberg.g1") as HTMLButtonElement | null;
    expect(fetchBtn).not.toBeNull();
    // The v2 stub is a real, clickable affordance (F56-c v1 shipped it disabled).
    expect(fetchBtn?.disabled).toBe(false);
    expect(fetchBtn?.title).toBe("coming in F56-d");
    await act(async () => {
      fireEvent.click(fetchBtn as HTMLElement);
    });
    expect(useToastStore.getState().toasts.map((t) => t.msg)).toContain("coming in F56-d");
    expect(Object.keys(useSearchStore.getState().fetches)).toEqual(["g1"]);
    expect(calls).toEqual([]); // the stub never touches the network
  });
});
