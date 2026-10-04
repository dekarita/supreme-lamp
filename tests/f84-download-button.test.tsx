// [F84 §2.4] The result card shows "Download to RDP" ONLY for file-ish URLs,
// and the click posts to /api/fetch?download=true.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import "@/i18n";
import { ResultsGrid } from "@/pages/search/ResultsGrid";
import { useSearchStore } from "@/stores/searchStore";
import { useToastStore } from "@/stores/toastStore";
import { isFileLikeUrl, fileUrlExtension } from "@/pages/search/tokens";

function result(id: string, sourceUrl: string, mimeType = "") {
  return {
    resultId: id,
    adapterId: "custom",
    nameKey: "search.sites.demo",
    title: id,
    sourceUrl,
    mimeType,
    licenceTag: "open-access",
    category: "video",
    sizeBytes: 1024,
  };
}

function seed(results: Record<string, unknown>) {
  useSearchStore.setState({
    results: results as never,
    resultOrder: Object.keys(results),
    categories: [],
    licenceTags: [],
    maxSizeBytes: 0,
    sort: "relevance",
    fileExtensions: [],
    yearFrom: null,
    yearTo: null,
    lastSubmittedQuery: "",
    activeRowIndex: -1,
    selectedIds: [],
    fetches: {},
    adapters: {},
  } as never);
}

beforeEach(() => {
  seed({});
});

describe("F84 download-to-RDP button", () => {
  it("detects file-ish URLs (mp4/pdf/zip/... but not a details landing page)", () => {
    expect(isFileLikeUrl("https://openculture.com/media/lecture.mp4")).toBe(true);
    expect(isFileLikeUrl("https://openculture.com/books/guide.pdf")).toBe(true);
    expect(fileUrlExtension("https://openculture.com/a/b.tar.gz")).toBe("tar.gz");
    expect(isFileLikeUrl("https://archive.org/details/some-item")).toBe(false);
  });

  it("renders Open in RDP + Download to RDP for a .mp4 result", async () => {
    seed({ r1: result("r1", "https://openculture.com/media/lecture.mp4", "video/mp4") });
    render(
      <MemoryRouter>
        <ResultsGrid />
      </MemoryRouter>,
    );
    expect(await screen.findByTestId("card-download-rdp")).toBeInTheDocument();
    expect(screen.getAllByTestId("card-open-rdp").length).toBeGreaterThan(0);
  });

  it("clicking it posts to /api/fetch?download=true and toasts the RDP path", async () => {
    seed({ r1: result("r1", "https://openculture.com/media/lecture.mp4", "video/mp4") });
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((u: string) => {
        calls.push(String(u));
        return Promise.resolve({
          ok: true,
          status: 200,
          text: () => Promise.resolve(JSON.stringify({ ok: true, path: "C:\\Users\\op\\Desktop\\RDP-Downloads\\lecture.mp4", bytes: 42 })),
        } as unknown as Response);
      }),
    );
    render(
      <MemoryRouter>
        <ResultsGrid />
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByTestId("card-download-rdp"));
    await waitFor(() => expect(calls.some((u) => u.includes("/api/fetch?download=true"))).toBe(true));
    await waitFor(() =>
      expect(useToastStore.getState().toasts.map((x) => x.msg).join(" ")).toContain("RDP-Downloads"),
    );
  });

  it("keeps a single Open in RDP action for a landing page", async () => {
    seed({ r1: result("r1", "https://archive.org/details/some-item") });
    render(
      <MemoryRouter>
        <ResultsGrid />
      </MemoryRouter>,
    );
    expect(await screen.findByTestId("card-open-rdp")).toBeInTheDocument();
    expect(screen.queryByTestId("card-download-rdp")).toBeNull();
  });
});
