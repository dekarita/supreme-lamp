// [F59 §4] Vitest - the three dispatch defaults are flipped and the plaintext
// banner renders when encrypt=false. The defaults are read from the SHIPPED
// workflow file (not a copy); the banner is rendered from the real component over
// the real telemetry store (same fixture shape as the F52 suite).
import { beforeEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import fs from "node:fs";
import path from "node:path";
import "@/i18n";
import { MirrorCard } from "@/components/domain/MirrorCard";
import { useTelemetryStore } from "@/stores/telemetryStore";

const root = path.resolve(__dirname, "../../..");
const mainYml = fs.readFileSync(path.join(root, ".github/workflows/main.yml"), "utf8");
const dispatch = mainYml.slice(mainYml.indexOf("workflow_dispatch:"), mainYml.indexOf("\npermissions:"));

function inputDefault(name: string): string | undefined {
  const m = dispatch.match(new RegExp(name + ":\\n(?:[^\\n]*\\n)*?\\s+default:\\s*(true|false)"));
  return m?.[1];
}

describe("F59 dispatch defaults", () => {
  it("F59-V1 mirror_enable defaults true (token-less guest, no secret)", () => {
    expect(inputDefault("mirror_enable")).toBe("true");
  });
  it("F59-V2 mirror_encrypt defaults false (plaintext manual lane); only explicit true keeps encryption", () => {
    expect(inputDefault("mirror_encrypt")).toBe("false");
    expect(mainYml).toMatch(/MIRROR_PLAINTEXT_ELECTED: \$\{\{ github\.event_name == 'workflow_dispatch' && github\.event\.inputs\.mirror_encrypt != 'true'/);
  });
  it("F59-V3 search_enable defaults true (Search tab + aria2c out of the box)", () => {
    expect(inputDefault("search_enable")).toBe("true");
  });
});

function fixture(plaintextElected: boolean) {
  return {
    mirror: true,
    encryptMode: plaintextElected ? "none" : "all",
    mirrorPlaintextElection: plaintextElected,
    agg: { total: 0, done: 0, failed: 0, bytesDone: 0, bytesTotal: 0, speedBps: 0 },
    active: { name: "", phase: "idle", bytesSent: "0", bytesTotal: "0", windowBytes: "0", windowSeconds: 0, noBytesSeconds: 0, speedBps: 0 },
    telemetry: { scans: 1, roots: ["Downloads"] },
    files: [],
    mirrorDiag: { encryptMode: plaintextElected ? "none" : "all", autoUpload: "downloads-always-on", encAlg: "AES-256-GCM" },
  };
}

describe("F59 plaintext banner", () => {
  beforeEach(() => useTelemetryStore.setState({ mirror: null, speedHistory: [], progress: null }));

  it("F59-V4 renders PLAINTEXT MODE - uploads not encrypted on an encrypt=false dispatch", () => {
    useTelemetryStore.getState().setProgress(fixture(true));
    render(<MirrorCard />);
    const banner = screen.getByTestId("mirror-plaintext-banner");
    expect(banner).toHaveTextContent("PLAINTEXT MODE");
    expect(banner).toHaveTextContent("uploads not encrypted");
    // the safety floor is stated on the banner itself
    expect(banner).toHaveTextContent("Downloads auto-upload and the runtime opt-in lane ALWAYS encrypt");
    expect(banner).toHaveTextContent("runner-local");
  });

  it("F59-V5 no banner when the lane is encrypted (mirror_encrypt=true)", () => {
    useTelemetryStore.getState().setProgress(fixture(false));
    render(<MirrorCard />);
    expect(screen.queryByTestId("mirror-plaintext-banner")).not.toBeInTheDocument();
  });
});
