// [F84 §2.3] The launchUrl() contract must NEVER fall back to window.open:
// a failure returns {ok:false, reason} so the caller can toast it, and no new
// browser tab is ever opened by the dashboard.
//
// [F90 §C.2] These three cases exercise the SERVER LADDER (Mode C, "unknown"),
// so the mode is pinned explicitly. In jsdom the hostname is `localhost`, which
// F90 correctly reads as Mode A (the dashboard IS the session's browser) - and
// in Mode A a successful window.open is the intended behaviour, not a fallback.
// The F84 guard that still has to hold in every mode is pinned structurally in
// tests/f85-f84-symbols.test.js: no window.open may appear after the ladder
// call, and the tailscale-local branch may not open a window at all.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { launchUrl, VIEWING_MODE_STORAGE_KEY, type ViewingMode } from "@/lib/launchUrl";

beforeEach(() => {
  vi.restoreAllMocks();
  window.localStorage.setItem(VIEWING_MODE_STORAGE_KEY, "unknown" satisfies ViewingMode);
});

describe("F84 launchUrl (no silent fallback)", () => {
  it("does not window.open on a 500 and returns a visible reason", async () => {
    const open = vi.fn();
    vi.stubGlobal("open", open);
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({ code: "LAUNCH_FAILED" }) } as unknown as Response)),
    );
    const out = await launchUrl("https://openculture.com/a");
    expect(out.ok).toBe(false);
    expect(out.reason).toBe("search.launchUrl.failed");
    expect(open).not.toHaveBeenCalled();
  });

  it("maps NO_ACTIVE_SESSION to its own reason key (no new tab)", async () => {
    const open = vi.fn();
    vi.stubGlobal("open", open);
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve({ ok: false, status: 503, json: () => Promise.resolve({ code: "NO_ACTIVE_SESSION" }) } as unknown as Response)),
    );
    const out = await launchUrl("https://openculture.com/a");
    expect(out).toEqual({ ok: false, reason: "search.launchUrl.noSession", code: "NO_ACTIVE_SESSION", mode: "unknown" });
    expect(open).not.toHaveBeenCalled();
  });

  it("does not window.open on a transport failure", async () => {
    const open = vi.fn();
    vi.stubGlobal("open", open);
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("network down"))));
    const out = await launchUrl("https://openculture.com/a");
    expect(out.ok).toBe(false);
    expect(out.code).toBe("transport");
    expect(open).not.toHaveBeenCalled();
  });

  it("refuses a non-https URL without calling the server", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const out = await launchUrl("http://openculture.com");
    expect(out.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns ok:true only when the server accepts the launch", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }) } as unknown as Response)));
    const out = await launchUrl("https://openculture.com/a");
    expect(out.ok).toBe(true);
  });
});
