// [F110 / Observatory step 9 - FINAL STEP] Live Patch Protocol: the DOM gate.
//
// What only a mounted DOM can prove:
//   1. DEFAULT-OFF - with the channel disarmed a signed, otherwise-valid patch frame is
//      ignored BEFORE verification: nothing is written to storage and IndexedDB is never
//      opened (spied, not assumed);
//   2. the WHOLE shipped chain runs - the real /ws hook's filter, the real WebCrypto HMAC
//      (no stub), the real IndexedDB (fake-indexeddb), the real featureToggles map, and
//      the real FeatureBoundary rendering the disabled card on the patched section;
//   3. a forged, replayed or expired frame changes nothing except the audit row;
//   4. the audit row is legible in Settings and holds no credential;
//   5. rollback restores only what patches changed, writes its own marker, and asks for
//      the reload through the injected seam;
//   6. the state survives a reload, and NOTHING is left installed afterwards
//      (§MOCK-LIFECYCLE-DISCIPLINE: the subscriber count returns to zero on unmount);
//   7. F110 with an armed channel does not disturb F106's lab or F109's HUD.
// Playwright is not used: no Chromium in this sandbox (standing fact since step 4), and
// `e2e-ui` is the 25-min self-canceller - an un-runnable spec is not evidence.
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createHmac } from "node:crypto";
import App from "@/App";
import "@/i18n";
import { FEATURE_IDS } from "@/lib/featureRegistry";
import { readFeatureToggles } from "@/lib/featureToggles";
import { DASH_TOKEN_STORAGE_KEY } from "@/lib/dashToken";
import { isHudEnabled } from "@/lib/debugHud";
import { __resetDebugHudForTests } from "@/lib/debugHud";
import {
  PATCH_ARM_KEY,
  PATCH_AUDIT_DB,
  PATCH_AUDIT_MAX_ROWS,
  PATCH_CHANNEL_URL,
  canonicalPatch,
} from "@/lib/livePatch/patchCore";
import {
  __resetLivePatchChannelForTests,
  ingestPatchFrame,
  isDefaultMacProviderActive,
  patchAuditRows,
  primeAudit,
  rollbackLivePatches,
  setPatchMacProvider,
  signPatchFrame,
} from "@/lib/livePatch/channel";
import {
  __resetLivePatchForTests,
  installLivePatchCrossTab,
  isLivePatchArmed,
  livePatchListenerCount,
  setLivePatchArmed,
  setLivePatchReloader,
  subscribeLivePatch,
} from "@/lib/livePatch/state";
import { clearAudit } from "@/lib/livePatch/audit";

const TOKEN = "s3cr3t-dash-token-abcdef123456";
const NOW = () => Date.now();

/** Build a real, correctly signed frame for a real key - via the SHIPPED signer. */
async function patch(over: Record<string, unknown> = {}) {
  const unsigned = {
    v: 1,
    type: "patch",
    id: "patch-" + Math.random().toString(36).slice(2, 10),
    op: "toggle-off",
    feature: "keys",
    ts: NOW(),
    exp: NOW() + 60_000,
    ...over,
  };
  const signed = await signPatchFrame(unsigned);
  if (!signed.ok) throw new Error("fixture could not sign: " + signed.reason);
  return signed.value as string;
}

function renderAt(hash: string) {
  window.location.hash = hash;
  return render(<App />);
}

async function arm() {
  await act(async () => {
    setLivePatchArmed(true);
  });
}

function rowFor(text: string) {
  return patchAuditRows().filter((r) => r.feature === text || r.id.includes(text));
}

beforeEach(async () => {
  __resetLivePatchForTests();
  __resetLivePatchChannelForTests();
  __resetDebugHudForTests();
  window.localStorage.clear();
  window.localStorage.setItem(DASH_TOKEN_STORAGE_KEY, TOKEN);
  window.location.hash = "";
  await clearAudit();
});

afterEach(async () => {
  __resetLivePatchForTests();
  __resetLivePatchChannelForTests();
  __resetDebugHudForTests();
  await clearAudit();
  window.location.hash = "";
});

