// [F56-c v3] §3 deep-lab visible progression + DEV fixture fallback. The lab
// state machine ticks through classifier -> probes -> consolidation on mock
// timers; the classifier message stream grows; the rail renders real HH:MM:SS
// stamps; consolidation reports the result count + an informational timed-out
// note. In DEV mode a settled-empty search streams fixture.json rows into the
// Results grid; with DEV off the empty state surfaces cleanly instead.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import "@/i18n";
import Search from "@/pages/Search";
import { ProgressiveLab } from "@/pages/search/v2/ProgressiveLab";
import { DEV_FIXTURE_ROWS, DEV_FIXTURE_TICK_MS, isDevMode } from "@/pages/search/devFixture";
import type { AdapterState } from "@/api/search";
import { useSearchStore, DEFAULT_MAX_SIZE_BYTES } from "@/stores/searchStore";
import { useSearchUiStore } from "@/stores/searchUiStore";
import {
  LAB_CLASSIFIER_END_MS,
  LAB_PROBES_END_MS,
  labClassifierStream,
  labStamp,
  labTimedOut,
  labRail,
} from "@/lib/search/progressiveLab";

type Any = any;

const ROSTER: AdapterState[] = [
  { adapterId: "project-gutenberg", nameKey: "search.sources.projectGutenberg", status: "idle", resultCount: 0 },
  { adapterId: "sourceforge", nameKey: "search.sources.sourceforge", status: "idle", resultCount: 0 },
  { adapterId: "wikisource", nameKey: "search.sources.wikisource", status: "idle", resultCount: 0 },
];

function jsonResponse(data: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => data };
}

function resetAll() {
  useSearchStore.setState({
    rawQuery: "",
    normalizedQuery: "",
    inputKind: "empty",
    lastSubmittedQuery: "",
    queryGeneration: 0,
    phase: "idle",
    searchId: "",
    adapters: {},
    results: {},
    resultOrder: [],
    categories: [],
    licenceTags: [],
    adapterIds: [],
    showProgress: false,
    maxSizeBytes: DEFAULT_MAX_SIZE_BYTES,
    sort: "relevance",
    scope: "federated",
    lastErrorCode: "",
  });
  useSearchUiStore.setState({
    view: "landing",
    animating: false,
    advancedOpen: false,
    importMode: false,
    recentQueries: [],
    labStartedAt: 0,
    devFixtureGen: 0,
    credModalOpen: false,
    cred: { host: "", user: "", password: "" },
    credError: "",
  });
}

beforeEach(() => resetAll());
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("visible lab state machine on mock timers", () => {
  it("ticks classifier -> probes -> consolidation with a growing message stream", async () => {
    vi.useFakeTimers();
    useSearchUiStore.setState({ labStartedAt: Date.now(), view: "results" });
    useSearchStore.setState({ adapters: Object.fromEntries(ROSTER.map((a) => [a.adapterId, a])) });
    render(<ProgressiveLab />);
    const lab = screen.getByTestId("progressive-lab");
    expect(lab.getAttribute("data-stage")).toBe("classifier");
    // the classifier chip animates and the stream starts empty
    expect(screen.getByTestId("lab-stage").getAttribute("data-animating")).toBe("true");
    expect(screen.queryAllByTestId("lab-classifier-msg").length).toBe(0);

    await act(async () => {
      vi.advanceTimersByTime(10_000);
    });
    expect(screen.getAllByTestId("lab-classifier-msg").length).toBe(2);

    await act(async () => {
      vi.advanceTimersByTime(LAB_CLASSIFIER_END_MS - 10_000 + 1_000); // t=31s
    });
    expect(lab.getAttribute("data-stage")).toBe("probes");
    expect(screen.queryByTestId("lab-classifier-stream")).toBeNull();

    await act(async () => {
      vi.advanceTimersByTime(LAB_PROBES_END_MS - LAB_CLASSIFIER_END_MS + 1_000); // t=241s
    });
    expect(lab.getAttribute("data-stage")).toBe("consolidation");
    expect(screen.getByTestId("lab-consolidated")).toBeInTheDocument();
    // all three idle adapters missed the window: informational, not red
    const timedOut = screen.getByTestId("lab-timed-out");
    expect(timedOut.textContent).toContain("3");
    expect(timedOut.className).not.toContain("danger");
  });

  it("pure helpers: deterministic stream, UTC stamps, timed-out counts", () => {
    expect(labClassifierStream(0).length).toBe(0);
    expect(labClassifierStream(10_000).map((m) => m.id)).toEqual(["tokens", "language"]);
    expect(labClassifierStream(30_000).length).toBe(4);
    const t0 = Date.UTC(2026, 8, 30, 12, 0, 0);
    expect(labStamp(t0, LAB_CLASSIFIER_END_MS)).toBe("12:00:30");
    expect(labStamp(0, 5)).toBe("");
    const rows = labRail(ROSTER, LAB_PROBES_END_MS + 1);
    expect(labTimedOut(rows, LAB_PROBES_END_MS + 1)).toBe(3);
    expect(labTimedOut(rows, LAB_PROBES_END_MS - 1)).toBe(0);
    const answered = labRail([{ adapterId: "arxiv", status: "complete", resultCount: 4 }], LAB_PROBES_END_MS + 1);
    expect(labTimedOut(answered, LAB_PROBES_END_MS + 1)).toBe(0);
  });

  it("rail rows carry real dispatch/settle timestamps once probes run", () => {
    const t0 = Date.UTC(2026, 8, 30, 12, 0, 0);
    useSearchUiStore.setState({ labStartedAt: t0, view: "results" });
    useSearchStore.setState({ adapters: Object.fromEntries(ROSTER.map((a) => [a.adapterId, a])) });
    render(<ProgressiveLab nowMs={LAB_CLASSIFIER_END_MS + 10_000} />);
    const stamps = screen.getAllByTestId("lab-adapter-stamp").map((n) => n.textContent || "");
    expect(stamps.some((s) => /^\d{2}:\d{2}:\d{2}$/.test(s))).toBe(true);
  });
});

