// [F57 §4] Durable operation queue. Large moves / pastes / deletes are async
// jobs: the op list is persisted (localStorage, guarded) so a reload keeps the
// pending work, each job reports progress to the bottom-dock rail, and a failed
// job is retryable. The queue is transport-injected: production wires
// postOp()/upload from ./transport, tests inject a fake, so nothing in this
// file needs a network or a DOM to be proven.
import type { ExplorerOp } from "./ops";

export type JobStatus = "queued" | "running" | "done" | "failed" | "cancelled";

export interface QueueJob {
  jobId: string;
  label: string;
  ops: ExplorerOp[];
  status: JobStatus;
  /** 0..1 across the job's ops (large-op fractions come from the transport). */
  progress: number;
  attempts: number;
  maxAttempts: number;
  error: string;
  createdAt: number;
  updatedAt: number;
}

export interface OpTransport {
  (op: ExplorerOp, onProgress?: (fraction: number) => void): Promise<{ ok: boolean; error?: string }>;
}

export const QUEUE_STORAGE_KEY = "ghrdp.f57.opqueue";
export const QUEUE_MAX_ATTEMPTS = 3;
export const QUEUE_LIMIT = 50;

let jobSeq = 0;
export function newJobId(now = Date.now()): string {
  jobSeq += 1;
  return "job-" + now.toString(36) + "-" + jobSeq.toString(36);
}

export function makeJob(ops: ExplorerOp[], label: string, now = Date.now()): QueueJob {
  return {
    jobId: newJobId(now),
    label,
    ops,
    status: "queued",
    progress: 0,
    attempts: 0,
    maxAttempts: QUEUE_MAX_ATTEMPTS,
    error: "",
    createdAt: now,
    updatedAt: now,
  };
}

/** Rehydrate persisted jobs - a `running` job from a dead session is pending. */
export function rehydrateJobs(raw: unknown): QueueJob[] {
  const list = Array.isArray(raw) ? raw : [];
  const out: QueueJob[] = [];
  for (const item of list) {
    const j = item as Partial<QueueJob>;
    if (!j || typeof j.jobId !== "string" || !Array.isArray(j.ops)) continue;
    out.push({
      jobId: j.jobId,
      label: String(j.label || "op"),
      ops: j.ops as ExplorerOp[],
      status: j.status === "done" || j.status === "cancelled" ? (j.status as JobStatus) : j.status === "failed" ? "failed" : "queued",
      progress: Math.min(1, Math.max(0, Number(j.progress) || 0)),
      attempts: Number(j.attempts) || 0,
      maxAttempts: Number(j.maxAttempts) || QUEUE_MAX_ATTEMPTS,
      error: String(j.error || ""),
      createdAt: Number(j.createdAt) || Date.now(),
      updatedAt: Number(j.updatedAt) || Date.now(),
    });
  }
  return out.slice(-QUEUE_LIMIT);
}

export function jobPercent(job: QueueJob): number {
  return Math.round(Math.min(1, Math.max(0, job.progress)) * 100);
}

export function activeJobs(jobs: QueueJob[]): QueueJob[] {
  return jobs.filter((j) => j.status === "queued" || j.status === "running");
}

export function overallPercent(jobs: QueueJob[]): number {
  if (!jobs.length) return 0;
  const total = jobs.reduce((n, j) => n + (j.status === "queued" ? 0 : jobPercent(j)), 0);
  return Math.round(total / jobs.length);
}

export function persistenceWrite(jobs: QueueJob[]): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(QUEUE_STORAGE_KEY, JSON.stringify(jobs.slice(-QUEUE_LIMIT)));
  } catch {
    /* private mode / quota - the queue stays in memory, it must not throw */
  }
}

export function persistenceRead(): QueueJob[] {
  try {
    if (typeof localStorage === "undefined") return [];
    const raw = localStorage.getItem(QUEUE_STORAGE_KEY);
    return raw ? rehydrateJobs(JSON.parse(raw)) : [];
  } catch {
    return [];
  }
}

/**
 * Sequential, resumable engine. One job runs at a time (ops inside a job run in
 * order), failures retry up to maxAttempts, cancellation is cooperative between
 * ops. `subscribe` lets the rail re-render without React state plumbing.
 */
export class OperationQueue {
  private jobs: QueueJob[];
  private listeners = new Set<(jobs: QueueJob[]) => void>();
  private running = false;

  constructor(private transport: OpTransport, initial: QueueJob[] = persistenceRead()) {
    this.jobs = initial;
  }

  setTransport(transport: OpTransport): void {
    this.transport = transport;
  }

  list(): QueueJob[] {
    return this.jobs.slice();
  }

  subscribe(fn: (jobs: QueueJob[]) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    const snapshot = this.list();
    persistenceWrite(snapshot);
    for (const fn of this.listeners) fn(snapshot);
  }

  private update(jobId: string, patch: Partial<QueueJob>): void {
    this.jobs = this.jobs.map((j) => (j.jobId === jobId ? { ...j, ...patch, updatedAt: Date.now() } : j));
    this.emit();
  }

  enqueue(ops: ExplorerOp[], label = "explorer"): QueueJob {
    const job = makeJob(ops, label);
    this.jobs = [...this.jobs, job].slice(-QUEUE_LIMIT);
    this.emit();
    return job;
  }

  cancel(jobId: string): void {
    const job = this.jobs.find((j) => j.jobId === jobId);
    if (!job || job.status === "done") return;
    this.update(jobId, { status: "cancelled", error: "cancelled" });
  }

  retry(jobId: string): void {
    const job = this.jobs.find((j) => j.jobId === jobId);
    if (!job || job.status !== "failed") return;
    this.update(jobId, { status: "queued", progress: 0, error: "" });
  }

  clearFinished(): void {
    this.jobs = this.jobs.filter((j) => j.status === "queued" || j.status === "running" || j.status === "failed");
    this.emit();
  }

  /** Drain the queue; safe to call repeatedly (re-entrant calls no-op). */
  async run(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (;;) {
        const next = this.jobs.find((j) => j.status === "queued");
        if (!next) break;
        await this.runJob(next.jobId);
      }
    } finally {
      this.running = false;
    }
  }

  async runJob(jobId: string): Promise<void> {
    const job = this.jobs.find((j) => j.jobId === jobId);
    if (!job || job.status === "done" || job.status === "cancelled") return;
    this.update(jobId, { status: "running", attempts: job.attempts + 1, error: "" });
    const total = Math.max(1, job.ops.length);
    for (let i = 0; i < job.ops.length; i += 1) {
      const current = this.jobs.find((j) => j.jobId === jobId);
      if (!current || current.status === "cancelled" || current.status === "done") return;
      const res = await this.transport(job.ops[i], (fraction) => {
        this.update(jobId, { progress: (i + Math.min(1, Math.max(0, fraction))) / total });
      });
      if (!res.ok) {
        const attempts = this.jobs.find((j) => j.jobId === jobId)?.attempts || 1;
        const failed = attempts >= job.maxAttempts;
        this.update(jobId, {
          status: failed ? "failed" : "queued",
          error: res.error || "op failed",
          progress: i / total,
        });
        return;
      }
      this.update(jobId, { progress: (i + 1) / total });
    }
    // A cancel that landed while the last op was in flight wins over "done".
    const final = this.jobs.find((j) => j.jobId === jobId);
    if (final && final.status === "cancelled") return;
    this.update(jobId, { status: "done", progress: 1 });
  }
}
