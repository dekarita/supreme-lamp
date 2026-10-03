// [F71 §D#5 / F74] Lab route is opened only through an explicit result action.
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import "@/i18n";
import { ResultsGrid } from "@/pages/search/ResultsGrid";
import { SearchLabPage } from "@/pages/search/SearchLabPage";
import { useSearchStore } from "@/stores/searchStore";
import type { SearchResult } from "@/api/search";

const result: SearchResult = {
  resultId: "github-releases.tls-radar", adapterId: "github-releases",
  nameKey: "search.sources.githubReleases", category: "software",
  title: "TLS-Radar", creator: "Team", snippet: "Release package",
  sizeBytes: 1024, licenceTag: "unknown", sourceSnapshotId: "snapshot-1",
  sourceUrl: "https://github.com/example/tls-radar/releases",
};

beforeEach(() => {
  useSearchStore.setState({
    rawQuery: "TLS-Radar", normalizedQuery: "TLS-Radar", inputKind: "text",
    categories: [], licenceTags: [], fileExtensions: [], yearFrom: null, yearTo: null,
    language: "", groupBySource: false, maxSizeBytes: 0, sort: "relevance",
    adapterIds: ["github-releases"], results: { [result.resultId]: result },
    resultOrder: [result.resultId], activeResultId: "", activeRowIndex: -1,
  } as any);
});

afterEach(() => vi.restoreAllMocks());

describe("F74 explicit Search Lab route", () => {
  it("registers the dedicated target route under the search-lane gate", () => {
    const app = readFileSync("src/App.tsx", "utf8");
    expect(app).toContain('<Route path="/search/lab/:targetId" element={<SearchLab />} />');
    expect(app).toContain("function SearchLab()");
  });

  it("does not navigate or inspect on hover; click opens the placeholder route", () => {
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    render(
      <MemoryRouter initialEntries={["/search"]}>
        <Routes>
          <Route path="/search" element={<ResultsGrid />} />
          <Route path="/search/lab/:targetId" element={<SearchLabPage />} />
        </Routes>
      </MemoryRouter>,
    );

    const action = screen.getByTestId("open-in-lab");
    fireEvent.mouseEnter(action);
    expect(screen.queryByTestId("search-lab-page")).toBeNull();
    expect(open).not.toHaveBeenCalled();

    fireEvent.click(action);
    expect(screen.getByTestId("search-lab-page")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Search Lab" })).toBeTruthy();
    expect(screen.getByText("TLS-Radar")).toBeTruthy();
    expect(screen.getByText(/No inspection or provider request runs automatically/)).toBeTruthy();
    expect(open).not.toHaveBeenCalled();
  });

  it("renders safely for a deep link whose result is no longer in memory", () => {
    render(
      <MemoryRouter initialEntries={["/search/lab/missing-result"]}>
        <Routes><Route path="/search/lab/:targetId" element={<SearchLabPage />} /></Routes>
      </MemoryRouter>,
    );
    expect(screen.getByTestId("search-lab-page")).toBeTruthy();
    expect(screen.getByText("missing-result")).toBeTruthy();
    expect(screen.getByText(/no longer in the current search state/)).toBeTruthy();
  });
});
