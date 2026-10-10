// [R-METRICS / #211 / #212] Truthful measurement plumbing.
//
// WHY THIS FILE EXISTS. The dashboard used to render several different physical
// quantities under one ambiguous label:
//   * `connRtt` showed the Tailscale wire RTT when it existed and the browser's
//     own HTTP round-trip otherwise - two different measurements, one label.
//   * `jit` rendered `0 ms` whenever fewer than two samples existed, which
//     reads as "measured, perfectly stable" when nothing was measured at all.
//   * status.remaining rendered the 5h30 policy window as if it were a live
//     measured deadline even when the server published `sessionEnd`.
//   * the speed-history caption claimed a server cadence for an array that the
//     client also fills at the poll cadence.
//
// The rule this module enforces: a number is never shown without saying WHAT
// produced it, and "we do not know" is a first-class state (null), never 0.
//
// Pure + dependency-free: no store, no React, no network. Idempotent, never
// throws on hostile input (NaN, Infinity, negative, null, non-array).

/** Where a number came from. This is the label, not decoration. */
export type MetricSource =
  /** measured by the dashboard's own fetch() timing (browser -> /ping) */
  | "browser-http"
  /** /ping `wire` object - the Tailscale-reported path statistics */
  | "tailscale-wire"
  /** /api/native-status pingPath/pingMs - a probe the runner performed */
  | "native-probe"
  /** computed by the server (mirror speed, aggregates, speedHistory) */
  | "server-derived"
  /** a configured constant, e.g. the 5h30 keep-alive policy window */
  | "policy"
  /** the transport simply does not publish this quantity (e.g. FPS) */
  | "not-exposed";

export type MeasurementReason =
  | "no-sample"
  | "insufficient-samples"
  | "not-exposed"
  | "invalid"
  | "expired";

export interface Measurement<T> {
  value: T | null;
  source: MetricSource;
  /** epoch-ms the sample was taken; null when unknown. */
  atMs: number | null;
  /** true when a value exists but is older than the caller's max age. */
  stale: boolean;
  /** why value === null (absent when a value exists). */
  reason?: MeasurementReason;
}

/** Jitter needs at least two samples; one sample has no dispersion. */
export const MIN_JITTER_SAMPLES = 2;

function finiteOrNull(n: unknown): number | null {
  // Guard BEFORE Number(): Number(null), Number("") and Number([]) are all 0,
  // so a missing sample would otherwise become a real, displayed zero.
  if (n == null || n === "") return null;
  if (typeof n === "boolean") return null;
  const v = typeof n === "number" ? n : Number(n);
  return Number.isFinite(v) ? v : null;
}

/** Wrap a raw value with its provenance. */
export function measure<T>(
  value: T | null,
  source: MetricSource,
  atMs: number | null = null,
  maxAgeMs: number | null = null,
  reason: MeasurementReason = "no-sample",
): Measurement<T> {
  if (value == null) {
    return { value: null, source, atMs, stale: false, reason: source === "not-exposed" ? "not-exposed" : reason };
  }
  const at = finiteOrNull(atMs);
  let stale = false;
  if (at != null && maxAgeMs != null && finiteOrNull(maxAgeMs) != null) {
    stale = Date.now() - at > (maxAgeMs as number);
  }
  return { value, source, atMs: at, stale };
}

/**
 * Median absolute deviation of a sample window, in the same unit as the input.
 *
 * Returns `null` (never 0) when there are fewer than MIN_JITTER_SAMPLES usable
 * samples: "we have not measured dispersion yet" is not "dispersion is zero".
 * Non-finite and non-positive samples are discarded, not coerced.
 */
export function jitterFromSamples(samples: readonly unknown[]): number | null {
  if (!Array.isArray(samples)) return null;
  const usable: number[] = [];
  for (const s of samples) {
    const v = finiteOrNull(s);
    if (v != null) usable.push(v);
  }
  if (usable.length < MIN_JITTER_SAMPLES) return null;
  const mean = usable.reduce((a, b) => a + b, 0) / usable.length;
  const dev = usable.map((x) => Math.abs(x - mean)).sort((a, b) => a - b);
  const mid = Math.floor(dev.length / 2);
  const mad = dev.length % 2 === 0 ? (dev[mid - 1] + dev[mid]) / 2 : dev[mid];
  return Math.round(mad);
}

/** How many usable samples a jitter figure was computed from. */
export function usableSampleCount(samples: readonly unknown[]): number {
  if (!Array.isArray(samples)) return 0;
  let n = 0;
  for (const s of samples) if (finiteOrNull(s) != null) n += 1;
  return n;
}

/**
 * Round-trip time selection with an explicit, DIFFERENT label per producer.
 * The call site must render both rows (or say which one it picked) - never
 * silently substitute one transport's RTT for another's.
 */
export interface RttPairInput {
  /** browser-measured HTTP round trip (ms) */
  httpRtt: number | null;
  /** /ping wire.rtt - Tailscale's own view (ms) */
  wireRtt: number | null;
  atMs?: number | null;
  maxAgeMs?: number | null;
}

export interface RttPair {
  http: Measurement<number>;
  tailscale: Measurement<number>;
  /** what the old single `connRtt` slot should show, and its honest label. */
  preferred: Measurement<number>;
  /** true when the two producers disagree by more than 25% - worth showing both. */
  divergent: boolean;
}

