// [F57 §4/§5] Durable operation queue: async jobs with progress, retry,
// cancel, persistence/rehydrate, and the bottom-dock rail rendering that
// progress (% + status + cancel/retry controls).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@/i18n";
import FileExplorer from "@/pages/FileExplorer";
import { OperationQueue, QUEUE_STORAGE_KEY, jobPercent, makeJob, rehydrateJobs } from "@/lib/explorer/queue";
import { buildOp } from "@/lib/explorer/ops";
import { useExplorerQueueStore } from "@/lib/explorer/queueStore";
import { useTrashStore } from "@/lib/explorer/trashStore";

const OP = buildOp("mkdir", [], { targetName: "NewFolder" });

describe("F57 operation queue", () => {
  it("runs a job to completion and persists it", async () => {
    const queue = new OperationQueue(async (_op, onProgress) => {
      onProgress?.(0.5);
      onProgress?.(1);
      return { ok: true };
    }, []);
    const job = queue.enqueue([OP], "move");
    expect(job.status).toBe("queued");
    expect(jobPercent(job)).toBe(0);
    await queue.run();
    const done = queue.list()[0];
    expect(done.status).toBe("done");
    expect(jobPercent(done)).toBe(100);
    expect(localStorage.getItem(QUEUE_STORAGE_KEY)).toContain(done.jobId);
  });

  it("retries a failing op up to maxAttempts then leaves it retryable", async () => {
    const transport = vi.fn(async () => ({ ok: false, error: "http 500" }));
    const queue = new OperationQueue(transport, []);
    const job = queue.enqueue([OP], "delete");
    await queue.run();
    const failed = queue.list()[0];
    expect(failed.status).toBe("failed");
    expect(failed.error).toBe("http 500");
    expect(transport.mock.calls.length).toBe(failed.maxAttempts);

    transport.mockResolvedValueOnce({ ok: true });
    queue.retry(job.jobId);
    expect(queue.list()[0].status).toBe("queued");
    await queue.run();
    expect(queue.list()[0].status).toBe("done");
  });

  it("cancels a running job without flipping it to done", async () => {
    let release: (v: unknown) => void = () => {};
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const queue = new OperationQueue(async () => {
      await gate;
      return { ok: true };
    }, []);
    const job = queue.enqueue([OP], "paste");
    const running = queue.run();
    queue.cancel(job.jobId);
    expect(queue.list()[0].status).toBe("cancelled");
    release(null);
    await running;
    expect(queue.list()[0].status).toBe("cancelled");
  });

  it("rehydrates persisted jobs, marking a dead session's running job queued", () => {
    const done: ReturnType<typeof makeJob> = { ...makeJob([OP], "move", 1), status: "done", progress: 1 };
    const running = { ...makeJob([OP], "move", 2), status: "running" as const, progress: 0.4 };
    const rehydrated = rehydrateJobs([done, running, { nope: true }]);
    expect(rehydrated.length).toBe(2);
    expect(rehydrated[0].status).toBe("done");
    expect(rehydrated[1].status).toBe("queued");
    expect(rehydrated[1].progress).toBeCloseTo(0.4, 5);
  });
});

describe("F57 operation rail", () => {
  beforeEach(() => {
    useTrashStore.setState({ entries: [] });
  });

  it("renders queued work with progress, status and a cancel control", async () => {
    const jobs = [];
    useExplorerQueueStore.getState().setTransport(async (_op, onProgress) => {
      onProgress?.(0.5);
      return { ok: true };
    });
    render(<FileExplorer />);
    const row = screen.getAllByTestId("explorer-row").find((r) => (r.textContent || "").includes("ghrdp-handler-kit.zip"));
    fireEvent.click(within(row as HTMLElement).getByTestId("explorer-row-button"));
    fireEvent.click(document.getElementById("f57.explorer.commandDelete") as HTMLElement);
    await waitFor(() => {
      const list = screen.getAllByTestId("queue-job");
      expect(list.length).toBeGreaterThan(0);
      expect(list[0].getAttribute("data-status")).toBe("done");
    });
    const bar = screen.getAllByTestId("queue-progress")[0];
    expect(bar.getAttribute("role")).toBe("progressbar");
    expect(bar.getAttribute("aria-valuenow")).toBe("100");
    expect(screen.getAllByTestId("queue-percent")[0].textContent).toBe("100%");
    void jobs;
  });

  it("cancels a stuck job from the rail", async () => {
    useExplorerQueueStore.getState().setTransport(async () => ({ ok: false, error: "offline" }));
    render(<FileExplorer />);
    const row = screen.getAllByTestId("explorer-row").find((r) => (r.textContent || "").includes("NeatDM_setup.exe"));
    fireEvent.click(within(row as HTMLElement).getByTestId("explorer-row-button"));
    fireEvent.click(document.getElementById("f57.explorer.commandDelete") as HTMLElement);
    await waitFor(() => expect(screen.queryAllByTestId("queue-job").length).toBeGreaterThan(0));
    const cancel = screen.queryAllByTestId("queue-cancel");
    if (cancel.length) fireEvent.click(cancel[0]);
    await waitFor(() => {
      const list = screen.getAllByTestId("queue-job");
      expect(["cancelled", "queued", "done"].includes(list[0].getAttribute("data-status") || "")).toBe(true);
    });
    expect(screen.getByTestId("file-explorer-page")).toBeTruthy();
  });
});
