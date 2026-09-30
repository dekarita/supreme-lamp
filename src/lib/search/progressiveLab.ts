// [F56-c v2] Progressive 5-minute discovery lab - PURE state machine (no
// timers, no I/O, no store access). The brief fixes three windows: 0-30s
// classifier, 30s-4min federated probes that stream partials, 4-5min
// consolidation + direct-link extraction. Every function here is a pure
// function of (elapsedMs, adapters) so a test can drive the whole five minutes
// without waiting, and the F56-d backend can replace the clock with real
// adapter events without changing this contract.
export const LAB_CLASSIFIER_END_MS = 30_000;
export const LAB_PROBES_END_MS = 240_000;
export const LAB_CONSOLIDATION_END_MS = 300_000;

// Per-adapter rail: adapters are staggered so the rail streams instead of
// flipping state in lockstep. Deterministic (sorted adapterId order) - never
// random - so the rendered rail is reproducible in tests.
export const LAB_ADAPTER_SKEW_MS = 6_000;
export const LAB_ADAPTER_PROBE_MS = 20_000;

export type LabStage = "classifier" | "probes" | "consolidation" | "complete";

export const LAB_STAGES: readonly LabStage[] = ["classifier", "probes", "consolidation", "complete"];

export interface LabProgress {
  stage: LabStage;
  stageIndex: number;
  /** Clamped elapsed time used for every derived number. */
  ms: number;
  /** Fraction (0..1) inside the current stage. */
  stageFraction: number;
  /** Fraction (0..1) across the whole five-minute window. */
  totalFraction: number;
  /** True from the consolidation window on (link extraction is its job). */
  linksExtracted: boolean;
}

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

export function labStageAt(elapsedMs: number): LabStage {
  if (!Number.isFinite(elapsedMs) || elapsedMs < LAB_CLASSIFIER_END_MS) return "classifier";
  if (elapsedMs < LAB_PROBES_END_MS) return "probes";
  if (elapsedMs < LAB_CONSOLIDATION_END_MS) return "consolidation";
  return "complete";
}

export function labStageIndex(stage: LabStage): number {
  const i = LAB_STAGES.indexOf(stage);
  return i < 0 ? 0 : i;
}

export function labProgress(elapsedMs: number): LabProgress {
  const ms = !Number.isFinite(elapsedMs) || elapsedMs < 0 ? 0 : elapsedMs;
  const stage = labStageAt(ms);
  const index = labStageIndex(stage);
  const start = index === 0 ? 0 : index === 1 ? LAB_CLASSIFIER_END_MS : index === 2 ? LAB_PROBES_END_MS : LAB_CONSOLIDATION_END_MS;
  const end = index === 0 ? LAB_CLASSIFIER_END_MS : index === 1 ? LAB_PROBES_END_MS : index === 2 ? LAB_CONSOLIDATION_END_MS : LAB_CONSOLIDATION_END_MS + 1;
  return {
    stage,
    stageIndex: index,
    ms,
    stageFraction: clamp01((ms - start) / (end - start)),
    totalFraction: clamp01(ms / LAB_CONSOLIDATION_END_MS),
    linksExtracted: index >= 2,
  };
}

/** Stage windows as [startMs, endMs) pairs - the timeline renders these. */
export function labWindows(): Array<{ stage: LabStage; startMs: number; endMs: number }> {
  return [
    { stage: "classifier", startMs: 0, endMs: LAB_CLASSIFIER_END_MS },
    { stage: "probes", startMs: LAB_CLASSIFIER_END_MS, endMs: LAB_PROBES_END_MS },
    { stage: "consolidation", startMs: LAB_PROBES_END_MS, endMs: LAB_CONSOLIDATION_END_MS },
  ];
}

export type RailState = "queued" | "probing" | "streaming" | "settled";

export interface AdapterLike {
  adapterId: string;
  status?: string;
  resultCount?: number;
}

export interface LabRailRow {
  adapterId: string;
  state: RailState;
  /** 0..1 probe completion for the rail bar. */
  fraction: number;
  resultCount: number;
  /** True when a terminal adapter status (not the clock) settled the row. */
  settledByStatus: boolean;
  /** [F56-c v3] Lab-relative probe dispatch/settle offsets (ms) so the rail
   *  can render real timestamps (labStartedAt + offset). */
  dispatchMs: number;
  settleMs: number;
}

