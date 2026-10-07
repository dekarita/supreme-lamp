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
