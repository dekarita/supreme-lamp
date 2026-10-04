// [F78 §4.2 / §6B] The stored-site Lab inspector: matching links first and
// highlighted, the rest behind the collapsed "All N links" section, the toggle
// flips the list, every link opens in a new tab with rel="noopener noreferrer",
// and a 429 turns the refetch into a visible countdown.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import "@/i18n";
import { LabInspector } from "@/pages/search/LabInspector";
import type { CustomSourceRow, LabInspectResult } from "@/api/lab";

const inspectSource = vi.fn();
vi.mock("@/api/lab", async (orig) => {
  const actual = await orig<typeof import("@/api/lab")>();
  return { ...actual, inspectSource: (...args: unknown[]) => inspectSource(...args) };
});

const SOURCE: CustomSourceRow = {
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

const DATA: LabInspectResult = {
  hostname: "docs.python.org",
  title: "Python 3 documentation",
  fetchedAt: "2026-10-04T00:00:00Z",
  linkCount: 3,
  matchCount: 1,
  links: [
    { text: "ssl — TLS support", href: "https://docs.python.org/3/library/ssl.html", matches: true },
    { text: "asyncio", href: "https://docs.python.org/3/library/asyncio.html", matches: false },
    { text: "typing", href: "https://docs.python.org/3/library/typing.html", matches: false },
  ],
};

function mount(query = "TLS") {
  render(
    <MemoryRouter>
      <LabInspector source={SOURCE} query={query} />
    </MemoryRouter>
  );
}

beforeEach(() => {
  inspectSource.mockReset();
});

describe("F78 LabInspector", () => {
  it("posts sourceId + query and renders title, hostname and the match count", async () => {
    inspectSource.mockResolvedValue({ ok: true, data: DATA });
    mount();
    await waitFor(() => expect(screen.getByTestId("lab-site-title")).toHaveTextContent("Python 3 documentation"));
    expect(screen.getByTestId("lab-hostname")).toHaveTextContent("docs.python.org");
    expect(screen.getByTestId("lab-match-count").textContent).toContain("1 of 3 links match");
    expect(inspectSource).toHaveBeenCalledWith("docs-python-org", "TLS");
  });

  it("shows matching links first/highlighted and hides non-matches behind the collapsed section", async () => {
    inspectSource.mockResolvedValue({ ok: true, data: DATA });
    mount();
    await waitFor(() => expect(screen.getByTestId("lab-link-list")).toBeInTheDocument());
    const rows = screen.getAllByTestId("lab-link-row");
    expect(rows).toHaveLength(1); // matches-first ON = the matching set only
    expect(rows[0].getAttribute("data-matches")).toBe("true");
    expect(rows[0].className).toContain("bg-accent/10");
    expect(screen.queryByTestId("lab-all-links-list")).toBeNull();
    fireEvent.click(screen.getByTestId("lab-all-links-toggle"));
    expect(screen.getByTestId("lab-all-links-list").textContent).toContain("asyncio.html");
  });

  it("the Matches first toggle reveals the full homepage list", async () => {
    inspectSource.mockResolvedValue({ ok: true, data: DATA });
    mount();
    await waitFor(() => expect(screen.getAllByTestId("lab-link-row")).toHaveLength(1));
    fireEvent.click(screen.getByTestId("lab-matches-first"));
    expect(screen.getAllByTestId("lab-link-row")).toHaveLength(3);
  });

  it("every link row opens in a new tab with rel=noopener noreferrer", async () => {
    inspectSource.mockResolvedValue({ ok: true, data: DATA });
    mount();
    await waitFor(() => expect(screen.getByTestId("lab-link-open")).toBeInTheDocument());
    const a = screen.getByTestId("lab-link-open");
    expect(a.getAttribute("target")).toBe("_blank");
    expect(a.getAttribute("rel")).toContain("noopener");
    expect(a.getAttribute("rel")).toContain("noreferrer");
    expect(a.getAttribute("href")).toBe("https://docs.python.org/3/library/ssl.html");
  });

  it("a 429 switches refetch into a visible countdown", async () => {
    inspectSource.mockResolvedValue({ ok: false, error: { code: "RATE_LIMITED", messageKey: "lab.rateLimited", retryAfterSeconds: 42 } });
    mount();
    await waitFor(() => expect(screen.getByTestId("lab-rate-limited")).toHaveTextContent("42"));
    expect(screen.getByTestId("lab-refetch")).toBeDisabled();
  });

  it.each([
    ["TIMEOUT", /10s/i],
    ["SIZE_LIMIT", /2 MB/i],
    ["HOSTNAME_MISMATCH", /hostname/i],
  ])("maps %s to a visible error state", async (code, text) => {
    inspectSource.mockResolvedValue({ ok: false, error: { code, messageKey: "lab.timeout" } });
    mount();
    await waitFor(() => expect(screen.getByTestId("lab-error")).toHaveTextContent(text));
  });
});
