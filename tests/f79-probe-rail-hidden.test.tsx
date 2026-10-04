import { beforeEach, describe, expect, it } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { useSearchStore } from "@/stores/searchStore";
import { DEFAULT_FANOUT_ADAPTER_IDS } from "@/lib/search/fanOut";
import { mountSearch, resetF79 } from "./f79-search-fixture";

beforeEach(() => resetF79());
describe("F79 debug disclosure", () => {
  it("hides the probe rail, adapter list and all phase chips by default", () => {
    mountSearch();
    expect(useSearchStore.getState().showProgress).toBe(false);
    for (const id of ["progressive-lab", "lab-adapter-rail", "adapter-status-list", "lab-stage-classifier", "lab-stage-probes", "lab-stage-consolidation", "status-live"]) {
      expect(screen.queryByTestId(id)).toBeNull();
    }
    expect(document.getElementById("f56.search.progressRail")).toBeNull();
  });
  it("Advanced's default-off toggle reveals and then hides the diagnostics", () => {
    mountSearch();
    fireEvent.click(screen.getByTestId("bar-icon-drawer"));
    const toggle = screen.getByRole("checkbox", { name: "Show search progress (debug)" });
    expect(toggle).not.toBeChecked();
    expect(toggle.id).toBe("f79.search.showProgressToggle");
    fireEvent.click(toggle);
    expect(toggle).toBeChecked();
    expect(screen.getByTestId("lab-adapter-rail")).toBeInTheDocument();
    expect(screen.getAllByTestId("lab-adapter-row").map((el) => el.dataset.adapterId).sort()).toEqual([...DEFAULT_FANOUT_ADAPTER_IDS].sort());
    fireEvent.click(toggle);
    expect(screen.queryByTestId("lab-adapter-rail")).toBeNull();
  });
  it("keeps backend status data even when diagnostic rendering is off", () => {
    useSearchStore.setState({ adapters: { "arxiv-public": { adapterId: "arxiv-public", nameKey: "search.sources.arxivPublic", status: "running", resultCount: 0 } } });
    mountSearch();
    expect(screen.queryByTestId("adapter-status-list")).toBeNull();
    expect(useSearchStore.getState().adapters["arxiv-public"].status).toBe("running");
  });
  it("uses a centered 760px container and a secondary Google link below the form", () => {
    mountSearch();
    const google = screen.getByTestId("google-nav-button");
    expect(screen.getByTestId("search-external-row")).toContainElement(google);
    expect(google).toHaveClass("text-xs", "text-tertiary");
    const form = screen.getByTestId("search-query").closest("form")!;
    expect(form.compareDocumentPosition(google) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(screen.getByTestId("search-page")).toHaveClass("mx-auto", "max-w-[760px]");
  });
});
