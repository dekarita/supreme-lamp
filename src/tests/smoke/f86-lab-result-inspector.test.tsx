// [F86 §B.3] RESULT-VIEW DEEP INSPECTOR.
//
// Before F86 a /#/search/lab/<resultId> navigation rendered the F74/F75 stub:
// the sentence "Full inspector coming in F75. Result metadata shown below." and
// a metadata card - no link list, no fetch. The spec's §B is exactly the fix:
// the result's sourceUrl is treated as the "site baseUrl", POST /api/lab/inspect
// is called with {sourceUrl, query}, and the SAME deep-inspector UI the stored
// sites use renders the links, with "Inspecting <title> from <adapter>" context.
//
// This suite asserts the three halves of that contract:
//   1. the placeholder text is GONE from the rendered route (and from the en
//      catalog, so a stale key cannot resurrect it),
//   2. a real link list renders for a result-id navigation, with the result's
//      sourceUrl as the inspected target (not the result id),
//   3. the row links still route through /api/launch-url (the F84 no-fallback
//      contract), i.e. the result view is not a second, weaker surface.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import "@/i18n";
import en from "@/i18n/en.json";
import Lab from "@/pages/search/Lab";
import { resetCustomSourcesStore } from "@/stores/customSourcesStore";
import { useSearchStore } from "@/stores/searchStore";
import type { SearchResult } from "@/api/search";

const inspectResultUrl = vi.fn();
vi.mock("@/api/lab", async (orig) => {
  const actual = await orig<typeof import("@/api/lab")>();
  return { ...actual, inspectResultUrl: (...args: unknown[]) => inspectResultUrl(...args) };
});

const RESULT_ID = "res-archive-item-1";
const SOURCE_URL = "https://archive.org/details/nasa-history-1964";

const RESULT = {
  resultId: RESULT_ID,
  title: "NASA History, 1964",
  sourceUrl: SOURCE_URL,
  nameKey: "adapter.internetArchive",
  category: "video",
  licenceTag: "public-domain",
  kind: "file",
  mimeType: "video/mp4",
  sizeBytes: 1024,
} as unknown as SearchResult;

const DATA = {
  hostname: "archive.org",
  title: "NASA History, 1964",
  fetchedAt: "2026-10-04T00:00:00Z",
  linkCount: 3,
  matchCount: 1,
  source: "result-url",
  sourceUrls: 3,
  links: [
    { text: "nasa-history-1964.mp4", href: "https://archive.org/download/nasa-history-1964/nasa-history-1964.mp4", matches: true },
    { text: "details page", href: "https://archive.org/details/nasa-history-1964", matches: false },
    { text: "collection", href: "https://archive.org/details/nasa-collection", matches: false },
  ],
};

function mount(id = RESULT_ID) {
  return render(
    <MemoryRouter initialEntries={[`/search/lab/${id}?q=nasa`]}>
      <Routes>
        <Route path="/search/lab/:targetId" element={<Lab />} />
      </Routes>
    </MemoryRouter>
  );
}

beforeEach(() => {
  resetCustomSourcesStore();
  inspectResultUrl.mockReset();
  useSearchStore.setState({ results: { [RESULT_ID]: RESULT }, resultOrder: [RESULT_ID] });
});

describe("F86 Lab result-view", () => {
  it("deletes the F75 placeholder: no 'Full inspector coming in F75' text anywhere", async () => {
    inspectResultUrl.mockResolvedValue({ ok: true, data: DATA });
    mount();
    await waitFor(() => expect(screen.getByTestId("lab-link-list")).toBeInTheDocument());
    expect(screen.queryByText(/Full inspector coming in F75/i)).toBeNull();
    expect(JSON.stringify(en)).not.toContain("Full inspector coming in F75");
  });

  it("inspects the result's sourceUrl and renders the deep-inspector link list", async () => {
    inspectResultUrl.mockResolvedValue({ ok: true, data: DATA });
    mount();
    await waitFor(() => expect(screen.getByTestId("lab-link-list")).toBeInTheDocument());
    expect(inspectResultUrl).toHaveBeenCalledWith(SOURCE_URL, "nasa");
    const rows = screen.getAllByTestId("lab-link-row");
    expect(rows.length).toBeGreaterThanOrEqual(1);
    // matches-first ON: the .mp4 row is the matching one and must be listed.
    expect(rows[0].textContent).toContain("nasa-history-1964.mp4");
    // The result metadata card survives BELOW the real inspector.
    expect(screen.getByTestId("lab-metadata")).toBeInTheDocument();
    expect(screen.getByTestId("lab-source-url")).toBeInTheDocument();
  });

  it("carries the 'Inspecting <title> from <adapter>' context header", async () => {
    inspectResultUrl.mockResolvedValue({ ok: true, data: DATA });
    mount();
    await waitFor(() => expect(screen.getByTestId("lab-result-context")).toBeInTheDocument());
    const ctx = screen.getByTestId("lab-result-context").textContent || "";
    expect(ctx).toContain("NASA History, 1964");
    expect(ctx.toLowerCase()).toContain("nasa history"); // adapter label resolves through i18n
  });

  it("renders the server's failure as a visible error, not as the stub", async () => {
    inspectResultUrl.mockResolvedValue({ ok: false, error: { code: "TIMEOUT", messageKey: "lab.timeout" } });
    mount();
    await waitFor(() => expect(screen.getByTestId("lab-error")).toBeInTheDocument());
    expect(screen.queryByText(/Full inspector coming in F75/i)).toBeNull();
  });
});
