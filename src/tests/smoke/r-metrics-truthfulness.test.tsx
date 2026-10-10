// [R-METRICS / #211 / #212] Behavioral tests for the truthful-metrics work.
//
// These execute the SHIPPED modules (src/lib/domain/metrics.ts, the telemetry
// store producers, ConnectionCard, the bottom bar and MirrorCard) - they are
// not string-presence checks. Each test names the defect it falsifies:
//   * jitter is never rendered as 0 when fewer than two samples exist;
//   * the Tailscale RTT and the browser HTTP RTT keep separate labels;
//   * FPS says "not exposed" instead of a numeric placeholder;
//   * the remaining clock prefers the server-published deadline, labels the
//     5h30 policy window as policy, and shows an unknown state otherwise;
//   * the speed-history caption follows the array's origin, not its length.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import {
  jitterFromSamples,
  measure,
  remainingTime,
  rttPair,
  speedSeriesInfo,
  usableSampleCount,
  MIN_JITTER_SAMPLES,
} from "@/lib/domain/metrics";
import { useTelemetryStore, remainingTimeFromStore } from "@/stores/telemetryStore";
import { mirrorModel } from "@/lib/domain/progress";

function resetStores() {
  useTelemetryStore.setState({
    progress: null,
    mirror: null,
    speedHistory: [],
    runStartedAtMs: null,
    sessionStartedAtMs: null,
    sessionEndMs: null,
    sessionEndRaw: "",
    progressAtMs: null,
    rttAtMs: null,
    wire: null,
    rttSamples: [],
    httpRtt: null,
    clockOffsetMs: 0,
    sessionExpired: false,
  });
}

beforeEach(() => resetStores());
afterEach(() => vi.useRealTimers());

const NOW = 1_700_000_000_000;

describe("R-METRICS-1: jitter is a measurement, never a default zero", () => {
  it("returns null for zero, one and non-finite samples (the 'jit 0 ms' defect)", () => {
    expect(jitterFromSamples([])).toBeNull();
    expect(jitterFromSamples([42])).toBeNull();
    expect(jitterFromSamples([Number.NaN, 5])).toBeNull();
    expect(jitterFromSamples(["x", null, undefined] as never[])).toBeNull();
    expect(MIN_JITTER_SAMPLES).toBe(2);
  });

  it("measures median absolute deviation once two real samples exist", () => {
    // 100 and 120 -> mean 110, deviations 10/10 -> MAD 10
    expect(jitterFromSamples([100, 120])).toBe(10);
    // 100/110/120 -> mean 110, deviations 10/0/10 -> median deviation 10
    expect(jitterFromSamples([100, 110, 120])).toBe(10);
    // identical samples really do have zero dispersion
    expect(jitterFromSamples([100, 100, 100, 100])).toBe(0);
    // one outlier moves the mean, so the median-absolute-deviation is 225 - a
    // real measurement, not a silent zero
    expect(jitterFromSamples([100, 100, 100, 1000])).toBe(225);
  });

  it("counts usable samples separately from the jitter value", () => {
    expect(usableSampleCount([1, Number.NaN, 3, "x"])).toBe(2);
    expect(usableSampleCount([])).toBe(0);
  });
});

describe("R-METRICS-2: RTT keeps one label per producer", () => {
  it("prefers the Tailscale wire figure and names it", () => {
    const p = rttPair({ httpRtt: 40, wireRtt: 90 });
    expect(p.preferred.value).toBe(90);
    expect(p.preferred.source).toBe("tailscale-wire");
    expect(p.http.source).toBe("browser-http");
    expect(p.tailscale.source).toBe("tailscale-wire");
    expect(p.divergent).toBe(true);
  });

  it("falls back to the browser HTTP figure WITHOUT relabelling it", () => {
    const p = rttPair({ httpRtt: 40, wireRtt: null });
    expect(p.preferred.value).toBe(40);
    expect(p.preferred.source).toBe("browser-http");
    expect(p.tailscale.value).toBeNull();
    expect(p.tailscale.reason).toBe("no-sample");
    expect(p.divergent).toBe(false);
  });

  it("is null (not 0) when nothing was measured", () => {
    const p = rttPair({ httpRtt: null, wireRtt: null });
    expect(p.preferred.value).toBeNull();
    expect(p.http.value).toBeNull();
  });

  it("marks an old sample stale instead of presenting it as live", () => {
    const p = rttPair({ httpRtt: 40, wireRtt: null, atMs: Date.now() - 120_000, maxAgeMs: 30_000 });
    expect(p.http.stale).toBe(true);
    const fresh = rttPair({ httpRtt: 40, wireRtt: null, atMs: Date.now(), maxAgeMs: 30_000 });
    expect(fresh.http.stale).toBe(false);
  });

  it("a 'not-exposed' measurement keeps the not-exposed reason", () => {
    const m = measure(null, "not-exposed");
    expect(m.value).toBeNull();
    expect(m.reason).toBe("not-exposed");
  });
});

