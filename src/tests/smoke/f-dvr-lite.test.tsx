// [F-DVR-LITE / Observatory step 3] The DVR against the REAL DOM + the REAL F104.
//
// The Node gate (tests/f-dvr-lite.test.js) proves the ring rules and the static
// wiring. This one proves the three claims that only a mounted UI can make:
//   1. the decorator is transparent - F104 keeps recording exactly the rows it
//      recorded before, and the ring additionally sees them;
//   2. the FAB's Copy hands over the SAME bytes the panel previewed, through
//      lib/clipboard, with a codec tag that matches the envelope;
//   3. opening, previewing and copying issue NO network call of any kind - the one
//      privacy guarantee option (d) of #169 still has, asserted rather than promised.
// jsdom cannot mint a trusted click, so trustCheck:false stands in for real user
// clicks (same convention as src/tests/smoke/f104-global-capture.test.tsx).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@/i18n";

import { DvrFab, DVR_PREVIEW_CHARS } from "@/components/domain/DvrFab";
import {
  __resetDvrForTests,
  clearDvr,
  dvrReport,
  dvrSnapshot,
  installDvr,
  installDvrObservers,
  setDvrRecording,
} from "@/lib/dvr";
import { __resetGlobalClickCaptureForTests, installGlobalClickCapture, GLOBAL_CLICK_SOURCE, type GlobalClickRecorder } from "@/lib/globalClickCapture";
import type { ButtonAction } from "@/lib/collectorAgent";

interface StubRecorder extends GlobalClickRecorder {
  rows: ButtonAction[];
  patches: Array<{ id: string; patch: Partial<ButtonAction> }>;
}

function stubRecorder(): StubRecorder {
  const rows: ButtonAction[] = [];
  const patches: Array<{ id: string; patch: Partial<ButtonAction> }> = [];
  let seq = 0;
  return {
    rows,
    patches,
    record: (rec) => {
      const row: ButtonAction = { id: "d" + ++seq, ts: new Date().toISOString(), ...rec };
      rows.push(row);
      return row;
    },
    update: (id, patch) => {
      patches.push({ id, patch });
      const row = rows.find((r) => r.id === id);
      if (row) Object.assign(row, patch);
    },
  };
}

function mountDom(): void {
  document.body.innerHTML = '<button data-testid="ordinary">Ordinary</button><div id="root"></div>';
}

let uninstallObservers: (() => void) | null = null;
/** Node's CompressionStream (absent in jsdom): captured once so a test that stubs
 *  it away can put the REAL global back - never vi.unstubAllGlobals(), which would
 *  also resurrect the real network fetch the setup file stubs out on purpose. */
const ORIGINAL_CS = (globalThis as { CompressionStream?: unknown }).CompressionStream;
/** This file owns its fetch mock, so "the DVR issued no request" is asserted against
 *  a counter this file can read - not against a helper that may have been unwrapped. */
const fetchSpy = vi.fn(() => Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) } as unknown as Response));

beforeEach(() => {
  __resetGlobalClickCaptureForTests();
  __resetDvrForTests();
  mountDom();
  vi.stubGlobal("fetch", fetchSpy);
  fetchSpy.mockClear();
});

afterEach(() => {
  uninstallObservers?.();
  uninstallObservers = null;
  __resetGlobalClickCaptureForTests();
  __resetDvrForTests();
  vi.stubGlobal("CompressionStream", ORIGINAL_CS);
  vi.useRealTimers();
});

