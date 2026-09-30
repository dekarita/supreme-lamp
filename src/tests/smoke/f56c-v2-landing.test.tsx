// [F56-c v3] All-in-one landing (§1/§2): the landing surface renders ZERO
// chips - every F56-c filter control (Category, Licence, Maximum-size, Sort,
// Sources, Scope + the "None selected" note) is ABSENT until the ⋯ inline
// drawer opens inside the bar. One centered ~60%-wide, ~72px-tall autofocused
// bar with the magnifier submit on the left and [clip][⋯][mic][clear] inline
// on the right; under it, one sub-line + three quiet chips, and the keyboard
// hint is exactly "Alt+F opens Search. Enter submits.".
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import "@/i18n";
import Search from "@/pages/Search";
import { useSearchStore, DEFAULT_MAX_SIZE_BYTES } from "@/stores/searchStore";
import { useSearchUiStore } from "@/stores/searchUiStore";

type Any = any;

const REMOVED_IDS = [
  "f56.search.categoryGroup",
  "f56.search.categoryChip.all",
  "f56.search.categoryChip.books",
  "f56.search.licenceGroup",
  "f56.search.licenceChip.public-domain",
  "f56.search.sizeSlider",
  "f56.search.sizeValue",
  "f56.search.sortSelector",
  "f56.search.scope",
  "f56.search.v2.adapterGroup",
  "f56.search.v2.adapterChip.project-gutenberg",
  "f56.search.filtersReset",
  "f56.search.filterSelectionCount",
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
    devFixtureGen: 0,
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

describe("F56-c v3 all-in-one landing", () => {
  it("renders ZERO chips: every removed F56-c control is absent from the landing", () => {
    renderSearch();
    for (const id of REMOVED_IDS) {
      expect(document.getElementById(id), id + " must not exist on the landing").toBeNull();
    }
    expect(screen.queryByText(/None selected probes every compiled source/i)).toBeNull();
    // only the quiet chips exist (3), never filter chips
    expect(document.querySelectorAll('[data-testid^="quiet-chip-"]').length).toBe(3);
    expect(screen.getByTestId("keyboard-help").textContent).toBe("Alt+F opens Search. Enter submits.");
  });

  it("centers one ~60%-wide, ~72px-tall autofocused bar with the 3 inline icons", () => {
    renderSearch();
    expect(screen.getByTestId("hero-bar").getAttribute("data-mode")).toBe("landing");
    expect(document.getElementById("f56.search.commandBar")?.className).toContain("w-[60%]");
    const bar = document.getElementById("f56.search.query")?.closest("form");
    expect(bar?.className).toContain("h-[72px]");
    expect(document.activeElement).toBe(document.getElementById("f56.search.query"));
    const clip = screen.getByTestId("bar-icon-clip");
    const drawer = screen.getByTestId("bar-icon-drawer");
    const mic = screen.getByTestId("bar-icon-mic");
    // §2 order: [clip][⋯][mic]
    expect(clip.compareDocumentPosition(drawer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(drawer.compareDocumentPosition(mic) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByTestId("hero-subline")).toBeInTheDocument();
  });

  it("⋯ opens the inline filter drawer; Esc collapses it again", async () => {
    renderSearch();
    await act(async () => {
      fireEvent.click(screen.getByTestId("bar-icon-drawer"));
    });
    const panel = screen.getByTestId("advanced-panel");
    expect(panel.hasAttribute("hidden")).toBe(false);
    // every §1 control now lives ONLY inside the open drawer
    expect(document.getElementById("f56.search.sizeSlider")).not.toBeNull();
    expect(document.getElementById("f56.search.categoryChip.books")).not.toBeNull();
    expect(document.getElementById("f56.search.licenceChip.public-domain")).not.toBeNull();
    expect(document.getElementById("f56.search.sortSelector")).not.toBeNull();
    expect(document.getElementById("f56.search.scope")).not.toBeNull();
    expect(document.getElementById("f56.search.v2.adapterChip.project-gutenberg")).not.toBeNull();
    await act(async () => {
      fireEvent.keyDown(document.getElementById("f56.search.commandBar") as HTMLElement, { key: "Escape" });
    });
    expect(screen.queryByTestId("advanced-panel")).toBeNull();
  });

  it("Enter collapses the drawer and submits (bar animates center -> top)", async () => {
    mockFetch((url) =>
      url.includes("/api/search/status")
        ? jsonResponse({ searchId: "s1", phase: "complete", queryGeneration: 1, adapterStatuses: [], results: [], hasMore: false, serverTs: "2026-09-30T10:00:00Z" })
        : jsonResponse({ requestId: "r", searchId: "s1", phase: "running", acceptedAdapterIds: ["project-gutenberg"], statusRef: "/api/search/status", queryGeneration: 1, adapterStatuses: [] }, true, 202)
    );
    renderSearch();
    fireEvent.change(screen.getByTestId("search-query"), { target: { value: "gutenberg" } });
    await act(async () => {
      fireEvent.click(screen.getByTestId("bar-icon-drawer"));
    });
    expect(screen.getByTestId("advanced-panel")).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByTestId("search-submit"));
    });
    await waitFor(() => expect(screen.getByTestId("hero-bar").getAttribute("data-mode")).toBe("results"));
    expect(screen.queryByTestId("advanced-panel")).toBeNull();
    expect(useSearchUiStore.getState().recentQueries).toEqual(["gutenberg"]);
    expect(useSearchUiStore.getState().labStartedAt).toBeGreaterThan(0);
  });

  it("URL-import mode auto-lights the clip icon on an HTTPS paste", () => {
    renderSearch();
    const clip = screen.getByTestId("bar-icon-clip");
    expect(clip.getAttribute("data-active")).toBe("false");
    fireEvent.change(screen.getByTestId("search-query"), { target: { value: "https://example.org/dataset.zip" } });
    expect(clip.getAttribute("data-active")).toBe("true");
    expect(clip.getAttribute("aria-pressed")).toBe("true");
    expect(useSearchStore.getState().inputKind).toBe("https-url");
    expect(document.getElementById("f56.search.urlImport")?.textContent).toContain("HTTPS URL detected");
  });

  it("quiet chips still act: Own Storage toggles scope, Paste URL enters import mode", async () => {
    renderSearch();
    await act(async () => {
      fireEvent.click(screen.getByTestId("quiet-chip-own-storage"));
    });
    expect(useSearchStore.getState().scope).toBe("own-storage");
    await act(async () => {
      fireEvent.click(screen.getByTestId("quiet-chip-paste-url"));
    });
    expect(useSearchUiStore.getState().importMode).toBe(true);
  });
});
