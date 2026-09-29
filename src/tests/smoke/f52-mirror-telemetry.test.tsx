// F52 frozen-bytes DOM + Int64 + plaintext-election truth, offline.
import { beforeEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import "@/i18n";
import { MirrorCard } from "@/components/domain/MirrorCard";
import { KeysCard } from "@/components/domain/KeysCard";
import { useTelemetryStore } from "@/stores/telemetryStore";
import { useSessionStore } from "@/stores/sessionStore";
import { mirrorBytes, mirrorPercent, mirrorTransfer } from "@/lib/domain/mirrorBytes";
import { mirrorModel } from "@/lib/domain/progress";

function frozen() {
  return {
    mirror: true, encryptMode: "all", mirrorPlaintextElection: false,
    agg: { total: 2, done: 1, failed: 0, bytesDone: 917340, bytesTotal: 8290172928, speedBps: 1 },
    active: { name: "benign.iso", phase: "http", bytesSent: "0", bytesTotal: "8290172928", windowBytes: "0", windowSeconds: 60, noBytesSeconds: 60, speedBps: 1 },
    telemetry: { scans: 26, roots: ["Downloads"] },
    files: [
      { name: "benign.iso", phase: "http", status: "active", bytesSent: "0", size: "8290172928", auto: "True", encrypted: "False", encryptMode: "all" },
      { name: "small.txt", phase: "done", status: "done", bytesSent: 917340, size: 917340, encrypted: "True", encryptMode: "all" },
    ],
    mirrorDiag: { encryptMode: "all", autoUpload: "downloads-always-on", encAlg: "AES-256-CBC-PBKDF2" },
  };
}

describe("F52 honest mirror telemetry", () => {
  beforeEach(() => useTelemetryStore.setState({ mirror: null, speedHistory: [], progress: null }));

  it("F52-DOM-V2-FROZEN RESULT=PASS: row and header stalled; never day-count ETA", () => {
    useTelemetryStore.getState().setProgress(frozen());
    const { container } = render(<MirrorCard />);
    expect(container.querySelector("#stEta")?.textContent).toBe("-");
    expect(container.querySelector("#stEtaTile")?.textContent).toBe("-");
    expect(container.querySelector("#pubTxt")?.textContent).toBe("stalled (no bytes in 60s)");
    expect(container.querySelector("#fileRows")?.textContent).toContain("stalled (no bytes in 60s)");
    expect(container.querySelector("#activePhase")?.textContent).toContain("stalled");
    expect(container.querySelector("#stEta")?.textContent).not.toMatch(/\d+d/);
    expect(container.textContent).not.toContain("Waiting for first upload");
  });

  it("F52-DOM-V2-MOVING RESULT=PASS: positive window yields actual speed/ETA", () => {
    const d = frozen(); Object.assign(d.active, { bytesSent: "1073741824", windowBytes: "1073741824", windowSeconds: 60, noBytesSeconds: 0 });
    useTelemetryStore.getState().setProgress(d);
    const { container } = render(<MirrorCard />);
    expect(container.querySelector("#stSpeed")?.textContent).not.toContain("stalled");
    expect(container.querySelector("#stSpeed")?.textContent).not.toBe("1 B/s");
    expect(container.querySelector("#stEta")?.textContent).not.toBe("-");
    expect(container.querySelector("#pubTxt")?.textContent).toBe("Uploading benign.iso");
  });

  it("F52-HEADER-DONE RESULT=PASS: any done row overrides stale queue totals", () => {
    const d = frozen(); d.active.name = ""; d.active.phase = "idle"; d.agg.done = 0;
    expect(mirrorModel({ progress: d }, []).pubTxt).toBe("1 uploaded");
  });

  it("F52-INT64-V2 RESULT=PASS: 128 GiB and >2^53 counters remain exact", () => {
    expect(mirrorBytes("137438953472")).toBe(137438953472n);
    expect(mirrorBytes("9007199254740993")).toBe(9007199254740993n);
    expect(mirrorPercent("9223372036854775806", "9223372036854775807")).toBe(99.9);
    expect(mirrorTransfer({ bytesSent: "9223372036854775806", size: "9223372036854775807", windowBytes: 2, windowSeconds: 1 }, true).eta).toBe(0.5);
    expect(mirrorBytes(9007199254740992)).toBe(0n);
  });

  it("F52-ETA-STALE RESULT=PASS: stale positive speed never rescues a zero/expired window", () => {
    const d = frozen(); d.active.windowBytes = "1048576"; d.active.noBytesSeconds = 64;
    const m = mirrorModel(d, []);
    expect(m.eta).toBe("-");
    expect(m.speed).toContain("stalled (no bytes in 64s)");
  });

  it("F52-PLAINTEXT-ELECTION RESULT=PASS: explicit election renders banner, mode in every row", () => {
    const d = frozen(); d.mirrorPlaintextElection = true;
    useTelemetryStore.getState().setProgress(d);
    const { container } = render(<MirrorCard />);
    expect(screen.getByTestId("mirror-plaintext-banner")).toHaveTextContent("manual lane only");
    expect(screen.getByTestId("mirror-plaintext-banner")).toHaveTextContent("Downloads auto-upload and runtime opt-in always encrypt");
    expect(container.querySelector("#fileRows")?.textContent).toContain("encryptMode=all");
  });

  it("F52-NO-IMPLICIT-PLAIN RESULT=PASS: missing election never invents a plaintext banner", () => {
    useTelemetryStore.getState().setProgress(frozen()); render(<MirrorCard />);
    expect(screen.queryByTestId("mirror-plaintext-banner")).not.toBeInTheDocument();
  });

  it("F52-ENCRYPT-DEFECT RESULT=PASS: auto plaintext reports STOP, not a hidden downgrade", () => {
    const d = frozen(); d.files[0].encryptMode = "none";
    useTelemetryStore.getState().setProgress(d); render(<MirrorCard />);
    expect(screen.getByTestId("mirror-encryption-defect")).toHaveTextContent("STOP");
  });

  it("F52-KEY-DOM RESULT=PASS: even an old server key field cannot enter DOM/reveal/copy", () => {
    useSessionStore.getState().setConfig({ mirrorKey: "f52-nonsecret-canary-not-a-key" });
    const { container } = render(<KeysCard />);
    expect(container.textContent).not.toContain("f52-nonsecret-canary");
    expect(container.querySelector("#mirrorKey")?.textContent).toContain("runner-local; not exposed");
    expect(container.querySelectorAll("#mirrorKey button")).toHaveLength(0);
  });
});