describe("F-DVR-LITE: the ring decorates F104 instead of forking it", () => {
  it("passes every record/update through to the inner recorder AND into the ring", async () => {
    const inner = stubRecorder();
    const recorder = installDvr(inner);
    const row = recorder.record({
      feature: "global",
      action: "click:overview-auto-login",
      params: { testId: "overview-auto-login", label: "", text: "Auto login", tag: "button", route: "#/", path: "button" },
      result: { capturing: true, fetch: [], opened: [] },
      elapsedMs: 0,
      source: GLOBAL_CLICK_SOURCE,
    });
    expect(inner.rows.length).toBe(1); // F104's own row is untouched
    expect(inner.rows[0].source).toBe(GLOBAL_CLICK_SOURCE);

    recorder.update(row.id, {
      result: { capturing: false, fetch: [{ kind: "fetch", url: "/api/status", method: "GET", status: 200 }], opened: [] },
      elapsedMs: 10_000,
      verdict: { status: "ok", reason: "auto-captured click: 1 fetch(es), 0 popup(s)", suggestedFix: "", relatedIssue: null },
    });
    expect(inner.patches.length).toBe(1); // the patch reached the collector store

    const report = await dvrReport();
    const kinds = report.bundle.entries.map((e) => e.kind);
    expect(kinds).toEqual(["click", "settle"]);
    const click = report.bundle.entries[0];
    expect(click.testId).toBe("overview-auto-login");
    const settle = report.bundle.entries[1];
    expect(settle.verdict).toBe("ok");
    expect(settle.fetch).toBe(1);
    expect(settle.failed).toBe(0);
    expect(report.bundle.counts.count).toBe(2);
  });

  it("records the click the moment F104 sees it, and the verdict when its 10 s window closes", async () => {
    vi.useFakeTimers();
    const inner = stubRecorder();
    installGlobalClickCapture(installDvr(inner), { trustCheck: false, windowMs: 10_000 });
    const button = document.querySelector('[data-testid="ordinary"]') as HTMLButtonElement;

    await act(async () => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    expect(dvrSnapshot().count).toBe(1);
    expect(dvrSnapshot().clicks).toBe(1);

    await act(async () => {
      vi.advanceTimersByTime(10_500);
    });
    expect(inner.rows.length).toBe(1);
    expect(inner.patches.length).toBe(1);
    const report = await dvrReport();
    expect(report.bundle.entries.map((e) => e.kind)).toEqual(["click", "settle"]);
  });

  it("a PAUSED DVR stops growing but keeps what it already has (the operator's switch)", async () => {
    const inner = stubRecorder();
    const recorder = installDvr(inner);
    const click = () =>
      recorder.record({
        feature: "global",
        action: "click:ordinary",
        params: { testId: "ordinary" },
        elapsedMs: 0,
        source: GLOBAL_CLICK_SOURCE,
      });
    click();
    expect(dvrSnapshot().count).toBe(1);

    setDvrRecording(false);
    click();
    click();
    expect(dvrSnapshot().count).toBe(1); // paused: the ring did not move...
    expect(inner.rows.length).toBe(3); // ...and F104's rows kept flowing (extend, never replace)
    expect(dvrSnapshot().recording).toBe(false);

    setDvrRecording(true);
    click();
    expect(dvrSnapshot().count).toBe(2);
    expect((await dvrReport()).bundle.counts.count).toBe(2);
  });

  it("records route changes and counts DOM churn without capturing a single node", async () => {
    const inner = stubRecorder();
    installDvr(inner);
    uninstallObservers = installDvrObservers();
    await act(async () => {
      window.location.hash = "#/mirror";
      window.dispatchEvent(new HashChangeEvent("hashchange"));
      document.body.appendChild(document.createElement("div"));
      await Promise.resolve();
    });
    await waitFor(() => expect(dvrSnapshot().mutations).toBeGreaterThan(0));
    const report = await dvrReport();
    const route = report.bundle.entries.find((e) => e.kind === "route");
    expect(route, "the hashchange must be recorded").toBeTruthy();
    expect(route?.to).toBe("#/mirror");
    expect(report.bundle.target.route).toBe("#/mirror");
    // The mutation counter is a NUMBER; no entry may carry DOM content.
    for (const entry of report.bundle.entries) {
      expect(JSON.stringify(entry)).not.toContain("Ordinary");
    }
  });
});

describe("F-DVR-LITE: the FAB inside the capture, the payload on the clipboard", () => {
  it("clicking the FAB is itself recorded (the FAB is deliberately NOT in F104's blind spot)", async () => {
    const inner = stubRecorder();
    installGlobalClickCapture(installDvr(inner), { trustCheck: false });
    render(<DvrFab />);

    await act(async () => {
      screen.getByTestId("dvr-fab").dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    expect(inner.rows.some((r) => (r.params as { testId?: string })?.testId === "dvr-fab")).toBe(true);
    const report = await dvrReport();
    expect(report.bundle.entries.map((e) => e.testId)).toContain("dvr-fab");
    // awaiting the async report settles the panel's state INSIDE act (no CI log noise)
    expect(await screen.findByTestId("dvr-panel")).toBeTruthy();
  });

  it("Copy hands over exactly the previewed envelope, tagged, sized, and through lib/clipboard", async () => {
    const writeText = vi.fn((_text: string) => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true, writable: true });
    const inner = stubRecorder();
    const recorder = installDvr(inner);
    recorder.record({
      feature: "global",
      action: "click:overview-auto-login",
      params: { testId: "overview-auto-login", text: "Auto login", tag: "button", route: "#/" },
      elapsedMs: 0,
      source: GLOBAL_CLICK_SOURCE,
    });
    render(<DvrFab />);

    await act(async () => {
      fireEvent.click(screen.getByTestId("dvr-fab"));
    });
    const preview = await screen.findByTestId("dvr-preview");
    await waitFor(() => expect(preview.getAttribute("data-chars")).not.toBe("0"));

    await act(async () => {
      fireEvent.click(screen.getByTestId("modal-primary"));
    });
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));

    const payload = String(writeText.mock.calls[0][0]);
    expect(payload.startsWith("mcrec1:")).toBe(true);
    const codec = payload.slice("mcrec1:".length).split(":")[0];
    expect(["gzip", "plain"]).toContain(codec);
    expect(preview.getAttribute("data-codec")).toBe(codec); // the panel told the truth about the codec
    expect(preview.getAttribute("data-chars")).toBe(String(payload.length));
    // the preview is the payload (or its documented prefix), never a summary
    const shown = preview.textContent || "";
    expect(payload.startsWith(shown.replace(/…$/, ""))).toBe(true);
    if (payload.length <= DVR_PREVIEW_CHARS) expect(shown).toBe(payload);
    // and the pasted line really carries the click (plain codec: no gzip involved)
    vi.stubGlobal("CompressionStream", undefined);
    const plain = await dvrReport();
    const bundle = JSON.parse(atob(plain.text.split(":")[2]));
    expect(bundle.format).toBe("mcrec");
    expect(bundle.entries.map((e: { testId: string }) => e.testId)).toContain("overview-auto-login");
    expect(await screen.findByTestId("dvr-copied")).toBeTruthy();
  });

  it("assembling, previewing and copying issue no fetch and no XHR (option (d) of #169)", async () => {
    const xhrOpen = vi.spyOn(XMLHttpRequest.prototype, "open");
    const writeText = vi.fn((_text: string) => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true, writable: true });
    const inner = stubRecorder();
    installDvr(inner).record({
      feature: "global",
      action: "click:ordinary",
      params: { testId: "ordinary" },
      elapsedMs: 0,
      source: GLOBAL_CLICK_SOURCE,
    });
    render(<DvrFab />);
    await act(async () => {
      fireEvent.click(screen.getByTestId("dvr-fab"));
    });
    await screen.findByTestId("dvr-preview");
    await act(async () => {
      fireEvent.click(screen.getByTestId("modal-primary"));
    });
    await waitFor(() => expect(writeText).toHaveBeenCalled());

    // fetch is stubbed globally by src/tests/setup.ts; a call would be visible here.
    expect(fetchSpy.mock.calls.length).toBe(0);
    expect(xhrOpen).not.toHaveBeenCalled();
    xhrOpen.mockRestore();
  });

  it("falls back to the plain codec when the host has no CompressionStream, and says so", async () => {
    vi.stubGlobal("CompressionStream", undefined);
    const inner = stubRecorder();
    installDvr(inner).record({ feature: "global", action: "click:ordinary", params: { testId: "ordinary" }, elapsedMs: 0, source: GLOBAL_CLICK_SOURCE });
    const report = await dvrReport();
    expect(report.codec).toBe("plain");
    expect(report.text.startsWith("mcrec1:plain:")).toBe(true);
  });

  it("an empty DVR still produces a valid, copyable bundle (no crash, no fake data)", async () => {
    vi.stubGlobal("CompressionStream", undefined);
    const inner = stubRecorder();
    installDvr(inner);
    const report = await dvrReport({ now: 1_700_000_000_000 });
    expect(report.bundle.counts.count).toBe(0);
    expect(report.bundle.entries).toEqual([]);
    expect(report.text.startsWith("mcrec1:")).toBe(true);
    expect(JSON.parse(atob(report.text.split(":")[2])).format).toBe("mcrec");
  });

  it("Clear empties the ring AND the panel, and the empty state is shown", async () => {
    const inner = stubRecorder();
    installDvr(inner).record({ feature: "global", action: "click:ordinary", params: { testId: "ordinary" }, elapsedMs: 0, source: GLOBAL_CLICK_SOURCE });
    expect(dvrSnapshot().count).toBe(1);
    render(<DvrFab />);
    await act(async () => {
      fireEvent.click(screen.getByTestId("dvr-fab"));
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("modal-secondary"));
    });
    await waitFor(() => expect(dvrSnapshot().count).toBe(0));
    clearDvr();
    expect((await dvrReport()).bundle.counts.count).toBe(0);
    expect(await screen.findByTestId("dvr-empty")).toBeTruthy();
    expect(screen.getByTestId("dvr-fab-count").textContent).toBe("0");
  });
});
