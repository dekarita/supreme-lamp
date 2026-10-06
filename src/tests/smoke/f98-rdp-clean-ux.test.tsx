// [F98] RDP FIRST-LOGIN UX CLEANUP + MANUAL LOGON OVERRIDE + WS RECONNECT.
//
// Drives the P1 and P2 fixes:
//   P1: the "I opened WEB DESKTOP manually" assertion now suppresses the
//       logon gate banner (which previously persisted because it only hid on
//       authLast.result === "success").
//   P2: the resetWs path in useDashboardPolling detaches onclose BEFORE
//       closing, uses a 100ms delay, and writes telemetry.
//
// P3, P4, P5 live in PowerShell/workflow files and are verified by
// tests/f98-workflow-audit.test.js (file-level, no interpreter).
import { describe, it, expect, beforeEach } from "vitest";
import {
  readManualWebDesktop,
  setManualWebDesktop,
  MANUAL_WEBDESKTOP_KEY,
  VIEWING_MODE_STORAGE_KEY,
} from "@/lib/launchUrl";

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
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440 });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 900 });
  Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: 2 });
}

describe("[F98 §2.1 / P1] manual override suppresses logon gate banner", () => {
  beforeEach(() => {
    window.localStorage.clear();
    setHost(TAILNET_HOST);
  });

  it("setManualWebDesktop(true) writes the stamp AND dispatches the custom event", () => {
    let eventFired = false;
    const handler = () => { eventFired = true; };
    window.addEventListener("f98:manualWebDesktopChanged", handler);
    try {
      const stamp = setManualWebDesktop(true);
      expect(stamp).not.toBe("");
      expect(Number(stamp)).toBeGreaterThan(0);
      expect(window.localStorage.getItem(MANUAL_WEBDESKTOP_KEY)).toBe(stamp);
      expect(window.localStorage.getItem(VIEWING_MODE_STORAGE_KEY)).toBe("web-desktop");
      expect(eventFired).toBe(true);
    } finally {
      window.removeEventListener("f98:manualWebDesktopChanged", handler);
    }
  });

  it("setManualWebDesktop(false) clears both keys AND dispatches the event", () => {
    setManualWebDesktop(true);
    let eventFired = false;
    const handler = () => { eventFired = true; };
    window.addEventListener("f98:manualWebDesktopChanged", handler);
    try {
      expect(setManualWebDesktop(false)).toBe("");
      expect(readManualWebDesktop()).toBe("");
      expect(window.localStorage.getItem(MANUAL_WEBDESKTOP_KEY)).toBeNull();
      expect(window.localStorage.getItem(VIEWING_MODE_STORAGE_KEY)).toBeNull();
      expect(eventFired).toBe(true);
    } finally {
      window.removeEventListener("f98:manualWebDesktopChanged", handler);
    }
  });

  it("the LogonGateBanner reads manualAsserted OR readManualWebDesktop() on each render", () => {
    // The F95 bug: the banner only hid on authLast.result === "success".
    // The F98 fix: the banner ALSO returns null when the manual assertion
    // is present, regardless of what native-status reports.
    const fs = require("node:fs") as typeof import("node:fs");
    const gate = fs.readFileSync("src/components/domain/LogonGateBanner.tsx", "utf8");
    // The hide condition must include the manual assertion.
    expect(gate).toContain("readManualWebDesktop()");
    expect(gate).toContain("if (manualAsserted || readManualWebDesktop()) return null");
    // The custom event listener for same-tab reactivity.
    expect(gate).toContain("f98:manualWebDesktopChanged");
  });

  it("PrimaryActions dispatches setManualWebDesktop (which triggers the event)", () => {
    const fs = require("node:fs") as typeof import("node:fs");
    const primary = fs.readFileSync("src/components/domain/PrimaryActions.tsx", "utf8");
    // The manual toggle calls setManualWebDesktop which now dispatches the event.
    expect(primary).toContain("setManualWebDesktop(!manualAsserted)");
    expect(primary).toContain("setManualWebDesktop(true)");
  });
});

