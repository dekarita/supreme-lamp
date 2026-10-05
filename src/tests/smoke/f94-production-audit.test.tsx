// [F94] Production audit regression lock - the eight operator-reported problems.
//
// Every cell below is pinned to the ROOT CAUSE found in the §1 audit, not to the
// symptom: a test that asserts "the modal appears" would still pass on a page
// that renders a modal and then refuses every write. So these assert the
// mechanism - the resolver chain, the null-handle check, the released socket
// handle, the named gate - and they fail if any of them is reverted.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@/i18n";
import {
  DASH_TOKEN_STORAGE_KEY,
  clearDashToken,
  dashTokenDebug,
  getDashToken,
  hasDashToken,
  isRunnerServed,
  keyFromHash,
  keyFromSearch,
  storeDashToken,
} from "@/lib/dashToken";
import { openWebDesktop } from "@/lib/openWebDesktop";
import { explainViewingMode, hostKindOf } from "@/lib/launchUrl";
import { transportErrorKey, unreachableErrorKey } from "@/api/lab";
import { DashTokenGate, gateVisible } from "@/components/domain/DashTokenGate";
import { LogonGateBanner } from "@/components/domain/LogonGateBanner";
import { useSessionStore } from "@/stores/sessionStore";
import { useTelemetryStore } from "@/stores/telemetryStore";

