// [F70 §2.2/§2.4] The default-adapter flip: a raw query typed on the landing
// state (no Advanced, no chip toggles) submits to google-books-public - the
// first adapter with a REAL server lane (Invoke-GhrdpGoogleBooksSearch, F70
// §2.1) - and the accepted status/ref wiring flows back into the store.
// Companion Node lab: tests/f70-google-books.test.js (server-side mapping).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, act, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import "@/i18n";
import Search from "@/pages/Search";
import { ADAPTER_ROSTER, ADAPTER_ROSTER_SIZE } from "@/pages/search/v2/adapters";
import { DEFAULT_ADAPTER_ID, useSearchStore } from "@/stores/searchStore";
import { useSearchUiStore } from "@/stores/searchUiStore";

type Any = any;

function jsonResponse(data: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => data, text: async () => JSON.stringify(data) };
}

const ACCEPTED = {
  requestId: "r1",
  searchId: "f70abc",
  phase: "complete",
  acceptedAdapterIds: ["google-books-public"],
  statusRef: "/api/search/status?searchId=f70abc",
  queryGeneration: 1,
  adapterStatuses: [
    { adapterId: "google-books-public", nameKey: "search.sources.googleBooksPublic", status: "complete", resultCount: 1 },
  ],
};

const STATUS = {
  searchId: "f70abc",
  phase: "complete",
  queryGeneration: 1,
  adapterStatuses: [
    { adapterId: "google-books-public", nameKey: "search.sources.googleBooksPublic", status: "complete", resultCount: 1 },
  ],
  results: [
    {
      resultId: "f70-row-1",
      adapterId: "google-books-public",
      nameKey: "search.sources.googleBooksPublic",
      category: "books",
      title: "War and Peace",
      creator: "Leo Tolstoy",
      sizeBytes: null,
      licenceTag: "public-domain",
      sourceSnapshotId: "gb-AAA",
      sourceUrl: "https://books.google.com/books?id=AAA",
      purchaseUrl: "https://books.google.com/books?id=AAA",
      mimeType: "application/epub+zip",
      date: "1869-01-01",
    },
  ],
  resultOrder: ["f70-row-1"],
  cursor: null,
  hasMore: false,
  serverTs: "2026-10-03T00:00:00Z",
};

beforeEach(() => {
  delete (window as Any).__GHRDP_SEARCH_ENABLED;
  useSearchStore.setState({
    rawQuery: "",
    normalizedQuery: "",
    inputKind: "empty",
    lastSubmittedQuery: "",
    queryGeneration: 0,
    phase: "idle",
    searchId: "",
    requestId: "",
    adapters: {},
    results: {},
    resultOrder: [],
    selectedIds: [],
    fetches: {},
    cursor: "",
    hasMore: false,
    lastErrorCode: "",
    adapterIds: [DEFAULT_ADAPTER_ID],
  } as Any);
  useSearchUiStore.setState({ view: "landing", advancedOpen: false, devFixtureGen: 0 } as Any);
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete (window as Any).__GHRDP_SEARCH_ENABLED;
});

describe("F70 §2.2 default adapter", () => {
  it("is google-books-public, is on the derived roster as entry 29, and has both i18n labels", () => {
    expect(DEFAULT_ADAPTER_ID).toBe("google-books-public");
    expect(ADAPTER_ROSTER_SIZE).toBe(29);
    const hit = ADAPTER_ROSTER.find((a) => a.adapterId === "google-books-public");
    expect(hit?.nameKey).toBe("search.sources.googleBooksPublic");
    // the F69 navigation-only entry is untouched
    expect(ADAPTER_ROSTER.find((a) => a.adapterId === "google-books")?.nameKey).toBe("search.sources.googleBooks");
  });

  it("a raw query with default state POSTs /api/search with adapterIds=[google-books-public]", async () => {
    const calls: Any[] = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      const u = String(url);
      if (u.includes("/api/search/status")) return jsonResponse(STATUS);
      return jsonResponse(ACCEPTED);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { setQuery, submit } = useSearchStore.getState();
    setQuery("war and peace");
    expect(useSearchStore.getState().inputKind).toBe("text");
    await act(async () => {
      await submit();
    });

    const create = calls.find((c) => c.url.includes("/api/search") && !c.url.includes("status"));
    expect(create, "POST /api/search was called").toBeTruthy();
    expect(create.init.method).toBe("POST");
    const body = JSON.parse(String(create.init.body));
    expect(body.query).toBe("war and peace");
    expect(body.adapterIds).toEqual(["google-books-public"]);
    expect(body.scope).toBe("federated");
    expect(body.limit).toBe(50);

    const st = useSearchStore.getState();
    expect(st.phase).toBe("complete");
    expect(st.searchId).toBe("f70abc");
    expect(st.adapters["google-books-public"].status).toBe("complete");
    expect(st.resultOrder).toEqual(["f70-row-1"]);
    expect(st.results["f70-row-1"].mimeType).toBe("application/epub+zip");
  });

  it("renders real google-books rows with the .epub badge through the landing page", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes("/api/search/status")) return jsonResponse(STATUS);
      return jsonResponse(ACCEPTED);
    });
    vi.stubGlobal("fetch", fetchMock);
    (window as Any).__GHRDP_SEARCH_ENABLED = "true";

    render(
      <MemoryRouter>
        <Search />
      </MemoryRouter>
    );
    const input = screen.getByTestId("search-query") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "war and peace" } });
    await act(async () => {
      fireEvent.click(screen.getByTestId("search-submit"));
      await waitFor(() => expect(useSearchStore.getState().phase).toBe("complete"));
    });
    await waitFor(() => {
      expect(screen.getByText("War and Peace")).toBeTruthy();
    });
    // [F69 §2.2] the file-ext badge derives from the epub mime type
    expect(screen.getByText(/epub/i)).toBeTruthy();
    expect(fetchMock).toHaveBeenCalled();
  });
});
