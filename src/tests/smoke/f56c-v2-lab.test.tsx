// [F56-c v2] Progressive 5-minute lab (§2): 0-30s classifier, 30s-4min
// federated probes streaming partials, 4-5min consolidation + link extraction,
// plus a per-adapter progress rail. The state machine is pure (no timers), so
// these cells drive all five minutes deterministically and only the rendered
// component uses the injected `nowMs` clock.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import "@/i18n";
import { ProgressiveLab } from "@/pages/search/v2/ProgressiveLab";
import { useSearchStore } from "@/stores/searchStore";
import { useSearchUiStore } from "@/stores/searchUiStore";
import {
  LAB_CLASSIFIER_END_MS,
  LAB_CONSOLIDATION_END_MS,
  LAB_PROBES_END_MS,
  labProgress,
  labRail,
  labStageAt,
  labStageIndex,
  labWindows,
} from "@/lib/search/progressiveLab";

const ADAPTERS = [
  { adapterId: "project-gutenberg", status: "running", resultCount: 2 },
  { adapterId: "sourceforge", status: "idle", resultCount: 0 },
  { adapterId: "wikisource", status: "idle", resultCount: 0 },
];

beforeEach(() => {
  useSearchStore.setState({
    adapters: {},
    results: {},
    resultOrder: [],
    categories: [],
    licenceTags: [],
    maxSizeBytes: 0,
    sort: "relevance",
  });
  useSearchUiStore.setState({ labStartedAt: 1000, view: "results" });
});
afterEach(() => {
  useSearchUiStore.setState({ labStartedAt: 0 });
});

describe("progressive lab state machine (pure)", () => {
  it("maps the three windows at 0-30s / 30s-4min / 4-5min", () => {
    expect(labStageAt(0)).toBe("classifier");
    expect(labStageAt(29_999)).toBe("classifier");
    expect(labStageAt(30_000)).toBe("probes");
    expect(labStageAt(239_999)).toBe("probes");
    expect(labStageAt(240_000)).toBe("consolidation");
    expect(labStageAt(299_999)).toBe("consolidation");
    expect(labStageAt(300_000)).toBe("complete");
    expect(labStageIndex("probes")).toBe(1);
    expect(labWindows().map((w) => w.stage)).toEqual(["classifier", "probes", "consolidation"]);
  });

  it("never moves backwards and only extracts links from consolidation on", () => {
    let last = -1;
    let lastIndex = 0;
    for (let ms = 0; ms <= LAB_CONSOLIDATION_END_MS + 60_000; ms += 5_000) {
      const p = labProgress(ms);
      expect(p.totalFraction).toBeGreaterThanOrEqual(last);
      expect(p.stageIndex).toBeGreaterThanOrEqual(lastIndex);
      expect(p.linksExtracted).toBe(ms >= LAB_PROBES_END_MS);
      last = p.totalFraction;
      lastIndex = p.stageIndex;
    }
    expect(labProgress(-1).ms).toBe(0);
    expect(labProgress(Number.NaN).stage).toBe("classifier");
    expect(labProgress(LAB_CLASSIFIER_END_MS).stageFraction).toBe(0);
  });

  it("streams a per-adapter rail: queued -> probing -> streaming -> settled", () => {
    expect(labRail(ADAPTERS, 0).every((r) => r.state === "queued")).toBe(true);
    const early = labRail(ADAPTERS, LAB_CLASSIFIER_END_MS);
    expect(early[0].state).toBe("probing");
    expect(early[2].state).toBe("queued"); // deterministic stagger by adapterId
    const later = labRail(ADAPTERS, LAB_PROBES_END_MS - 1);
    expect(later.every((r) => r.state === "settled")).toBe(true);
    // a real terminal adapter status always wins over the clock
    const terminal = labRail([{ adapterId: "sourceforge", status: "complete", resultCount: 9 }], 0);
    expect(terminal[0].state).toBe("settled");
    expect(terminal[0].settledByStatus).toBe(true);
    expect(terminal[0].resultCount).toBe(9);
  });
});

describe("ProgressiveLab component (frozen clock)", () => {
  it("renders the classifier stage, the timeline and a 28-source rail at t+10s", () => {
    useSearchStore.setState({ adapters: ADAPTERS });
    render(<ProgressiveLab nowMs={10_000} />);
    const lab = screen.getByTestId("progressive-lab");
    expect(lab.getAttribute("data-stage")).toBe("classifier");
    expect(screen.getByTestId("lab-stage").textContent).toBe("Classifier");
    expect(screen.getByTestId("lab-stage-classifier").getAttribute("data-state")).toBe("active");
    expect(screen.getByTestId("lab-stage-probes").getAttribute("data-state")).toBe("pending");
    const rows = screen.getAllByTestId("lab-adapter-row");
    expect(rows.length).toBe(3);
    expect(document.getElementById("f56.search.v2.labAdapterRow.project-gutenberg")).not.toBeNull();
    expect(document.getElementById("f56.search.v2.labAdapterBar.project-gutenberg")?.getAttribute("aria-valuenow")).toBe("0");
  });

  it("streams partials during probes and extracts direct HTTPS links in consolidation", () => {
    useSearchStore.setState({
      adapters: ADAPTERS,
      results: {
        g1: {
          resultId: "g1",
          adapterId: "project-gutenberg",
          nameKey: "search.sources.projectGutenberg",
          category: "books",
          title: "Pride and Prejudice",
          sizeBytes: 412000,
          licenceTag: "public-domain",
          sourceSnapshotId: "s",
          sourceUrl: "https://www.gutenberg.org/ebooks/1342",
        },
      },
      resultOrder: ["g1"],
    });
    const { unmount } = render(<ProgressiveLab nowMs={LAB_CLASSIFIER_END_MS + 10_000} />);
    expect(screen.getByTestId("progressive-lab").getAttribute("data-stage")).toBe("probes");
    expect(screen.getByTestId("lab-stage-probes").getAttribute("data-state")).toBe("active");
    const probeRow = document.getElementById("f56.search.v2.labAdapterRow.project-gutenberg") as HTMLElement;
    expect(["probing", "streaming", "settled"]).toContain(probeRow.getAttribute("data-state"));
    unmount();

    render(<ProgressiveLab nowMs={LAB_PROBES_END_MS + 5_000} />);
    expect(screen.getByTestId("progressive-lab").getAttribute("data-stage")).toBe("consolidation");
    expect(screen.getByTestId("lab-stage-consolidation").getAttribute("data-state")).toBe("active");
    expect(screen.getByTestId("lab-links").textContent).toContain("1");
    expect(document.getElementById("f56.search.v2.labLinks")).not.toBeNull();
  });
});