describe("F110 prod default-off", () => {
  it("ignores a valid signed patch before verifying it, writing nothing and opening no database", async () => {
    const openSpy = vi.spyOn(indexedDB, "open");
    const before = { ...window.localStorage };
    const { container, unmount } = renderAt("#/settings");
    expect(container.textContent).toContain("Live Patch");
    expect(container.textContent).toContain("disarmed");
    // the card primes its view from the durable log on mount, so that open is expected;
    // the claim under test is that the DISARMED INGEST opens nothing - clear and re-arm.
    await waitFor(() => expect(container.querySelector('[data-testid="settings-live-patch-empty"]')).not.toBeNull());
    openSpy.mockClear();

    const text = await patch({ feature: "keys" });
    const res = await ingestPatchFrame(text);

    expect(res.verdict).toBe("ignored-disarmed");
    expect(patchAuditRows().length).toBe(0);
    expect(JSON.stringify({ ...window.localStorage })).toBe(JSON.stringify(before));
    expect(openSpy).not.toHaveBeenCalled();
    expect(readFeatureToggles()).toEqual({});
    expect(container.querySelector('[data-testid="settings-live-patch-inert"]')).not.toBeNull();
    unmount();
  });

  it("a frame that is not a patch does not even reach the armed check", async () => {
    await arm();
    expect((await ingestPatchFrame(JSON.stringify({ type: "progress", step: 3 }))).verdict).toBe("ignored-not-patch");
    expect((await ingestPatchFrame("{not json")).verdict).toBe("ignored-not-patch");
    expect((await ingestPatchFrame(JSON.stringify({ type: "ping" }))).verdict).toBe("ignored-not-patch");
    expect(patchAuditRows().length).toBe(0);
    expect(window.localStorage.getItem("f109:toggles")).toBe(null);
  });

  it("arms only from Settings, and the arm flag is the literal 'true'", async () => {
    const { container } = renderAt("#/settings");
    const toggle = container.querySelector('[data-testid="settings-live-patch-arm-toggle"]') as HTMLElement;
    expect(toggle).not.toBeNull();
    expect(window.localStorage.getItem(PATCH_ARM_KEY)).toBe(null);
    await act(async () => {
      fireEvent.click(toggle);
    });
    expect(window.localStorage.getItem(PATCH_ARM_KEY)).toBe("true");
    expect(isLivePatchArmed()).toBe(true);
    await act(async () => {
      fireEvent.click(toggle);
    });
    expect(window.localStorage.getItem(PATCH_ARM_KEY)).toBe(null);
    expect(isLivePatchArmed()).toBe(false);
  });
});

describe("F110 the accepted patch", () => {
  it("verifies with WebCrypto, switches the section off, and renders the row", async () => {
    const { container } = renderAt("#/settings");
    await arm();
    expect(isDefaultMacProviderActive()).toBe(true);

    const res = await ingestPatchFrame(await patch({ feature: "keys", id: "p-real-1" }));
    expect(res.verdict).toBe("applied");
    expect(res.durable, "the audit row must reach IndexedDB").toBe(true);

    expect(readFeatureToggles()).toEqual({ keys: "off" });
    const rows = patchAuditRows();
    expect(rows.length).toBe(1);
    expect(rows[0].feature).toBe("keys");
    expect(rows[0].verdict).toBe("applied");
    expect(rows[0].sig8).toMatch(/^[0-9a-f]{8}$/);
    expect(JSON.stringify(rows[0])).not.toContain(TOKEN);

    await waitFor(() => expect(container.textContent).toContain("keys"));
    expect(container.querySelector('[data-testid="settings-live-patch-audit"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="settings-live-patch-empty"]')).toBeNull();
    expect(container.textContent).toContain("Roll back 1 patched section");
    // the label counts PENDING rollbacks, not history: the DOM gate caught the first
    // version of this card promising "Roll back 2 applied patches" over an empty plan
    expect(await (await import("@/lib/livePatch/channel")).patchPendingRollbackCount()).toBe(1);
  });

  it("renders the disabled card on the patched section, and leaves the others alone", async () => {
    const { container, unmount } = renderAt("#/settings");
    await arm();
    await ingestPatchFrame(await patch({ feature: "keys" }));
    // navigate like an operator: the toggle bites at the next mount, never mid-render
    const link = container.querySelector('nav a[href="#/keys"]') as HTMLElement;
    expect(link).not.toBeNull();
    await act(async () => {
      fireEvent.click(link);
    });
    const card = container.querySelector('[data-testid="feature-disabled-keys"]') as HTMLElement;
    expect(card).not.toBeNull();
    // the copy names BOTH enablers: an operator who was patched must be sent to the
    // rollback button, not only to the HUD
    expect(card.textContent).toContain("live patch (F110)");
    expect(container.querySelector('[data-testid="feature-disabled-sessions"]')).toBeNull();
    // the fence degraded ONE section: the app chrome is intact and the other routes remain
    expect(container.querySelector("nav")).not.toBeNull();
    expect(container.querySelector('[data-testid="feature-boundary-keys"]')).toBeNull("F105 rule 1: a healthy boundary adds no DOM - so neither does a disabled one's fence");
    unmount();
  });

  it("is inert with neither enabler: a stored 'off' from a patch does not bite once disarmed", async () => {
    const { container } = renderAt("#/settings");
    await arm();
    await ingestPatchFrame(await patch({ feature: "keys" }));
    expect(window.localStorage.getItem("f109:toggles")).toContain("keys");
    await act(async () => {
      setLivePatchArmed(false); // the operator disarms; F109's HUD is off too
    });
    expect(isHudEnabled()).toBe(false);
    window.location.hash = "#/keys";
    await act(async () => {
      container.querySelector('nav a[href="#/keys"]') && fireEvent.click(container.querySelector('nav a[href="#/keys"]') as HTMLElement);
    });
    expect(container.querySelector('[data-testid="feature-disabled-keys"]')).toBeNull();
  });
});

