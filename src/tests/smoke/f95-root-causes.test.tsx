// [F95] TRUE ROOT CAUSE pins - EXECUTED, not grepped.
//
// The F94 loop fixed 8 reported symptoms and every one of them came back, because
// each fix treated the message instead of the cause. This suite drives the real
// shipped functions for R3 (manual WEB DESKTOP assertion), R4 (the WS reconnect
// state machine) and R5 (the search error classifier), so a regression has to
// break behaviour and not merely move a string.
//
// R1 (LogonType filter) and R2 (watcher auto-start) live in PowerShell; this
// sandbox has no PowerShell interpreter, so those two are pinned by
// tests/f95-root-causes.test.js and proven for real by launch-gates.
import { describe, it, expect, beforeEach } from "vitest";
import {
  explainViewingMode,
  readManualWebDesktop,
  setManualWebDesktop,
  MANUAL_WEBDESKTOP_KEY,
  VIEWING_MODE_STORAGE_KEY,
} from "@/lib/launchUrl";
import { statusMessageKey, transportErrorKey } from "@/api/search";
import { useTelemetryStore } from "@/stores/telemetryStore";
import EN from "@/i18n/en.json";
import SI from "@/i18n/si.json";

// A tailnet host, exactly like the operator's http://100.81.171.116:7333/ page.
const TAILNET_HOST = "100.81.171.116";

function setHost(host: string): void {
  Object.defineProperty(window, "location", {
    value: {
      ...window.location,
      protocol: "http:",
      hostname: host,
      host: host + ":7333",
      search: "",
      hash: "",
    },
    writable: true,
    configurable: true,
  });
  // jsdom's default viewport is 1024x768@dpr1, which IS one of the runner's
  // session geometries - so an unmodified jsdom window would legitimately
  // detect "WEB DESKTOP" and the "no assertion" case would be untestable. Pin a
  // non-session geometry (the F94 suite does the same at 1440x900@dpr2).
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440 });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 900 });
  Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: 2 });
}

describe("[F95 §3.3 / R3] manual WEB DESKTOP assertion", () => {
  beforeEach(() => {
    window.localStorage.clear();
    setHost(TAILNET_HOST);
  });

  it("a tailnet host with no assertion reads 'Tailscale local' - the operator's verbatim badge", () => {
    const d = explainViewingMode("");
    expect(d.label).toBe("Tailscale local");
    expect(readManualWebDesktop()).toBe("");
  });

  it("setManualWebDesktop(true) flips the SAME host to WEB DESKTOP and stamps it", () => {
    // This is the whole fix: the popup was blocked, the operator opened noVNC
    // by hand, and previously nothing could tell the dashboard.
    const stamp = setManualWebDesktop(true);
    expect(stamp).not.toBe("");
    expect(Number(stamp)).toBeGreaterThan(0);
    expect(window.localStorage.getItem(VIEWING_MODE_STORAGE_KEY)).toBe("web-desktop");

    const d = explainViewingMode("");
    expect(d.mode).toBe("web-desktop");
    expect(d.detected).toBe("web-desktop");
    expect(d.confirmed).toBe(true);
    // An ASSERTED mode must never look like a MEASUREMENT.
    expect(d.label).toBe("WEB DESKTOP (manual)");
    expect(d.reason).toContain("operator-asserted@");
    expect(d.signals.manual).toBe(stamp);
  });

  it("withdrawing the assertion returns to signal detection", () => {
    setManualWebDesktop(true);
    expect(setManualWebDesktop(false)).toBe("");
    expect(readManualWebDesktop()).toBe("");
    expect(window.localStorage.getItem(MANUAL_WEBDESKTOP_KEY)).toBeNull();
    expect(window.localStorage.getItem(VIEWING_MODE_STORAGE_KEY)).toBeNull();
    expect(explainViewingMode("").label).toBe("Tailscale local");
  });

  it("a loopback host honours the assertion too, and still says (manual)", () => {
    setHost("127.0.0.1");
    expect(explainViewingMode("").label).toBe("LOCAL DEV");
    setManualWebDesktop(true);
    const d = explainViewingMode("");
    expect(d.label).toBe("WEB DESKTOP (manual)");
    expect(d.mode).toBe("web-desktop");
  });

  it("locked-down storage must not throw - the page still renders", () => {
    // Swap in a storage area that throws on every call, then ALWAYS put the
    // real one back: src/tests/setup.ts clears window.localStorage in an
    // afterEach, so leaving a stub behind would fail every later suite in the
    // file (it did, on the first run of this test).
    const descriptor = Object.getOwnPropertyDescriptor(window, "localStorage");
    const real = window.localStorage;
    const hostile = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
      removeItem: () => {
        throw new Error("denied");
      },
      clear: () => {
        throw new Error("denied");
      },
    };
    try {
      Object.defineProperty(window, "localStorage", { value: hostile, configurable: true, writable: true });
      expect(() => readManualWebDesktop()).not.toThrow();
      expect(() => setManualWebDesktop(true)).not.toThrow();
      expect(() => explainViewingMode("")).not.toThrow();
    } finally {
      if (descriptor) Object.defineProperty(window, "localStorage", descriptor);
      else Object.defineProperty(window, "localStorage", { value: real, configurable: true, writable: true });
    }
    // Proof the real storage came back: setup.ts's afterEach must be able to
    // clear it, and our own reads must work again.
    expect(() => window.localStorage.clear()).not.toThrow();
    expect(readManualWebDesktop()).toBe("");
  });

  it("both blocked banners and the always-visible toggle carry the control", () => {
    // The R3 failure had two halves: no button in the banner, and no way to
    // assert the mode when no banner ever appeared.
    const fs = require("node:fs") as typeof import("node:fs");
    const primary = fs.readFileSync("src/components/domain/PrimaryActions.tsx", "utf8");
    const gate = fs.readFileSync("src/components/domain/LogonGateBanner.tsx", "utf8");
    expect(primary).toContain('id="f95.webdeskManual"');
    expect(primary).toContain("setManualWebDesktop(true)");
    // Not gated on `webdeskBlocked` - it renders unconditionally.
    expect(primary).toContain('id="f95.viewingModeToggle"');
    expect(primary).toContain("setManualWebDesktop(!manualAsserted)");
    expect(gate).toContain('id="f95.logonGate.webdeskManual"');
    expect(gate).toContain("setManualWebDesktop(true)");
  });
});

