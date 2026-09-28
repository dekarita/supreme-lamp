// [F46 §1/§4/§6] Mirror card truth gates (offline DOM).
//
// §0 ground truth this file answers: the runner UI showed an "error" cell that
// was sliced to 40 characters with no host/phase/status anywhere, and the card
// claimed "AES-256 encrypted upload" while the worker logged encrypted=False.
// These tests pin the fix on the SHIPPED component:
//   - the complete reason (and every attempt line behind it) is in the DOM,
//     never truncated by code or CSS;
//   - the card title claims AES-256 only when the worker reported an encrypted
//     upload, and says so plainly when encryptMode asks for encryption this
//     build cannot provide.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import "@/i18n";
import { MirrorCard } from "@/components/domain/MirrorCard";
import { useTelemetryStore } from "@/stores/telemetryStore";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const LONG_MSG =
  "host status=error-limits (HTTP 403) while opening the upload stream: " +
  "detail ".repeat(40) +
  "END-OF-UNTRUNCATED-MESSAGE";

function progressPayload(encrypted: string) {
  return {
    mirror: true,
    encryptMode: "none",
    agg: { total: 1, done: 0, failed: 1, bytesDone: 0, bytesTotal: 917340, speedBps: 0 },
    telemetry: { scans: 34, lastScan: "2026-09-28T12:21:20Z", roots: ["Downloads"] },
    active: { name: "", phase: "idle", pct: 0, bytesDone: 0, bytesTotal: 0 },
    files: [
      {
        name: "NeatDM_setup.exe",
        phase: "failed",
        pct: 0,
        size: 917340,
        status: "failed",
        link: "",
        encrypted,
        host: "gofile",
        error: "phase=auth status=403 msg=" + LONG_MSG,
        attempts: [
          { n: 1, host: "gofile", phase: "auth", status: 403, msg: LONG_MSG, ms: 91 },
        ],
      },
    ],
    mirrorDiag: {
      attempts: [{ n: 1, host: "gofile", phase: "auth", status: 403, msg: LONG_MSG, ms: 91 }],
      terminalFiles: ["neatdm_setup.exe"],
      hosts: [{ id: "gofile", enabled: false, apiRoot: "https://api.gofile.io" }],
      encryptMode: "none",
    },
  };
}

describe("F46 mirror reason visibility", () => {
  beforeEach(() => {
    useTelemetryStore.setState({ mirror: null, speedHistory: [], progress: null });
  });
  afterEach(() => {
    useTelemetryStore.setState({ mirror: null, speedHistory: [], progress: null });
  });

  it("renders the COMPLETE reason and every attempt line - no slice, no CSS truncation", () => {
    useTelemetryStore.getState().setProgress(progressPayload("False") as Any);
    render(<MirrorCard />);
    const full = screen.getByTestId("mirror-reason-full");
    expect(full.textContent).toContain("END-OF-UNTRUNCATED-MESSAGE");
    expect(full.textContent).toContain("phase=auth status=403");
    expect(full.textContent!.length).toBeGreaterThan(400);
    // the old cell sliced to exactly 40 chars; the new one must not.
    expect(screen.getByTestId("mirror-reason-summary").textContent).not.toContain("END-OF");
    const cell = screen.getByTestId("mirror-error-cell");
    expect(cell.className).not.toMatch(/truncate|overflow-hidden|text-ellipsis/);
    // the attempt table behind the reason (artifact parity)
    expect(screen.getByTestId("mirror-attempts").textContent).toContain("attempt 1 host=gofile phase=auth status=403");
    expect(screen.getByTestId("mirror-attempts").textContent).toContain("ms=91");
  });

  it("never claims AES-256 while the worker reports plaintext", () => {
    useTelemetryStore.getState().setProgress(progressPayload("False") as Any);
    const { container } = render(<MirrorCard />);
    const title = container.querySelector("#sec-mirror h2, #sec-mirror [data-card-title]") || screen.getByText(/Mirror - /);
    expect(title.textContent).toContain("plaintext");
    expect(title.textContent).not.toContain("AES-256 encrypted runner upload");
    expect(screen.getByTestId("mirror-encrypt-honesty").textContent).toContain("encryptMode=none");
    expect(screen.getByTestId("mirror-encrypt-honesty").textContent).toContain("encrypted uploads=no");
  });

  it("claims AES-256 only when a file row actually reports encrypted=True", () => {
    useTelemetryStore.getState().setProgress(progressPayload("True") as Any);
    const { container } = render(<MirrorCard />);
    const title = container.querySelector("#sec-mirror h2, #sec-mirror [data-card-title]") || screen.getByText(/Mirror - /);
    expect(title.textContent).toContain("AES-256 encrypted runner upload");
    expect(screen.getByTestId("mirror-encrypt-honesty").textContent).toContain("encrypted uploads=yes");
  });
});
