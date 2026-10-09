// [WP-13b / MC-P24] DVR SCREENSHOT + STORAGE PRIVACY — behavioral proof against
// the SHIPPED code.
//
// MC-P24 proved the old fence claim wrong: XMLSerializer serializes text nodes
// and attribute VALUES, so a revealed password (MaskedField renders the raw
// value as text when revealed) or a reflected input value (React 18 writes a
// controlled input's typed value into the `value` attribute) was rasterized
// into the PNG. The repair is three layers, all proven here:
//   1. EXCLUSIONS: prepareShotClone removes every [data-dvr-exclude] subtree and
//      every typed input value from the clone BEFORE serialization, and the
//      credential surfaces carry the attribute (MaskedField renders it — proven
//      by mounting the real primitive).
//   2. CONSENT: shots are OFF by default; the session's takeShot is a no-op
//      until the operator opts in (setShotsConsented). Non-image diagnostics
//      (timeline + mutation descriptors) keep working with shots off.
//   3. MIGRATION: pre-fix stored shots are purged from IndexedDB (deleted,
//      never copied) and the session metas are zeroed — idempotent via a marker
//      record that no export can reach.
//
// Synthetic secret only: hunter2-synthetic.
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import "@/i18n";

import { __resetDvrForTests, installDvr } from "@/lib/dvr";
import { __resetGlobalClickCaptureForTests, installGlobalClickCapture, type GlobalClickRecorder } from "@/lib/globalClickCapture";
import type { ButtonAction } from "@/lib/collectorAgent";
import {
  DVR_EXCLUDE_ATTR,
  prepareShotClone,
  setShotsConsented,
  shotsConsented,
} from "@/lib/dvr/screenshots";
import { setShotRasterizer } from "@/lib/dvr/screenshots";
import { SHOT_MIME_PREFIX } from "@/lib/dvr/screenshotCore";
import {
  __resetDvrFullForTests,
  installDvrFull,
  storedSessionDetail,
  storedSessions,
} from "@/lib/dvr/session";
import { migratePurgeLegacyShots, openDvrDb, saveSession, saveShots } from "@/lib/dvr/storage";
import { MaskedField } from "@/components/primitives/Data";

const PASS = "hunter2-synthetic";
const TINY_PNG = SHOT_MIME_PREFIX + "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

interface StubRecorder extends GlobalClickRecorder {
  rows: ButtonAction[];
}

function stubRecorder(): StubRecorder {
  const rows: ButtonAction[] = [];
  let seq = 0;
  return {
    rows,
    record: (rec) => {
      const row: ButtonAction = { id: "b" + ++seq, ts: new Date().toISOString(), ...rec };
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
  document.body.innerHTML = '<button data-testid="wp13b-click">Click me</button><div id="root"></div>';
}

let uninstallCapture: (() => void) | null = null;
let prevRasterizer: ReturnType<typeof setShotRasterizer> | null = null;

beforeEach(() => {
  __resetGlobalClickCaptureForTests();
  __resetDvrForTests();
  __resetDvrFullForTests();
  setShotsConsented(false);
  mountDom();
  vi.stubGlobal("fetch", vi.fn(() => Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) }) as unknown as Response));
});

afterEach(() => {
  uninstallCapture?.();
  uninstallCapture = null;
  if (prevRasterizer) setShotRasterizer(null);
  prevRasterizer = null;
  setShotsConsented(false);
  __resetDvrFullForTests();
  __resetGlobalClickCaptureForTests();
  __resetDvrForTests();
});

describe("[WP-13b] prepareShotClone: credential surfaces never enter the capture path", () => {
  it("strips typed input values, clears textareas, removes excluded subtrees, keeps labels", () => {
    const root = document.createElement("div");
    root.innerHTML =
      '<input type="password" data-testid="cred-password" value="' + PASS + '">' +
      '<input type="text" value="' + PASS + '">' +
      '<input type="hidden" name="csrf" value="' + PASS + '">' +
      '<input type="submit" value="Save changes">' +
      '<textarea>' + PASS + '</textarea>' +
      '<div ' + DVR_EXCLUDE_ATTR + '><span>revealed secret: ' + PASS + '</span></div>' +
      '<p>ordinary diagnostic text</p>';
    const clone = prepareShotClone(root);
    const xml = new XMLSerializer().serializeToString(clone);
    expect(xml).not.toContain(PASS);
    // visible-label inputs keep their value (it is the button's label, not typed content)
    expect(xml).toContain("Save changes");
    // ordinary content survives — the exclusion is surgical, not a blanket mute
    expect(xml).toContain("ordinary diagnostic text");
    // the excluded subtree is gone entirely
    expect(clone.querySelectorAll("[" + DVR_EXCLUDE_ATTR + "]")).toHaveLength(0);
    // typed inputs lost their value attribute
    const pw = clone.querySelector('input[type="password"]') as HTMLInputElement;
    expect(pw.getAttribute("value")).toBeNull();
    const ta = clone.querySelector("textarea") as HTMLTextAreaElement;
    expect(ta.textContent).toBe("");
  });

  it("never throws on a detached or odd root", () => {
    const root = document.createElement("div");
    expect(() => prepareShotClone(root)).not.toThrow();
    expect(prepareShotClone(root).children.length).toBe(0);
  });

  it("MaskedField — the revealed-password surface — renders the exclusion attribute", () => {
    const { container, unmount } = render(
      <MaskedField id="credWinPass" value={PASS} mask="************" labelKey="keys.windowsPassword" />
    );
    const field = container.querySelector("#credWinPass") as HTMLElement;
    expect(field).toBeTruthy();
    expect(field.hasAttribute(DVR_EXCLUDE_ATTR)).toBe(true);
    // and the revealed raw value is inside that excluded subtree
    const reveal = container.querySelector('[data-testid="field-reveal-credWinPass"]') as HTMLButtonElement;
    fireEvent.click(reveal);
    expect(field.textContent).toContain(PASS); // the UI still reveals it to the operator…
    expect(field.hasAttribute(DVR_EXCLUDE_ATTR)).toBe(true); // …but the capture path drops it
    unmount();
  });
});

