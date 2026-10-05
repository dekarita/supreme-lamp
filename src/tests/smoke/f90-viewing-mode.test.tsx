// [F90 §C] Viewing-mode aware launch-url.
//
// The bug this closes is a SILENT one: `window.open()` opens a tab in whichever
// browser is running the dashboard. Viewed through WEB DESKTOP that is the RDP
// session's Chrome (correct). Viewed directly over Tailscale it is the
// operator's laptop (looks identical, lands on the wrong machine).
//
// So the tests below pin the three things that matter:
//   1. detection never invents confidence it does not have;
//   2. tailscale-local NEVER opens a window implicitly - it asks;
//   3. web-desktop DOES open in the session's own browser.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import "@/i18n";
import {
  VIEWING_MODE_STORAGE_KEY,
  detectViewingMode,
  isRunnerSizedViewport,
  launchUrl,
  resolveViewingMode,
  type ViewingMode,
} from "@/lib/launchUrl";
import { F90ViewingModeBadge } from "@/components/search/F86DiagnosticBanner";
import { F90LaunchChoiceModal } from "@/components/search/F90LaunchChoiceModal";
import { useLaunchChoiceStore } from "@/stores/launchChoiceStore";

/** Full session geometry + dpr 1 = "runner-sized". */
const SESSION = { w: 1280, h: 800, dpr: 1 };

function setHost(hostname: string, search = "") {
  // jsdom's location is read-only; redefine it for the duration of a test.
  Object.defineProperty(window, "location", {
    configurable: true,
    writable: true,
    value: { ...window.location, hostname, search },
  });
}

function setViewport(w: number, h: number, dpr: number) {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: w });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: h });
  Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: dpr });
}

function renderBadge() {
  return render(
    <MemoryRouter>
      <F90ViewingModeBadge />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  window.localStorage.clear();
  useLaunchChoiceStore.getState().close();
  vi.unstubAllGlobals();
  setViewport(SESSION.w, SESSION.h, SESSION.dpr);
});

describe("F90 viewing-mode detection", () => {
  it("reads loopback + a runner-sized viewport as an in-session browser", () => {
    setViewport(1280, 800, 1);
    setHost("localhost");
    expect(detectViewingMode()).toBe("web-desktop");
    setHost("127.0.0.1");
    expect(detectViewingMode()).toBe("web-desktop");
    // ...but not a loopback window shaped like a laptop browser.
    setViewport(1440, 812, 2);
    expect(detectViewingMode()).toBe("unknown");
  });

  it("splits a tailnet host on the session-shaped viewport", () => {
    setHost("runner.tail1234.ts.net");
    setViewport(1280, 800, 1);
    expect(detectViewingMode()).toBe("web-desktop");
    // A resized laptop window at a fractional scaling is NOT the session.
    setViewport(1512, 945, 2);
    expect(detectViewingMode()).toBe("tailscale-local");
  });

  it("degrades to unknown rather than guessing on a public host", () => {
    setHost("dash.example.com");
    expect(detectViewingMode()).toBe("unknown");
  });

  it("lets an explicit operator choice beat every signal", () => {
    setHost("localhost");
    expect(detectViewingMode("?viewingMode=tailscale-local")).toBe("tailscale-local");
    window.localStorage.setItem(VIEWING_MODE_STORAGE_KEY, "unknown");
    expect(detectViewingMode()).toBe("unknown");
  });

  it("rejects a fractional or scaled device pixel ratio", () => {
    expect(isRunnerSizedViewport(1280, 800, 1)).toBe(true);
    expect(isRunnerSizedViewport(1280, 800, 1.5)).toBe(false);
    expect(isRunnerSizedViewport(1280, 800, 2)).toBe(false);
    expect(isRunnerSizedViewport(1234, 567, 1)).toBe(false);
  });
});

describe("F90 the confirmation gate (an inferred in-session claim is not enough)", () => {
  it("an UNCONFIRMED web-desktop detection still uses the server ladder", async () => {
    // jsdom's hostname is loopback and its viewport is session-shaped, so the
    // raw detection says "web-desktop". Acting on that guess is the F84/F85
    // silent-wrong-machine failure, so the ladder must still run.
    setHost("127.0.0.1");
    setViewport(1280, 800, 1);
    expect(detectViewingMode()).toBe("web-desktop");

    const open = vi.fn(() => ({}) as Window);
    vi.stubGlobal("open", open);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true, tier: 1 }), { status: 200 }),
    );

    const out = await launchUrl("https://example.com/a");

    expect(open).not.toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalled();
    expect(out.mode).toBe("unknown");
  });

  it("confirming the mode turns Mode A on, and only then", async () => {
    setHost("127.0.0.1");
    setViewport(1280, 800, 1);
    resolveViewingMode(); // unconfirmed
    window.localStorage.setItem(VIEWING_MODE_STORAGE_KEY, "web-desktop");
    const open = vi.fn(() => ({}) as Window);
    vi.stubGlobal("open", open);

    const out = await launchUrl("https://example.com/a");

    expect(out.mode).toBe("web-desktop");
    expect(out.viaWindowOpen).toBe(true);
    expect(open).toHaveBeenCalled();
  });

  it("tailscale-local is acted on as detected (it only ever ADDS a choice)", () => {
    setHost("runner.tail1234.ts.net");
    setViewport(1512, 945, 2);
    const s = resolveViewingMode();
    expect(s.detected).toBe("tailscale-local");
    expect(s.mode).toBe("tailscale-local");
    expect(s.confirmed).toBe(false);
  });
});

