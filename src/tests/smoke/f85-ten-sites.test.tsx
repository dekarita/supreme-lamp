// [F85 §1/§4] Local (vitest/jsdom) mirror of the ten-site E2E flow. The E2E lane
// cannot run in every sandbox (no Chromium download), so the SAME operator
// fixture is replayed here against the shipped components: bare-domain
// normalisation, the stored-row card, the visible canonical host, the Lab's
// www-tolerance and the file-ish download button. Any regression in those five
// behaviours fails locally, before CI.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import "@/i18n";
import FIXTURE from "../../../tests/e2e/fixtures/f85-sites.json";
import { AddSiteQuick, isInsecureHttp, normalizeUrl } from "@/components/search/AddSiteQuick";
import { CustomSitesRow } from "@/components/search/CustomSitesRow";
import { LabInspector } from "@/pages/search/LabInspector";
import Search from "@/pages/Search";
import { fileUrlExtension, isFileLikeUrl } from "@/pages/search/tokens";
import { resetCustomSourcesStore, useCustomSourcesStore } from "@/stores/customSourcesStore";
import { DEFAULT_MAX_SIZE_BYTES, useSearchStore } from "@/stores/searchStore";
import { useSearchUiStore } from "@/stores/searchUiStore";
import { useToastStore } from "@/stores/toastStore";
import type { CustomSourceRow } from "@/api/lab";
import F58 from "@/search/custom-source-core";

const SITES = (FIXTURE as unknown as { sites: string[] }).sites;
const idOf = (site: string) => site.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

const inspectSource = vi.fn();
vi.mock("@/api/lab", async (orig) => {
  const actual = await orig<typeof import("@/api/lab")>();
  return { ...actual, inspectSource: (...args: unknown[]) => inspectSource(...args) };
});

function row(site: string, extra: Partial<CustomSourceRow> = {}): CustomSourceRow {
  return {
    id: idOf(site),
    name: site,
    baseUrl: "https://" + site,
    hostname: site,
    labMode: true,
    category: "software",
    allowedDomains: [site],
    enableState: "permanent",
    addedAt: "2026-10-04T00:00:00Z",
    ...extra,
  };
}

beforeEach(() => {
  resetCustomSourcesStore();
  inspectSource.mockReset();
  useToastStore.setState({ toasts: [] });
});

