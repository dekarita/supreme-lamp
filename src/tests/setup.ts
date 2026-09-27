// [F41] Vitest jsdom setup: DOM matchers + fetch/WS stubs so the whole App
// mounts offline. CRLF-safe by construction (no file-content assertions here;
// static file checks live in scripts/*.mjs with explicit EOL normalization).
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  window.sessionStorage.clear();
});

// All network soft-fails like production getJson()/probeHealth() expect.
vi.stubGlobal(
  "fetch",
  vi.fn(() => Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) }))
);

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  readyState = 3;
  onopen: ((e?: unknown) => void) | null = null;
  onclose: ((e?: unknown) => void) | null = null;
  onerror: ((e?: unknown) => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  close() {
    /* noop */
  }
  send() {
    /* noop */
  }
}
vi.stubGlobal("WebSocket", FakeWebSocket);

if (!("scrollTo" in Element.prototype)) {
  // jsdom lacks scrollTo; components that auto-scroll must not explode.
  Object.defineProperty(Element.prototype, "scrollTo", { value: () => {}, writable: true });
}
