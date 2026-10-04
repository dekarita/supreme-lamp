// [F85 §3] The diagnostic banner. Two things must be true or the banner is
// worse than useless: (a) it NEVER shows a green mark it could not verify, and
// (b) it disappears completely on the normal surface (?diag absent).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import "@/i18n";
import { F85DiagnosticBanner } from "@/components/search/F85DiagnosticBanner";
import { installLaunchUrlHandle } from "@/lib/launchUrl";

function mount(entry: string) {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <F85DiagnosticBanner />
    </MemoryRouter>,
  );
}

function stubVersion(body: unknown, ok = true) {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve({ ok, status: ok ? 200 : 500, json: () => Promise.resolve(body) } as unknown as Response)),
  );
}

const FEATURES = { autoHttps: true, wwwTolerance: true, noFallback: true, downloadToRdp: true };

beforeEach(() => {
  delete (window as unknown as { launchUrl?: unknown }).launchUrl;
  vi.unstubAllGlobals();
});

describe("F85 diagnostic banner", () => {
  it("renders nothing unless ?diag=1 is set", () => {
    mount("/search");
    expect(screen.queryByTestId("f85-diag-banner")).toBeNull();
    mount("/search?q=tls");
    expect(screen.queryByTestId("f85-diag-banner")).toBeNull();
  });

  it("marks all four features only when the server reports them AND the bundle exposes launchUrl", async () => {
    stubVersion({ sha7: "abc1234", features: FEATURES });
    installLaunchUrlHandle();
    mount("/search?diag=1");
    await waitFor(() => expect(screen.getByTestId("f85-diag-banner")).toHaveAttribute("data-probed", "1"));
    for (const key of ["autoHttps", "wwwTolerance", "noFallback", "downloadToRdp"]) {
      expect(screen.getByTestId("f85-diag-" + key)).toHaveAttribute("data-ok", "1");
    }
    expect(screen.getByTestId("f85-diag-sha")).toHaveTextContent("server: abc1234");
    expect(screen.getByTestId("f85-diag-banner")).toHaveAttribute("data-active-count", "4");
  });

  it("shows a missing mark instead of a green one when the launchUrl handle is absent", async () => {
    stubVersion({ sha7: "abc1234", features: FEATURES });
    mount("/search?diag=1");
    await waitFor(() => expect(screen.getByTestId("f85-diag-banner")).toHaveAttribute("data-probed", "1"));
    // The server claims the capability; the RUNNING bundle does not carry it.
    // This is exactly the stale-bundle case the banner exists to catch.
    expect(screen.getByTestId("f85-diag-noFallback")).toHaveAttribute("data-ok", "0");
    expect(screen.getByTestId("f85-diag-autoHttps")).toHaveAttribute("data-ok", "1");
    expect(screen.getByTestId("f85-diag-banner")).toHaveAttribute("data-active-count", "3");
  });

  it("never turns a failed /api/version into green marks", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("offline"))));
    installLaunchUrlHandle();
    mount("/search?diag=1");
    await waitFor(() => expect(screen.getByTestId("f85-diag-banner")).toHaveAttribute("data-probed", "1"));
    expect(screen.getByTestId("f85-diag-autoHttps")).toHaveAttribute("data-ok", "0");
    expect(screen.getByTestId("f85-diag-wwwTolerance")).toHaveAttribute("data-ok", "0");
    expect(screen.getByTestId("f85-diag-downloadToRdp")).toHaveAttribute("data-ok", "0");
    expect(screen.getByTestId("f85-diag-noFallback")).toHaveAttribute("data-ok", "1");
    expect(screen.getByTestId("f85-diag-server-missing")).toBeInTheDocument();
  });
});