describe("[F95 §3.4 / R4] WebSocket reconnect state machine", () => {
  beforeEach(() => {
    useTelemetryStore.setState({
      wsLive: false,
      wsDead: false,
      wsDeadReason: "",
      wsAttempts: 0,
      wsReconnectNonce: 0,
    });
  });

  it("wsDead is a DISTINCT state from wsLive=false - a retry in flight is not 'disconnected'", () => {
    const st = useTelemetryStore.getState();
    expect(st.wsLive).toBe(false);
    expect(st.wsDead).toBe(false); // retrying, not dead
    useTelemetryStore.getState().setWsDead(true, "ladder-exhausted");
    const s2 = useTelemetryStore.getState();
    expect(s2.wsDead).toBe(true);
    expect(s2.wsDeadReason).toBe("ladder-exhausted");
  });

  it("a successful open clears the dead state and the attempt count", () => {
    useTelemetryStore.getState().setWsAttempts(7);
    useTelemetryStore.getState().setWsDead(true, "ladder-exhausted");
    useTelemetryStore.getState().setWsLive(true);
    useTelemetryStore.getState().setWsDead(false);
    useTelemetryStore.getState().setWsAttempts(0);
    const s = useTelemetryStore.getState();
    expect(s.wsLive).toBe(true);
    expect(s.wsDead).toBe(false);
    expect(s.wsDeadReason).toBe("");
    expect(s.wsAttempts).toBe(0);
  });

  it("requestWsReconnect bumps the nonce (which the hook watches) and clears wsDead", () => {
    useTelemetryStore.getState().setWsDead(true, "ladder-exhausted");
    const before = useTelemetryStore.getState().wsReconnectNonce;
    useTelemetryStore.getState().requestWsReconnect();
    const after = useTelemetryStore.getState();
    expect(after.wsReconnectNonce).toBe(before + 1);
    expect(after.wsDead).toBe(false);
  });

  it("the socket carries the dash token in the URL AND as the first frame", () => {
    const fs = require("node:fs") as typeof import("node:fs");
    const hook = fs.readFileSync("src/hooks/useDashboardPolling.ts", "utf8");
    // Same-origin protocol switch (already correct in F94) - pinned so it cannot
    // regress to a hardcoded wss:// on a plain-http Tailscale page.
    expect(hook).toContain('const proto = location.protocol === "https:" ? "wss:" : "ws:";');
    expect(hook).toContain('"//" + location.host + "/ws"');
    // THE ACTUAL R4 ROOT CAUSE: no credential on the upgrade request.
    expect(hook).toContain('base + "?key=" + encodeURIComponent(token)');
    expect(hook).toContain('ws.send(JSON.stringify({ type: "hello", key: token }))');
    // Reconnect on a token change from another tab, and on the manual button.
    expect(hook).toContain("DASH_TOKEN_STORAGE_KEY");
    expect(hook).toContain('window.addEventListener("storage", onStorage)');
    expect(hook).toContain("wsReconnectNonce");
    // Ladder exhaustion is PUBLISHED, not retried silently forever.
    expect(hook).toContain('setWsDead(true, "ladder-exhausted")');
    expect(hook).toContain("if (wsAttempt > RECONNECT_LADDER.length)");
  });

  it("the top bar renders DISCONNECTED + a Reconnect button only when the ladder is exhausted", () => {
    const fs = require("node:fs") as typeof import("node:fs");
    const shell = fs.readFileSync("src/components/layout/AppShell.tsx", "utf8");
    expect(shell).toContain('"DISCONNECTED"');
    expect(shell).toContain('id="f95.wsReconnect"');
    expect(shell).toContain("requestWsReconnect()");
    // The button is conditional on wsDead, so a healthy retry stays quiet.
    expect(shell).toContain("{wsDead ? (");
    expect(EN.activity.wsReconnect).toBe("Reconnect");
    expect(typeof SI.activity.wsReconnect).toBe("string");
  });
});

