// [F87 §D.1/§E.B] The expanded ?diag=1 banner: sha mismatch warning, the
// example.com "test launch" button that reports the rung, the last five
// launches (hostname + tier + ok/fail + timestamp), the download-dir probe and
// the self-test shortcut. The F86 chips are untouched (their own smoke tests).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import "@/i18n";
import { DIAG_TEST_LAUNCH_URL, F86DiagnosticBanner, UI_SHA7, lastFiveLaunches } from "@/components/search/F86DiagnosticBanner";

function mount(entry: string) {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/search" element={<><F86DiagnosticBanner /><span data-testid="where">search</span></>} />
      </Routes>
    </MemoryRouter>,
  );
}

const HISTORY = [1, 2, 3, 4, 5, 6, 7].map((i) => ({ at: `2026-10-05T00:0${i}:00Z`, host: `site${i}.org`, tier: (i % 3) + 1, ok: i !== 6, detail: "x" }));

function stubRoutes(launchStatus = 200, serverSha = UI_SHA7) {
  const fn = vi.fn((input: string, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/api/version")) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ sha7: serverSha, features: { autoHttps: true, wwwTolerance: true, noFallback: true, downloadToRdp: true, launchTiers: true, selfTest: true } }) } as unknown as Response);
    if (url.endsWith("/api/launch-url/diag")) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ activeTier: 1, lastLaunchAt: "2026-10-05T00:07:00Z", lastResult: "ok", history: HISTORY }) } as unknown as Response);
    if (url.endsWith("/api/launch-url") && init?.method === "POST") return Promise.resolve({ ok: launchStatus === 200, status: launchStatus, json: () => Promise.resolve(launchStatus === 200 ? { ok: true, tier: 2, tierDetail: "schtasks-interactive" } : { code: "NO_ACTIVE_SESSION" }) } as unknown as Response);
    if (url.includes("/api/f87-selftest")) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, results: [{ site: "archive.org", downloadDir: "C:\\Users\\runner\\Desktop\\RDP-Downloads", downloadDirOk: true }] }) } as unknown as Response);
    return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) } as unknown as Response);
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

beforeEach(() => vi.unstubAllGlobals());

describe("F87 expanded diagnostic banner", () => {
  it("lastFiveLaunches: newest first, hostname only, at most five", () => {
    const rows = lastFiveLaunches(HISTORY);
    expect(rows.length).toBe(5);
    expect(rows[0].host).toBe("site7.org");
    expect(rows[1]).toMatchObject({ host: "site6.org", ok: false });
    expect(lastFiveLaunches([{ url: "https://www.pluto.tv/us/live-tv", tier: 1, ok: true }])[0].host).toBe("www.pluto.tv");
    expect(lastFiveLaunches(undefined)).toEqual([]);
  });

  it("shows the last five launches with tier + ok/fail and a sha mismatch only when the server sha differs from a real build sha", async () => {
    stubRoutes();
    mount("/search?diag=1");
    await waitFor(() => expect(screen.getByTestId("f86-diag-banner").getAttribute("data-probed")).toBe("1"));
    expect(screen.getAllByTestId("f87-diag-recent-row").length).toBe(5);
    expect(screen.getAllByTestId("f87-diag-recent-row")[1].getAttribute("data-ok")).toBe("0");
    expect(screen.getByTestId("f87-diag-recent").textContent).toContain("site7.org t2 ok");
    // server sha == this bundle's sha: no mismatch claimed
    expect(screen.queryByTestId("f87-diag-sha-mismatch")).toBeNull();
  });

  it("warns on a ui/server sha mismatch only from a real build sha (never from a dev bundle)", async () => {
    stubRoutes(200, "0000000");
    mount("/search?diag=1");
    await waitFor(() => expect(screen.getByTestId("f86-diag-banner").getAttribute("data-probed")).toBe("1"));
    // CI builds carry VITE_BUILD_SHA (-> warning); a local dev bundle ("dev") must stay silent.
    if (UI_SHA7 === "dev") expect(screen.queryByTestId("f87-diag-sha-mismatch")).toBeNull();
    else expect(screen.getByTestId("f87-diag-sha-mismatch").textContent).toContain("sha mismatch");
  });

  it("test launch POSTs example.com through launchUrl and reports the rung; a failure reports the reason", async () => {
    const fn = stubRoutes(200);
    mount("/search?diag=1");
    fireEvent.click(await screen.findByTestId("f87-diag-test-launch"));
    const out = await screen.findByTestId("f87-diag-test-launch-result");
    await waitFor(() => expect(out.getAttribute("data-ok")).toBe("1"));
    expect(out.textContent).toContain("tier 2");
    const post = fn.mock.calls.find((c) => String(c[0]).endsWith("/api/launch-url") && (c[1] as RequestInit)?.method === "POST");
    expect(post).toBeTruthy();
    expect(JSON.parse(String((post![1] as RequestInit).body)).url).toBe(DIAG_TEST_LAUNCH_URL);
    expect(DIAG_TEST_LAUNCH_URL).toBe("https://example.com/");

    stubRoutes(503);
    mount("/search?diag=1");
    fireEvent.click((await screen.findAllByTestId("f87-diag-test-launch"))[1]);
    const bad = (await screen.findAllByTestId("f87-diag-test-launch-result"))[1];
    await waitFor(() => expect(bad.getAttribute("data-ok")).toBe("0"));
  });

  it("the download-dir probe shows path + writable mark, and the shortcut navigates to ?selftest=1", async () => {
    stubRoutes();
    const r = mount("/search?diag=1");
    fireEvent.click(await screen.findByTestId("f87-diag-probe-dir"));
    const dir = await screen.findByTestId("f87-diag-download-dir");
    await waitFor(() => expect(dir.getAttribute("data-ok")).toBe("1"));
    expect(dir.textContent).toContain("RDP-Downloads");
    fireEvent.click(screen.getByTestId("f87-diag-selftest-link"));
    // the banner is ?diag=1-only: after navigating to ?selftest=1 it unmounts itself
    await waitFor(() => expect(r.container.querySelector('[data-testid="f86-diag-banner"]')).toBeNull());
  });
});
