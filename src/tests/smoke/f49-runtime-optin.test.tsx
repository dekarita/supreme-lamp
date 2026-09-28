// [F49] Runtime (one-click) mirror opt-in - DOM truth gates (offline).
//
// Ground truth this file answers: with the mirror OFF (the shipped default),
// "Upload everything now" used to flush silently; now the Mirror page must
// show the disabled banner and open the ConfirmModal FIRST, and
// [Enable & Upload] must be enable+flush in one action (dash token +
// CSRF, this-run scope). A pre-F49 server (status 404s) keeps the legacy
// flush so old servers keep working.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@/i18n";
import { MirrorCard } from "@/components/domain/MirrorCard";
import { useTelemetryStore } from "@/stores/telemetryStore";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const originalFetch = globalThis.fetch;
const DASH_KEY = "test-dash-key-000000000000000000000001";
const CSRF = "abcdef0123456789abcdef0123456789abcdef0123456789";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
}
let calls: Call[];
let statusMode: "disabled" | "enabled" | "missing" | "offline";

function hdrs(map: Record<string, string>) {
  return { get: (n: string) => map[n] ?? null };
}

function stubFetch() {
  calls = [];
  globalThis.fetch = vi.fn(async (input: Any, init: Any) => {
    const url = String(input);
    const method = String((init && init.method) || "GET").toUpperCase();
    calls.push({ url, method, headers: { ...((init && init.headers) || {}) } });
    if (url.includes("/api/mirror/status")) {
      if (statusMode === "missing") return { ok: false, status: 404, headers: hdrs({}), json: async () => ({}) };
      if (statusMode === "offline") throw new Error("socket hang up");
      const enabled = statusMode === "enabled";
      return {
        ok: true,
        status: 200,
        headers: hdrs({ "X-CSRF-Token": CSRF }),
        json: async () => ({
          ok: true,
          enabled,
          mirror: enabled,
          hosts: [{ id: "gofile", enabled }],
          host: enabled ? "gofile" : "",
          scope: "this-run",
          source: enabled ? "runtime" : "off",
          at: enabled ? "2026-09-28T17:00:00Z" : "",
          pending: false,
        }),
      };
    }
    if (url.includes("/api/mirror/enable") || url.includes("/api/mirror/disable")) {
      const h = (init && init.headers) || {};
      if (h["X-Dash-Token"] !== DASH_KEY) return { ok: false, status: 401, headers: hdrs({}), json: async () => ({ error: "dashboard authorization required" }) };
      if (h["X-CSRF-Token"] !== CSRF) return { ok: false, status: 403, headers: hdrs({}), json: async () => ({ error: "CSRF token missing or invalid" }) };
      return { ok: true, status: 200, headers: hdrs({}), json: async () => ({ ok: true, enabled: url.includes("/enable") }) };
    }
    if (url.includes("/flush") || url.includes("/launch")) {
      return { ok: true, status: 200, headers: hdrs({}), json: async () => ({ ok: true }) };
    }
    return { ok: false, status: 404, headers: hdrs({}), json: async () => ({}) };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;
}

function postsTo(path: string) {
  return calls.filter((c) => c.method === "POST" && c.url.includes(path));
}

beforeEach(() => {
  statusMode = "disabled";
  stubFetch();
  useTelemetryStore.setState({ mirror: null, speedHistory: [], progress: null });
  window.history.replaceState({}, "", "/?key=" + DASH_KEY);
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  useTelemetryStore.setState({ mirror: null, speedHistory: [], progress: null });
  window.history.replaceState({}, "", "/");
});

describe("F49 disabled banner + ConfirmModal", () => {
  it("shows the disabled banner while the mirror is off, with no dialog open", async () => {
    render(<MirrorCard />);
    const banner = await screen.findByTestId("mirror-disabled-banner");
    expect(banner.textContent).toContain("Mirror is OFF for this run");
    expect(banner.getAttribute("role")).toBe("status");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("hides the banner when enabled and offers the this-run disable", async () => {
    statusMode = "enabled";
    render(<MirrorCard />);
    await waitFor(() => expect(screen.getByTestId("mirror-disable")).toBeTruthy());
    expect(screen.queryByTestId("mirror-disabled-banner")).toBeNull();
    expect(screen.getByTestId("mirror-disable").textContent).toContain("Disable mirror for this run");
  });

  it("opens the ConfirmModal FIRST on click when disabled (no flush, no enable yet)", async () => {
    render(<MirrorCard />);
    await screen.findByTestId("mirror-disabled-banner");
    calls = [];
    fireEvent.click(screen.getByText("Upload everything now"));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.getAttribute("aria-labelledby")).toBeTruthy();
    expect(screen.getByText("Enable mirror for this run?")).toBeTruthy();
    expect(screen.getByText("Enable & Upload")).toBeTruthy();
    expect(screen.getByText("Cancel")).toBeTruthy();
    // the modal opens BEFORE anything is sent: no flush, no enable
    expect(calls.filter((c) => c.url.includes("/flush")).length).toBe(0);
    expect(postsTo("/api/mirror/enable").length).toBe(0);
  });

  it("[Enable & Upload] POSTs enable with dash token + CSRF, then closes", async () => {
    render(<MirrorCard />);
    await screen.findByTestId("mirror-disabled-banner");
    fireEvent.click(screen.getByText("Upload everything now"));
    await screen.findByRole("dialog");
    calls = [];
    fireEvent.click(screen.getByText("Enable & Upload"));
    await waitFor(() => expect(postsTo("/api/mirror/enable").length).toBe(1));
    const post = postsTo("/api/mirror/enable")[0];
    expect(post.headers["X-Dash-Token"]).toBe(DASH_KEY);
    expect(post.headers["X-CSRF-Token"]).toBe(CSRF);
    expect(post.url).not.toContain("key=");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("Cancel closes the modal without POSTing anything", async () => {
    render(<MirrorCard />);
    await screen.findByTestId("mirror-disabled-banner");
    fireEvent.click(screen.getByText("Upload everything now"));
    await screen.findByRole("dialog");
    calls = [];
    fireEvent.click(screen.getByText("Cancel"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(calls.filter((c) => c.method === "POST").length).toBe(0);
  });

  it("a pre-F49 server (status 404s) keeps the legacy flush on click", async () => {
    statusMode = "missing";
    render(<MirrorCard />);
    // no banner without a status, and no dialog on click: straight to flush
    await waitFor(() => expect(calls.filter((c) => c.url.includes("/api/mirror/status")).length).toBeGreaterThan(0));
    expect(screen.queryByTestId("mirror-disabled-banner")).toBeNull();
    calls = [];
    fireEvent.click(screen.getByText("Upload everything now"));
    await waitFor(() => expect(calls.filter((c) => c.url.includes("/flush")).length).toBe(1));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("the disable affordance POSTs disable with dash token + CSRF", async () => {
    statusMode = "enabled";
    render(<MirrorCard />);
    await screen.findByTestId("mirror-disable");
    calls = [];
    fireEvent.click(screen.getByTestId("mirror-disable"));
    await waitFor(() => expect(postsTo("/api/mirror/disable").length).toBe(1));
    const post = postsTo("/api/mirror/disable")[0];
    expect(post.headers["X-Dash-Token"]).toBe(DASH_KEY);
    expect(post.headers["X-CSRF-Token"]).toBe(CSRF);
  });
});
