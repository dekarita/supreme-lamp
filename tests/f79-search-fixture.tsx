import "@testing-library/jest-dom/vitest";
import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import "@/i18n";
import Search from "@/pages/Search";
import { useSearchStore } from "@/stores/searchStore";
import { useSearchUiStore } from "@/stores/searchUiStore";
import { resetCustomSourcesStore } from "@/stores/customSourcesStore";
import type { CustomSourceRow } from "@/api/lab";
import type { SearchPhase, SearchResult } from "@/api/search";

export const RESULT: SearchResult = {
  resultId: "f79-result", adapterId: "arxiv-public", nameKey: "search.sources.arxivPublic",
  category: "scholarly", title: "TLS overview", creator: "Open archive", snippet: "Secure connections explained.",
  licenceTag: "open-access", sourceSnapshotId: "snapshot-1", sourceUrl: "https://arxiv.org/abs/2606.01342",
};
export const SITE: CustomSourceRow = {
  id: "docs-python-org", name: "Python docs", hostname: "docs.python.org",
  baseUrl: "https://docs.python.org", labMode: true, category: "software",
  allowedDomains: ["docs.python.org"], enableState: "permanent", addedAt: "2026-10-04T00:00:00Z",
};
export function resetF79(phase: SearchPhase = "complete") {
  useSearchStore.setState(useSearchStore.getInitialState(), true);
  useSearchStore.setState({ phase, lastSubmittedQuery: "xyz", normalizedQuery: "xyz", rawQuery: "xyz", inputKind: "text", queryGeneration: 1 });
  useSearchUiStore.setState(useSearchUiStore.getInitialState(), true);
  useSearchUiStore.setState({ view: "results", devFixtureGen: 1 });
  resetCustomSourcesStore();
}
export function mountSearch() {
  return render(<MemoryRouter initialEntries={["/search"]}><Search /></MemoryRouter>);
}
