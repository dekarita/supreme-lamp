// [F57 §4] React-facing wrapper around the durable OperationQueue: one engine
// instance per session, a zustand mirror for the bottom-dock rail, and the
// production transport (postOp + a real upload POST for `upload` jobs).
// Tests swap the transport through setExplorerTransport().
import { create } from "zustand";
import type { ExplorerOp } from "./ops";
import { OperationQueue, type OpTransport, type QueueJob, jobPercent, activeJobs } from "./queue";
import { postOp } from "./transport";
import { getKey } from "@/lib/api";

export const FX_UPLOAD_PATH = "/api/fx/upload";

/** Production transport: one §1.5 op per call, upload jobs go to §1.6. */
export const defaultExplorerTransport: OpTransport = async (op, onProgress) => {
  if (onProgress) onProgress(0.25);
  if (op.kind === "upload") {
    const key = getKey();
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (key) headers["X-Dash-Token"] = key;
    try {
      const r = await fetch(FX_UPLOAD_PATH, {
        method: "POST",
        headers,
        cache: "no-store",
        body: JSON.stringify({ ids: op.entries.map((e) => e.id), host: "gofile" }),
      });
      if (onProgress) onProgress(1);
      return r.ok || r.status === 202 ? { ok: true } : { ok: false, error: "http " + r.status };
    } catch (err) {
      return { ok: false, error: String((err as Error)?.message || "network") };
    }
  }
  const res = await postOp(op);
  if (onProgress) onProgress(res.ok ? 1 : 0.25);
  return { ok: res.ok, error: res.error };
};

const engine = new OperationQueue(defaultExplorerTransport);

interface QueueStoreState {
  jobs: QueueJob[];
  enqueue: (ops: ExplorerOp[], label?: string) => string;
  run: () => Promise<void>;
  cancel: (jobId: string) => void;
  retry: (jobId: string) => void;
  clearFinished: () => void;
  setTransport: (transport: OpTransport) => void;
}

export const useExplorerQueueStore = create<QueueStoreState>((set, get) => {
  engine.subscribe((jobs) => set({ jobs }));
  return {
    jobs: engine.list(),
    enqueue: (ops, label = "explorer") => {
      const job = engine.enqueue(ops, label);
      void engine.run();
      return job.jobId;
    },
    run: async () => {
      await engine.run();
    },
    cancel: (jobId) => engine.cancel(jobId),
    retry: (jobId) => {
      engine.retry(jobId);
      void engine.run();
    },
    clearFinished: () => engine.clearFinished(),
    setTransport: (transport) => {
      engine.setTransport(transport);
      set({ jobs: get().jobs.slice() });
    },
  };
});

export function activeExplorerJobs(): QueueJob[] {
  return activeJobs(useExplorerQueueStore.getState().jobs);
}

export { engine as explorerQueueEngine, jobPercent };
