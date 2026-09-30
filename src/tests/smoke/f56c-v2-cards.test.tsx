// [F56-d] Result cards: source badge + title + creator + ACTUAL bytes + direct HTTPS URL + real Fetch button (aria2c lane)
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import "@/i18n";
import Search from "@/pages/Search";
import { useSearchStore, DEFAULT_MAX_SIZE_BYTES } from "@/stores/searchStore";
import { useSearchUiStore } from "@/stores/searchUiStore";
import { useToastStore } from "@/stores/toastStore";
import { requestFetchStub, FETCH_STUB_CODE } from "@/lib/fetchStub";
import { formatActualBytes, validatedHttpsUrl } from "@/pages/search/tokens";

type Any = any;

const RESULT = {
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
};

beforeEach(() => {
  useSearchStore.setState({
    phase: "complete",
    results: { g1: RESULT },
    resultOrder: ["g1"],
    adapters: {},
    categories: [],
    licenceTags: [],
    maxSizeBytes: DEFAULT_MAX_SIZE_BYTES,
    sort: "relevance",
    fetches: {},
  });
  useSearchUiStore.setState({ view: "results", animating: false });
  useToastStore.setState({ toasts: [] });
});
afterEach(() => vi.unstubAllGlobals());

function renderSearch() {
  return render(
    <MemoryRouter initialEntries={["/search"]}>
      <Search />
    </MemoryRouter>
  );
}

describe("F56-c v2 result cards", () => {
  it("surfaces the source badge, title, creator, actual bytes and the direct URL", () => {
    renderSearch();
    expect(document.getElementById("f56.search.v2.card.project-gutenberg.g1")).not.toBeNull();
    expect(screen.getByTestId("card-source-badge").textContent).toBe("Project Gutenberg");
    expect(document.getElementById("f56.search.resultTitle.project-gutenberg.g1")?.textContent).toBe("Pride and Prejudice");
    expect(document.getElementById("f56.search.resultCreator.project-gutenberg.g1")?.textContent).toBe("Jane Austen");
    expect(screen.getByTestId("card-bytes").textContent).toContain("412,000 B");
    expect(useSearchStore.getState().results.g1.sizeBytes).toBe(412000);
    const link = screen.getByTestId("card-direct-url") as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("https://www.gutenberg.org/ebooks/1342");
    expect(link.getAttribute("rel")).toContain("noopener");
  });

  it("withholds any URL that is not a validated absolute https origin", () => {
    useSearchStore.setState({
      results: { g1: { ...RESULT, sourceUrl: "http://insecure.example/x" } },
      resultOrder: ["g1"],
    });
    renderSearch();
    expect(screen.queryByTestId("card-direct-url")).toBeNull();
    expect(screen.getByTestId("card-url-withheld")).toBeInTheDocument();
    expect(validatedHttpsUrl("http://insecure.example/x")).toBe("");
    expect(validatedHttpsUrl("javascript:alert(1)")).toBe("");
    expect(validatedHttpsUrl("//insecure.example/x")).toBe("");
    expect(validatedHttpsUrl("https://host.example/a")).toBe("https://host.example/a");
    expect(formatActualBytes(917340)).toContain("917,340 B");
  });

  it("Fetch is real in F56-d: calls /api/fetch, toast fetch.started, pending rail row", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn((url: Any) => {
      calls.push(String(url));
      if (String(url).includes("/api/fetch")) {
        return Promise.resolve({ ok: true, status: 202, json: async () => ({ fetchId: "fetch123", gid: "gid123", progressRef: "fetch-fetch123", sourceSnapshotId: "snap-1", status: "queued" }) });
      }
      if (String(url).includes("/api/config")) {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ mirrorKey: btoa(String.fromCharCode(...new Uint8Array(32))) }) });
      }
      return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
    }));
    renderSearch();
    const btn = screen.getByTestId("card-fetch");
    expect((btn as HTMLButtonElement).disabled).toBe(false);
    await act(async () => {
      fireEvent.click(btn);
    });
    await waitFor(() => {
      expect(useToastStore.getState().toasts.length).toBeGreaterThan(0);
    });
    // Real fetch now hits /api/fetch
    expect(calls.some((u) => u.includes("/api/fetch"))).toBe(true);
    expect(useSearchStore.getState().fetches.g1).toBeDefined();
    // Stub still exists for compat
    const out = requestFetchStub({ resultId: "g1", sourceUrl: RESULT.sourceUrl });
    expect(out.ok).toBe(false);
    expect(out.code).toBe(FETCH_STUB_CODE);
    expect(out.networkCalls).toBe(0);
  });
});
