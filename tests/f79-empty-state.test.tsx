import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen } from "@testing-library/react";
import { useSearchStore } from "@/stores/searchStore";
import { useSearchUiStore } from "@/stores/searchUiStore";
import { useCustomSourcesStore } from "@/stores/customSourcesStore";
import { mountSearch, resetF79, RESULT, SITE } from "./f79-search-fixture";

beforeEach(() => resetF79());
afterEach(() => vi.useRealTimers());
describe("F79 clean empty state + F78 preservation", () => {
  it.each(["complete", "empty"] as const)("names the submitted query when phase=%s", (phase) => {
    useSearchStore.setState({ phase });
    mountSearch();
    expect(screen.getByTestId("results-empty")).toHaveTextContent("No results for 'xyz'. Try broader terms or");
    expect(screen.getByRole("button", { name: "+ Add a custom site" })).toBeInTheDocument();
    expect(screen.queryByTestId("adapter-status-list")).toBeNull();
    expect(screen.queryByTestId("results-loading")).toBeNull();
  });
  it("the empty-state custom-site button opens F78's quick-add modal", () => {
    mountSearch();
    fireEvent.click(screen.getByTestId("add-custom-site-button"));
    expect(document.getElementById("f78.addSite.modal")).toBeInTheDocument();
    expect(document.getElementById("f78.addSite.name")).toBeInTheDocument();
    expect(document.getElementById("f78.addSite.url")).toBeInTheDocument();
  });
  it("never turns a real zero-result response into DEV fixtures by default", async () => {
    vi.useFakeTimers();
    useSearchUiStore.setState({ devFixtureGen: 0 });
    mountSearch();
    await act(async () => { vi.advanceTimersByTime(5000); });
    expect(useSearchStore.getState().resultOrder).toEqual([]);
    expect(screen.getByTestId("results-empty")).toBeInTheDocument();
  });
  it("keeps Your sites visible above the zero-result message", () => {
    useCustomSourcesStore.setState({ labSources: [SITE] });
    mountSearch();
    const sites = screen.getByTestId("your-sites-row");
    expect(sites.compareDocumentPosition(screen.getByTestId("results-empty")) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
  });
  it("keeps Your sites first and omits headers for a single result category", () => {
    useSearchStore.setState({ results: { [RESULT.resultId]: RESULT }, resultOrder: [RESULT.resultId] });
    useCustomSourcesStore.setState({ labSources: [SITE] });
    mountSearch();
    const card = screen.getByTestId("result-card");
    expect(screen.getByTestId("your-sites-row").compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(document.getElementById("f56.search.resultsHeader")).toBeNull();
    expect(screen.getByTestId("card-snippet")).toHaveTextContent(RESULT.snippet!);
    expect(screen.getByTestId("card-direct-url")).toHaveClass("text-xs", "text-success");
    expect(card).toHaveClass("p-4", "hover:shadow-md");
  });
  it("allows a results header only when two or more categories are present", () => {
    const book = { ...RESULT, resultId: "book", category: "books" as const };
    useSearchStore.setState({ results: { [RESULT.resultId]: RESULT, book }, resultOrder: [RESULT.resultId, "book"] });
    mountSearch();
    expect(document.getElementById("f56.search.resultsHeader")).toBeInTheDocument();
  });
});
