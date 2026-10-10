// [R-DL / #210 stage 1] The progress rail must never imply a number it does not
// have, and must never offer an action its state does not support.
//
// Scope note (deliberate, not a gap): stage 1 makes the EXISTING engine-to-UI
// path honest. A live bytes/speed/ETA feed needs a server-side status read
// (aria2.tellStatus is wrapped by payloads/ghrdp-aria2.ps1 Get-Aria2Status but
// nothing publishes it to the SPA yet) - that is the next stage and is tracked
// with the exact dependency in the closure ledger, not faked here.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@/i18n";
import { BottomProgressRail } from "@/pages/search/BottomProgressRail";
import { useSearchStore, type FetchRecord } from "@/stores/searchStore";
import { useToastStore } from "@/stores/toastStore";

const cancelFetch = vi.fn();
const retryFetch = vi.fn();

vi.mock("@/lib/fetchStub", () => ({
  cancelFetch: (...a: unknown[]) => cancelFetch(...a),
  retryFetch: (...a: unknown[]) => retryFetch(...a),
}));

function record(over: Partial<FetchRecord> = {}): FetchRecord {
  return { fetchId: "fetch-1", resultId: "res-1", gid: "gid-1", transport: "aria2c", status: "downloading", sourceSnapshotId: "snap-1", ...over };
}

beforeEach(() => {
  cancelFetch.mockReset();
  retryFetch.mockReset();
  useSearchStore.setState({ fetches: {} } as never);
  useToastStore.setState({ items: [] } as never);
});

// The store keys `fetches` by RESULT id (searchStore.setFetchStatus /
// setFetchAccepted both index by resultId), with fetchId===resultId for the
// F56-d compat rows. Mirroring that convention here is what keeps the status
// writes below from being a silent no-op.
function mount(records: FetchRecord[]) {
  const map: Record<string, FetchRecord> = {};
  for (const r of records) map[r.resultId || r.fetchId] = r;
  useSearchStore.setState({ fetches: map } as never);
  return render(<BottomProgressRail />);
}

describe("R-DL-1: reserved cells say unavailable instead of inventing a number", () => {
  it("renders bytes/speed/ETA in an explicit unavailable state", () => {
    mount([record()]);
    for (const id of ["progress-bytes", "progress-speed", "progress-eta"]) {
      const el = screen.getByTestId(id);
      expect(el.getAttribute("data-available")).toBe("0");
      // the defect: a "0 B/s" or "0s" that reads as a measurement
      expect(el.textContent).not.toMatch(/\d/);
    }
    expect(screen.getByTestId("progress-feed-note").textContent).toBeTruthy();
  });

  it("keeps one row per job with its transport and gid", () => {
    mount([record({ fetchId: "a", resultId: "res-a" }), record({ fetchId: "b", resultId: "res-b", transport: "torrent", gid: undefined })]);
    expect(screen.getAllByTestId("progress-row").length).toBe(2);
    expect(screen.getAllByTestId("progress-gid").length).toBe(1);
  });
});

describe("R-DL-2: lifecycle states stay distinct", () => {
  it.each([
    ["downloading", "downloading"],
    ["verifying", "verifying"],
    ["encrypting", "encrypting"],
    ["post-fetch", "postfetch"],
    ["completed", "completed"],
    ["failed", "failed"],
    ["cancelled", "cancelled"],
  ])("status %s renders its own label", (status) => {
    mount([record({ status })]);
    const cell = screen.getByTestId("progress-status");
    expect(cell.getAttribute("id")).toBe("f56.search.progressStage.fetch-1");
    expect(cell.textContent).toBeTruthy();
    expect(screen.getByTestId("progress-row").getAttribute("data-fetch-status")).toBe(status);
  });
});

describe("R-DL-3: actions match the job state", () => {
  it("a live job can be cancelled and NOT retried", async () => {
    mount([record({ status: "downloading" })]);
    expect(screen.getByTestId("progress-cancel")).toBeInTheDocument();
    expect(screen.queryByTestId("progress-retry")).toBeNull();
    fireEvent.click(screen.getByTestId("progress-cancel"));
    await waitFor(() => expect(cancelFetch).toHaveBeenCalledWith("fetch-1", "gid-1"));
  });

  it("a completed job is neither cancelled nor retried", () => {
    mount([record({ status: "completed" })]);
    expect(screen.queryByTestId("progress-cancel")).toBeNull();
    expect(screen.queryByTestId("progress-retry")).toBeNull();
  });

  it("a failed job can be retried (starting a second transfer is the operator's call)", async () => {
    retryFetch.mockResolvedValue({ ok: true, data: {} });
    mount([record({ status: "failed" })]);
    const retry = screen.getByTestId("progress-retry");
    fireEvent.click(retry);
    await waitFor(() =>
      expect(retryFetch).toHaveBeenCalledWith("fetch-1", "snap-1"),
    );
    await waitFor(() => expect(screen.getByTestId("progress-row").getAttribute("data-fetch-status")).toBe("queued"));
  });

  it("a failed retry is reported and leaves the row failed", async () => {
    retryFetch.mockResolvedValue({ ok: false, error: { messageKey: "search.errors.generic" } });
    mount([record({ status: "failed" })]);
    fireEvent.click(screen.getByTestId("progress-retry"));
    await waitFor(() => expect(screen.getByTestId("progress-row").getAttribute("data-fetch-status")).toBe("failed"));
  });
});
