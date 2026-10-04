// [F77] Search is unconditional: diagnostic flags and legacy browser cache cannot hide it.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import App from "@/App";

type SearchWindow = Window & {
  __GHRDP_SEARCH_ENABLED?: unknown;
  __GHRDP_SEARCH_INPUT?: string;
};

function stubDiag(payload: unknown) {
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    const data = url.endsWith("/diag") ? payload : {};
    const ok = url.endsWith("/diag");
    return Promise.resolve({
      ok,
      status: ok ? 200 : 404,
      json: async () => data,
      text: async () => JSON.stringify(data),
    } as Response);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function searchEntry() {
  return document.getElementById("f56.search.nav");
}

beforeEach(() => {
  window.location.hash = "#/";
  delete (window as SearchWindow).__GHRDP_SEARCH_ENABLED;
  delete (window as SearchWindow).__GHRDP_SEARCH_INPUT;
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete (window as SearchWindow).__GHRDP_SEARCH_ENABLED;
  delete (window as SearchWindow).__GHRDP_SEARCH_INPUT;
  window.localStorage.clear();
});

describe("F77 Search visibility and build diagnostics", () => {
  it("renders Search when /diag.searchEnabled is undefined", async () => {
    const fetchMock = stubDiag({ searchInput: "" });
    render(<App />);
    await waitFor(() => expect((window as SearchWindow).__GHRDP_SEARCH_INPUT).toBe(""));
    expect(fetchMock.mock.calls.some(([url]) => String(url) === "/diag")).toBe(true);
    expect(searchEntry()).toBeInTheDocument();
  });

  it("renders Search when /diag.searchEnabled is false", async () => {
    const fetchMock = stubDiag({ searchEnabled: false, searchInput: "" });
    render(<App />);
    await waitFor(() => expect((window as SearchWindow).__GHRDP_SEARCH_INPUT).toBe(""));
    expect(fetchMock.mock.calls.some(([url]) => String(url) === "/diag")).toBe(true);
    expect((window as SearchWindow).__GHRDP_SEARCH_ENABLED).toBeUndefined();
    expect(searchEntry()).toBeInTheDocument();
  });

  it("renders Search with a stale __GHRDP_SEARCH_ENABLED=false localStorage value", () => {
    window.localStorage.setItem("__GHRDP_SEARCH_ENABLED", "false");
    (window as SearchWindow).__GHRDP_SEARCH_ENABLED = false;
    render(<App />);
    expect(searchEntry()).toBeInTheDocument();
  });

  it("clears all legacy Search cache keys on mount", () => {
    window.localStorage.setItem("__GHRDP_SEARCH_ENABLED", "false");
    window.localStorage.setItem("f56.search.enabled", "false");
    window.localStorage.setItem("ghrdp.lane.search", "false");
    render(<App />);
    expect(window.localStorage.getItem("__GHRDP_SEARCH_ENABLED")).toBeNull();
    expect(window.localStorage.getItem("f56.search.enabled")).toBeNull();
    expect(window.localStorage.getItem("ghrdp.lane.search")).toBeNull();
  });

  it("shows the build SHA7 footer badge, or the dev fallback", () => {
    render(<App />);
    const expectedSha = import.meta.env.VITE_BUILD_SHA?.slice(0, 7) || "dev";
    expect(screen.getByTestId("ui-build-sha")).toHaveTextContent(`ui: ${expectedSha}`);
    expect(screen.getByTestId("ui-build-sha").textContent).toMatch(/^ui: (?:[0-9a-f]{7}|dev)$/);
  });
});
