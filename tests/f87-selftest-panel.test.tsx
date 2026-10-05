// [F87 §C.2/§E.B] The eleven-site self-test panel: hidden unless ?selftest=1,
// one POST with the operator fixture, a progress bar while it runs, one row per
// site with four cells read from SERVER data (never a hard-coded tick), a red
// mark + error tooltip on any failure, and the visible 429 / error states.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import "@/i18n";
import { F87SelfTestPanel, F87_SITES, cellOk, rowOk } from "@/components/search/F87SelfTestPanel";

const SITES = ["openculture.com", "archive.org", "openverse.org", "awesome.re", "gutenberg.org", "standardebooks.org",
  "librivox.org", "openlibrary.org", "tubitv.com", "pluto.tv", "freemusicarchive.org"];

function mount(entry: string) {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <F87SelfTestPanel />
    </MemoryRouter>,
  );
}

const okRow = (site: string, over: Record<string, unknown> = {}) => ({
  site, probeOk: true, sitemapUrls: 1234, launchTier: 1, launchOk: true, launchDetail: "direct-spawn", downloadDirOk: true,
  downloadDir: "C:\\Users\\runner\\Desktop\\RDP-Downloads", errors: [],
  // [F90 §D] awesome.re's row carries the cross-domain README proof: the
  // strategy that ran and how many items the Networking section resolved to.
  ...(site === "awesome.re" ? { searchStrategy: "markdown-section", searchOk: true, searchItems: 12, networkingItemCount: 12 } : {}),
  ...over,
});

function stubFetch(status: number, body: unknown) {
  const fn = vi.fn(() => Promise.resolve({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) } as unknown as Response));
  vi.stubGlobal("fetch", fn);
  return fn;
}

beforeEach(() => vi.unstubAllGlobals());

describe("F87 self-test panel", () => {
  it("the fixture is the eleven operator sites, verbatim", () => {
    expect([...F87_SITES]).toEqual(SITES);
  });

  it("renders nothing unless ?selftest=1", () => {
    mount("/search");
    expect(screen.queryByTestId("f87-selftest-panel")).toBeNull();
    mount("/search?diag=1");
    expect(screen.queryByTestId("f87-selftest-panel")).toBeNull();
  });

  it("Run self-test POSTs the eleven sites once and renders one row per site from server data", async () => {
    const fn = stubFetch(200, { ok: true, total: 11, passed: 10, results: SITES.map((s) => (s === "pluto.tv" ? okRow(s, { launchTier: 2 }) : okRow(s))) });
    mount("/search?selftest=1");
    expect(screen.getByTestId("f87-selftest-panel").getAttribute("data-phase")).toBe("idle");
    fireEvent.click(screen.getByTestId("f87-selftest-run"));
    await waitFor(() => expect(screen.getByTestId("f87-selftest-table")).toBeTruthy());
    expect(fn).toHaveBeenCalledTimes(1);
    const [url, init] = (fn.mock.calls[0] as unknown as [string, RequestInit]);
    expect(url.endsWith("/api/f87-selftest")).toBe(true);
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body)).sites).toEqual(SITES);
    for (const s of SITES) expect(screen.getByTestId("f87-selftest-row-" + s.replace(/[^a-z0-9]+/g, "-")).getAttribute("data-ok")).toBe("1");
    expect(screen.getByTestId("f87-selftest-row-pluto-tv").textContent).toContain("2");
    expect(screen.getByTestId("f87-selftest-summary").getAttribute("data-passed")).toBe("11");
  });

  it("a failed cell is a red mark with the server error as tooltip; clicking the row shows the detail", async () => {
    stubFetch(200, { ok: true, results: [okRow("archive.org"), okRow("pluto.tv", { probeOk: false, sitemapUrls: 0, errors: ["probe: timeout", "sitemap: no URLs found"] })] });
    mount("/search?selftest=1");
    fireEvent.click(screen.getByTestId("f87-selftest-run"));
    const row = await screen.findByTestId("f87-selftest-row-pluto-tv");
    expect(row.getAttribute("data-ok")).toBe("0");
    expect(row.getAttribute("title")).toContain("probe: timeout");
    expect(row.textContent).toContain("\u2717");
    fireEvent.click(row);
    expect(screen.getByTestId("f87-selftest-detail-pluto-tv").textContent).toContain("sitemap: no URLs found");
    expect(screen.getByTestId("f87-selftest-summary").getAttribute("data-passed")).toBe("1");
  });

  it("a 429 renders the countdown line, a transport failure renders the error line (never a silent no-op)", async () => {
    stubFetch(429, { code: "RATE_LIMITED", retryAfterSeconds: 42 });
    mount("/search?selftest=1");
    fireEvent.click(screen.getByTestId("f87-selftest-run"));
    expect((await screen.findByTestId("f87-selftest-rate-limited")).textContent).toContain("42");
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("down"))));
    mount("/search?selftest=1");
    fireEvent.click(screen.getAllByTestId("f87-selftest-run")[1]);
    expect((await screen.findByTestId("f87-selftest-error")).textContent).toContain("transport");
  });

  it("cell/row verdicts come only from server fields (absent = fail)", () => {
    expect(rowOk(okRow("archive.org"))).toBe(true);
    expect(cellOk({ site: "x" }, "https")).toBe(false);
    expect(cellOk({ site: "x", sitemapUrls: 0 }, "sitemapUrls")).toBe(false);
    expect(cellOk({ site: "x", launchOk: true, launchTier: 4 }, "launchTier")).toBe(false);
    expect(cellOk({ site: "x", launchOk: true, launchTier: 3 }, "launchTier")).toBe(true);
    expect(cellOk({ site: "x", downloadDirOk: true }, "downloadDir")).toBe(true);
  });
});
