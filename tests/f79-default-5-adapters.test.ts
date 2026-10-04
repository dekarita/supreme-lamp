import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_FANOUT_ADAPTER_IDS, resolveFanOutAdapters } from "@/lib/search/fanOut";
import { useSearchStore } from "@/stores/searchStore";

const FIVE = ["github-releases", "internet-archive", "arxiv-public", "wikipedia-public", "google-books-public"];
beforeEach(() => useSearchStore.setState(useSearchStore.getInitialState(), true));
afterEach(() => vi.unstubAllGlobals());
describe("F79 automatic five-adapter contract", () => {
  it("the debug mirror is exactly the locked five", () => {
    expect(DEFAULT_FANOUT_ADAPTER_IDS).toEqual(FIVE);
    expect(resolveFanOutAdapters([])).toEqual(FIVE);
  });
  it("initial and reset selections delegate to the backend, never one or 29", () => {
    expect(useSearchStore.getState().adapterIds).toEqual([]);
    useSearchStore.getState().toggleAdapter("custom");
    useSearchStore.getState().resetFilters();
    expect(useSearchStore.getState().adapterIds).toEqual([]);
  });
  it("preserves F72 explicit-selection deduplication and the eight-adapter cap", () => {
    expect(resolveFanOutAdapters(["custom", "custom"])).toEqual(["custom"]);
    expect(resolveFanOutAdapters(Array.from({ length: 12 }, (_, n) => "adapter-" + n))).toHaveLength(8);
  });
  it("POSTs an empty adapterIds array and consumes only the backend's five statuses", async () => {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    const adapterStatuses = FIVE.map((adapterId) => ({ adapterId, nameKey: "search.sources.googleBooksPublic", status: "empty", resultCount: 0 }));
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : {} });
      return { ok: true, status: 200, json: async () => url.includes("/status")
        ? { searchId: "f79", phase: "empty", adapterStatuses, results: [], hasMore: false, serverTs: "2026-10-04T00:00:00Z" }
        : { searchId: "f79", phase: "running", acceptedAdapterIds: FIVE, adapterStatuses } };
    }));
    useSearchStore.getState().setQuery("xyz");
    await useSearchStore.getState().submit();
    expect(calls[0].body.adapterIds).toEqual([]);
    expect(Object.keys(useSearchStore.getState().adapters)).toEqual(FIVE);
    expect(useSearchStore.getState().phase).toBe("empty");
  });
});
