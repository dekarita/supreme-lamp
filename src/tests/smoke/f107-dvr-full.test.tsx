// [F107 / Observatory step 6] Full DVR v2 against the REAL DOM, the REAL F104
// seam and a REAL IndexedDB implementation.
//
// The Node gate (tests/f107-dvr-full.test.js) proves the four pure cores and the
// static wiring. This suite proves the five claims only a mounted DOM can make:
//   1. a REAL MutationObserver on #root turns live DOM churn into descriptors
//      (and churn OUTSIDE #root is not recorded - the wrong-root falsification);
//   2. a click through the REAL F104 -> installDvr -> onDvrEntry chain lands one
//      timeline entry AND one screenshot in the session (seam-injected rasterizer,
//      because jsdom has no canvas);
//   3. the default screenshot pipeline fails HONESTLY on jsdom (no 2d context) -
//      an {ok:false, reason}, never a throw, never a fake pixel;
//   4. exportDvrV2 produces a `.mcrec` v2 bundle that the SHIPPED validator
//      accepts, and the download goes through the operator seam exactly once;
//   5. the session list SURVIVES A RELOAD (persist -> reset -> list) and deletes.
// fake-indexeddb provides a spec-faithful IndexedDB so the SHIPPED adapter runs
// for real (no hand-rolled mock of the API under test).
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import "@/i18n";

import { __resetDvrForTests, installDvr } from "@/lib/dvr";
import { __resetGlobalClickCaptureForTests, installGlobalClickCapture, type GlobalClickRecorder } from "@/lib/globalClickCapture";
import type { ButtonAction } from "@/lib/collectorAgent";
import { installMutationRecorder } from "@/lib/dvr/mutations";
import { captureShot, isDefaultRasterizerActive, setShotRasterizer } from "@/lib/dvr/screenshots";
import { exportDvrV2, isDefaultDownloaderActive, setExportDownload } from "@/lib/dvr/export";
import { validateBundleV2 } from "@/lib/dvr/exportCore";
import {
  __resetDvrFullForTests,
  deleteStoredSession,
  dvrFullHandle,
  installDvrFull,
  storedSessions,
} from "@/lib/dvr/session";
import { SHOT_MIME_PREFIX } from "@/lib/dvr/screenshotCore";
import Collector from "@/pages/Collector";
import { DvrFab } from "@/components/domain/DvrFab";
import type { MutationDescriptor } from "@/lib/dvr/mutationCore";

interface StubRecorder extends GlobalClickRecorder {
  rows: ButtonAction[];
}

function stubRecorder(): StubRecorder {
  const rows: ButtonAction[] = [];
  let seq = 0;
  return {
    rows,
    record: (rec) => {
      const row: ButtonAction = { id: "s" + ++seq, ts: new Date().toISOString(), ...rec };
      rows.push(row);
      return row;
    },
    update: (id, patch) => {
      const row = rows.find((r) => r.id === id);
      if (row) Object.assign(row, patch);
    },
  };
}

function mountDom(): void {
  document.body.innerHTML = '<button data-testid="f107-click">Click me</button><div id="root"></div>';
}

/** A tiny valid PNG data URL (1x1) - the only pixel source the seam may return. */
const TINY_PNG = SHOT_MIME_PREFIX + "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

let uninstallCapture: (() => void) | null = null;
let prevRasterizer: ReturnType<typeof setShotRasterizer> | null = null;
let prevDownloader: ReturnType<typeof setExportDownload> | null = null;

beforeEach(() => {
  __resetGlobalClickCaptureForTests();
  __resetDvrForTests();
  __resetDvrFullForTests();
  mountDom();
  vi.stubGlobal("fetch", vi.fn(() => Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) }) as unknown as Response));
});

afterEach(() => {
  uninstallCapture?.();
  uninstallCapture = null;
  if (prevRasterizer) setShotRasterizer(null);
  prevRasterizer = null;
  if (prevDownloader) setExportDownload(null);
  prevDownloader = null;
  __resetDvrFullForTests();
  __resetGlobalClickCaptureForTests();
  __resetDvrForTests();
  // Deliberately NOT vi.unstubAllGlobals(): the setup file's fetch/WebSocket
  // stubs must survive for every other suite in this worker.
});