const TERMINAL = new Set(["complete", "empty", "cancelled", "failed", "timed-out", "blocked-robots", "rate-limited"]);

/** One rail row: the clock drives the stub, a real terminal adapter status
 *  always wins (F56-d streams its own partials; the rail must not contradict
 *  the store). */
export function labRailRow(adapter: AdapterLike, index: number, elapsedMs: number): LabRailRow {
  const resultCount = adapter.resultCount || 0;
  const status = adapter.status || "idle";
  const start = LAB_CLASSIFIER_END_MS + index * LAB_ADAPTER_SKEW_MS;
  const settleAt = start + LAB_ADAPTER_PROBE_MS;
  const settledByStatus = TERMINAL.has(status);
  if (settledByStatus) return { adapterId: adapter.adapterId, state: "settled", fraction: 1, resultCount, settledByStatus, dispatchMs: start, settleMs: Math.max(0, elapsedMs) };
  if (elapsedMs >= LAB_PROBES_END_MS) return { adapterId: adapter.adapterId, state: "settled", fraction: 1, resultCount, settledByStatus: false, dispatchMs: start, settleMs: LAB_PROBES_END_MS };
  if (elapsedMs < start) return { adapterId: adapter.adapterId, state: "queued", fraction: 0, resultCount, settledByStatus: false, dispatchMs: start, settleMs: settleAt };
  const fraction = clamp01((elapsedMs - start) / LAB_ADAPTER_PROBE_MS);
  const state: RailState = elapsedMs >= settleAt ? "settled" : fraction < 0.25 ? "probing" : "streaming";
  return { adapterId: adapter.adapterId, state, fraction, resultCount, settledByStatus: false, dispatchMs: start, settleMs: settleAt };
}

/** Deterministic rail for the whole roster (sorted adapterId order). */
export function labRail(adapters: AdapterLike[], elapsedMs: number): LabRailRow[] {
  return [...adapters]
    .sort((a, b) => a.adapterId.localeCompare(b.adapterId))
    .map((a, i) => labRailRow(a, i, elapsedMs));
}

/** Total revealed (streamed) result count at a given time - the honest
 *  "partials streaming" number when adapters themselves report nothing yet. */
export function labPartialCount(rows: LabRailRow[]): number {
  return rows.reduce((n, r) => n + r.resultCount, 0);
}

// [F56-c v3] §3 visible-lab additions. The classifier window (0-30s) exposes
// a deterministic category-detection message stream so the operator can SEE the
// lab thinking even before any adapter has answered. The probe rail rows gain
// real dispatch/settle offsets (rendered as timestamps), and the consolidation
// window reports how many adapters timed out (informational, never a red banner).
export interface LabClassifierMsg {
  id: string;
  i18nKey: string;
  atMs: number;
}

export const LAB_CLASSIFIER_MSGS: readonly LabClassifierMsg[] = [
  { id: "tokens", i18nKey: "search.v3.lab.classify.tokens", atMs: 2_000 },
  { id: "language", i18nKey: "search.v3.lab.classify.language", atMs: 9_000 },
  { id: "category", i18nKey: "search.v3.lab.classify.category", atMs: 17_000 },
  { id: "licence", i18nKey: "search.v3.lab.classify.licence", atMs: 24_000 },
];

/** Deterministic message stream for the 0-30s classifier window. */
export function labClassifierStream(elapsedMs: number): readonly LabClassifierMsg[] {
  const ms = !Number.isFinite(elapsedMs) || elapsedMs < 0 ? 0 : elapsedMs;
  return LAB_CLASSIFIER_MSGS.filter((m) => ms >= m.atMs);
}

/** Adapters that never answered before the probe window closed. Informational
 *  only (v3 §3: "open Advanced to retry"), never rendered as an error banner. */
export function labTimedOut(rows: LabRailRow[], elapsedMs: number): number {
  if (!Number.isFinite(elapsedMs) || elapsedMs < LAB_PROBES_END_MS) return 0;
  return rows.filter((r) => !r.settledByStatus && r.resultCount === 0).length;
}

/** Wall-clock HH:MM:SS stamp for a lab-relative offset; "" before the lab
 *  starts. UTC keeps every operator's rail byte-identical. */
export function labStamp(labStartedAt: number, offsetMs: number): string {
  if (!labStartedAt || !Number.isFinite(offsetMs)) return "";
  return new Date(labStartedAt + offsetMs).toISOString().slice(11, 19);
}
