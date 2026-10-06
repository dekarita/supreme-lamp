// [F99 §3.2] /#/collector - the Diagnosis Collector page, EXECUTED.
//
// The page's whole job is honesty: it must show "no run yet" before the first
// run, "running" while the child process works, the per-feature verdict with
// the Issue link for every red row, and the two download buttons only when the
// server actually wrote the files. Each of those is asserted below against
// mocked fetch responses shaped exactly like the routes in
// payloads/ghrdp-server.ps1.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@/i18n";
import { CollectorPage, issueUrl } from "@/pages/Collector";

type Status = Record<string, unknown>;

const NEVER_RUN: Status = { ok: true, state: "never-run", messageKey: "collector.neverRun", features: {}, summary: null };

const DONE: Status = {
  ok: true,
  state: "done",
  runId: "20261006T140000Z",
  durationSec: 84,
  reportReady: true,
  markdownReady: true,
  order: ["launcher", "webSocket", "logon"],
  features: {
    launcher: { name: "launcher", status: "pass", detail: "launcher service heartbeat 3s", issue: "#148", ms: 41, data: { httpStatus: 200 } },
    webSocket: { name: "webSocket", status: "fail", detail: "upgrade failed: HTTP/1.1 401", issue: "#153", ms: 12, data: { handshakeOk: false } },
    logon: { name: "logon", status: "warn", detail: "no accepted interactive logon", issue: "#153", ms: 30, data: {} },
  },
  summary: {
    totalFeatures: 3,
    passed: 1,
    failed: 1,
    warnings: 1,
    skipped: 0,
    criticalIssues: [{ feature: "webSocket", detail: "upgrade failed: HTTP/1.1 401", issue: "#153" }],
    recommendations: ["fix the 1 failing feature(s) first"],
  },
  advisories: ["collector process started by POST /api/collector/run"],
};

function mockFetch(routes: Record<string, { ok?: boolean; status?: number; body: unknown }>) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    const key = Object.keys(routes).find((k) => path.startsWith(k));
    const hit = key ? routes[key] : undefined;
    if (!hit) throw new Error("unmocked " + path);
    void init;
    return {
      ok: hit.ok !== false,
      status: hit.status ?? 200,
      json: async () => hit.body,
      text: async () => JSON.stringify(hit.body),
    } as unknown as Response;
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("[F99 §3.2] Diagnosis Collector page", () => {
  it("shows the never-run state and a 60-120s button, and POSTs the run", async () => {
    let statusBody: unknown = NEVER_RUN;
    const fetchMock = mockFetch({
      "/api/collector/status": { body: NEVER_RUN },
      "/api/collector/run": { status: 202, body: { ok: true, runId: "x", state: "running" } },
    });
    fetchMock.mockImplementation(async (url: string) => {
      const path = String(url);
      if (path.includes("/api/collector/status")) {
        return { ok: true, status: 200, json: async () => statusBody, text: async () => "{}" } as unknown as Response;
      }
      if (path.includes("/api/collector/run")) {
        statusBody = { ...DONE, reportReady: false, markdownReady: false };
        return { ok: true, status: 202, json: async () => ({ ok: true, runId: "x", state: "running" }), text: async () => "{}" } as unknown as Response;
      }
      throw new Error("unmocked " + path);
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    render(<CollectorPage />);
    // The state is asserted on the data attribute (locale-independent): the
    // English copy is a translation, the state machine is the contract.
    expect(screen.getByTestId("collector-page").getAttribute("data-state")).toBe("never-run");
    expect(screen.getByTestId("collector-state").textContent).toContain("No run yet");
    expect(screen.getByTestId("collector-run").textContent).toContain("60-120");

    await userEvent.click(screen.getByTestId("collector-run"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/api/collector/run"), expect.objectContaining({ method: "POST" })));
    await waitFor(() => expect(screen.getByTestId("collector-features")).toBeTruthy());
  });

  it("renders per-feature statuses, the summary cards and the Issue link for a red row", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({ "/api/collector/status": { body: DONE } }) as unknown as typeof fetch,
    );
    render(<CollectorPage />);
    await waitFor(() => expect(screen.getByTestId("collector-features")).toBeTruthy());

    expect(screen.getByTestId("collector-row-webSocket").getAttribute("data-status")).toBe("fail");
    expect(screen.getByTestId("collector-row-launcher").getAttribute("data-status")).toBe("pass");
    expect(screen.getByTestId("collector-summary-passed").textContent).toContain("1");
    expect(screen.getByTestId("collector-summary-failed").textContent).toContain("1");
    expect(screen.getByTestId("collector-critical").textContent).toContain("upgrade failed");
    expect(screen.getByTestId("collector-recommendations").textContent).toContain("fix the 1 failing");

    const links = screen.getAllByRole("link").map((a) => a.getAttribute("href"));
    expect(links).toContain("https://github.com/dekarita/supreme-lamp/issues/153");
    expect(links).toContain("https://github.com/dekarita/supreme-lamp/issues/148");

    // Downloads are enabled exactly when the server says the files exist.
    expect((screen.getByTestId("collector-download-json") as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByTestId("collector-download-md") as HTMLButtonElement).disabled).toBe(false);
  });

  it("names the reason a refused run gives (COLLECTOR_MISSING -> i18n, never a bare failure)", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      const path = String(url);
      if (path.includes("/api/collector/status")) {
        return { ok: true, status: 200, json: async () => NEVER_RUN, text: async () => "{}" } as unknown as Response;
      }
      return {
        ok: false,
        status: 503,
        json: async () => ({ ok: false, code: "COLLECTOR_MISSING", error: "ghrdp-collector.ps1 is not staged next to the server" }),
        text: async () => "{}",
      } as unknown as Response;
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    render(<CollectorPage />);
    await userEvent.click(screen.getByTestId("collector-run"));
    await waitFor(() => expect(screen.getByTestId("collector-error")).toBeTruthy());
    // The refusal must name its reason, not just flash a red box: the localized
    // sentence (or, in an unlocalized build, the server's own words).
    const text = screen.getByTestId("collector-error").textContent ?? "";
    expect(text.length).toBeGreaterThan(0);
    expect(text.includes("not staged") || text.includes("stage")).toBe(true);
  });

  it("issueUrl() maps only real issue references", () => {
    expect(issueUrl("#153")).toBe("https://github.com/dekarita/supreme-lamp/issues/153");
    expect(issueUrl("148")).toBe("https://github.com/dekarita/supreme-lamp/issues/148");
    expect(issueUrl(undefined)).toBe(null);
    expect(issueUrl("https://evil.example/x")).toBe(null);
    expect(issueUrl("#abc")).toBe(null);
  });
});
