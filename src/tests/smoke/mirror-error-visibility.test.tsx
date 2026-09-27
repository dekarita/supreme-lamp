// [F44 §1.2 §5] jsdom gate: tool-created mirror errors are NEVER truncated in
// the v2 Mirror UI - the FULL phase+status+hostMessage string must render
// verbatim, the attempt ledger must expand, and the per-host matrix must show.
import { describe, expect, it } from "vitest";
import { render, act } from "@testing-library/react";
import "@/i18n";
import { MirrorCard } from "@/components/domain/MirrorCard";
import { useTelemetryStore } from "@/stores/telemetryStore";

const LONG_ERROR =
  "phase=type | catbox.moe: phase=type http=403 tries=1 msg=\"Rejected by content policy: file type not allowed on this host - executable content is refused by the published host rules, see the host FAQ for the full list of blocked extensions\" ; 0x0.st: phase=type http=0 tries=1 msg=\"preflight: extension .exe denied by 0x0.st content policy (0 network tries)\" ; tmpfiles.org: phase=http http=429 tries=3 msg=\"transient-http: slow down, retry later\"";

const progressPayload = {
  ts: "2026-09-27T12:00:00.000Z",
  alive: true,
  mirror: true,
  active: { name: "", phase: "idle", bytesDone: 0, bytesTotal: 0, pct: 0, speedBps: 0 },
  agg: { total: 1, done: 0, active: 0, failed: 1, bytesDone: 0, bytesTotal: 4096, overallPct: 0, speedBps: 0 },
  telemetry: { scans: 53, lastScan: "2026-09-27T11:59:59", roots: ["C:\\Users\\lab\\Downloads"], seen: 4, skippedJunk: 0, skippedSmall: 0, locked: 0, queued: 0 },
  archives: [],
  files: [
    {
      name: "IDM-Trial-Setup.exe",
      size: 4096,
      phase: "type",
      pct: 0,
      status: "failed",
      link: "",
      error: LONG_ERROR,
      attempts: [
        { host: "catbox.moe", ts: "2026-09-27T11:00:00.000Z", phase: "type", httpStatus: 403, hostMessage: "Rejected by content policy: file type not allowed on this host", bytesSent: 4096, durationMs: 812 },
        { host: "0x0.st", ts: "2026-09-27T11:00:01.000Z", phase: "type", httpStatus: 0, hostMessage: "preflight: extension .exe denied by 0x0.st content policy (0 network tries)", bytesSent: 0, durationMs: 0 },
        { host: "tmpfiles.org", ts: "2026-09-27T11:00:02.000Z", phase: "http", httpStatus: 429, hostMessage: "transient-http: slow down, retry later", bytesSent: 4096, durationMs: 1331 },
      ],
    },
  ],
  log: [],
  speedHistory: [0],
};

describe("F44 mirror error visibility (no truncation ever)", () => {
  it("renders the FULL error string verbatim (no slice, no ellipsis, no truncate class)", () => {
    const { getAllByTestId } = render(<MirrorCard />);
    act(() => {
      useTelemetryStore.getState().setProgress(progressPayload);
    });
    const cells = getAllByTestId("mirror-error-full");
    expect(cells.length).toBe(1);
    expect(cells[0].textContent).toBe(LONG_ERROR);
    expect(cells[0].className).not.toMatch(/truncate/);
    expect(cells[0].getAttribute("title")).toBe(LONG_ERROR);
    // nothing truncated: the rendered text is byte-identical to the source
    expect(cells[0].textContent!.length).toBe(LONG_ERROR.length);
  });

  it("expands the row into the per-attempt ledger with full host messages", () => {
    const { getAllByTestId, queryAllByTestId } = render(<MirrorCard />);
    act(() => {
      useTelemetryStore.getState().setProgress(progressPayload);
    });
    expect(queryAllByTestId("mirror-attempt-row").length).toBe(0);
    const btn = getAllByTestId("mirror-error-expand")[0];
    act(() => {
      btn.click();
    });
    const rows = getAllByTestId("mirror-attempt-row");
    expect(rows.length).toBe(3);
    const joined = rows.map((r) => r.textContent).join("\n");
    expect(joined).toContain("catbox.moe");
    expect(joined).toContain("403");
    expect(joined).toContain("Rejected by content policy: file type not allowed on this host");
    expect(joined).toContain("(0 network tries)");
  });

  it("shows the per-host failure matrix card across the run", () => {
    const { getByTestId, getAllByTestId } = render(<MirrorCard />);
    act(() => {
      useTelemetryStore.getState().setProgress(progressPayload);
    });
    const matrix = getByTestId("mirror-host-matrix");
    expect(matrix.textContent).toContain("catbox.moe");
    expect(matrix.textContent).toContain("0x0.st");
    expect(matrix.textContent).toContain("tmpfiles.org");
    const cells = getAllByTestId("mirror-host-cell");
    expect(cells.length).toBe(3);
    expect(cells[0].textContent).toContain("type:1");
    expect(cells[2].textContent).toContain("http:1");
  });
});
