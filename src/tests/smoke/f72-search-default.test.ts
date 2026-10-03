// [F71 §D#1 / F72.2] Empty adapter selection delegates to the compiled server default.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_FANOUT_ADAPTER_IDS, useSearchStore } from "@/stores/searchStore";

type Any = any;

function jsonResponse(data: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => data };
}

beforeEach(() => {
  useSearchStore.setState({
    rawQuery: "TLS-Radar",
    normalizedQuery: "TLS-Radar",
    inputKind: "text",
    adapterIds: [],
    categories: [],
    licenceTags: [],
    maxSizeBytes: 0,
    sort: "relevance",
    scope: "federated",
    queryGeneration: 0,
    phase: "idle",
    searchId: "",
    adapters: {},
    results: {},
    resultOrder: [],
    cursor: "",
    hasMore: false,
    lastErrorCode: "",
  } as Any);
});

afterEach(() => vi.unstubAllGlobals());

describe("F72 server-default adapter selection", () => {
  it("resolves an empty selection to the five-source pack for POST /api/search", async () => {
    const calls: Array<{ url: string; body: Any }> = [];
    vi.stubGlobal("fetch", vi.fn((input: Any, init?: Any) => {
      const url = String(input);
      let body: Any = null;
      try { body = init?.body ? JSON.parse(String(init.body)) : null; } catch { }
      calls.push({ url, body });
      if (url.includes("/api/search/status")) {
        return Promise.resolve(jsonResponse({
          searchId: "s-f72", phase: "complete", queryGeneration: 1,
          adapterStatuses: [], results: [], hasMore: false, serverTs: "2026-10-03T00:00:00Z",
        }));
      }
      return Promise.resolve(jsonResponse({
        requestId: body?.requestId, searchId: "s-f72", phase: "complete",
        acceptedAdapterIds: ["github-releases", "internet-archive", "arxiv-public", "wikipedia-public", "google-books-public"],
        statusRef: "/api/search/status?searchId=s-f72", queryGeneration: 1, adapterStatuses: [],
      }, 202));
    }));

    await useSearchStore.getState().submit();
    const create = calls.find((call) => call.url.includes("/api/search") && !call.url.includes("/status"));
    expect(create).toBeDefined();
    expect(create?.body.query).toBe("TLS-Radar");
    expect(create?.body.adapterIds).toEqual([...DEFAULT_FANOUT_ADAPTER_IDS]);
    expect(useSearchStore.getState().searchId).toBe("s-f72");
    expect(calls.some((call) => call.url.includes("/api/search/status?searchId=s-f72"))).toBe(true);
  });
});
