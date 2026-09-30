// [F56-c v2] Google-style landing (§2): centered ~60%-wide, ~64px-tall bar with
// autofocus, a sub-line, exactly three QUIET chips (Recent | Own Storage |
// Paste URL), NO visible filter chips and NO visible size cap, and the
// "Advanced ⋯" disclosure holding the frozen F56-c filter ids. Submitting
// animates the same bar center -> top before results render.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import "@/i18n";
import Search from "@/pages/Search";
import { useSearchStore, DEFAULT_MAX_SIZE_BYTES } from "@/stores/searchStore";
import { useSearchUiStore } from "@/stores/searchUiStore";

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
  },
];

function mockFetch(impl: (url: string, init?: Any) => Any) {
  vi.stubGlobal("fetch", vi.fn((url: Any, init?: Any) => Promise.resolve(impl(String(url), init))));
}

function jsonResponse(data: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => data };
}

function reset() {
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
    categories: [],
    licenceTags: [],
    adapterIds: [],
    maxSizeBytes: DEFAULT_MAX_SIZE_BYTES,
    sort: "relevance",
    scope: "federated",
    lastErrorCode: "",
  });
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
}

function renderSearch() {
  return render(
    <MemoryRouter initialEntries={["/search"]}>
      <Search />
    </MemoryRouter>
  );
}

beforeEach(() => reset());
afterEach(() => vi.unstubAllGlobals());

describe("F56-c v2 Google-style landing", () => {
  it("centers a large autofocused bar with a sub-line and exactly three quiet chips", () => {
    renderSearch();
    const bar = screen.getByTestId("hero-bar");
    expect(bar.getAttribute("data-mode")).toBe("landing");
    // ~60% viewport width + ~64px height + the center->top transition exist on
    // the bar (the exact px live in the class list; the animation latch is the
    // data-anim attribute).
    expect(document.getElementById("f56.search.commandBar")?.className).toContain("w-[60%]");
    expect(document.getElementById("f56.search.query")?.className).toContain("h-16");
    // autofocus is real focus (React applies autoFocus imperatively, not as an attribute)
    expect(document.activeElement).toBe(document.getElementById("f56.search.query"));
    expect(screen.getByTestId("hero-subline")).toBeInTheDocument();
    expect(screen.getByTestId("quiet-chip-recent")).toBeInTheDocument();
    expect(screen.getByTestId("quiet-chip-own-storage")).toBeInTheDocument();
    expect(screen.getByTestId("quiet-chip-paste-url")).toBeInTheDocument();
    expect(document.querySelectorAll('[data-testid^="quiet-chip-"]').length).toBe(3);
  });

  it("shows NO visible filter chips and NO visible size cap until Advanced opens", async () => {
    renderSearch();
    const panel = screen.getByTestId("advanced-panel");
    expect(panel.hasAttribute("hidden")).toBe(true);
    expect(screen.getByTestId("advanced-toggle").getAttribute("aria-expanded")).toBe("false");
    // the frozen F56-c filter ids remain in the DOM exactly once (id lock), just
    // inside the collapsed disclosure
    expect(document.getElementById("f56.search.sizeSlider")).not.toBeNull();
    expect(document.getElementById("f56.search.licenceChip.public-domain")).not.toBeNull();
    expect(document.getElementById("f56.search.categoryChip.books")).not.toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByTestId("advanced-toggle"));
    });
    expect(panel.hasAttribute("hidden")).toBe(false);
    expect(screen.getByTestId("advanced-toggle").getAttribute("aria-expanded")).toBe("true");
    // the size slider's untouched default is 0 = unlimited (v2 A1 overwrite)
    expect(screen.getByTestId("size-value").textContent).toBe("No maximum");
    expect(document.getElementById("f56.search.v2.adapterChip.project-gutenberg")).not.toBeNull();
  });

  it("quiet chips act: Own Storage toggles scope, Paste URL enters import mode", async () => {
    renderSearch();
    await act(async () => {
      fireEvent.click(screen.getByTestId("quiet-chip-own-storage"));
    });
    expect(useSearchStore.getState().scope).toBe("own-storage");
    await act(async () => {
      fireEvent.click(screen.getByTestId("quiet-chip-paste-url"));
    });
    expect(useSearchUiStore.getState().importMode).toBe(true);
    expect(useSearchUiStore.getState().view).toBe("results");
  });

  it("animates the bar center -> top on submit and records the query as recent", async () => {
    mockFetch((url) => (url.includes("/api/search/status") ? jsonResponse({ searchId: "s1", phase: "complete", queryGeneration: 1, adapterStatuses: [], results: RESULTS, hasMore: false, serverTs: "2026-09-30T10:00:00Z" }) : jsonResponse({ requestId: "r", searchId: "s1", phase: "running", acceptedAdapterIds: ["project-gutenberg"], statusRef: "/api/search/status", queryGeneration: 1, adapterStatuses: [] }, true, 202)));
    renderSearch();
    fireEvent.change(screen.getByTestId("search-query"), { target: { value: "gutenberg" } });
    await act(async () => {
      fireEvent.click(screen.getByTestId("search-submit"));
    });
    await waitFor(() => expect(screen.getByTestId("hero-bar").getAttribute("data-mode")).toBe("results"));
    expect(screen.getByTestId("hero-bar").getAttribute("data-anim")).toBe("to-top");
    expect(screen.getByTestId("hero-bar").className).toContain("transition-all");
    expect(useSearchUiStore.getState().recentQueries).toEqual(["gutenberg"]);
    expect(useSearchUiStore.getState().labStartedAt).toBeGreaterThan(0);
    // the landing elements are gone once the bar is at the top
    expect(screen.queryByTestId("hero-subline")).toBeNull();
  });
});
