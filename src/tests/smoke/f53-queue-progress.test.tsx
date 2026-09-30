// F53: a pending/retrying row renders 0% plus the attempt counter, never 100%.
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import "@/i18n";
import { MirrorCard } from "@/components/domain/MirrorCard";
import { useTelemetryStore } from "@/stores/telemetryStore";
import { mirrorQueueProgress } from "@/lib/domain/mirrorBytes";
import { mirrorModel } from "@/lib/domain/progress";

function pendingPayload() {
  return {
    mirror: true,
    encryptMode: "all",
    agg: { total: 1, done: 0, failed: 0, bytesDone: 0, bytesTotal: 1170366464 },
    active: { name: "", phase: "idle" },
    files: [
      {
        name: "frozen.bin",
        phase: "queued",
        status: "pending",
        bytesSent: 1170366464,
        size: 1170366464,
        pct: 100,
        attempt: 2,
        attempts: [{ n: 1, host: "gofile", phase: "http", status: 500, msg: "exceed", ms: 10 }],
        encryptMode: "all",
        encrypted: "True",
      },
    ],
    mirrorDiag: { encryptMode: "all", encAlg: "AES-256-CBC-PBKDF2" },
  };
}

describe("F53 queue progress", () => {
  it("F53-QUEUE-PROGRESS RESULT=PASS: pending row is 0% · attempt 2, never 100%", () => {
    const row = pendingPayload().files[0];
    expect(mirrorQueueProgress(row).text).toBe("0% · attempt 2");
    expect(mirrorQueueProgress(row).pct).toBe(0);
    const model = mirrorModel({ progress: pendingPayload() }, []);
    expect(model.files[0].pct).toBe(0);
    expect(model.files[0].pctText).toBe("0% · attempt 2");
    expect(model.files[0].pctText).not.toContain("100");
    useTelemetryStore.getState().setProgress(pendingPayload());
    const { container } = render(<MirrorCard />);
    const rows = container.querySelector("#fileRows")?.textContent ?? "";
    expect(rows).toContain("0% · attempt 2");
    expect(rows).not.toContain("100%");
  });
});