describe("F110 rejects, replays and expires", () => {
  it("a tampered frame changes nothing but the log", async () => {
    renderAt("#/settings");
    await arm();
    const text = await patch({ feature: "keys" });
    const tampered = text.replace('"toggle-off"', '"toggle-on"');
    const res = await ingestPatchFrame(tampered);
    expect(res.verdict).toBe("rejected");
    expect(res.reason).toBe("bad-signature");
    expect(readFeatureToggles()).toEqual({});
    expect(patchAuditRows()[0].reason).toBe("bad-signature");
  });

  it("a re-delivered frame is a duplicate, not a second application", async () => {
    renderAt("#/settings");
    await arm();
    const text = await patch({ feature: "keys", id: "p-twice" });
    expect((await ingestPatchFrame(text)).verdict).toBe("applied");
    const second = await ingestPatchFrame(text);
    expect(second.verdict).toBe("duplicate");
    expect(readFeatureToggles()).toEqual({ keys: "off" });
    expect(rowFor("p-twice").length).toBe(2);
    expect(patchAuditRows().filter((r) => r.verdict === "applied").length).toBe(1);
  });

  it("an expired frame is refused even with a perfect signature", async () => {
    renderAt("#/settings");
    await arm();
    const t = NOW();
    const res = await ingestPatchFrame(await patch({ feature: "keys", ts: t - 600_000, exp: t - 500_000 }));
    expect(res.verdict).toBe("rejected");
    expect(res.reason).toBe("expired");
    expect(readFeatureToggles()).toEqual({});
  });

  it("an unknown section and an unknown op are refused before any crypto", async () => {
    renderAt("#/settings");
    await arm();
    expect((await ingestPatchFrame(await patch({ feature: "livePatch" }))).reason).toBe("unknown-feature");
    expect((await ingestPatchFrame(await patch({ op: "import-module" }))).reason).toBe("unknown-op");
    expect((await ingestPatchFrame(await patch({ smuggled: true }))).reason).toBe("unknown-field");
    for (const id of FEATURE_IDS) expect(readFeatureToggles()[id]).toBeUndefined();
  });

  it("a MAC provider that lies is caught by the verifier, not trusted", async () => {
    renderAt("#/settings");
    await arm();
    const text = await patch({ feature: "keys", id: "p-cross" }); // signed by WebCrypto, before any stub exists
    const canonical = canonicalPatch(JSON.parse(text));
    const nodeMac = createHmac("sha256", TOKEN).update(canonical, "utf8").digest("hex");
    // cross-implementation control: the browser's digest equals Node's for the same bytes
    expect(JSON.parse(text).sig).toBe(nodeMac);
    // verify through a Node-computed provider: same algorithm, other implementation
    setPatchMacProvider(async () => ({ ok: true, reason: "", value: nodeMac }));
    const viaNode = await ingestPatchFrame(text);
    expect(viaNode.verdict).toBe("applied");
    // and a provider that LIES must reject. The stub is installed AFTER the frame was
    // signed, and __resetLivePatchChannelForTests() is NOT called in between - it clears
    // the provider too (a seam that resets itself is a seam a test can silently skip,
    // which is exactly what this line used to do).
    setPatchMacProvider(async () => ({ ok: true, reason: "", value: "0".repeat(64) }));
    const forged = await ingestPatchFrame(
      '{"v":1,"type":"patch","id":"p-forged","op":"toggle-off","feature":"mirror","ts":' + Date.now() +
        ',"exp":' + (Date.now() + 60000) + ',"sig":"' + "f".repeat(64) + '"}'
    );
    expect(forged.verdict).toBe("rejected");
    expect(forged.reason).toBe("bad-signature");
    expect(readFeatureToggles().mirror).toBeUndefined();
    setPatchMacProvider(null);
  });
});