describe("F85 operator fixture (local)", () => {
  it("names every operator domain exactly once and slugifies it to the stored id", () => {
    expect(SITES.length).toBeGreaterThanOrEqual(10);
    expect(new Set(SITES).size).toBe(SITES.length);
    for (const site of SITES) {
      // The fixture the mock serves and the id the UI builds must agree.
      expect(FIXTURE.sources.find((s) => s.hostname === site)?.id).toBe(idOf(site));
    }
  });

  it.each(SITES)("%s: bare input -> https:// + file-ish detection", (site) => {
    // 1. auto-https: exactly what the operator types (no scheme).
    expect(normalizeUrl(site)).toBe("https://" + site);
    expect(normalizeUrl(site + "/media/x.pdf")).toBe("https://" + site + "/media/x.pdf");
    // An explicit http:// is preserved so the modal can refuse it visibly.
    expect(isInsecureHttp("http://" + site)).toBe(true);
    expect(normalizeUrl("http://" + site)).toBe("http://" + site);
    // The hostname the store derives must survive non-.com TLDs (awesome.re,
    // pluto.tv, tubitv.com) - the F58 core is the single source of truth.
    expect(F58.hostnameFor("https://" + site)).toBe(site);
    // 4. a file URL on this host is file-ish: the F84 Download-to-RDP button.
    expect(fileUrlExtension("https://" + site + "/media/sample.pdf")).toBe("pdf");
    expect(isFileLikeUrl("https://" + site + "/media/sample.mp4")).toBe(true);
    expect(isFileLikeUrl("https://" + site + "/details/landing-page")).toBe(false);
  });

  it.each(SITES)("%s: the stored row renders a card, delete modal and canonical host", async (site) => {
    const withCanonical = row(site, { canonicalHostname: "www." + site });
    render(
      <MemoryRouter>
        <CustomSitesRow query="" sources={[withCanonical]} />
      </MemoryRouter>,
    );
    expect(screen.getByTestId("your-site-card-" + idOf(site))).toBeInTheDocument();
    // 2. the site is visible on the row, and the probe-answered host is SHOWN
    //    (the F85 §2 fix: F84 stored it but the client dropped it).
    expect(screen.getByTestId("your-site-canonical-" + idOf(site))).toHaveTextContent("www." + site);
    // 5. delete: trash -> confirm modal.
    fireEvent.click(screen.getByTestId("your-site-delete-" + idOf(site)));
    expect(screen.getByTestId("delete-site-modal")).toBeInTheDocument();
  });

  it("no canonical line is rendered when the probe answered the typed host", () => {
    render(
      <MemoryRouter>
        <CustomSitesRow query="" sources={[row("openculture.com")]} />
      </MemoryRouter>,
    );
    expect(screen.queryByTestId("your-site-canonical-openculture-com")).toBeNull();
  });

  it("the add-site modal posts the normalised https URL for a non-.com TLD", async () => {
    const posts: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, init?: RequestInit) => {
        if (init?.method === "POST") {
          posts.push(JSON.parse(String(init.body)));
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve({ ok: true, source: row("awesome.re") }),
          } as unknown as Response);
        }
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ sources: [] }) } as unknown as Response);
      }),
    );
    render(
      <MemoryRouter>
        <AddSiteQuick open={true} onClose={() => {}} />
      </MemoryRouter>,
    );
    fireEvent.change(screen.getByTestId("add-site-name"), { target: { value: "Awesome" } });
    fireEvent.change(screen.getByTestId("add-site-url"), { target: { value: "awesome.re" } });
    fireEvent.click(screen.getByTestId("add-site-save"));
    await waitFor(() => expect(posts.length).toBe(1));
    expect(posts[0].baseUrl).toBe("https://awesome.re");
    vi.unstubAllGlobals();
  });

  it("the Lab accepts a www answer for a bare-stored site (no hostname error)", async () => {
    inspectSource.mockResolvedValue({
      ok: true,
      data: {
        hostname: "www.openculture.com",
        title: "Open Culture",
        fetchedAt: "2026-10-04T00:00:00Z",
        linkCount: 1,
        matchCount: 1,
        links: [{ text: "free courses", href: "https://www.openculture.com/free_courses", matches: true }],
      },
    });
    render(
      <MemoryRouter>
        <LabInspector source={row("openculture.com")} query="free" />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByTestId("lab-hostname")).toHaveTextContent("www.openculture.com"));
    expect(screen.queryByText(/different hostname/i)).toBeNull();
    expect(screen.getByTestId("lab-link-list")).toBeInTheDocument();
  });

  it("a file-ish result on a stored site renders the download button and toasts the RDP path", async () => {
    useSearchStore.setState({
      phase: "complete",
      results: {
        f1: {
          resultId: "f1",
          adapterId: "custom",
          nameKey: "search.sources.custom",
          category: "software",
          title: "openculture.com public media bundle",
          creator: "Operator fixture",
          sizeBytes: 12345,
          licenceTag: "open-access",
          sourceSnapshotId: "f85-snapshot-1",
          sourceUrl: "https://openculture.com/media/sample.pdf",
        },
      },
      resultOrder: ["f1"],
      adapters: {},
      categories: [],
      licenceTags: [],
      maxSizeBytes: DEFAULT_MAX_SIZE_BYTES,
      sort: "relevance",
      fetches: {},
    });
    useSearchUiStore.setState({ view: "results", animating: false });
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        calls.push(String(url));
        return Promise.resolve({
          ok: true,
          status: 200,
          text: () => Promise.resolve(JSON.stringify({ ok: true, path: "C:\\Users\\runner\\Desktop\\RDP-Downloads\\sample.pdf", bytes: 12345 })),
          json: () => Promise.resolve({ ok: true, path: "C:\\Users\\runner\\Desktop\\RDP-Downloads\\sample.pdf", bytes: 12345 }),
        } as unknown as Response);
      }),
    );
    render(
      <MemoryRouter initialEntries={["/search"]}>
        <Search />
      </MemoryRouter>,
    );
    const dl = screen.getByTestId("card-download-rdp");
    fireEvent.click(dl);
    await waitFor(() => expect(calls.some((u) => u.includes("/api/fetch?download=true"))).toBe(true));
    await waitFor(() =>
      expect(useToastStore.getState().toasts.map((x) => x.msg).join(" ")).toContain("RDP-Downloads"),
    );
    vi.unstubAllGlobals();
  });
});
