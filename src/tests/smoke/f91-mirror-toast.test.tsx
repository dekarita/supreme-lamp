// [F91 §B/§6.B] Mirror Mode toasts: success-first in EVERY outcome, local-open
// always first, queue in parallel, and the banned string can never render.
// The module is tested through the SAME store the buttons use, so this file
// pins the contract of openMirrored() itself (the page-level wiring is pinned
// by tests/f91-mirror-open.test.js; the e2e spec covers the rendered surfaces).
import { beforeEach, describe, expect, it, vi } from "vitest";

const getKey = vi.fn(() => "tok");
vi.mock("@/lib/api", () => ({
  getKey: () => getKey(),
  apiBase: () => "",
}));

import { dirnameWindows, isSafeExplorerPath, mirrorToastText, openMirrored, queueLauncherJob, type MirrorOutcome } from "@/lib/launchUrl";

const ID_T = (key: string, opts?: Record<string, unknown>) => (opts ? `${key}:${JSON.stringify(opts)}` : key);

function okFetch(status = 200, body: unknown = { ok: true, jobId: "j-1" }) {
  return vi.fn(() => Promise.resolve({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) } as unknown as Response));
}

beforeEach(() => {
  getKey.mockReturnValue("tok");
  vi.unstubAllGlobals();
});