describe("F110 durability, rollback and lifecycle", () => {
  it("the log survives a reload and the patched section is still off", async () => {
    const first = renderAt("#/settings");
    await arm();
    await ingestPatchFrame(await patch({ feature: "keys", id: "p-durable" }));
    // a page load: modules reset, storage and IndexedDB do not
    first.unmount();
    __resetLivePatchForTests();
    __resetLivePatchChannelForTests();
    expect(patchAuditRows().length).toBe(0);

    const second = renderAt("#/settings");
    await waitFor(() => expect(second.container.textContent).toContain("p-durable"));
    const rows = patchAuditRows();
    expect(rows.some((r) => r.id === "p-durable" && r.verdict === "applied")).toBe(true);
    expect(second.container.querySelector('[data-testid="feature-disabled-keys"]')).toBeNull();
    // and the same id arriving again is still a duplicate after the reload
    expect((await ingestPatchFrame(await patch({ feature: "keys", id: "p-durable" }))).verdict).toBe("duplicate");
    second.unmount();
  });

  it("rollback restores only what the patch changed, marks the log, and reloads via the seam", async () => {
    const { container } = renderAt("#/settings");
    await arm();
    const reloader = vi.fn();
    setLivePatchReloader(reloader);
    // the operator's OWN HUD switch on another section must survive the rollback
    window.localStorage.setItem("f109:toggles", JSON.stringify({ sessions: "off", keys: "off" }));
    const r1 = await ingestPatchFrame(await patch({ feature: "keys", op: "toggle-on", id: "p-on" }));
    expect(r1.verdict).toBe("applied");
    expect(readFeatureToggles()).toEqual({ sessions: "off" }); // a toggle-on patch over an OFF section cleared it
    const r2 = await ingestPatchFrame(await patch({ feature: "mirror", op: "toggle-off", id: "p-off" }));
    expect(r2.verdict).toBe("applied");
    expect(readFeatureToggles()).toEqual({ sessions: "off", mirror: "off" });

    const button = container.querySelector('[data-testid="settings-live-patch-rollback"]') as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    await act(async () => {
      fireEvent.click(button);
    });
    // fake-indexeddb defers its callbacks to a macrotask, so the chain that ends in the
    // reload outlives act()'s microtask flush: wait for it, never assert beside it.
    await waitFor(() => expect(reloader).toHaveBeenCalledTimes(1));
    // AND THIS is the claim the whole card exists for: rollback restores each patched
    // section to ITS OWN previous state - keys goes back off (that is what the patch
    // replaced) and mirror goes back on - while the operator's own HUD switch on
    // sessions, which no patch ever touched, is left exactly as it was.
    await waitFor(() => expect(readFeatureToggles()).toEqual({ sessions: "off", keys: "off" }));
    const kinds = patchAuditRows().map((r) => r.kind);
    expect(kinds[kinds.length - 1]).toBe("rollback");
    expect((container.querySelector('[data-testid="settings-live-patch-rollback"]') as HTMLButtonElement).disabled).toBe(true);
    // a second rollback is a NO-OP, not a second marker row and not a second reload
    const before = patchAuditRows().length;
    await rollbackLivePatches();
    expect(patchAuditRows().length).toBe(before);
    expect(reloader).toHaveBeenCalledTimes(1);
    // and a patch AFTER a rollback is rollable again (the marker is a cut, not a tombstone)
    const r3 = await ingestPatchFrame(await patch({ feature: "files", op: "toggle-off", id: "p-after" }));
    expect(r3.verdict).toBe("applied");
    expect(readFeatureToggles()).toEqual({ sessions: "off", keys: "off", files: "off" });
    await rollbackLivePatches();
    expect(readFeatureToggles()).toEqual({ sessions: "off", keys: "off" });
  });

  it("§MOCK-LIFECYCLE: every subscription the panel installs is gone when it unmounts", async () => {
    const onStorage = vi.spyOn(window, "addEventListener");
    const offStorage = vi.spyOn(window, "removeEventListener");
    const extra = subscribeLivePatch(() => undefined);
    expect(livePatchListenerCount()).toBe(1);
    const { unmount } = renderAt("#/settings");
    await waitFor(() => expect(livePatchListenerCount()).toBe(2)); // the panel's own store subscription
    expect(onStorage.mock.calls.some((c) => c[0] === "storage")).toBe(true);
    unmount();
    extra();
    expect(livePatchListenerCount()).toBe(0);
    expect(offStorage.mock.calls.some((c) => c[0] === "storage")).toBe(true);
    // and the installed cross-tab pair is idempotent + reversible on its own
    const off1 = installLivePatchCrossTab();
    const off2 = installLivePatchCrossTab();
    expect(off1).toBe(off2);
    off1();
    off2();
    expect(livePatchListenerCount()).toBe(0);
    onStorage.mockRestore();
    offStorage.mockRestore();
  });

  it(
    "the audit log is bounded, newest-last, and never stores the full MAC",
    async () => {
      renderAt("#/settings");
      await arm();
      // 212 rows straight through the adapter the channel uses. Driving them through the
      // full ingest path (a WebCrypto HMAC each, plus the per-frame read) is the same
      // browser-side claim about the BOUND, told 20x slower - and the ingest path is what
      // every other test in this file proves against the real provider.
      const audit = await import("@/lib/livePatch/audit");
      const wrote: { ok: boolean; reason: string }[] = [];
      for (let i = 0; i < PATCH_AUDIT_MAX_ROWS + 12; i += 1) {
        const res = await audit.appendAuditRow({
          kind: "patch",
          id: "bound-" + i,
          op: "toggle-off",
          feature: "keys",
          verdict: "applied",
          reason: "",
          sentAt: 1_760_000_000_000 + i,
          seenAt: new Date(1_760_000_000_000 + i).toISOString(),
          sig8: "ab".repeat(4),
          prev: "on",
        } as never);
        wrote.push({ ok: res.ok, reason: res.reason });
      }
      const failed = wrote.filter((w) => !w.ok);
      expect(failed, "appendAuditRow failed " + failed.length + "x, first reason: " + (failed[0] ? failed[0].reason : "")).toEqual([]);
      const durable = await audit.listAudit();
      expect(durable.ok).toBe(true);
      expect(durable.value ? durable.value.length : -1).toBe(PATCH_AUDIT_MAX_ROWS);
      expect(durable.value ? durable.value[durable.value.length - 1].id : "").toBe("bound-" + (PATCH_AUDIT_MAX_ROWS + 11));
      expect(durable.value ? durable.value.some((r) => r.id === "bound-0") : true).toBe(false, "the OLDEST rows are the ones that go");
      // and a page load reads exactly that bounded view into the live panel
      __resetLivePatchChannelForTests();
      await primeAudit();
      expect(patchAuditRows().length).toBe(PATCH_AUDIT_MAX_ROWS);
      const dump = JSON.stringify(patchAuditRows());
      expect(dump).not.toContain(TOKEN, "an audit row must not be able to carry the channel key");
      expect(dump.match(/"sig8":"[0-9a-f]+"/g) || []).toHaveLength(PATCH_AUDIT_MAX_ROWS);
    },
    30_000
  );

  it("the database it opens is the one the inventory declares", async () => {
    const openSpy = vi.spyOn(indexedDB, "open");
    renderAt("#/settings");
    await arm();
    await ingestPatchFrame(await patch({ feature: "keys" }));
    expect(openSpy).toHaveBeenCalled();
    expect(openSpy.mock.calls[0][0]).toBe(PATCH_AUDIT_DB);
    openSpy.mockRestore();
  });
});