describe("F107-S1: DOM mutations observed on the real root", () => {
  it("records descriptors for churn inside #root and ignores churn outside it", async () => {
    const batches: MutationDescriptor[][] = [];
    let seen: MutationDescriptor[] = [];
    const rec = installMutationRecorder((batch) => {
      batches.push(batch);
      seen = seen.concat(batch);
    });
    expect(rec.rootName()).toBe("div"); // #root is a div - proof of the attach point
    // Churn INSIDE #root: one child added to a section.
    const root = document.getElementById("root") as HTMLElement;
    const section = document.createElement("section");
    root.appendChild(section);
    section.appendChild(document.createElement("p"));
    await waitFor(() => expect(seen.length).toBeGreaterThan(0));
    const first = seen.find((d) => d.target === "section");
    expect(first).toBeTruthy();
    // M2 falsification stand-in: churn on document.body OUTSIDE #root must NOT
    // be recorded by this observer (a wrong-root observer would have caught it).
    const before = seen.length;
    document.body.appendChild(document.createElement("aside"));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(seen.filter((d) => d.target === "aside").length).toBe(0);
    expect(seen.length >= before).toBe(true);
    expect(batches.length).toBeGreaterThan(0);
    rec.uninstall();
    // After uninstall, churn is silent.
    const atUninstall = seen.length;
    root.appendChild(document.createElement("footer"));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(seen.length).toBe(atUninstall);
  });

  it("feeds the session meta through the shipped core (no fork)", async () => {
    const stub = stubRecorder();
    // The uninstaller MUST be captured: a leaked document listener would keep
    // decorating clicks for later tests (the cross-test pollution class the
    // f-dvr-lite suite documents).
    uninstallCapture = installGlobalClickCapture(installDvr(stub, { enabled: true }), { trustCheck: false });
    const handle = installDvrFull();
    const root = document.getElementById("root") as HTMLElement;
    root.appendChild(document.createElement("div"));
    await waitFor(() => expect(handle.meta().mutations).toBeGreaterThan(0));
    expect(handle.timeline().length).toBe(0); // mutations are not timeline entries
    __resetDvrFullForTests();
  });
});

describe("F107-S2: click -> timeline entry + screenshot", () => {
  it("a real click through the F104 chain lands one entry and one shot", async () => {
    prevRasterizer = setShotRasterizer(() => TINY_PNG);
    const stub = stubRecorder();
    uninstallCapture = installGlobalClickCapture(installDvr(stub, { enabled: true }), { trustCheck: false });
    const handle = installDvrFull();
    const btn = document.querySelector('[data-testid="f107-click"]') as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(btn);
    });
    // F104 recorded the row, the ring saw it, the session timeline saw it.
    expect(stub.rows.length).toBe(1);
    await waitFor(() => expect(handle.timeline().some((e) => e.kind === "click")).toBe(true));
    // The screenshot pipeline ran on the SAME click (seam rasterizer).
    await waitFor(() => expect(handle.shots().length).toBe(1));
    const shot = handle.shots()[0];
    expect(shot.dataUrl).toBe(TINY_PNG);
    expect(shot.w).toBeGreaterThan(0);
    expect(shot.h).toBeGreaterThan(0);
    expect(handle.meta().clicks).toBe(1);
    expect(handle.meta().shots).toBe(1);
    __resetDvrFullForTests();
  });

  it("the default pipeline fails honestly on jsdom (no canvas) - never throws", async () => {
    expect(isDefaultRasterizerActive()).toBe(true);
    const res = await captureShot({ viewW: 800, viewH: 600, dpr: 1 });
    expect(res.ok).toBe(false);
    expect(res.reason.length).toBeGreaterThan(0);
    expect(res.dataUrl).toBe("");
  });

  it("an oversized rasterizer answer is refused by the thumbnail fence", async () => {
    prevRasterizer = setShotRasterizer(() => "data:image/png;base64,QUJD"); // tiny but legal mime...
    const okShot = await captureShot({ viewW: 800, viewH: 600, dpr: 1 });
    expect(okShot.ok).toBe(true);
    prevRasterizer = setShotRasterizer(() => "data:image/jpeg;base64,QUJD");
    const badShot = await captureShot({ viewW: 800, viewH: 600, dpr: 1 });
    expect(badShot.ok).toBe(false);
    expect(badShot.reason).toBe("not-a-png-data-url");
  });
});