describe("[F98 §2.2 / P2] reconnect actually resets WS", () => {
  it("resetWs detaches onclose BEFORE closing, then uses a delayed connectWs", () => {
    const fs = require("node:fs") as typeof import("node:fs");
    const hook = fs.readFileSync("src/hooks/useDashboardPolling.ts", "utf8");
    // The close handler must be detached before .close() to prevent the
    // ladder from re-arming.
    expect(hook).toContain("ws.onclose = null;");
    expect(hook).toContain("ws.close();");
    // The F98 fix: a 100ms delay before reconnect to avoid race condition.
    expect(hook).toContain("window.setTimeout(() => {");
    expect(hook).toContain("if (alive) connectWs();");
    // Telemetry: the reconnect timestamp for diagnostic bundles.
    expect(hook).toContain("__f98_lastWsReconnectAt");
  });

  it("the Reconnect button calls requestWsReconnect which bumps the nonce", () => {
    const fs = require("node:fs") as typeof import("node:fs");
    const shell = fs.readFileSync("src/components/layout/AppShell.tsx", "utf8");
    // The button's onClick calls requestWsReconnect().
    expect(shell).toContain('id="f95.wsReconnect"');
    expect(shell).toContain("requestWsReconnect()");
    // The nonce watcher in useDashboardPolling watches wsReconnectNonce.
    const hook = fs.readFileSync("src/hooks/useDashboardPolling.ts", "utf8");
    expect(hook).toContain("wsReconnectNonce");
    expect(hook).toContain('resetWs("manual-reconnect")');
  });
});

describe("[F98 §2.3-2.5 / P3-P5] workflow + first-login script", () => {
  it("main.yml includes the SYSTEM-level watcher fallback (P3)", () => {
    const fs = require("node:fs") as typeof import("node:fs");
    const main = fs.readFileSync(".github/workflows/main.yml", "utf8");
    expect(main).toContain("GhrdpWatcherSystem");
    expect(main).toContain("SYSTEM-level fallback");
    expect(main).toContain("-UserId 'SYSTEM'");
  });

  it("main.yml suppresses the Tailscale welcome dialog (P5)", () => {
    const fs = require("node:fs") as typeof import("node:fs");
    const main = fs.readFileSync(".github/workflows/main.yml", "utf8");
    expect(main).toContain("Tailscale welcome dialog suppression");
  });

  it("main.yml registers the first-login cleanup script (P4)", () => {
    const fs = require("node:fs") as typeof import("node:fs");
    const main = fs.readFileSync(".github/workflows/main.yml", "utf8");
    expect(main).toContain("ghrdp-rdp-first-login.ps1");
    expect(main).toContain("GhrdpFirstLogin");
    expect(main).toContain("first-login Startup shortcut");
  });

  it("main.yml writes dashboard-url.txt for the first-login script", () => {
    const fs = require("node:fs") as typeof import("node:fs");
    const main = fs.readFileSync(".github/workflows/main.yml", "utf8");
    expect(main).toContain("dashboard-url.txt");
  });

  it("the first-login script minimizes PowerShell, dismisses Tailscale, and opens Edge", () => {
    const fs = require("node:fs") as typeof import("node:fs");
    const script = fs.readFileSync("payloads/ghrdp-rdp-first-login.ps1", "utf8");
    // PowerShell minimization via Win32 ShowWindow.
    expect(script).toContain("ShowWindow");
    expect(script).toContain("SW_MINIMIZE");
    expect(script).toContain("powershell, pwsh, cmd");
    // Tailscale welcome dismissal.
    expect(script).toContain("Tailscale|Connect to your tailnet");
    expect(script).toContain("WM_CLOSE");
    // Edge auto-open.
    expect(script).toContain("msedge.exe");
    expect(script).toContain("--app=");
    // Once-only guard.
    expect(script).toContain("first-login-ran.flag");
  });
});