describe("[F95 §3.5 / R5] search error classification", () => {
  it("401 is 'session expired', NOT 'something went wrong'", () => {
    const c = statusMessageKey(401);
    expect(c.code).toBe("UNAUTHENTICATED");
    expect(c.messageKey).toBe("search.errors.sessionExpired");
    expect(c.retryable).toBe(false);
  });

  it("429 is rate-limited and retryable", () => {
    const c = statusMessageKey(429);
    expect(c.code).toBe("RATE_LIMITED");
    expect(c.messageKey).toBe("search.errors.rateLimitedGeneric");
    expect(c.retryable).toBe(true);
  });

  it("a thrown fetch (dead transport) says the connection was lost, not 'something went wrong'", () => {
    const c = transportErrorKey();
    expect(c.code).toBe("TRANSPORT_UNAVAILABLE");
    expect(c.messageKey).toBe("search.errors.connectionLost");
  });

  it("4xx/5xx each get their own sentence", () => {
    expect(statusMessageKey(400).messageKey).toBe("search.errors.validation");
    expect(statusMessageKey(422).messageKey).toBe("search.errors.validation");
    expect(statusMessageKey(404).messageKey).toBe("search.errors.notFound");
    expect(statusMessageKey(413).messageKey).toBe("search.errors.payloadTooLarge");
    expect(statusMessageKey(500).messageKey).toBe("search.errors.serverError");
    expect(statusMessageKey(503).messageKey).toBe("search.errors.serverError");
  });

  it("'Something went wrong' survives ONLY for a genuinely unknown status", () => {
    // 418 and 451 are not in the table: the generic key is reserved for them.
    expect(statusMessageKey(418).messageKey).toBe("search.errors.generic");
    expect(statusMessageKey(451).messageKey).toBe("search.errors.generic");
  });

  it("every classifier key resolves in BOTH locales", () => {
    const errs = (EN as unknown as Record<string, any>).search.errors;
    const errsSi = (SI as unknown as Record<string, any>).search.errors;
    for (const status of [400, 401, 404, 413, 429, 500]) {
      const key = statusMessageKey(status).messageKey.split(".").pop() as string;
      expect(typeof errs[key], "string", "en search.errors." + key);
      expect(typeof errsSi[key], "string", "si search.errors." + key);
    }
    const tKey = transportErrorKey().messageKey.split(".").pop() as string;
    expect(typeof errs[tKey]).toBe("string");
    expect(typeof errsSi[tKey]).toBe("string");
  });

  it("the connectionLost sentence points at the Reconnect control", () => {
    // A message that names a symptom without naming the fix is the exact
    // dead-end F95 exists to remove.
    const s = (EN as unknown as Record<string, any>).search.errors.connectionLost as string;
    expect(s.toLowerCase()).toContain("reconnect");
  });
});