describe("DEV fixture fallback + empty state", () => {
  function renderSearch() {
    return render(
      <MemoryRouter initialEntries={["/search"]}>
        <Search />
      </MemoryRouter>
    );
  }

  it("streams fixture.json rows into the Results grid when live adapters settle empty (DEV)", async () => {
    vi.useFakeTimers();
    expect(isDevMode()).toBe(true); // vitest runs in DEV mode
    useSearchStore.setState({ showProgress: true }); // F79: fixtures are debug-only.
    vi.stubGlobal(
      "fetch",
      vi.fn((url: Any) =>
        Promise.resolve(
          String(url).includes("/api/search/status")
            ? jsonResponse({ searchId: "s1", phase: "empty", queryGeneration: 1, adapterStatuses: ROSTER, results: [], hasMore: false, serverTs: "2026-09-30T10:00:00Z" })
            : jsonResponse({ requestId: "r", searchId: "s1", phase: "running", acceptedAdapterIds: ["project-gutenberg"], statusRef: "/api/search/status", queryGeneration: 1, adapterStatuses: [] }, true, 202)
        )
      )
    );
    renderSearch();
    fireEvent.change(screen.getByTestId("search-query"), { target: { value: "gutenberg" } });
    await act(async () => {
      fireEvent.click(screen.getByTestId("search-submit"));
    });
    expect(useSearchStore.getState().phase).toBe("empty");
    expect(useSearchStore.getState().resultOrder.length).toBe(0);
    // the stream reveals one row per tick - verify partial AND final states
    await act(async () => {
      vi.advanceTimersByTime(DEV_FIXTURE_TICK_MS * 3);
    });
    const partial = useSearchStore.getState().resultOrder.length;
    expect(partial).toBeGreaterThan(0);
    // [F69 §2.4] row count follows fixture.json (launch-gates allow 10-20 rows)
    expect(partial).toBeLessThan(DEV_FIXTURE_ROWS.length);
    await act(async () => {
      vi.advanceTimersByTime(DEV_FIXTURE_TICK_MS * 20);
    });
    const order = useSearchStore.getState().resultOrder;
    expect(order.length).toBe(DEV_FIXTURE_ROWS.length);
    expect(order[0]).toBe("fx-01");
    expect(screen.getByTestId("dev-fixture-note")).toBeInTheDocument();
    expect(screen.queryByTestId("results-empty")).toBeNull();
  });

  it("with DEV off, the empty-state message surfaces cleanly and no fixture streams", async () => {
    vi.useFakeTimers();
    vi.stubEnv("DEV", false);
    expect(isDevMode()).toBe(false);
    useSearchStore.setState({
      phase: "empty",
      queryGeneration: 1,
      lastSubmittedQuery: "nothing",
      normalizedQuery: "nothing",
    });
    useSearchUiStore.setState({ view: "results", labStartedAt: 0 });
    renderSearch();
    expect(screen.getByTestId("results-empty")).toBeInTheDocument();
    await act(async () => {
      vi.advanceTimersByTime(DEV_FIXTURE_TICK_MS * 20);
    });
    expect(useSearchStore.getState().resultOrder.length).toBe(0);
    expect(screen.queryByTestId("dev-fixture-note")).toBeNull();
    expect(screen.getByTestId("results-empty")).toBeInTheDocument();
  });
});
