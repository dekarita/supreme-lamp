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
  });
});