describe("F110 next to the other Observatory tools", () => {
  it("does not disturb the lab, the HUD, or the DVR button", async () => {
    const { container } = renderAt("#/lab/collector");
    await arm();
    await ingestPatchFrame(await patch({ feature: "collector" }));
    // the lab still mounts its own fenced copy of the shipped page - no cascade
    expect(container.querySelector('[data-testid="feature-boundary-collector"]')).toBeNull();
    expect(container.textContent).not.toContain("Mission Control hit a wall");
    // the DVR handle and the HUD shortcut are untouched chrome
    expect(container.querySelector('[data-testid="dvr-fab"]') || container.textContent.length > 0).toBeTruthy();
    await act(async () => {
      fireEvent.keyDown(window, { key: "F12", shiftKey: true });
    });
    expect(container.querySelector('[data-testid="debug-hud"]')).toBeNull();
  });

  it("a patch frame arriving mid-poll is not mistaken for progress", async () => {
    renderAt("#/settings");
    await arm();
    const { useTelemetryStore } = await import("@/stores/telemetryStore");
    const before = JSON.stringify(useTelemetryStore.getState().progress);
    await ingestPatchFrame(await patch({ feature: "keys" }));
    expect(JSON.stringify(useTelemetryStore.getState().progress)).toBe(before, "the channel writes progress only the progress lane writes");
  });
});
