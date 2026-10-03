// [F70 §3.2/§3.3] The deep add-time probe wiring: both SourceForm mount points
// (Settings + AdvancedPanel) now inject the ONE server probe implementation
// (src/search/probe-client.ts -> POST /api/search/probe via the typed api
// client). The probe fires ONLY from the "Probe source" button - never on
// mount, never on save - and the save gate requires recommendation "approve"
// OR the explicit operator override. The F58 "unwired probe never invents a
// request" guard (f58-source-form.test.tsx) remains green.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import "@/i18n";
import Settings from "@/pages/Settings";
import { AdvancedPanel } from "@/pages/search/v2/AdvancedPanel";
import { SourceForm } from "@/components/search/SourceForm";
import { serverAddTimeProbe } from "@/search/probe-client";
import { customSources } from "@/search/custom-source-store";

type Any = any;

function probeResponse(overrides: Record<string, unknown> = {}) {
  return {
    reachable: true,
    robotsOk: true,
    schemaMatch: true,
    sampleResultCount: 2,
    sampleItem: { name: "repo-one", html_url: "https://api.github.com/x/repo-one" },
    httpStatus: 200,
    contentType: "application/json",
    contentLength: 1234,
    recommendation: "approve",
    ...overrides,
  };
}

beforeEach(() => {
  customSources.reset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("F70 §3.2 probe wiring + save gate", () => {
  it("the probe NEVER fires on mount - only the button click triggers POST /api/search/probe", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => probeResponse(),
      text: async () => JSON.stringify(probeResponse()),
    }));
    vi.stubGlobal("fetch", fetchMock);

    render(
      <MemoryRouter>
        <Settings />
      </MemoryRouter>
    );
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("source-form-preset-code-hosting-github"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("source-form-probe-run"));
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/api/search/probe");
    expect(init.method).toBe("POST");
    const body = JSON.parse(String(init.body));
    expect(body.baseUrl).toBeTruthy();
    expect(body.parseContract.resultSelector).toBeTruthy();
    expect(screen.getByTestId("source-form-probe-recommendation").textContent).toContain("approve");
  });

  it("AdvancedPanel mounts the same wired probe (one shared implementation)", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => probeResponse({ recommendation: "warn", reason: "resultSelector matched zero items" }),
      text: async () => "{}",
    }));
    vi.stubGlobal("fetch", fetchMock);
    render(<AdvancedPanel open />);
    await act(async () => {
      fireEvent.click(screen.getByTestId("source-form-probe-run"));
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain("/api/search/probe");
    expect(screen.getByTestId("source-form-probe-recommendation").textContent).toContain("warn");
    expect(screen.getByTestId("source-form-probe-status").textContent).toContain("resultSelector matched zero items");
  });

  it("save is refused until the probe approves OR the operator ticks the override", async () => {
    const warn = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => probeResponse({ recommendation: "warn", reason: "robots.txt disallows the configured path" }),
      text: async () => "{}",
    }));
    vi.stubGlobal("fetch", warn);

    render(<SourceForm surface="settings" probe={serverAddTimeProbe} />);
    fireEvent.click(screen.getByTestId("source-form-preset-code-hosting-github"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("source-form-probe-run"));
    });
    // confirmed contract, warn probe: still refused
    fireEvent.click(screen.getByTestId("source-form-confirm-contract"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("source-form-save"));
    });
    expect(customSources.entries().length).toBe(0);
    expect(screen.getByTestId("source-form-errors").textContent).toContain("Probe approval required");

    // the override unlocks the save despite the warn findings
    fireEvent.click(screen.getByTestId("source-form-override"));
    expect(screen.getByTestId("source-form-override-row").textContent).toContain("Save despite probe findings");
    await act(async () => {
      fireEvent.click(screen.getByTestId("source-form-save"));
    });
    expect(customSources.entries().length).toBe(1);
    expect(customSources.entries()[0].parseContractPinned).toBe(true);
  });

  it("an APPROVED probe saves without the override", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => probeResponse(),
      text: async () => "{}",
    })));
    render(<SourceForm surface="settings" probe={serverAddTimeProbe} />);
    fireEvent.click(screen.getByTestId("source-form-preset-code-hosting-github"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("source-form-probe-run"));
    });
    fireEvent.click(screen.getByTestId("source-form-confirm-contract"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("source-form-save"));
    });
    expect(customSources.entries().length).toBe(1);
  });

  it("an unwired SourceForm still refuses instead of inventing a request (F58 guard)", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<SourceForm surface="advanced" />);
    await act(async () => {
      fireEvent.click(screen.getByTestId("source-form-probe-run"));
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByTestId("source-form-probe-status").textContent).toContain("probe-backend-unwired");
    expect(customSources.entries().length).toBe(0);
  });

  it("a probe backend error surfaces as warn, never an approve", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: false,
      status: 403,
      json: async () => ({ code: "VALIDATION_ERROR", messageKey: "search.errors.validation", requestId: "r", traceId: "t", retryable: false }),
      text: async () => "{}",
    })));
    render(<SourceForm surface="settings" probe={serverAddTimeProbe} />);
    fireEvent.click(screen.getByTestId("source-form-preset-code-hosting-github"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("source-form-probe-run"));
    });
    expect(screen.getByTestId("source-form-probe-status").textContent).toContain("probe-backend-error (VALIDATION_ERROR)");
    expect(screen.getByTestId("source-form-probe-recommendation").textContent).toContain("warn");
  });
});
