// [R-UX / #214 §10] The responsive shell's acceptance cells, in jsdom.
//
// jsdom cannot prove a blur or a 44px box (no layout engine), so everything
// here is the part that IS provable without a browser: the locked navigation
// contract, the primary-bar size limit, accessible names, Escape + focus
// restoration on the drawer, and the presence of the safe-area rules the
// #214 acceptance list names. The visual half is the browser lab
// (tests/e2e/r-glass-lab.spec.ts).
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "@/App";
import { Card } from "@/components/primitives/Data";
import { useSidebarStore, useGlassStore } from "@/stores/prefsStore";

const NAV_ORDER = ["/", "/search", "/sessions", "/connections", "/keys", "/files", "/mirror", "/telemetry", "/health", "/collector", "/settings"];

function stubFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve({ ok: false, status: 404, json: async () => ({}), text: async () => "" }))
  );
}

/** Every interactive control must have a name a screen reader can announce. */
function accessibleName(el: Element): string {
  const labelledBy = el.getAttribute("aria-labelledby");
  if (labelledBy) {
    const target = document.getElementById(labelledBy);
    if (target && target.textContent && target.textContent.trim()) return target.textContent.trim();
  }
  return (
    el.getAttribute("aria-label") ||
    (el.textContent || "").trim() ||
    el.getAttribute("title") ||
    ""
  ).trim();
}