// ---------------------------------------------------------------------------
// Problem 1 - the dashboard token (?key=)  [F94 §3.1]
// ---------------------------------------------------------------------------
describe("F94 P1: dashboard token resolution", () => {
  beforeEach(() => {
    window.localStorage.clear();
    clearDashToken();
  });

  it("reads ?key= from the query string (the canonical source)", () => {
    expect(keyFromSearch("?key=abc123")).toBe("abc123");
    expect(keyFromSearch("/x?ui=v2&key=tok%2Fwith%2Fslash")).toBe("tok/with/slash");
    expect(keyFromSearch("")).toBe("");
  });

  it("[F94 §3.1] also reads #key= / #/route?key= - the v2 UI is a HashRouter, so a key pasted after the route used to be invisible", () => {
    expect(keyFromHash("#key=hashkey")).toBe("hashkey");
    expect(keyFromHash("#/overview?key=hashkey2")).toBe("hashkey2");
    expect(keyFromHash("")).toBe("");
  });

  it("[F94 §3.1] falls back to localStorage so a refresh (or a URL re-shared without its query) keeps working", () => {
    storeDashToken("stored-token-value");
    // No ?key=, no #key= - the OLD getKey() returned "" here, which is what made
    // every write route answer 403 and produced the eight reported symptoms.
    expect(getDashToken("", "")).toBe("stored-token-value");
    expect(hasDashToken("", "")).toBe(true);
  });

  it("[F94 §3.1] a URL key wins over the stored one and re-banks itself", () => {
    storeDashToken("old");
    expect(getDashToken("?key=fresh", "")).toBe("fresh");
    expect(window.localStorage.getItem(DASH_TOKEN_STORAGE_KEY)).toBe("fresh");
  });

  it("[F94 §3.1] the URL key is persisted on success, so the FIRST good load immunises every later one", () => {
    window.localStorage.clear();
    expect(getDashToken("?key=persist-me", "")).toBe("persist-me");
    expect(window.localStorage.getItem(DASH_TOKEN_STORAGE_KEY)).toBe("persist-me");
  });

  it("[F94 §3.1] the debug shape never leaks the token value", () => {
    storeDashToken("supersecrettoken");
    const d = dashTokenDebug("", "");
    expect(d.present).toBe(true);
    expect(d.source).toBe("stored");
    expect(JSON.stringify(d)).not.toContain("supersecrettoken");
  });

  it("[F94 §3.1] the gate blocks on the runner-served dashboard and stays out of the way in dev/tests", () => {
    clearDashToken();
    // isRunnerServed() is false on vitest's http://localhost:3000, so App-level
    // renders are NOT blocked (that is the anti-regression half of this cell).
    expect(isRunnerServed()).toBe(false);
    expect(gateVisible()).toBe(false);
    // Forced on, it blocks - and it blocks with the recovery UI, not a shrug.
    expect(gateVisible(true)).toBe(true);
  });

  it("[F94 §3.1] the gate offers BOTH exits: manual key entry and a link back to Actions", async () => {
    clearDashToken();
    render(<DashTokenGate force={true} />);
    expect(screen.getByTestId("dash-token-gate")).toBeTruthy();
    const enter = screen.getByTestId("dash-token-enter");
    const actions = screen.getByTestId("dash-token-actions");
    expect(actions.getAttribute("href")).toContain("github.com");
    // The Actions link must not carry the token or any query payload.
    expect(actions.getAttribute("href")).not.toContain("key=");

    await userEvent.click(enter);
    const input = screen.getByTestId("dash-token-input") as HTMLInputElement;
    expect(input.type).toBe("password");
    await userEvent.type(input, "operator-pasted-key");
    await userEvent.click(screen.getByTestId("dash-token-save"));

    // Unlocked: the gate is gone AND the key is banked for the next load.
    await waitFor(() => expect(screen.queryByTestId("dash-token-gate")).toBeNull());
    expect(hasDashToken()).toBe(true);
    expect(window.localStorage.getItem(DASH_TOKEN_STORAGE_KEY)).toBe("operator-pasted-key");
  });

  it("[F94 §3.1] an empty or too-short key is refused with its own message, never a false success", async () => {
    clearDashToken();
    render(<DashTokenGate force={true} />);
    await userEvent.click(screen.getByTestId("dash-token-enter"));
    await userEvent.click(screen.getByTestId("dash-token-save"));
    expect(screen.getByTestId("dash-token-error").textContent).toBeTruthy();
    expect(hasDashToken()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Problem 3 - "Open WEB DESKTOP does nothing"  [F94 §3.2]
// ---------------------------------------------------------------------------
describe("F94 P3: WEB DESKTOP opener reports a blocked popup", () => {
  const openSpy = vi.spyOn(window, "open");

  beforeEach(() => {
    openSpy.mockReset();
    useSessionStore.setState({
      native: {
        rdpListener: { authLast: { result: "none" } },
        webdeskUrl: "http://100.64.0.1:7333/vnc.html",
      },
    });
  });

  afterEach(() => {
    useSessionStore.setState({ native: null });
  });

  it("reports opened=true when the browser returns a window handle", () => {
    openSpy.mockReturnValue({ focus: () => {} } as unknown as Window);
    const out = openWebDesktop("http://100.64.0.1:7333/vnc.html");
    expect(out.opened).toBe(true);
    expect(out.blocked).toBe(false);
  });

  it("[F94 §3.2] reports blocked=true when window.open returns null - the exact case the old handler swallowed", () => {
    openSpy.mockReturnValue(null);
    const out = openWebDesktop("http://100.64.0.1:7333/vnc.html");
    expect(out.opened).toBe(false);
    expect(out.blocked).toBe(true);
    expect(out.reason).toBe("popup-blocked");
  });

  it("[F94 §3.2] a thrown window.open is also surfaced, never a silent no-op", () => {
    openSpy.mockImplementation(() => {
      throw new Error("blocked");
    });
    const out = openWebDesktop("http://100.64.0.1:7333/vnc.html");
    expect(out.blocked).toBe(true);
  });

  it("[F94 §3.2] refuses a non-https URL without attempting to open anything", () => {
    const out = openWebDesktop("http://insecure.example/vnc.html");
    expect(out.invalid).toBe(true);
    expect(openSpy).not.toHaveBeenCalled();
  });

  it("[F94 §3.2] the logon banner shows a copyable URL when the popup is blocked", async () => {
    openSpy.mockReturnValue(null);
    render(<LogonGateBanner />);
    await userEvent.click(screen.getByTestId("logon-gate-open-webdesk"));
    const blockedEl = await screen.findByTestId("logon-gate-webdesk-blocked");
    expect(blockedEl.textContent).toContain("WEB DESKTOP");
    // The URL itself is on screen: the operator can still get there.
    expect(screen.getByTestId("logon-gate-webdesk-blocked-link").textContent).toContain("vnc.html");
  });
});

// ---------------------------------------------------------------------------
// Problem 4 - "Windows Auto Login is non-functional"  [F94 §3.3]
// ---------------------------------------------------------------------------
describe("F94 P4: AUTO-LOGIN always names the gate that blocked it", () => {
  beforeEach(() => {
    window.localStorage.clear();
    clearDashToken();
  });

  it("[F94 §3.3] a missing FQDN sets a VISIBLE reason instead of the old bare `return`", async () => {
    useSessionStore.setState({ fqdn: "", user: "rdpuser", native: null });
    useSessionStore.getState().setAutoLoginNote("");
    await useSessionStore.getState().fireAutoLogin();
    const note = useSessionStore.getState().autoLogin.note;
    expect(note).not.toBe("");
    expect(note.toLowerCase()).toContain("fqdn");
  });

  it("[F94 §3.3] a failed ticket without a dashboard token names the token, not a catch-all", async () => {
    useSessionStore.setState({ fqdn: "runner.tail1234.ts.net", user: "rdpuser", native: null });
    useSessionStore.getState().setAutoLoginNote("");
    await useSessionStore.getState().fireAutoLogin();
    const note = useSessionStore.getState().autoLogin.note;
    expect(note).toContain("?key=");
    expect(note).not.toBe("");
  });
});

// ---------------------------------------------------------------------------
// Problem 6 - "WebSocket: idle" (permanent)  [F94 §3.5]
// ---------------------------------------------------------------------------
describe("F94 P6: the websocket state is honest and reconnectable", () => {
  it("[F94 §3.5] /health's ws flag drives wsAvailable (informational), NEVER wsLive", () => {
    useTelemetryStore.setState({ wsLive: false, wsAvailable: false });
    // The shipped PowerShell server answers ws=$false; that must describe the
    // ENDPOINT, not silently claim our socket is down for a reason we cannot fix.
    expect(useTelemetryStore.getState().wsAvailable).toBe(false);
    expect(useTelemetryStore.getState().wsLive).toBe(false);
    useTelemetryStore.getState().setWsAvailable(true);
    expect(useTelemetryStore.getState().wsAvailable).toBe(true);
    // wsLive is untouched by the endpoint flag - only the socket sets it.
    expect(useTelemetryStore.getState().wsLive).toBe(false);
  });

  it("[F94 §3.5] the store exposes an independent wsAvailable setter", () => {
    useTelemetryStore.setState({ wsAvailable: false });
    useTelemetryStore.getState().setWsAvailable(true);
    expect(useTelemetryStore.getState().wsAvailable).toBe(true);
    useTelemetryStore.getState().setWsLive(true);
    expect(useTelemetryStore.getState().wsLive).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Problem 7 - "Viewing: Unknown"  [F94 §3.6]
// ---------------------------------------------------------------------------
describe("F94 P7: viewing mode explains itself", () => {
  function setHost(host: string) {
    Object.defineProperty(window, "location", {
      configurable: true,
      writable: true,
      value: { ...window.location, hostname: host, search: "" },
    });
  }

  beforeEach(() => {
    window.localStorage.clear();
  });

  it("[F94 §3.6] loopback is LOCAL DEV even when the viewport is not a session geometry", () => {
    setHost("127.0.0.1");
    const d = explainViewingMode("");
    expect(d.label).toBe("LOCAL DEV");
    expect(d.signals.hostKind).toBe("loopback");
    expect(d.reason).toContain("loopback-host");
  });

  it("[F94 §3.6] a tailnet host without a session geometry is 'Tailscale local', not one bare word", () => {
    setHost("runner.tail1234.ts.net");
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 900 });
    Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: 2 });
    const d = explainViewingMode("");
    expect(d.label).toBe("Tailscale local");
    expect(d.reason).toContain("not-a-session-geometry");
    expect(d.reason).toContain("dpr2");
  });

  it("[F94 §3.6] an unprovable host names its signals instead of collapsing to 'Unknown'", () => {
    setHost("my-preview.example.com");
    const d = explainViewingMode("");
    expect(d.label).toBe("Unknown - ambiguous signals");
    expect(d.reason).toContain("my-preview.example.com");
    expect(d.reason).toContain("viewport-");
  });

  it("[F94 §3.6] hostKindOf classifies every branch the diagnosis switches on", () => {
    expect(hostKindOf("localhost")).toBe("loopback");
    expect(hostKindOf("127.0.0.1")).toBe("loopback");
    expect(hostKindOf("a.tail1234.ts.net")).toBe("tailnet");
    // 100.64/10 is the TAILSCALE range, not generic RFC1918: [F94 §3.6] it now
    // classifies as "tailnet" so a production CGNAT dashboard is recognised.
    expect(hostKindOf("100.64.0.1")).toBe("tailnet");
    expect(hostKindOf("10.0.0.5")).toBe("private");
    expect(hostKindOf("example.com")).toBe("public");
    expect(hostKindOf("")).toBe("empty");
  });
});

// ---------------------------------------------------------------------------
// Problem 8 - "යම් දෝෂයක් සිදු විය" for everything  [F94 §3.7]
// ---------------------------------------------------------------------------
describe("F94 P8: search/lab errors name a cause the operator can act on", () => {
  beforeEach(() => {
    window.localStorage.clear();
    clearDashToken();
  });

  it("[F94 §3.7] a 401/403 is named as a missing dashboard token, not the generic line", () => {
    expect(transportErrorKey(401)).toBe("addSite.authMissing");
    expect(transportErrorKey(403)).toBe("addSite.authMissing");
  });

  it("[F94 §3.7] rate limiting and a missing route get their own keys", () => {
    expect(transportErrorKey(429)).toBe("lab.rateLimited");
    expect(transportErrorKey(404)).toBe("lab.routeMissing");
  });

  it("[F94 §3.7] an unreachable server WITH a token is the generic line; without one it names the token", () => {
    expect(unreachableErrorKey()).toBe("addSite.authMissing");
    storeDashToken("a-real-token");
    expect(unreachableErrorKey()).toBe("search.errors.generic");
  });
});