describe("[WP-13b] consent: shots are off by default and opt-in per session", () => {
  it("default: a real click lands the timeline entry but NO screenshot", async () => {
    expect(shotsConsented()).toBe(false);
    prevRasterizer = setShotRasterizer(() => TINY_PNG); // even a working pipeline must not fire
    const stub = stubRecorder();
    uninstallCapture = installGlobalClickCapture(installDvr(stub, { enabled: true }), { trustCheck: false });
    const handle = installDvrFull();
    const btn = document.querySelector('[data-testid="wp13b-click"]') as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(btn);
    });
    await waitFor(() => expect(handle.timeline().some((e) => e.kind === "click")).toBe(true));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    // non-image diagnostics are preserved; the pixel path stayed disabled
    expect(handle.meta().clicks).toBe(1);
    expect(handle.shots()).toHaveLength(0);
    expect(handle.meta().shots).toBe(0);
    __resetDvrFullForTests();
  });

  it("opt-in: with consent, the same click lands one exclusion-fenced shot", async () => {
    setShotsConsented(true);
    prevRasterizer = setShotRasterizer(() => TINY_PNG);
    const stub = stubRecorder();
    uninstallCapture = installGlobalClickCapture(installDvr(stub, { enabled: true }), { trustCheck: false });
    const handle = installDvrFull();
    const btn = document.querySelector('[data-testid="wp13b-click"]') as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(btn);
    });
    await waitFor(() => expect(handle.shots().length).toBe(1));
    expect(handle.meta().shots).toBe(1);
    __resetDvrFullForTests();
  });
});

describe("[WP-13b] migration: pre-fix stored shots are purged, never copied", () => {
  it("purges every legacy shot, zeroes the metas, and is idempotent", async () => {
    // A FRESH database: the consent tests above already opened the shared
    // fake-indexeddb and ran the (correct) migration on an empty store, which
    // wrote the marker. This test needs the pre-migration state.
    const { IDBFactory } = await import("fake-indexeddb");
    const realIndexedDB = (globalThis as { indexedDB?: unknown }).indexedDB;
    (globalThis as { indexedDB?: unknown }).indexedDB = new IDBFactory();
    try {
      const dbRes = await openDvrDb();
      expect(dbRes.ok).toBe(true);
      const db = dbRes.value as IDBDatabase;
    // seed a pre-fix session: meta counts 2 shots / 100 bytes, 2 stored shots
    const meta = { id: "dvr-legacy-1", startedAt: Date.now() - 1000, endedAt: 0, clicks: 2, settles: 0, routes: 0, mutations: 0, shots: 2, bytes: 100, label: "" };
    await saveSession(db, meta as never);
    await saveShots(db, "dvr-legacy-1", [
      { key: "1", at: Date.now() - 500, w: 320, h: 240, bytes: 50, dataUrl: TINY_PNG },
      { key: "2", at: Date.now() - 400, w: 320, h: 240, bytes: 50, dataUrl: TINY_PNG },
    ], 100);
    const detailBefore = await storedSessionDetail("dvr-legacy-1");
    expect(detailBefore.ok).toBe(true);
    expect(detailBefore.shots).toHaveLength(2);

    const first = await migratePurgeLegacyShots(db);
    expect(first.ok).toBe(true);
    expect(first.value?.purgedShots).toBe(2);
    expect(first.value?.sessionsRewritten).toBe(1);

    // shots are GONE (deleted, not copied), the meta is zeroed
    const detailAfter = await storedSessionDetail("dvr-legacy-1");
    expect(detailAfter.ok).toBe(true);
    expect(detailAfter.shots).toHaveLength(0);
    expect(detailAfter.meta?.shots).toBe(0);
    expect(detailAfter.meta?.bytes).toBe(0);
    // the session itself survives — only the unredactable pixels are purged
    const list = await storedSessions();
    expect(list.value.some((s) => s.id === "dvr-legacy-1")).toBe(true);

    // idempotent: the marker makes the second run a no-op
    const second = await migratePurgeLegacyShots(db);
    expect(second.ok).toBe(true);
    expect(second.reason).toBe("already-migrated");
    expect(second.value?.purgedShots).toBe(0);

    // a post-migration consented shot is never touched by a later migration run
    await saveShots(db, "dvr-legacy-1", [{ key: "3", at: Date.now(), w: 320, h: 240, bytes: 50, dataUrl: TINY_PNG }], 50);
    const third = await migratePurgeLegacyShots(db);
    expect(third.ok).toBe(true);
    expect(third.reason).toBe("already-migrated");
    const detailFinal = await storedSessionDetail("dvr-legacy-1");
    expect(detailFinal.shots).toHaveLength(1);
    db.close();
    } finally {
      (globalThis as { indexedDB?: unknown }).indexedDB = realIndexedDB;
    }
  });
});