beforeEach(() => {
  window.localStorage.clear();
  window.location.hash = "";
  // The shell stores are MODULE-level (zustand), so they survive RTL's DOM
  // teardown. Without this reset a test that opens the drawer leaves
  // `mobileOpen: true` for the next one, and the overlay behaves differently.
  useSidebarStore.setState({ mobileOpen: false, collapsed: false });
  useGlassStore.setState({ quality: "auto", clarity: 0.75, variant: "tinted" });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("R-UX-a: the locked navigation contract survives the redesign", () => {
  it("still renders exactly 11 sidebar links in the F76 order", () => {
    stubFetch();
    const { container } = render(<App />);
    const nav = container.querySelector('[data-testid="sidebar"] nav');
    const links = Array.from(nav?.querySelectorAll("a") || []);
    expect(links.length).toBe(11);
    expect(links.map((a) => (a.getAttribute("href") || "").replace(/^#/, ""))).toEqual(NAV_ORDER);
  });

  it("the phone primary bar has at most 5 slots and is NOT the locked nav", () => {
    stubFetch();
    const { container } = render(<App />);
    const mobile = container.querySelector('[data-testid="mobile-nav"]');
    expect(mobile).not.toBeNull();
    // 4 real destinations + More
    const slots = Array.from((mobile as HTMLElement).querySelectorAll("a,button"));
    expect(slots.length).toBeLessThanOrEqual(5);
    // it must not be inside the element the locked selector counts
    expect(container.querySelector('[data-testid="sidebar"] [data-testid="mobile-nav"]')).toBeNull();
    // "Downloads" was NOT invented: every slot is a real registered route (or More)
    const hrefs = Array.from((mobile as HTMLElement).querySelectorAll("a")).map((a) =>
      (a.getAttribute("href") || "").replace(/^#/, "")
    );
    for (const h of hrefs) expect(NAV_ORDER).toContain(h);
  });

  it("every destination reachable on desktop is reachable on the phone through More", async () => {
    stubFetch();
    const { container } = render(<App />);
    const more = screen.getByTestId("mobile-nav-more");
    await userEvent.click(more);
    const nav = container.querySelector('[data-testid="sidebar"] nav');
    const hrefs = Array.from(nav?.querySelectorAll("a") || []).map((a) => (a.getAttribute("href") || "").replace(/^#/, ""));
    expect(hrefs).toEqual(NAV_ORDER);
  });
});

describe("R-UX-b: accessible names and touch targets", () => {
  it("every top-bar control has a non-empty accessible name", () => {
    stubFetch();
    const { container } = render(<App />);
    const bar = container.querySelector('[data-testid="app-topbar"]') as HTMLElement;
    const controls = Array.from(bar.querySelectorAll("button, a"));
    expect(controls.length).toBeGreaterThan(0);
    for (const c of controls) {
      expect(accessibleName(c), c.outerHTML.slice(0, 120)).not.toBe("");
    }
  });

  it("every phone-bar slot has a visible label (icon-only navigation is rejected)", () => {
    stubFetch();
    const { container } = render(<App />);
    const mobile = container.querySelector('[data-testid="mobile-nav"]') as HTMLElement;
    for (const slot of Array.from(mobile.querySelectorAll("a,button"))) {
      const label = (slot.textContent || "").trim();
      expect(label, slot.outerHTML.slice(0, 120)).not.toBe("");
      expect(accessibleName(slot)).not.toBe("");
    }
  });

  it("sidebar rows and top-bar controls carry the 44px touch-target class", () => {
    stubFetch();
    const { container } = render(<App />);
    const bar = container.querySelector('[data-testid="app-topbar"]') as HTMLElement;
    for (const b of Array.from(bar.querySelectorAll("button, a"))) {
      // the reconnect chip is a dense inline action; the rest are primary controls
      if (b.id === "f95.wsReconnect") continue;
      expect(b.className.includes("tap-44"), b.outerHTML.slice(0, 120)).toBe(true);
    }
    const nav = container.querySelector('[data-testid="sidebar"] nav') as HTMLElement;
    for (const a of Array.from(nav.querySelectorAll("a"))) {
      expect(a.className.includes("min-h-[44px]"), a.outerHTML.slice(0, 120)).toBe(true);
    }
  });

  it("collapsed desktop rows still expose the name in the DOM, not only in title", () => {
    stubFetch();
    const { container } = render(<App />);
    const nav = container.querySelector('[data-testid="sidebar"] nav') as HTMLElement;
    const files = nav.querySelector('a[href="#/files"]') as HTMLElement;
    // the label span is hidden for sighted users when collapsed, but it is
    // still in the accessibility tree
    const spans = Array.from(files.querySelectorAll("span"));
    expect(spans.some((s) => (s.textContent || "").trim().length > 0)).toBe(true);
  });
});

describe("R-UX-c: overlay behaviour", () => {
  it("Escape closes the phone drawer and focus returns to the control that opened it", async () => {
    stubFetch();
    render(<App />);
    const more = screen.getByTestId("mobile-nav-more");
    more.focus();
    await userEvent.click(more);
    await waitFor(() => expect(screen.getByTestId("sidebar-close")).toBeInTheDocument());
    // focus moved INTO the drawer
    await waitFor(() => expect(document.activeElement).not.toBe(more));
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByTestId("sidebar-close")).toBeNull());
    // and came back out
    await waitFor(() => expect(document.activeElement).toBe(more));
  });

  it("the drawer has a visible close control (the back gesture is not the only way out)", async () => {
    stubFetch();
    render(<App />);
    await userEvent.click(screen.getByTestId("mobile-nav-more"));
    const close = await screen.findByTestId("sidebar-close");
    // a glyph plus a name: never an unlabelled X
    expect(close.querySelector("svg")).not.toBeNull();
    expect(close.getAttribute("aria-label")).not.toBe("");
  });
});

describe("R-UX-d: safe area and glass plumbing", () => {
  it("globals.css declares the safe-area helpers and the glass fallbacks", () => {
    const css = readFileSync(path.join(process.cwd(), "src/styles/globals.css"), "utf8");
    // #214 §10: "padding uses env(safe-area-inset-bottom)"
    expect(css).toMatch(/env\(safe-area-inset-bottom/);
    expect(css).toMatch(/env\(safe-area-inset-top/);
    expect(css).toMatch(/env\(safe-area-inset-left/);
    expect(css).toMatch(/env\(safe-area-inset-right/);
    // #213 §7: Safari prefix + the three forced-opaque paths
    expect(css).toMatch(/-webkit-backdrop-filter/);
    expect(css).toMatch(/@supports not \(\(backdrop-filter/);
    expect(css).toMatch(/prefers-reduced-transparency: reduce/);
    expect(css).toMatch(/forced-colors: active/);
  });

  it("a Card is a NESTED glass surface (paint-only), so a page of cards costs one blur", () => {
    render(<Card title="Hello">body</Card>);
    const card = screen.getByText("Hello").closest("[data-glass]") as HTMLElement;
    expect(card).not.toBeNull();
    expect(card.getAttribute("data-glass-surface")).toBe("nested");
    expect(card.getAttribute("data-glass-samples")).toBe("0");
    expect(card.tagName).toBe("SECTION");
  });
});