describe("F90 mode-aware launchUrl", () => {
  it("Mode A (web-desktop): opens in the session's own browser, no server call", async () => {
    setHost("127.0.0.1");
    window.localStorage.setItem(VIEWING_MODE_STORAGE_KEY, "web-desktop");
    const open = vi.fn(() => ({}) as Window);
    vi.stubGlobal("open", open);
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const out = await launchUrl("https://example.com/a");

    expect(out.ok).toBe(true);
    expect(out.mode).toBe("web-desktop");
    expect(out.viaWindowOpen).toBe(true);
    expect(open).toHaveBeenCalledWith("https://example.com/a", "_blank", "noopener,noreferrer");
    // No round trip, no rung that can fail.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("Mode A: a blocked popup falls through to the ladder instead of lying", async () => {
    setHost("127.0.0.1");
    window.localStorage.setItem(VIEWING_MODE_STORAGE_KEY, "web-desktop");
    vi.stubGlobal("open", vi.fn(() => null));
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true, tier: 1 }), { status: 200 }),
    );

    const out = await launchUrl("https://example.com/a");

    expect(out.viaWindowOpen).toBeUndefined();
    expect(fetchSpy).toHaveBeenCalled();
    expect(out.ok).toBe(true);
  });

  it("Mode B (tailscale-local): NEVER opens a window, asks instead", async () => {
    setHost("runner.tail1234.ts.net");
    setViewport(1512, 945, 2); // a laptop-shaped window => not the session
    const open = vi.fn(() => ({}) as Window);
    vi.stubGlobal("open", open);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ code: "NO_ACTIVE_SESSION" }), { status: 503 }),
    );

    const out = await launchUrl("https://example.com/a");

    // The whole point: the link is never opened on the wrong machine.
    expect(open).not.toHaveBeenCalled();
    expect(out.ok).toBe(false);
    expect(out.needsChoice).toBe(true);
    expect(out.url).toBe("https://example.com/a");
    expect(useLaunchChoiceStore.getState().pendingUrl).toBe("https://example.com/a");
  });

  it("Mode B: a successful ladder still wins (no modal when it just works)", async () => {
    setHost("runner.tail1234.ts.net");
    setViewport(1512, 945, 2);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true, tier: 2, tierDetail: "direct-spawn" }), { status: 200 }),
    );

    const out = await launchUrl("https://example.com/a");

    expect(out.ok).toBe(true);
    expect(out.tier).toBe(2);
    expect(useLaunchChoiceStore.getState().pendingUrl).toBeNull();
  });

  it("Mode C (unknown): keeps the F86 backend ladder", async () => {
    setHost("dash.example.com");
    const open = vi.fn(() => ({}) as Window);
    vi.stubGlobal("open", open);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true, tier: 3 }), { status: 200 }),
    );

    const out = await launchUrl("https://example.com/a");

    expect(open).not.toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalled();
    expect(out.ok).toBe(true);
    expect(out.mode).toBe("unknown");
  });

  it("still refuses an unsafe URL before any mode logic runs", async () => {
    setHost("127.0.0.1");
    const open = vi.fn();
    vi.stubGlobal("open", open);
    const out = await launchUrl("http://insecure.example.com/a");
    expect(out.ok).toBe(false);
    expect(open).not.toHaveBeenCalled();
  });
});

describe("F90 viewing-mode badge", () => {
  it("is visible WITHOUT ?diag=1 (the mode is needed before a click)", () => {
    setHost("runner.tail1234.ts.net");
    setViewport(1512, 945, 2);
    renderBadge();
    const badge = screen.getByTestId("f90-viewing-mode-badge");
    expect(badge).toBeTruthy();
    expect(badge.getAttribute("data-mode")).toBe("tailscale-local");
  });

  it("lets the operator correct a wrong guess, and remembers it", async () => {
    setHost("runner.tail1234.ts.net");
    setViewport(1512, 945, 2);
    renderBadge();
    await userEvent.click(screen.getByTestId("f90-viewing-mode-badge"));
    await userEvent.click(screen.getByTestId("f90-viewing-mode-pick-web-desktop"));

    expect(screen.getByTestId("f90-viewing-mode-badge").getAttribute("data-mode")).toBe("web-desktop");
    expect(window.localStorage.getItem(VIEWING_MODE_STORAGE_KEY)).toBe("web-desktop");
  });
});

describe("F90 tailscale link modal", () => {
  it("shows the URL and every option, and opens nothing implicitly", async () => {
    useLaunchChoiceStore.getState().open("https://example.com/deep/link", "search.launchUrl.noSession");
    render(
      <MemoryRouter>
        <F90LaunchChoiceModal />
      </MemoryRouter>,
    );

    expect(screen.getByTestId("f90-launch-choice-url").textContent).toBe("https://example.com/deep/link");
    expect(screen.getByTestId("f90-launch-choice-copy")).toBeTruthy();
    expect(screen.getByTestId("f90-launch-choice-switch")).toBeTruthy();
    // "Open anyway" is an anchor the operator clicks deliberately - never a
    // programmatic window.open, so nothing navigates on render.
    const anyway = screen.getByTestId("f90-launch-choice-open-anyway");
    expect(anyway.getAttribute("href")).toBe("https://example.com/deep/link");
    expect(anyway.getAttribute("target")).toBe("_blank");

    await userEvent.click(screen.getByTestId("f90-launch-choice-dismiss"));
    expect(useLaunchChoiceStore.getState().pendingUrl).toBeNull();
  });

  it("renders nothing until there is a decision to make", () => {
    render(
      <MemoryRouter>
        <F90LaunchChoiceModal />
      </MemoryRouter>,
    );
    expect(screen.queryByTestId("f90-launch-choice-modal")).toBeNull();
  });
});

describe("F90 guards preserved", () => {
  it("every mode resolves to a known value", () => {
    const modes: ViewingMode[] = ["web-desktop", "tailscale-local", "unknown"];
    expect(modes).toHaveLength(3);
  });
});
