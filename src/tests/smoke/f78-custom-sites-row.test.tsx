// [F78 §3.1/§3.2 / §6B] "Your sites": one card per stored Lab Mode source,
// hidden entirely with no sources, CTA carries the query, and a click routes to
// /search/lab/<sourceId>?q=<query>. An empty query opens the site without an
// injected search - a stored site is never queried on the operator's behalf.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import "@/i18n";
import { CustomSitesRow } from "@/components/search/CustomSitesRow";
import { resetCustomSourcesStore, useCustomSourcesStore } from "@/stores/customSourcesStore";
import type { CustomSourceRow } from "@/api/lab";

const DOCS: CustomSourceRow = {
  id: "docs-python-org",
  name: "Python docs",
  baseUrl: "https://docs.python.org",
  hostname: "docs.python.org",
  labMode: true,
  category: "software",
  allowedDomains: ["docs.python.org"],
  enableState: "permanent",
  addedAt: "2026-10-04T00:00:00Z",
};
const WIKI: CustomSourceRow = { ...DOCS, id: "si-wikipedia-org", name: "Wikipedia", baseUrl: "https://si.wikipedia.org", hostname: "si.wikipedia.org" };

function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="location">{loc.pathname + loc.search}</div>;
}

function mount(sources: CustomSourceRow[], query: string) {
  render(
    <MemoryRouter initialEntries={["/search"]}>
      <Routes>
        <Route
          path="*"
          element={
            <>
              <LocationProbe />
              <CustomSitesRow query={query} sources={sources} />
            </>
          }
        />
      </Routes>
    </MemoryRouter>
  );
}

beforeEach(() => {
  resetCustomSourcesStore();
});

describe("F78 CustomSitesRow", () => {
  it("renders nothing when there are no stored Lab sources", () => {
    mount([], "tls");
    expect(screen.queryByTestId("your-sites-row")).toBeNull();
  });

  it("renders one card per source with its hostname", () => {
    mount([DOCS, WIKI], "tls");
    expect(screen.getByTestId("your-sites-row")).toBeInTheDocument();
    expect(screen.getByTestId("your-site-card-docs-python-org")).toBeInTheDocument();
    expect(screen.getByTestId("your-site-card-si-wikipedia-org")).toBeInTheDocument();
    expect(screen.getByText("docs.python.org")).toBeInTheDocument();
    expect(screen.getByText("si.wikipedia.org")).toBeInTheDocument();
  });

  it("the CTA names the query and the hostname", () => {
    mount([DOCS], "TLS-Radar");
    expect(screen.getByTestId("your-site-cta-docs-python-org").textContent).toContain("TLS-Radar");
    expect(screen.getByTestId("your-site-cta-docs-python-org").textContent).toContain("docs.python.org");
  });

  it("an empty query opens the site without injecting a search", () => {
    mount([DOCS], "");
    expect(screen.getByTestId("your-site-cta-docs-python-org").textContent).toContain("docs.python.org");
    expect(screen.getByTestId("your-site-cta-docs-python-org").textContent).not.toContain("Deep-inspect");
  });

  it("clicking a card routes to /search/lab/<sourceId>?q=<query>", () => {
    mount([DOCS], "typing");
    fireEvent.click(screen.getByTestId("your-site-cta-docs-python-org"));
    expect(screen.getByTestId("location").textContent).toBe("/search/lab/docs-python-org?q=typing");
  });

  it("the ⋯ Open Lab button routes to the same inspector", () => {
    mount([DOCS], "typing");
    fireEvent.click(screen.getByTestId("your-site-open-lab-docs-python-org"));
    expect(screen.getByTestId("location").textContent).toBe("/search/lab/docs-python-org?q=typing");
  });

  it("falls back to a letter avatar when the favicon errors", () => {
    mount([DOCS], "typing");
    const img = screen.getByTestId("your-site-favicon-docs-python-org");
    expect(img.getAttribute("src")).toBe("https://docs.python.org/favicon.ico");
    fireEvent.error(img);
    expect(screen.getByTestId("site-avatar-letter")).toHaveTextContent("D");
  });

  it("the store's labSources drive the row when no sources prop is given", () => {
    useCustomSourcesStore.setState({ labSources: [WIKI] });
    render(
      <MemoryRouter>
        <CustomSitesRow query="x" />
      </MemoryRouter>
    );
    expect(screen.getByTestId("your-site-card-si-wikipedia-org")).toBeInTheDocument();
  });

  it("is mounted ABOVE the public results on the search page (order contract)", async () => {
    const src = (await import("node:fs")).readFileSync("src/pages/Search.tsx", "utf8");
    const rowAt = src.indexOf("<CustomSitesRow");
    const gridAt = src.indexOf("<ResultsGrid />");
    expect(rowAt).toBeGreaterThan(0);
    expect(gridAt).toBeGreaterThan(0);
    expect(rowAt).toBeLessThan(gridAt);
    // Mounted OUTSIDE the "public results exist" condition, so stored sites are
    // reachable when the federated lane returns nothing.
    expect(src).toContain("{totalResults > 0 ? <ResultsGrid /> : null}");
  });
});