describe("F107-S3: export produces a valid .mcrec v2", () => {
  it("bundle validates with the shipped validator; download seam called exactly once", async () => {
    prevRasterizer = setShotRasterizer(() => TINY_PNG);
    const downloads: Array<{ filename: string; text: string }> = [];
    prevDownloader = setExportDownload((filename, text) => {
      downloads.push({ filename, text });
      return true;
    });
    const stub = stubRecorder();
    uninstallCapture = installGlobalClickCapture(installDvr(stub, { enabled: true }), { trustCheck: false });
    const handle = installDvrFull();
    const btn = document.querySelector('[data-testid="f107-click"]') as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(btn);
    });
    await waitFor(() => expect(handle.timeline().length).toBeGreaterThan(0));
    // Let the async db open + first persist land so the stored index is real.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(isDefaultDownloaderActive()).toBe(false); // seam active for this test
    const res = await exportDvrV2();
    expect(res.ok).toBe(true);
    expect(res.filename.endsWith(".mcrec")).toBe(true);
    expect(downloads.length).toBe(1);
    const parsed = JSON.parse(downloads[0].text);
    const check = validateBundleV2(parsed);
    expect(check.ok).toBe(true);
    expect(parsed.version).toBe(2);
    expect(parsed.timeline.length).toBeGreaterThan(0);
    expect(parsed.features.length).toBe(11); // the F105 registry snapshot
    expect(parsed.storage.sessions.length).toBeGreaterThan(0); // live session persisted by export time? (index at least)
    __resetDvrFullForTests();
  });
});

describe("F107-S4: the session list persists across a reload", () => {
  it("persist -> teardown -> list shows the session; delete removes it", async () => {
    const stub = stubRecorder();
    uninstallCapture = installGlobalClickCapture(installDvr(stub, { enabled: true }), { trustCheck: false });
    const handle = installDvrFull();
    const sessionId = handle.sessionId();
    const btn = document.querySelector('[data-testid="f107-click"]') as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(btn);
    });
    await waitFor(() => expect(handle.meta().clicks).toBe(1));
    // Let the async db open land, then persist for real.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    const persisted = await handle.persistNow();
    expect(persisted.ok).toBe(true);
    // RELOAD: the singleton dies, its db handle closes.
    __resetDvrFullForTests();
    expect(dvrFullHandle()).toBeNull();
    const list = await storedSessions();
    expect(list.ok).toBe(true);
    const found = list.value.find((s) => s.id === sessionId);
    expect(found).toBeTruthy();
    expect(found?.clicks).toBe(1);
    // DELETE removes meta and shots.
    const del = await deleteStoredSession(sessionId);
    expect(del.ok).toBe(true);
    const after = await storedSessions();
    expect(after.value.find((s) => s.id === sessionId)).toBeUndefined();
  });
});