export function rttPair(input: RttPairInput): RttPair {
  const { httpRtt, wireRtt, atMs = null, maxAgeMs = null } = input;
  const http = measure(finiteOrNull(httpRtt), "browser-http", atMs, maxAgeMs);
  const tailscale = measure(finiteOrNull(wireRtt), "tailscale-wire", atMs, maxAgeMs);
  // Preference order: the Tailscale wire figure describes the path the RDP
  // session actually travels; the browser HTTP figure describes the dashboard's
  // own request. When only one exists we show that one - labelled.
  const preferred = tailscale.value != null ? tailscale : http;
  const a = http.value;
  const b = tailscale.value;
  let divergent = false;
  if (a != null && b != null) {
    const hi = Math.max(a, b);
    const lo = Math.min(a, b);
    divergent = hi > 0 && (hi - lo) / hi > 0.25;
  }
  return { http, tailscale, preferred, divergent };
}

export type RemainingBasis = "server-session-end" | "policy-window" | "unknown";

export interface RemainingTime {
  /** null when there is no honest deadline to show (never a fabricated one). */
  seconds: number | null;
  basis: RemainingBasis;
  expired: boolean;
  /** the deadline actually used, epoch-ms. */
  deadlineMs: number | null;
}

/**
 * Remaining session time.
 *
 * Preference: the server-published `sessionEnd` (/api/progress, min of the
 * github/keep-alive/watcher deadlines) is AUTHORITATIVE when it parses. The
 * 5h30 constant is a POLICY WINDOW: it is only a fallback and it is labelled
 * as one. When neither exists the answer is null - the UI must render an
 * unknown state instead of a confident countdown.
 *
 * Handles: missing start, missing deadline, run identity changes (the caller
 * clears sessionEndMs when runStartedAtMs moves), invalid/NaN values, and
 * deadlines already in the past.
 */
export function remainingTime(args: {
  sessionEndMs?: number | null;
  runStartedAtMs?: number | null;
  nowMs: number;
  policyWindowMs: number;
}): RemainingTime {
  const now = finiteOrNull(args.nowMs);
  if (now == null) return { seconds: null, basis: "unknown", expired: false, deadlineMs: null };

  const deadline = finiteOrNull(args.sessionEndMs);
  if (deadline != null && deadline > 0) {
    const sec = (deadline - now) / 1000;
    return { seconds: Math.max(0, sec), basis: "server-session-end", expired: sec <= 0, deadlineMs: deadline };
  }

  const start = finiteOrNull(args.runStartedAtMs);
  const window = finiteOrNull(args.policyWindowMs);
  if (start != null && start > 0 && window != null && window > 0) {
    const sec = (start + window - now) / 1000;
    return { seconds: Math.max(0, sec), basis: "policy-window", expired: sec <= 0, deadlineMs: start + window };
  }

  return { seconds: null, basis: "unknown", expired: false, deadlineMs: null };
}

export type SpeedSeriesOrigin = "server" | "client-fallback" | "empty";

export interface SpeedSeriesInfo {
  origin: SpeedSeriesOrigin;
  /** how many samples are actually on screen. */
  count: number;
  /** the cadence the caption may claim, ms. null when unknown. */
  cadenceMs: number | null;
  /** the observed span, ms. null when it cannot be derived. */
  spanMs: number | null;
  /**
   * true when the array was produced by the client poll loop, in which case a
   * caption claiming the SERVER cadence would be false.
   */
  serverCadenceWouldBeFalse: boolean;
}

/**
 * Describe a speed-history array so the caption can tell the truth.
 *
 * The server appends on the watcher's 5 s loop and caps at 90 samples; the
 * client fallback pushes once per 3 s progress poll and caps at 90 as well.
 * Same length, different span - so the caption must follow the ORIGIN, not the
 * array length.
 */
export function speedSeriesInfo(args: {
  history: readonly unknown[];
  serverProvided: boolean;
  serverCadenceMs?: number;
  clientCadenceMs?: number;
}): SpeedSeriesInfo {
  const hist = Array.isArray(args.history) ? args.history : [];
  const usable = hist.map(finiteOrNull).filter((v): v is number => v != null);
  const count = usable.length;
  if (count === 0) {
    return { origin: "empty", count: 0, cadenceMs: null, spanMs: null, serverCadenceWouldBeFalse: false };
  }
  const cadence = args.serverProvided
    ? finiteOrNull(args.serverCadenceMs ?? 5000)
    : finiteOrNull(args.clientCadenceMs ?? 3000);
  const span = cadence != null ? cadence * count : null;
  return {
    origin: args.serverProvided ? "server" : "client-fallback",
    count,
    cadenceMs: cadence,
    spanMs: span,
    serverCadenceWouldBeFalse: !args.serverProvided,
  };
}

/** Stable, machine-readable labels for tests and for the DOM (data-* attrs). */
export const METRIC_SOURCE_LABEL: Record<MetricSource, string> = {
  "browser-http": "browser-http",
  "tailscale-wire": "tailscale-wire",
  "native-probe": "native-probe",
  "server-derived": "server-derived",
  policy: "policy",
  "not-exposed": "not-exposed",
};
