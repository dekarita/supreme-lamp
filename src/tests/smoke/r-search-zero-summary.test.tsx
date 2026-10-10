// [R-SEARCH / #216] Behavioral tests for the zero-result explanation.
//
// These drive the SHIPPED summarizeZeroResult() and the rendered component
// through the real search store, covering:
//   * clean zero  -> normal empty state, no summary
//   * zero with failures -> counted summary
//   * rate-limited vs failed are non-overlapping buckets (no double counting)
//   * an in-progress search is never reported as a completed zero failure
//   * a stale generation's failures never leak into the current query
//   * cancellation and partial failures stay distinct
//   * no raw error string, error code or URL reaches the summary
//   * the "View source status" action reaches the existing adapter list
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import "@/i18n";
import { summarizeZeroResult } from "@/lib/search/zeroResultSummary";
import { SearchFailureSummary } from "@/pages/search/SearchFailureSummary";
import { useSearchStore, type AdapterState } from "@/stores/searchStore";

function adapter(id: string, status: AdapterState["status"], generation?: number): AdapterState {
  return {
    adapterId: id,
    nameKey: "search.sources." + id,
    status,
    resultCount: 0,
    ...(generation == null ? {} : { requestGeneration: generation }),
  };
}

function setState(partial: Partial<ReturnType<typeof useSearchStore.getState>>) {
  useSearchStore.setState(partial as never);
}

beforeEach(() => {
  useSearchStore.setState({
    adapters: {},
    phase: "idle",
    queryGeneration: 1,
    resultOrder: [],
    results: {},
    cancelling: false,
    showProgress: false,
    lastErrorCode: "",
  } as never);
});

describe("summarizeZeroResult: classification", () => {
  it("stays hidden for a clean zero - no summary invented", () => {
    const s = summarizeZeroResult(
      { a: adapter("a", "complete", 1), b: adapter("b", "empty", 1) },
      1,
      "complete",
      { resultCount: 0 },
    );
    expect(s.visible).toBe(false);
    expect(s.failed).toEqual([]);
    expect(s.hasFailures).toBe(false);
    expect(s.total).toBe(2);
  });

  it("counts failures and stays hidden for rows with results", () => {
    const s = summarizeZeroResult(
      { a: adapter("a", "failed", 1), b: adapter("b", "timed-out", 1), c: adapter("c", "complete", 1) },
      1,
      "complete",
      { resultCount: 0 },
    );
    expect(s.failed.sort()).toEqual(["a", "b"]);
    expect(s.total).toBe(3);
    expect(s.visible).toBe(true);

    const withRows = summarizeZeroResult({ a: adapter("a", "failed", 1) }, 1, "complete", { resultCount: 4 });
    expect(withRows.visible).toBe(false);
  });

  it("does NOT double-count a rate-limited adapter as a failure", () => {
    const s = summarizeZeroResult(
      {
        a: adapter("a", "rate-limited", 1),
        b: adapter("b", "rate-limited", 1),
        c: adapter("c", "failed", 1),
      },
      1,
      "complete",
      { resultCount: 0 },
    );
    expect(s.rateLimited.length).toBe(2);
    expect(s.failed).toEqual(["c"]);
    // the buckets are disjoint by construction
    expect(s.failed.filter((x) => s.rateLimited.includes(x))).toEqual([]);
    expect(s.total).toBe(3);
  });

  it("never classifies an in-progress search as a completed zero-result failure", () => {
    for (const phase of ["queued", "running", "partial"]) {
      const s = summarizeZeroResult({ a: adapter("a", "failed", 1) }, 1, phase, { resultCount: 0 });
      expect(s.inProgress).toBe(true);
      expect(s.visible).toBe(false);
    }
    // an adapter still running is in progress even when the phase settled
    const s2 = summarizeZeroResult({ a: adapter("a", "running", 1) }, 1, "partial", { resultCount: 0 });
    expect(s2.inProgress).toBe(true);
    expect(s2.visible).toBe(false);
  });

  it("ignores adapter rows from a previous generation", () => {
    const s = summarizeZeroResult(
      { old: adapter("old", "failed", 1), now: adapter("now", "complete", 2) },
      2,
      "complete",
      { resultCount: 0 },
    );
    expect(s.failed).toEqual([]);
    expect(s.total).toBe(1);
    expect(s.visible).toBe(false);
  });

  it("treats a row without a generation stamp as current", () => {
    const s = summarizeZeroResult({ a: adapter("a", "failed") }, 7, "complete", { resultCount: 0 });
    expect(s.failed).toEqual(["a"]);
    expect(s.visible).toBe(true);
  });

  it("keeps cancellation distinct from failure", () => {
    const s = summarizeZeroResult({ a: adapter("a", "cancelled", 1) }, 1, "complete", { resultCount: 0 });
    expect(s.cancelled).toEqual(["a"]);
    expect(s.failed).toEqual([]);
    expect(s.hasFailures).toBe(false);
    expect(s.visible).toBe(true);
  });

  it("survives hostile input", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const s = summarizeZeroResult(null as any, 1, "complete", { resultCount: 0 });
    expect(s.visible).toBe(false);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const s2 = summarizeZeroResult({ x: {} as any, y: { adapterId: "y" } as any }, 1, "complete", { resultCount: 0 });
    expect(s2.total).toBe(1);
    expect(s2.failed).toEqual([]);
  });
});

async function mount() {
  const { render } = await import("@testing-library/react");
  return render(<SearchFailureSummary />);
}