describe("F91 mirror toasts", () => {
  it("queue accepted: local tab opens FIRST, one POST carries {url,mode:navigate}, toast = openedBoth", async () => {
    const openSpy = vi.fn(() => ({ closed: false }));
    vi.stubGlobal("open", openSpy);
    const fetchFn = okFetch();
    vi.stubGlobal("fetch", fetchFn);
    const push = vi.fn();
    const out = await openMirrored("https://archive.org/details/x", { push, t: ID_T });
    expect(out.localOpened).toBe(true);
    expect(out.rdpOk).toBe(true);
    expect(push.mock.calls[0][0]).toBe("mirror.openedBoth");
    expect(push.mock.calls[0][1]).toBe("ok");
    // exactly ONE window.open, and it happened (the fetch may resolve after,
    // but the local half is not awaited behind it)
    expect(openSpy).toHaveBeenCalledTimes(1);
    expect(String(openSpy.mock.calls[0][0])).toBe("https://archive.org/details/x");
    // [F45-R §4 / #203 Defect B] SUPERSEDED assertion: the old line demanded
    // "noopener" in the features string, but the spec makes window.open()
    // return null whenever noopener is set, so it faked popupBlocked on EVERY
    // click. The call must stay handle-returning (no noopener feature) and
    // sever the opener on the returned handle instead:
    expect(String(openSpy.mock.calls[0][2] ?? "")).not.toContain("noopener");
    expect((openSpy.mock.results[0].value as { opener?: unknown }).opener).toBeNull();
    const call = fetchFn.mock.calls.find((c) => String(c[0]) === "/api/launcher/queue");
    expect(call).toBeTruthy();
    const init = call![1] as RequestInit;
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ url: "https://archive.org/details/x", mode: "navigate", name: "" });
  });

  it("queue answered 503: success-first info toast naming queue-503 - NEVER the banned failure string", async () => {
    vi.stubGlobal("open", vi.fn(() => ({ closed: false })));
    vi.stubGlobal("fetch", okFetch(503, { code: "QUEUE_DIR_UNAVAILABLE" }));
    const push = vi.fn();
    const out = await openMirrored("https://gutenberg.org/ebooks/84", { push, t: ID_T });
    expect(out.localOpened).toBe(true);
    expect(out.rdpOk).toBe(false);
    expect(out.rdpReason).toBe("queue-503");
    expect(push.mock.calls[0][0]).toContain("mirror.rdpOffline");
    expect(push.mock.calls[0][0]).toContain("queue-503");
    expect(push.mock.calls[0][1]).toBe("");
    const flat = JSON.stringify(push.mock.calls);
    expect(flat).not.toContain("Could not open");
  });

  it("queue transport failure/timeout: reason queue-timeout, local tab still opened", async () => {
    vi.stubGlobal("open", vi.fn(() => ({ closed: false })));
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("boom"))));
    const push = vi.fn();
    const out = await openMirrored("https://librivox.org/album/1", { push, t: ID_T });
    expect(out.localOpened).toBe(true);
    expect(out.rdpReason).toBe("queue-timeout");
    expect(push.mock.calls[0][0]).toContain("queue-timeout");
  });

  it("an unvalidated URL opens NOTHING anywhere and says so (refusal, not failure)", async () => {
    const openSpy = vi.fn();
    vi.stubGlobal("open", openSpy);
    const fetchFn = okFetch();
    vi.stubGlobal("fetch", fetchFn);
    const push = vi.fn();
    for (const bad of ["javascript:alert(1)", "http://insecure.example/", "https://user:pw@ex.com/", "file:///C:/x", "https://ex.com/" + "a".repeat(3000)]) {
      const out = await openMirrored(bad, { push, t: ID_T });
      expect(out.localOpened).toBe(false);
      expect(out.rdpOk).toBe(false);
    }
    expect(openSpy).not.toHaveBeenCalled();
    expect(fetchFn).not.toHaveBeenCalled();
    expect(push.mock.calls.every((c) => c[0] === "mirror.blocked")).toBe(true);
  });

  it("mirrorToastText covers the three outcomes; the fourth (blocked) never claims RDP", () => {
    const both: MirrorOutcome = { localOpened: true, rdpOk: true, rdpReason: "" };
    const offline: MirrorOutcome = { localOpened: true, rdpOk: false, rdpReason: "queue-429" };
    const blocked: MirrorOutcome = { localOpened: false, rdpOk: false, rdpReason: "invalid-url" };
    expect(mirrorToastText(both, ID_T)).toBe("mirror.openedBoth");
    expect(mirrorToastText(offline, ID_T)).toContain("queue-429");
    expect(mirrorToastText(blocked, ID_T)).toBe("mirror.blocked");
  });

  it("queueLauncherJob: explorer mode accepts ONLY a Windows folder path; navigate keeps the https fence", async () => {
    const fetchFn = okFetch();
    vi.stubGlobal("fetch", fetchFn);
    expect(isSafeExplorerPath("C:\\Users\\runner\\Desktop\\RDP-Downloads")).toBe(true);
    expect(isSafeExplorerPath("https://example.com/")).toBe(false);
    expect(isSafeExplorerPath("C:\\..\\..\\Windows")).toBe(true); // the SERVER fences traversal at the launch; the pattern is the same literal
    const ok = await queueLauncherJob("C:\\Users\\runner\\Desktop\\RDP-Downloads", "explorer", "song.mp3");
    expect(ok.ok).toBe(true);
    const rejected = await queueLauncherJob("https://nope/", "explorer");
    expect(rejected.ok).toBe(false);
    expect(rejected.reason).toBe("invalid-path");
    const bad = await queueLauncherJob("javascript:x", "navigate");
    expect(bad.ok).toBe(false);
    expect(bad.reason).toBe("validation");
    // only the accepted explorer call reached the network
    const calls = fetchFn.mock.calls.filter((c) => String(c[0]) === "/api/launcher/queue");
    expect(calls.length).toBe(1);
    expect(JSON.parse(String((calls[0][1] as RequestInit).body)).mode).toBe("explorer");
  });

  it("dirnameWindows walks back to the folder, keeps the root, trims trailing separators", () => {
    expect(dirnameWindows("C:\\Users\\runner\\Desktop\\RDP-Downloads\\song.mp3")).toBe("C:\\Users\\runner\\Desktop\\RDP-Downloads");
    expect(dirnameWindows("C:\\Users\\runner\\Desktop\\RDP-Downloads\\song.mp3\\")).toBe("C:\\Users\\runner\\Desktop\\RDP-Downloads");
    expect(dirnameWindows("C:\\f.bin")).toBe("C:\\f.bin".slice(0, 3));
    expect(dirnameWindows("")).toBe("");
  });
});
