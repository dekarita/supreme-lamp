// [F88 §A.3/§B.4/§C.3] Lab inspector source line + source tabs + the
// per-row Download button, plus the tier-naming launch failure toast.
//
// The server now answers /api/lab/inspect with sourceDisplay/tookMs/
// sourceSets; the inspector renders the visible "Source: ..." line, tabs
// across multiple fetched sources, and offers ⬇ Download to RDP next to
// file-ish URLs. launchFailureToast() names the rung that failed and points
// the operator at /#/search?diag=1 (the B.4 contract).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import "@/i18n";
import LabInspector from "@/pages/search/LabInspector";
import { launchFailureToast } from "@/lib/launchUrl";
import type { CustomSourceRow } from "@/api/lab";

const inspectSource = vi.fn();
vi.mock("@/api/lab", async (orig) => {
  const actual = await orig<typeof import("@/api/lab")>();
  return { ...actual, inspectSource: (...args: unknown[]) => inspectSource(...args) };
});
const requestFetch = vi.fn();
vi.mock("@/api/fetch", async (orig) => {
  const actual = await orig<typeof import("@/api/fetch")>();
  return { ...actual, requestFetch: (...args: unknown[]) => requestFetch(...args) };
});

const SOURCE = {
  id: "openculture-com",
  name: "openculture.com",
  hostname: "openculture.com",
  baseUrl: "https://openculture.com/",
  labMode: true,
} as unknown as CustomSourceRow;

const SET_A = {
  key: "search-endpoint",
  label: "HTML search endpoint",
  strategy: "html",
  count: 42,
  links: [
    { text: "Free Online Philosophy Courses", href: "https://www.openculture.com/freeonlinecourses", matches: true },
    { text: "Philosophy", href: "https://www.openculture.com/philosophy", matches: false },
    { text: "lecture.mp3", href: "https://www.openculture.com/audio/lecture.mp3", matches: false },
  ],
};
const SET_B = {
  key: "sitemap",
  label: "Sitemap XML",
  strategy: "sitemap",
  count: 500,
  links: [
    { text: "/about", href: "https://openculture.com/about", matches: false },
    { text: "/courses", href: "https://openculture.com/courses", matches: false },
  ],
};
const PAYLOAD = {
  hostname: "openculture.com",
  title: "Open Culture",
  fetchedAt: "2026-10-05T00:00:00Z",
  linkCount: 42,
  matchCount: 1,
  source: "search-endpoint",
  sourceUrls: 42,
  sourceDisplay: "HTML search endpoint",
  sourceStrategy: "html",
  tookMs: 1200,
  sourceSets: [SET_A, SET_B],
  links: SET_A.links.map((l) => ({ ...l })),
  adapterStatus: { phase: "search-endpoint", sourceLabel: "search-endpoint" },
};

function renderInspector() {
  return render(
    <MemoryRouter initialEntries={["/search/lab/openculture-com"]}>
      <LabInspector source={SOURCE} query="Free Online Philosophy Courses" />
    </MemoryRouter>,
  );
}

