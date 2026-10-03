// [F71 §D#2-4 / F73] Fan-out, local filters, grouped rendering, and Google navigation.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import "@/i18n";
import { CommandBar } from "@/pages/search/CommandBar";
import { AdvancedPanel } from "@/pages/search/v2/AdvancedPanel";
import { ResultsGrid } from "@/pages/search/ResultsGrid";
import { resolveFanOutAdapters, DEFAULT_FANOUT_ADAPTER_IDS } from "@/lib/search/fanOut";
import { scoreResult } from "@/lib/search/relevance";
import { selectVisibleResults, useSearchStore } from "@/stores/searchStore";
import type { SearchResult } from "@/api/search";

type Any = any;

const RESULTS: SearchResult[] = [
  {
    resultId: "pdf-1", adapterId: "arxiv-public", nameKey: "search.sources.arxivPublic",
    category: "scholarly", title: "TLS-Radar", creator: "A. Author", snippet: "TLS research paper",
    sizeBytes: 100, licenceTag: "open-access", sourceSnapshotId: "snap-pdf",
    sourceUrl: "https://arxiv.org/pdf/2601.00001.pdf", mimeType: "application/pdf", date: "2026-01-02",
  },
  {
    resultId: "zip-1", adapterId: "github-releases", nameKey: "search.sources.githubReleases",
    category: "software", title: "TLS Radar Toolkit", creator: "team", snippet: "A radar project",
    sizeBytes: 200, licenceTag: "unknown", sourceSnapshotId: "snap-zip",
    sourceUrl: "https://github.com/example/tls-radar", date: "2026-02-02", metadata: { stars: 200, language: "Rust" },
  },
  {
    resultId: "exe-1", adapterId: "internet-archive", nameKey: "search.sources.internetArchive",
    category: "software", title: "TLS-Radar installer.exe", creator: "archive", snippet: "",
    sizeBytes: 300, licenceTag: "unknown", sourceSnapshotId: "snap-exe",
    sourceUrl: "https://archive.org/download/tls-radar.exe", date: "2025-03-02",
  },
];

function resetStore() {
  useSearchStore.setState({
    rawQuery: "TLS-Radar", normalizedQuery: "TLS-Radar", inputKind: "text",
    categories: [], licenceTags: [], fileExtensions: [], yearFrom: null, yearTo: null,
    language: "", groupBySource: false, maxSizeBytes: 0, sort: "relevance", scope: "federated",
    adapterIds: [...DEFAULT_FANOUT_ADAPTER_IDS], adapters: {}, results: {}, resultOrder: [],
    selectedIds: [], activeResultId: "", activeRowIndex: -1, fetches: {}, previewResultId: "",
    phase: "complete", searchId: "", queryGeneration: 0,
  } as Any);
}

beforeEach(resetStore);
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("F73 fan-out and lightweight relevance", () => {
  it("uses the five-source default, deduplicates explicit IDs, and clamps at eight", () => {
    expect(resolveFanOutAdapters([])).toEqual([...DEFAULT_FANOUT_ADAPTER_IDS]);
    expect(resolveFanOutAdapters(["github-releases", "github-releases", "arxiv-public"])).toEqual(["github-releases", "arxiv-public"]);
    expect(resolveFanOutAdapters(Array.from({ length: 10 }, (_, i) => "adapter-" + i))).toHaveLength(8);
  });

  it("scores exact title above token and text matches, with log-scaled GitHub authority", () => {
    const exact = { ...RESULTS[0], title: "TLS-Radar", mimeType: "" };
    const token = { ...RESULTS[0], title: "TLS-Radar Paper", mimeType: "" };
    const popular = { ...RESULTS[1], metadata: { stars: 100000 } };
    expect(scoreResult("TLS-Radar", exact)).toBeGreaterThan(scoreResult("TLS-Radar", token));
    expect(scoreResult("TLS", popular)).toBeGreaterThan(scoreResult("TLS", { ...popular, metadata: { stars: 0 } }));
  });
});

describe("F73 local search filters and grouped results", () => {
  it("file chips filter by MIME, URL, and source-code group; year and language remain local", () => {
    const results = Object.fromEntries(RESULTS.map((row) => [row.resultId, row]));
    useSearchStore.setState({ results, resultOrder: RESULTS.map((row) => row.resultId) });
    render(<MemoryRouter><AdvancedPanel open /></MemoryRouter>);

    fireEvent.click(document.getElementById("f56.search.v2.fileExtChip.pdf") as HTMLElement);
    expect(selectVisibleResults(useSearchStore.getState()).map((row) => row.resultId)).toEqual(["pdf-1"]);
    fireEvent.click(document.getElementById("f56.search.v2.fileExtChip.pdf") as HTMLElement);
    fireEvent.click(document.getElementById("f56.search.v2.fileExtChip.source-code") as HTMLElement);
    expect(selectVisibleResults(useSearchStore.getState()).map((row) => row.resultId)).toEqual(["zip-1"]);
    fireEvent.click(document.getElementById("f56.search.v2.fileExtChip.source-code") as HTMLElement);

    fireEvent.change(document.getElementById("f56.search.v2.yearFrom") as HTMLInputElement, { target: { value: "2026" } });
    expect(useSearchStore.getState().yearFrom).toBe(2026);
    expect(selectVisibleResults(useSearchStore.getState()).map((row) => row.resultId)).toEqual(["pdf-1", "zip-1"]);
    fireEvent.change(document.getElementById("f56.search.v2.languageFilter") as HTMLSelectElement, { target: { value: "Rust" } });
    expect(useSearchStore.getState().language).toBe("Rust");
    expect(selectVisibleResults(useSearchStore.getState()).map((row) => row.resultId)).toEqual(["zip-1"]);
  });

  it("group toggle is default-off and renders one accessible group per source", () => {
    useSearchStore.setState({ results: Object.fromEntries(RESULTS.map((row) => [row.resultId, row])), resultOrder: RESULTS.map((row) => row.resultId) });
    const { unmount } = render(<MemoryRouter><AdvancedPanel open /></MemoryRouter>);
    const toggle = document.getElementById("f56.search.v2.groupBySourceToggle") as HTMLButtonElement;
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(toggle);
    expect(useSearchStore.getState().groupBySource).toBe(true);
    unmount();

    render(<MemoryRouter><ResultsGrid /></MemoryRouter>);
    expect(screen.getAllByTestId("source-group")).toHaveLength(3);
    expect(screen.getAllByTestId("source-group-header")).toHaveLength(3);
    const grid = screen.getByTestId("results-grid");
    expect(grid.getAttribute("aria-rowcount")).toBe("6");
    fireEvent.keyDown(grid, { key: "ArrowDown" });
    expect(useSearchStore.getState().activeResultId).toBe("pdf-1");
    fireEvent.keyDown(grid, { key: "ArrowDown" });
    expect(useSearchStore.getState().activeResultId).toBe("exe-1");
  });
});

describe("F73 Google navigation fallback", () => {
  it("opens an encoded Google search in a new tab without making an API request", () => {
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    render(<MemoryRouter><CommandBar /></MemoryRouter>);
    fireEvent.click(screen.getByTestId("google-search-nav"));
    expect(open).toHaveBeenCalledWith("https://www.google.com/search?q=TLS-Radar", "_blank", "noopener,noreferrer");
    expect(open).toHaveBeenCalledTimes(1);
  });
});
