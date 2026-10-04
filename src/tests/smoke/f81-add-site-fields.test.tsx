// [F81 §4.1/Q9 + §5.0/Q10] Vitest-runt coverage for the AddSiteQuick
// per-field error rendering + max-sites cap. The existing F78 test still
// owns the data-testid="add-site-error" invariant; this file pins the new
// per-field ids + the disabled-when-cap behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import "@/i18n";
import { AddSiteQuick } from "@/components/search/AddSiteQuick";
import {
  MAX_CUSTOM_SITES,
  resetCustomSourcesStore,
  useCustomSourcesStore,
} from "@/stores/customSourcesStore";

function mount() {
  const onClose = vi.fn();
  render(
    <MemoryRouter>
      <AddSiteQuick open={true} onClose={onClose} />
    </MemoryRouter>,
  );
  return onClose;
}

function stubFetchGet(rows: unknown[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ ok: true, source: rows[0] }),
        } as unknown as Response);
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ sources: rows }),
      } as unknown as Response);
    }),
  );
}

beforeEach(() => {
  resetCustomSourcesStore();
  stubFetchGet([]);
});

describe("F81 AddSiteQuick per-field + cap", () => {
  it("renders the URL error inline under the URL input (no toast)", () => {
    mount();
    fireEvent.change(screen.getByTestId("add-site-name"), { target: { value: "Demo" } });
    fireEvent.change(screen.getByTestId("add-site-url"), { target: { value: "http://example.com" } });
    fireEvent.click(screen.getByTestId("add-site-save"));
    expect(screen.getByTestId("add-site-url-error")).toBeInTheDocument();
  });

  it("renders the name error inline under the name input", () => {
    mount();
    // empty name is rejected by validateNewSite
    fireEvent.change(screen.getByTestId("add-site-url"), { target: { value: "https://example.com" } });
    fireEvent.click(screen.getByTestId("add-site-save"));
    expect(screen.getByTestId("add-site-name-error")).toBeInTheDocument();
  });

  it("disables Save + shows the at-cap hint when 50 sites are already present", () => {
    const rows = Array.from({ length: MAX_CUSTOM_SITES }, (_, i) => ({
      id: "row-" + i,
      name: "row-" + i,
      baseUrl: "https://row" + i + ".example.com",
      hostname: "row" + i + ".example.com",
      labMode: true,
      category: "software",
      allowedDomains: ["row" + i + ".example.com"],
      enableState: "permanent",
      addedAt: new Date().toISOString(),
    }));
    useCustomSourcesStore.setState({ labSources: rows as any });
    mount();
    expect(screen.getByTestId("add-site-at-cap")).toBeInTheDocument();
    expect(screen.getByTestId("add-site-save")).toBeDisabled();
  });
});