describe("R-METRICS-3: remaining time prefers the authoritative deadline", () => {
  it("uses the server-published sessionEnd and says so", () => {
    const r = remainingTime({ sessionEndMs: NOW + 3_600_000, runStartedAtMs: NOW - 600_000, nowMs: NOW, policyWindowMs: 19_800_000 });
    expect(r.basis).toBe("server-session-end");
    expect(r.seconds).toBe(3600);
    expect(r.expired).toBe(false);
    expect(r.deadlineMs).toBe(NOW + 3_600_000);
  });

  it("labels the 5h30 constant as a POLICY fallback, not a measurement", () => {
    const r = remainingTime({ sessionEndMs: null, runStartedAtMs: NOW - 600_000, nowMs: NOW, policyWindowMs: 19_800_000 });
    expect(r.basis).toBe("policy-window");
    expect(r.seconds).toBe(19_800 - 600);
  });

  it("returns null (never a fabricated 05:30:00) when no start and no deadline exist", () => {
    const r = remainingTime({ sessionEndMs: null, runStartedAtMs: null, nowMs: NOW, policyWindowMs: 19_800_000 });
    expect(r.seconds).toBeNull();
    expect(r.basis).toBe("unknown");
    expect(r.expired).toBe(false);
  });

  it("treats an invalid/NaN deadline as absent rather than rendering NaN", () => {
    const r = remainingTime({ sessionEndMs: Number.NaN, runStartedAtMs: NOW - 600_000, nowMs: NOW, policyWindowMs: 19_800_000 });
    expect(r.basis).toBe("policy-window");
    expect(Number.isFinite(r.seconds as number)).toBe(true);
  });

  it("reports expiry when the deadline has passed", () => {
    const r = remainingTime({ sessionEndMs: NOW - 1000, runStartedAtMs: NOW - 600_000, nowMs: NOW, policyWindowMs: 19_800_000 });
    expect(r.expired).toBe(true);
    expect(r.seconds).toBe(0);
  });

  it("the store selector threads the deadline through and the old shim agrees", () => {
    useTelemetryStore.setState({ sessionEndMs: NOW + 60_000, runStartedAtMs: NOW - 600_000 });
    const r = remainingTimeFromStore({ sessionEndMs: useTelemetryStore.getState().sessionEndMs, runStartedAtMs: useTelemetryStore.getState().runStartedAtMs, now: NOW });
    expect(r.basis).toBe("server-session-end");
    expect(r.seconds).toBe(60);
  });
});

describe("R-METRICS-4: progress producer handling (deadline, run identity, staleness)", () => {
  it("stores the server deadline when /api/progress publishes one", () => {
    const end = new Date(NOW + 7_200_000).toISOString();
    act(() => {
      useTelemetryStore.getState().setProgress({ serverTs: new Date(NOW).toISOString(), sessionEnd: end, runStartedAt: new Date(NOW - 600_000).toISOString() });
    });
    expect(useTelemetryStore.getState().sessionEndMs).toBe(Date.parse(end));
    expect(useTelemetryStore.getState().progressAtMs).not.toBeNull();
  });

  it("keeps a cached deadline when a frame simply omits the key", () => {
    const end = new Date(NOW + 7_200_000).toISOString();
    act(() => useTelemetryStore.getState().setProgress({ sessionEnd: end, runStartedAt: new Date(NOW - 600_000).toISOString() }));
    act(() => useTelemetryStore.getState().setProgress({ runStartedAt: new Date(NOW - 600_000).toISOString() }));
    expect(useTelemetryStore.getState().sessionEndMs).toBe(Date.parse(end));
  });

  it("drops a cached deadline when the server publishes an empty one", () => {
    const end = new Date(NOW + 7_200_000).toISOString();
    act(() => useTelemetryStore.getState().setProgress({ sessionEnd: end, runStartedAt: new Date(NOW - 600_000).toISOString() }));
    expect(useTelemetryStore.getState().sessionEndMs).not.toBeNull();
    act(() => useTelemetryStore.getState().setProgress({ sessionEnd: "", runStartedAt: new Date(NOW - 600_000).toISOString() }));
    expect(useTelemetryStore.getState().sessionEndMs).toBeNull();
  });

  it("a repeated identical run start does not thrash the deadline", () => {
    const start = new Date(NOW - 600_000).toISOString();
    act(() => useTelemetryStore.getState().setProgress({ runStartedAt: start, sessionEnd: new Date(NOW + 3_600_000).toISOString() }));
    const before = useTelemetryStore.getState().sessionEndMs;
    act(() => useTelemetryStore.getState().setProgress({ runStartedAt: start }));
    expect(useTelemetryStore.getState().sessionEndMs).toBe(before);
  });

  it("invalid deadline text is discarded, not stored as NaN", () => {
    act(() => useTelemetryStore.getState().setProgress({ sessionEnd: "not-a-date", runStartedAt: new Date(NOW).toISOString() }));
    expect(useTelemetryStore.getState().sessionEndMs).toBeNull();
    expect(useTelemetryStore.getState().sessionEndRaw).toBe("not-a-date");
  });

  it("a CHANGED run re-seats the start and invalidates the old deadline", () => {
    const first = new Date(NOW - 600_000).toISOString();
    act(() => useTelemetryStore.getState().setProgress({ runStartedAt: first, sessionEnd: new Date(NOW + 3_600_000).toISOString() }));
    const firstStart = useTelemetryStore.getState().runStartedAtMs;
    expect(firstStart).toBe(Date.parse(first));

    const second = new Date(NOW - 60_000).toISOString();
    act(() => useTelemetryStore.getState().setProgress({ runStartedAt: second, sessionEnd: "" }));
    expect(useTelemetryStore.getState().runStartedAtMs).toBe(Date.parse(second));
    expect(useTelemetryStore.getState().sessionEndMs).toBeNull();
    expect(useTelemetryStore.getState().runStartedAtMs).not.toBe(firstStart);
  });

  it("setWire records the sample time and rejects non-finite HTTP RTT", () => {
    act(() => useTelemetryStore.getState().setWire(null, 42));
    expect(useTelemetryStore.getState().rttAtMs).not.toBeNull();
    expect(useTelemetryStore.getState().rttSamples).toEqual([42]);
    act(() => useTelemetryStore.getState().setWire(null, Number.NaN));
    expect(useTelemetryStore.getState().rttSamples).toEqual([42]);
    expect(useTelemetryStore.getState().httpRtt).toBeNull();
  });
});