describe("F88 LabInspector source line + tabs", () => {
  beforeEach(() => {
    inspectSource.mockReset();
    requestFetch.mockReset();
    requestFetch.mockResolvedValue({ ok: true, data: { path: "C:\\Users\\runner\\Desktop\\RDP-Downloads\\lecture.mp3" } });
  });

  it("renders the visible Source line with strategy, count and timing", async () => {
    inspectSource.mockResolvedValue({ ok: true, data: PAYLOAD });
    renderInspector();
    const line = await screen.findByTestId("lab-source-line");
    expect(line.textContent).toContain("HTML search endpoint");
    expect(line.textContent).toContain("42");
    expect(line.textContent).toContain("1.2");
    // the legacy lab-source span keeps serving the F86 assertions
    expect(screen.getByTestId("lab-source").textContent).toContain("search-endpoint");
  });

  it("tabs across every fetched source and switches the visible list", async () => {
    inspectSource.mockResolvedValue({ ok: true, data: PAYLOAD });
    renderInspector();
    await screen.findByTestId("lab-source-tabs");
    const tabs = screen.getAllByTestId("lab-source-tab");
    expect(tabs).toHaveLength(2);
    expect(tabs[0].textContent).toContain("HTML search endpoint (42)");
    expect(tabs[1].textContent).toContain("Sitemap XML (500)");
    expect(tabs[0].getAttribute("data-active")).toBe("true");
    // default tab = the search endpoint's matching rows
    expect(screen.getAllByTestId("lab-link-row").length).toBeGreaterThan(0);
    fireEvent.click(tabs[1]);
    expect(tabs[1].getAttribute("data-active")).toBe("true");
    // matches-first is ON by default; show the whole (unmatched) sitemap set
    fireEvent.click(screen.getByTestId("lab-matches-first"));
    const hrefs = screen.getAllByTestId("lab-link-row").map((r) => r.textContent);
    expect(hrefs.join(" ")).toContain("openculture.com/about");
    expect(hrefs.join(" ")).not.toContain("freeonlinecourses");
  });

  it("shows no tabs when only one source was fetched", async () => {
    inspectSource.mockResolvedValue({ ok: true, data: { ...PAYLOAD, sourceSets: [SET_A] } });
    renderInspector();
    await screen.findByTestId("lab-source-line");
    expect(screen.queryByTestId("lab-source-tabs")).toBeNull();
  });

  it("file-ish rows get the ⬇ Download button and post download=true", async () => {
    inspectSource.mockResolvedValue({ ok: true, data: { ...PAYLOAD, sourceSets: [SET_A], matchesFirst: undefined } });
    // matches-first hides non-matching rows by default; flip it off so the mp3 shows
    renderInspector();
    await screen.findByTestId("lab-link-list");
    fireEvent.click(screen.getByTestId("lab-matches-first"));
    const dl = await screen.findByTestId("lab-link-download");
    expect(dl).toBeTruthy();
    fireEvent.click(dl);
    await vi.waitFor(() => expect(requestFetch).toHaveBeenCalledTimes(1));
    const req = requestFetch.mock.calls[0][0] as { download?: boolean; urlImport?: { url: string } };
    expect(req.download).toBe(true);
    expect(req.urlImport?.url).toContain("lecture.mp3");
  });

  it("only the one file-ish row in the set gets a download button", async () => {
    inspectSource.mockResolvedValue({ ok: true, data: { ...PAYLOAD, sourceSets: [SET_A] } });
    renderInspector();
    await screen.findByTestId("lab-link-list");
    fireEvent.click(screen.getByTestId("lab-matches-first"));
    // SET_A = 2 landing pages + 1 .mp3: exactly one download button appears
    expect(screen.getAllByTestId("lab-link-row")).toHaveLength(3);
    expect(screen.getAllByTestId("lab-link-download")).toHaveLength(1);
  });
});

describe("F88 launchFailureToast", () => {
  const t = (key: string, opts?: Record<string, unknown>) => {
    if (key === "search.launchUrl.failedTier") return `Could not open in RDP (tier ${opts?.tier} failed): ${opts?.reason}. See /#/search?diag=1 for details.`;
    if (key === "search.launchUrl.failed") return "Could not open in RDP";
    if (key === "search.launchUrl.retry") return "Retry";
    return key;
  };

  it("names the failed rung and links the diag panel", () => {
    const msg = launchFailureToast({ ok: false, reason: "search.launchUrl.failed", code: "LAUNCH_FAILED", tier: 3 }, t);
    expect(msg).toContain("tier 3 failed");
    expect(msg).toContain("/#/search?diag=1");
  });

  it("falls back to the F84 reason + retry line when no tier is known", () => {
    const msg = launchFailureToast({ ok: false, reason: "search.launchUrl.failed", code: "transport" }, t);
    expect(msg).toContain("Could not open in RDP");
    expect(msg).toContain("Retry");
  });
});