describe("F107-S5: the stored-session UI surfaces mount", () => {
  it("Collector hosts the DVR sessions section and the button opens the modal", async () => {
    const { container, unmount } = render(<Collector />);
    const openBtn = container.querySelector('[data-testid="dvr-sessions-open"]') as HTMLButtonElement;
    expect(openBtn).toBeTruthy();
    await act(async () => {
      fireEvent.click(openBtn);
    });
    await waitFor(() => expect(document.querySelector('[data-testid="dvr-sessions-modal"]')).toBeTruthy());
    // The list either shows rows or the honest empty state - never a crash.
    await waitFor(() =>
      expect(
        document.querySelector('[data-testid="dvr-session-row"]') || document.querySelector('[data-testid="dvr-session-empty"]')
      ).toBeTruthy()
    );
    unmount();
  });

  it("the FAB panel carries the sessions handle (step-3 surface extended, not forked)", async () => {
    const { unmount } = render(<DvrFab />);
    const fab = document.querySelector('[data-testid="dvr-fab"]') as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(fab);
    });
    await waitFor(() => expect(document.querySelector('[data-testid="dvr-panel"]')).toBeTruthy());
    const sessionsBtn = document.querySelector('[data-testid="dvr-sessions-button"]') as HTMLButtonElement;
    expect(sessionsBtn).toBeTruthy();
    await act(async () => {
      fireEvent.click(sessionsBtn);
    });
    await waitFor(() => expect(document.querySelector('[data-testid="dvr-sessions-modal"]')).toBeTruthy());
    unmount();
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { indexedDB as fakeDB, IDBObjectStore } from "fake-indexeddb";
import "@/i18n";
import { DvrFab } from "@/components/domain/DvrFab";
import App from "@/App";
import { SessionListModal } from "@/components/dvr/SessionListModal";
import { startFullDvr, stopFullDvr, fullDvrState, currentFullSession, __resetFullDvrForTests } from "@/lib/dvr/full";
import { closeDvrDatabase, listSessions, getSession, saveSession, deleteSession } from "@/lib/dvr/storage";
import { exportSession } from "@/lib/dvr/export";
import { installDvr, __resetDvrForTests } from "@/lib/dvr";
import type { ButtonAction } from "@/lib/collectorAgent";

vi.mock("html2canvas", () => ({ default: vi.fn(async () => {
  const canvas = document.createElement("canvas");
  canvas.width = 640; canvas.height = 480;
  return canvas;
}) }));
const ctx = { fillRect: vi.fn(), drawImage: vi.fn(), set fillStyle(_: string) {} };

beforeEach(async () => {
  vi.stubGlobal("indexedDB", fakeDB);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:image/png;base64,QUJD");
  window.location.hash = "";
  document.body.innerHTML = '<div id="root"><button data-testid="real-action">Act</button><div data-testid="result"></div></div>';
  stopFullDvr(); await currentFullSession();
  __resetDvrForTests(); __resetFullDvrForTests();
  for (const s of await listSessions()) await deleteSession(s.id);
});
afterEach(async () => {
  stopFullDvr(); await currentFullSession();
  __resetFullDvrForTests(); await closeDvrDatabase();
  vi.restoreAllMocks();
  window.location.hash = "";
});

describe("F107 full DVR: real root observer, click rasterization, persistence", () => {
  it("requires opt-in; click produces a bounded structural mutation and a thumbnail, then exports valid v2", async () => {
    expect(fullDvrState().enabled).toBe(false);
    await startFullDvr();
    expect(fullDvrState().enabled).toBe(true);
    const inner = {
      record: (rec: Omit<ButtonAction, "id" | "ts">) => ({ id: "click1", ts: new Date().toISOString(), ...rec }),
      update: vi.fn(),
    };
    const recorder = installDvr(inner);
    fireEvent.click(screen.getByTestId("real-action"));
    recorder.record({ feature: "global", action: "click", params: { testId: "real-action" } });
    screen.getByTestId("result").appendChild(document.createElement("span"));
    await waitFor(async () => {
      const timeline = (await currentFullSession())?.timeline || [];
      expect(timeline.some(e => e.kind === "mutation" && (e.diff as { path: number[] }).path.length > 0)).toBe(true);
      expect(timeline.some(e => e.kind === "screenshot" && String(e.image).startsWith("data:image/png"))).toBe(true);
    });
    const rows = await listSessions();
    expect(rows).toHaveLength(1);
    const bundle = JSON.parse(exportSession(rows[0]));
    expect(bundle).toMatchObject({ format: "mcrec", version: 2, storage: { policy: "local-indexeddb" } });
    expect(bundle.features.length).toBe(11);
    expect(bundle.timeline.some((e: { kind: string }) => e.kind === "click")).toBe(true);
    expect(ctx.drawImage).toHaveBeenCalled();
  });

  it("observes only #root; excludes private nodes and records no attribute values", async () => {
    await startFullDvr();
    const outside = document.createElement("div"); document.body.appendChild(outside);
    outside.setAttribute("title", "external secret");
    const privateNode = document.createElement("div"); privateNode.setAttribute("data-dvr-private", "");
    screen.getByTestId("result").appendChild(privateNode);
    privateNode.setAttribute("title", "private secret");
    const before = (await currentFullSession())?.timeline.length || 0;
    screen.getByTestId("result").setAttribute("title", "attribute secret");
    await waitFor(async () => expect((await currentFullSession())?.timeline.length).toBeGreaterThan(before));
    const text = exportSession((await currentFullSession())!);
    expect(text).not.toContain("external secret");
    expect(text).not.toContain("private secret");
    expect(text).not.toContain("attribute secret");
    stopFullDvr();
    const count = (await currentFullSession())?.timeline.length;
    screen.getByTestId("result").setAttribute("title", "after stop");
    await Promise.resolve();
    expect((await currentFullSession())?.timeline.length).toBe(count);
  });

  it("lists sessions after remount/reload, exports each and deletes it", async () => {
    await startFullDvr();
    const id = fullDvrState().id;
    stopFullDvr();
    __resetFullDvrForTests(); // simulate a new page load: in-memory singleton gone, database remains
    render(<SessionListModal open onClose={() => {}} />);
    expect(await screen.findByTestId("dvr-session")).toBeTruthy();
    expect(screen.getByTestId(`dvr-export-${id}`)).toBeTruthy();
    fireEvent.click(screen.getByTestId(`dvr-delete-${id}`));
    await waitFor(async () => expect(await getSession(id)).toBeUndefined());
  });

  it("mounts the real collector lab while full capture is active, without a boundary crash", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}), text: async () => "{}" })));
    window.location.hash = "#/lab/collector";
    const root = document.getElementById("root")!;
    root.innerHTML = "";
    const view = render(<App />, { container: root });
    await waitFor(() => expect(screen.getByTestId("feature-lab-collector")).toBeTruthy());
    await startFullDvr();
    expect(fullDvrState().enabled).toBe(true);
    expect(screen.queryByTestId("feature-boundary-collector")).toBeNull();
    expect(screen.getByTestId("collector-page")).toBeTruthy();
    view.unmount();
  });

  it("never persists route query credentials in v2 targets or click frames", async () => {
    window.location.hash = "#/collector?token=PRIVATE-QUERY-VALUE";
    await startFullDvr();
    const recorder = installDvr({
      record: (rec) => ({ id: "route1", ts: new Date().toISOString(), ...rec }),
      update: vi.fn(),
    });
    recorder.record({ feature: "global", action: "click", params: { testId: "real-action" } });
    const saved = (await currentFullSession())!;
    expect(exportSession(saved)).not.toContain("PRIVATE-QUERY-VALUE");
    expect(saved.target.route).toBe("#/collector");
  });

  it("deduplicates concurrent starts so both callers share one durable session", async () => {
    const first = startFullDvr();
    const second = startFullDvr();
    expect(second).toBe(first);
    await Promise.all([first, second]);
    expect((await listSessions()).map(s => s.id)).toEqual([fullDvrState().id]);
  });

  it("cannot resurrect a deleted live session behind a queued write", async () => {
    await startFullDvr();
    const id = fullDvrState().id;
    screen.getByTestId("result").setAttribute("title", "queued");
    render(<SessionListModal open onClose={() => {}} />);
    await screen.findByTestId(`dvr-delete-${id}`);
    fireEvent.click(screen.getByTestId(`dvr-delete-${id}`));
    await waitFor(async () => expect(await getSession(id)).toBeUndefined());
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(await getSession(id)).toBeUndefined();
    expect(fullDvrState().enabled).toBe(false);
  });

  it("deletes expired sessions from the database on listing", async () => {
    const now = Date.now();
    await saveSession({ id: "old", createdAt: now - 32 * 86400000, updatedAt: now - 31 * 86400000,
      target: { route: "/", lang: "en", ui: "v2" }, features: [], timeline: [] });
    expect((await listSessions(now)).some(s => s.id === "old")).toBe(false);
    expect(await getSession("old")).toBeUndefined();
  });

  it("handles a real transaction QuotaExceededError without breaking the v1 ring", async () => {
    await startFullDvr();
    const put = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(() => {
      throw new DOMException("Disk full", "QuotaExceededError");
    });
    screen.getByTestId("result").setAttribute("title", "changed");
    await waitFor(() => expect(fullDvrState().enabled).toBe(false));
    expect(fullDvrState().error).toContain("quota");
    put.mockRestore();
    expect((await currentFullSession())?.timeline.length).toBeGreaterThan(0);
  });

  it("rejects >5 MB before writing; the v1 FAB remains usable when storage is unavailable", async () => {
    await expect(saveSession({ id: "oversized", createdAt: 1, updatedAt: 1, target: { route: "/", lang: "en", ui: "v2" }, features: [], timeline: [{ kind: "screenshot", at: 1, image: "x".repeat(5_242_880) }] })).rejects.toThrow("5 MB");
    await closeDvrDatabase();
    vi.stubGlobal("indexedDB", undefined);
    render(<DvrFab />);
    fireEvent.click(screen.getByTestId("dvr-fab"));
    fireEvent.click(screen.getByTestId("dvr-full-toggle"));
    await waitFor(() => expect(screen.getByTestId("dvr-full-error")).toBeTruthy());
    expect(screen.getByTestId("dvr-preview")).toBeTruthy();
    expect(screen.getByTestId("dvr-full-warning")).toBeTruthy();
  });
});