describe("SearchFailureSummary: rendered behavior", () => {
  it("renders nothing for a clean zero (the normal empty state survives)", async () => {
    setState({
      phase: "complete",
      queryGeneration: 3,
      resultOrder: [],
      adapters: { a: adapter("a", "complete", 3), b: adapter("b", "empty", 3) },
    });
    await mount();
    expect(screen.queryByTestId("zero-result-summary")).toBeNull();
  });

  it("renders a counted summary for a zero with failures, tied to the generation", async () => {
    setState({
      phase: "complete",
      queryGeneration: 4,
      resultOrder: [],
      adapters: {
        a: adapter("a", "failed", 4),
        b: adapter("b", "blocked-robots", 4),
        c: adapter("c", "complete", 4),
      },
    });
    await mount();
    const el = screen.getByTestId("zero-result-summary");
    expect(el.getAttribute("data-generation")).toBe("4");
    expect(el.getAttribute("data-failed")).toBe("2");
    expect(el.getAttribute("data-total")).toBe("3");
    expect(el.textContent).toMatch(/2\s+of\s+3/);
  });

  it("names rate limits separately instead of inflating the failure count", async () => {
    setState({
      phase: "complete",
      queryGeneration: 5,
      resultOrder: [],
      adapters: {
        a: adapter("a", "rate-limited", 5),
        b: adapter("b", "rate-limited", 5),
        c: adapter("c", "failed", 5),
      },
    });
    await mount();
    const el = screen.getByTestId("zero-result-summary");
    expect(el.getAttribute("data-failed")).toBe("1");
    expect(el.getAttribute("data-rate-limited")).toBe("2");
    expect(el.textContent).toMatch(/1\s+of\s+3/);
    expect(el.textContent).toMatch(/2\s+rate-limited/i);
  });

  it("does not appear while the search is still running", async () => {
    setState({ phase: "running", queryGeneration: 6, resultOrder: [], adapters: { a: adapter("a", "failed", 6) } });
    await mount();
    expect(screen.queryByTestId("zero-result-summary")).toBeNull();
  });

  it("does not appear while a cancel is in flight", async () => {
    setState({
      phase: "complete",
      queryGeneration: 7,
      resultOrder: [],
      cancelling: true,
      adapters: { a: adapter("a", "failed", 7) },
    });
    await mount();
    expect(screen.queryByTestId("zero-result-summary")).toBeNull();
  });

  it("never leaks a raw error string, code or URL into the summary", async () => {
    setState({
      phase: "complete",
      queryGeneration: 8,
      resultOrder: [],
      lastErrorCode: "SNAPSHOT_MISMATCH",
      adapters: {
        a: { ...adapter("a", "failed", 8), lastErrorCode: "HTTP_403_FROM_UPSTREAM" },
      },
    });
    await mount();
    const el = screen.getByTestId("zero-result-summary");
    expect(el.textContent).not.toMatch(/HTTP_403/);
    expect(el.textContent).not.toMatch(/SNAPSHOT_MISMATCH/);
    expect(el.textContent).not.toMatch(/https?:\/\//);
    expect(el.textContent).not.toMatch(/\{\{|\}\}/);
  });

  it("'View source status' opens the existing adapter-status surface and focuses it", async () => {
    const raf = vi.fn((cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    });
    vi.stubGlobal("requestAnimationFrame", raf);
    const list = document.createElement("ul");
    list.id = "f56.search.adapterStatusList";
    list.setAttribute("aria-label", "adapter status");
    const scrollIntoView = vi.fn();
    list.scrollIntoView = scrollIntoView;
    document.body.appendChild(list);

    setState({
      phase: "complete",
      queryGeneration: 9,
      resultOrder: [],
      adapters: { a: adapter("a", "failed", 9) },
    });
    await mount();
    expect(useSearchStore.getState().showProgress).toBe(false);
    fireEvent.click(screen.getByTestId("zero-result-view-sources"));
    // the disclosure opens (which is what mounts AdapterStatusList in the page)
    expect(useSearchStore.getState().showProgress).toBe(true);
    // and the existing list is scrolled to + focused, not a new surface
    expect(scrollIntoView).toHaveBeenCalled();
    expect(document.activeElement).toBe(list);
    expect(list.getAttribute("tabindex")).toBe("-1");

    list.remove();
    vi.unstubAllGlobals();
  });
});

// ---------------------------------------------------------------------------
// Integration: the summary is wired into the real Search page.
// ---------------------------------------------------------------------------
describe("Search page integration (#216)", () => {
  it("shows the summary above the empty state when sources failed", async () => {
    const { resetF79, mountSearch } = await import("../../../tests/f79-search-fixture");
    resetF79("complete");
    useSearchStore.setState({
      adapters: {
        a: adapter("a", "failed", 1),
        b: adapter("b", "rate-limited", 1),
        c: adapter("c", "complete", 1),
      },
    } as never);
    mountSearch();
    const summary = screen.getByTestId("zero-result-summary");
    const empty = screen.getByTestId("results-empty");
    // the explanation comes BEFORE the generic "try broader terms" advice
    expect(summary.compareDocumentPosition(empty) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(summary.getAttribute("data-failed")).toBe("1");
  });

  it("keeps the plain empty state when every source simply had no match", async () => {
    const { resetF79, mountSearch } = await import("../../../tests/f79-search-fixture");
    resetF79("complete");
    useSearchStore.setState({
      adapters: { a: adapter("a", "complete", 1), b: adapter("b", "empty", 1) },
    } as never);
    mountSearch();
    expect(screen.getByTestId("results-empty")).toBeInTheDocument();
    expect(screen.queryByTestId("zero-result-summary")).toBeNull();
  });
});
