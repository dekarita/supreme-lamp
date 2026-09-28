// [F47 §2/§3] Mirror page truth gates (offline DOM).
//
// §0 ground truth this file answers: the F46 probe matrix existed only in the
// CI artifact and the raw Diagnose drawer, so the operator could not see gofile
// reachability from the runner egress on the Mirror page; and the card claimed
// "AES-256 encrypted upload" while the worker uploaded plaintext. These tests
// pin (a) the probe rows rendering live from /diag with the operator options on
// a 403 egress, and (b) the card title equalling the worker's reported mode.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import "@/i18n";
import { MirrorHostMatrix } from "@/components/domain/MirrorHostMatrix";
import { MirrorCard } from "@/components/domain/MirrorCard";
import { useTelemetryStore } from "@/stores/telemetryStore";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const originalFetch = globalThis.fetch;

function stubDiag(payload: Any) {
  globalThis.fetch = vi.fn(async () => ({
    ok: true,
    json: async () => payload,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  })) as any;
}

function progressPayload(encrypted: string, encAlg: string) {
  return {
    mirror: true,
    encryptMode: encAlg ? "all" : "none",
    agg: { total: 1, done: 1, failed: 0, bytesDone: 2048, bytesTotal: 2048, speedBps: 0 },
    telemetry: { scans: 3, lastScan: "2026-09-28T13:00:00Z", roots: ["Downloads"] },
    active: { name: "", phase: "idle", pct: 0, bytesDone: 0, bytesTotal: 0 },
    files: [
      {
        name: "f47-benign.txt.ghenc",
        phase: "done",
        pct: 100,
        size: 2048,
        status: "done",
        link: "https://gofile.test/d/f47",
        encrypted,
        host: "gofile",
        error: "",
        attempts: [],
      },
    ],
    mirrorDiag: {
      attempts: [],
      terminalFiles: [],
      hosts: [{ id: "gofile", enabled: true, apiRoot: "https://api.gofile.io" }],
      encryptMode: encAlg ? "all" : "none",
      encAlg,
    },
  };
}

describe("F47 mirror host matrix (probe visibility)", () => {
  beforeEach(() => {
    useTelemetryStore.setState({ mirror: null, speedHistory: [], progress: null });
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    useTelemetryStore.setState({ mirror: null, speedHistory: [], progress: null });
  });

  it("renders the {host,status,note} rows live from /diag", async () => {
    stubDiag({
      mirrorHosts: [
        { host: "gofile", status: "200", note: "read-only GET /servers reachable; upload flow is documented + enabled=True" },
      ],
      mirrorAttempts: [],
    });
    render(<MirrorHostMatrix />);
    await waitFor(() => expect(screen.getByTestId("mirror-host-matrix")).toBeTruthy());
    expect(screen.getByTestId("mirror-host-status").textContent).toBe("200");
    expect(screen.getByTestId("mirror-host-note").textContent).toContain("read-only GET /servers reachable");
    // a reachable host must NOT show the dead-end note
    expect(screen.queryByTestId("mirror-host-operator-options")).toBeNull();
  });

  it("renders the operator options when the runner egress is blocked (403)", async () => {
    stubDiag({
      mirrorHosts: [
        {
          host: "gofile",
          status: "403",
          note: "runner egress rejected (403) - policy/endpoint level rejection; operator option: operator-owned VPS egress (no evasion)",
        },
      ],
      mirrorAttempts: [],
    });
    render(<MirrorHostMatrix />);
    await waitFor(() => expect(screen.getByTestId("mirror-host-operator-options")).toBeTruthy());
    expect(screen.getByTestId("mirror-host-status").textContent).toBe("403");
    const options = screen.getByTestId("mirror-host-operator-options");
    expect(options.textContent).toContain("VPS");
    expect(options.textContent).toContain("docs/MIRROR-HOSTS.md");
    // no evasion is offered: the note names the two honest options only
    expect(options.textContent).not.toMatch(/Mozilla|proxy|rotat|spoof/i);
  });
});

describe("F47 card title parity with the worker mode", () => {
  beforeEach(() => {
    useTelemetryStore.setState({ mirror: null, speedHistory: [], progress: null });
  });
  afterEach(() => {
    useTelemetryStore.setState({ mirror: null, speedHistory: [], progress: null });
  });

  it("says AES-256 encrypted runner upload only when a row reports encrypted=True", () => {
    useTelemetryStore.getState().setProgress(progressPayload("True", "AES-256-GCM") as Any);
    const { container } = render(<MirrorCard />);
    const title = container.querySelector("#sec-mirror h2, #sec-mirror [data-card-title]") || screen.getByText(/Mirror - /);
    expect(title.textContent).toBe("Mirror - AES-256 encrypted runner upload");
    expect(screen.getByTestId("mirror-encrypt-honesty").textContent).toContain("encrypted uploads=yes");
    expect(screen.getByTestId("mirror-encrypt-honesty").textContent).toContain("AES-256-GCM");
  });

  it("says plaintext (and shows no algorithm) when the worker uploaded plaintext", () => {
    useTelemetryStore.getState().setProgress(progressPayload("False", "") as Any);
    const { container } = render(<MirrorCard />);
    const title = container.querySelector("#sec-mirror h2, #sec-mirror [data-card-title]") || screen.getByText(/Mirror - /);
    expect(title.textContent).toContain("plaintext");
    // the honest plaintext title names the mode it does NOT use
    expect(title.textContent).not.toContain("AES-256 encrypted runner upload");
    expect(screen.getByTestId("mirror-encrypt-honesty").textContent).toContain("encrypted uploads=no");
  });
});