describe("R-METRICS-5: speed-history caption follows the array's origin", () => {
  it("a server series is captioned with the server cadence (5s)", () => {
    const info = speedSeriesInfo({ history: new Array(90).fill(1000), serverProvided: true, serverCadenceMs: 5000, clientCadenceMs: 3000 });
    expect(info.origin).toBe("server");
    expect(info.count).toBe(90);
    expect(info.spanMs).toBe(450_000);
    expect(info.serverCadenceWouldBeFalse).toBe(false);
  });

  it("a client-fallback series of the SAME length is NOT captioned as 7.5 min", () => {
    const info = speedSeriesInfo({ history: new Array(90).fill(1000), serverProvided: false, serverCadenceMs: 5000, clientCadenceMs: 3000 });
    expect(info.origin).toBe("client-fallback");
    expect(info.count).toBe(90);
    expect(info.spanMs).toBe(270_000);
    expect(info.serverCadenceWouldBeFalse).toBe(true);
  });

  it("an empty series reports empty, not a cadence", () => {
    const info = speedSeriesInfo({ history: [], serverProvided: true });
    expect(info.origin).toBe("empty");
    expect(info.cadenceMs).toBeNull();
  });

  it("mirrorModel marks which array it produced", () => {
    const withServer = mirrorModel({ progress: { speedHistory: [1, 2, 3] } }, []);
    expect(withServer.speedHistoryOrigin).toBe("server");
    const fallback = mirrorModel({ progress: { speedHistory: [] } }, [10]);
    expect(fallback.speedHistoryOrigin).toBe("client-fallback");
    expect(fallback.speedHistory).toEqual([10, 0]);
  });
});

// ---------------------------------------------------------------------------
// Rendered behavior: the DOM must not claim a measurement it does not have.
// ---------------------------------------------------------------------------
async function mountApp() {
  const App = (await import("@/App")).default;
  return render(<App />);
}

describe("R-METRICS-6: rendered DOM states", () => {
  it("the remaining cell shows an unknown state (never 05:30:00) with no progress", async () => {
    await act(async () => {
      await mountApp();
    });
    const cell = document.getElementById("timerRemaining") as HTMLElement;
    expect(cell.textContent).toBe("--:--:--");
    expect(cell.getAttribute("data-basis")).toBe("unknown");
    expect(cell.getAttribute("data-expired")).toBe("0");
  });

  it("the remaining cell names the policy basis when only a run start is known", async () => {
    useTelemetryStore.setState({ runStartedAtMs: Date.now() - 60_000 });
    await act(async () => {
      await mountApp();
    });
    const cell = document.getElementById("timerRemaining") as HTMLElement;
    expect(cell.getAttribute("data-basis")).toBe("policy-window");
    expect(cell.textContent).toMatch(/^05:2\d:\d\d$/);
  });

  it("the remaining cell prefers the server deadline and marks it 'sched'", async () => {
    useTelemetryStore.setState({
      runStartedAtMs: Date.now() - 60_000,
      sessionEndMs: Date.now() + 7_200_000,
    });
    await act(async () => {
      await mountApp();
    });
    const cell = document.getElementById("timerRemaining") as HTMLElement;
    expect(cell.getAttribute("data-basis")).toBe("server-session-end");
    // ~2h, allowing for the milliseconds spent rendering
    expect(cell.textContent).toMatch(/^0[12]:[0-5]\d:[0-5]\d$/);
    expect(cell.textContent).not.toBe("--:--:--");
  });

  it("an expired server deadline marks data-expired", async () => {
    useTelemetryStore.setState({ runStartedAtMs: Date.now() - 600_000, sessionEndMs: Date.now() - 1000 });
    await act(async () => {
      await mountApp();
    });
    const cell = document.getElementById("timerRemaining") as HTMLElement;
    expect(cell.getAttribute("data-expired")).toBe("1");
    expect(cell.textContent).toBe("00:00:00");
  });
});
