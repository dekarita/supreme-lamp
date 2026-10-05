// [F93 §2.1/§1.3] The logon gate banner + the probe-reason text mapping.
// The banner must speak ONLY on evidence (a scan that says no type-10 4624),
// must offer the validated WEB DESKTOP URL, and must vanish on the first
// success - no dismiss button can keep it alive.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import "@/i18n";
import { LogonGateBanner } from "@/components/domain/LogonGateBanner";
import { isProbeReason, reasonText } from "@/components/search/AddSiteQuick";
import { useSessionStore } from "@/stores/sessionStore";

const t = ((k: string, o?: { code?: string; reason?: string }) =>
  o ? k + ":" + (o.code || o.reason) : k) as unknown as (k: string, o?: { code?: string; reason?: string }) => string;

function mount() {
  return render(
    <MemoryRouter>
      <LogonGateBanner />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  useSessionStore.setState({ native: null });
});

describe("F93 logon gate banner", () => {
  it("renders when the scan says no RDP user has logged on, with the WEB DESKTOP button", () => {
    useSessionStore.setState({
      native: {
        rdpListener: { authLast: { result: "none", scanTs: "2026-10-05T12:32:21Z", windowStart: "2026-10-05T12:20:00Z" } },
        webdeskUrl: "http://100.64.0.10:7333/vnc.html",
      },
    });
    mount();
    expect(screen.getByTestId("logon-gate-banner")).toBeInTheDocument();
    expect(screen.getByTestId("logon-gate-open-webdesk")).toBeInTheDocument();
  });

  it("hides on a type-10 4624 success and never fires on an unknown scan", () => {
    useSessionStore.setState({
      native: { rdpListener: { authLast: { result: "success", eventTs: "2026-10-05T12:40:00Z" } }, webdeskUrl: "http://100.64.0.10:7333/vnc.html" },
    });
    const a = mount();
    expect(screen.queryByTestId("logon-gate-banner")).toBeNull();
    a.unmount();
    useSessionStore.setState({ native: { rdpListener: { authLast: null } } });
    mount();
    expect(screen.queryByTestId("logon-gate-banner")).toBeNull();
  });

  it("keeps the banner but names the missing deployment when no WEB DESKTOP url is valid", () => {
    useSessionStore.setState({
      native: { rdpListener: { authLast: { result: "failed", sub: "C000006A" } }, webdeskUrl: "http://1.2.3.4:7333/vnc.html" },
    });
    mount();
    expect(screen.getByTestId("logon-gate-banner")).toBeInTheDocument();
    expect(screen.queryByTestId("logon-gate-open-webdesk")).toBeNull();
  });

  it("maps every concrete server reason to its own sentence, never to the generic line", () => {
    for (const r of ["cloudflare-challenge", "dns-nxdomain", "ssl-cert-invalid", "timeout-10s", "http-5xx", "redirect-loop", "no-response"]) {
      expect(isProbeReason(r)).toBe(true);
      expect(reasonText(t, r)).not.toContain("search.errors.validation");
    }
    expect(reasonText(t, "http-403")).toBe("addSite.reason.httpStatus:403");
    expect(reasonText(t, "weird-new-reason")).toBe("addSite.reason.other:weird-new-reason");
    expect(isProbeReason("newSiteHttpsRequired")).toBe(false);
  });

  it("does not send a token or key in the launcher-health probe url", async () => {
    const fetchMock = vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ serviceRunning: false }) } as unknown as Response));
    vi.stubGlobal("fetch", fetchMock);
    render(
      <MemoryRouter>
        <LogonGateBanner />
      </MemoryRouter>,
    );
    vi.unstubAllGlobals();
    // The banner itself must never fetch (the modal owns the launcher hint).
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
