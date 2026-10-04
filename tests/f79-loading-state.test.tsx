import { beforeEach, describe, expect, it } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { useSearchStore } from "@/stores/searchStore";
import { mountSearch, resetF79, RESULT } from "./f79-search-fixture";

beforeEach(() => resetF79("running"));
describe("F79 single-spinner loading", () => {
  it.each(["queued", "running", "partial"] as const)("shows one spinner while phase=%s with no rows", (phase) => {
    useSearchStore.setState({ phase });
    mountSearch();
    expect(screen.getByTestId("results-loading")).toHaveTextContent("Searching...");
    expect(screen.getAllByTestId("search-spinner")).toHaveLength(1);
    expect(screen.getByTestId("search-spinner")).toHaveAttribute("aria-hidden", "true");
    expect(screen.queryByTestId("results-empty")).toBeNull();
    expect(screen.queryByTestId("progressive-lab")).toBeNull();
  });
  it("does not replace streamed result cards with the initial loading state", () => {
    useSearchStore.setState({ phase: "partial", results: { [RESULT.resultId]: RESULT }, resultOrder: [RESULT.resultId] });
    mountSearch();
    expect(screen.getByTestId("result-card")).toBeInTheDocument();
    expect(screen.queryByTestId("results-loading")).toBeNull();
  });
  it("only reveals per-source progress after explicit opt-in", () => {
    mountSearch();
    fireEvent.click(screen.getByTestId("bar-icon-drawer"));
    fireEvent.click(screen.getByTestId("show-progress-toggle"));
    expect(screen.getByTestId("lab-adapter-rail")).toBeInTheDocument();
    expect(screen.getAllByTestId("search-spinner")).toHaveLength(1);
  });
});
