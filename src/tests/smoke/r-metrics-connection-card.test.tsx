// [R-METRICS / #211] The connection card's DOM states.
//
// Defects these tests falsify (each was a real rendered claim):
//   * "jit 0 ms" shown when only one sample existed - reads as a measurement
//     of perfect stability when nothing was measured;
//   * "fps --" / "-- fps" placeholders that a reader can mistake for a value
//     the transport publishes;
//   * one RTT slot that silently switched between the Tailscale wire figure and
//     the browser's own HTTP round trip.
import { beforeEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import "@/i18n";
import { ConnectionCard } from "@/components/domain/ConnectionCard";
import { useTelemetryStore } from "@/stores/telemetryStore";

beforeEach(() => {
  useTelemetryStore.setState({
    wire: null,
    rttSamples: [],
    httpRtt: null,
    rttAtMs: null,
  });
});

describe("ConnectionCard: one label per measurement", () => {
  it("renders no numeric jitter when fewer than two samples exist", () => {
    useTelemetryStore.setState({ rttSamples: [42], httpRtt: 42, rttAtMs: Date.now() });
    render(<ConnectionCard />);
    const jit = screen.getByTestId("conn-jit");
    expect(jit.getAttribute("data-measured")).toBe("0");
    expect(jit.getAttribute("data-samples")).toBe("1");
    // the defect: "jit 0 ms"
    expect(jit.textContent).not.toMatch(/jit\s+0\s*ms/);
    expect(jit.textContent).not.toMatch(/jit\s+--\s*ms/);
    expect(jit.textContent).toBeTruthy();
  });

  it("renders a measured jitter once two samples exist", () => {
    useTelemetryStore.setState({ rttSamples: [100, 120], httpRtt: 120, rttAtMs: Date.now() });
    render(<ConnectionCard />);
    const jit = screen.getByTestId("conn-jit");
    expect(jit.getAttribute("data-measured")).toBe("1");
    expect(jit.textContent).toMatch(/jit\s+10\s*ms/);
  });

  it("never renders an FPS number - the transport does not expose one", () => {
    render(<ConnectionCard />);
    for (const id of ["conn-fps", "c2-fps"]) {
      const el = screen.getByTestId(id);
      expect(el.getAttribute("data-exposed")).toBe("0");
      expect(el.textContent).not.toMatch(/\d+\s*fps/);
      expect(el.textContent).not.toMatch(/fps\s*\d/);
    }
  });

  it("names the producer of the RTT it displays", () => {
    // only the browser HTTP figure exists
    useTelemetryStore.setState({ httpRtt: 55, rttAtMs: Date.now(), wire: null });
    const a = render(<ConnectionCard />);
    expect(screen.getByTestId("conn-rtt").getAttribute("data-source")).toBe("browser-http");
    expect(screen.getByTestId("conn-rtt-source").textContent).toMatch(/HTTP/i);
    a.unmount();

    // the Tailscale wire figure takes over and says so
    useTelemetryStore.setState({ httpRtt: 55, wire: { rtt: 91, via: "tailscale", direct: true } });
    render(<ConnectionCard />);
    expect(screen.getByTestId("conn-rtt").getAttribute("data-source")).toBe("tailscale-wire");
    expect(screen.getByTestId("conn-rtt-source").textContent).toMatch(/Tailscale/i);
    expect(screen.getByTestId("conn-rtt").textContent).toBe("91 ms");
    // the two producers stay separate rows with separate labels
    expect(screen.getByTestId("c2-rtt").getAttribute("data-source")).toBe("tailscale-wire");
  });

  it("marks nothing as stale while the sample is fresh", () => {
    useTelemetryStore.setState({ httpRtt: 55, rttAtMs: Date.now(), wire: null });
    render(<ConnectionCard />);
    expect(screen.getByTestId("conn-rtt").getAttribute("data-stale")).toBe("0");
  });

  it("keeps the frozen regression ids the launcher gates depend on", () => {
    render(<ConnectionCard />);
    for (const id of ["connRtt", "connBadge", "connFps", "connJit", "connSpark", "c2Srv", "c2Via", "c2Fps", "c2Jit", "c2Rtt", "c2Spark"]) {
      expect(document.getElementById(id), id).toBeInTheDocument();
    }
  });
});
