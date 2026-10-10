// [F41] Telemetry store - /api/progress (mirror + log + run clocks), /ping
// wire state, /health ws probe, and the 1s tick values (bottom bar + banner).
import { create } from "zustand";
import { parseTs, SESSION_WINDOW_MS } from "@/lib/format";
import { mirrorModel, type MirrorModel } from "@/lib/domain/progress";
import type { WireState } from "@/lib/domain/connProbe";
// [R-METRICS / #212] the authoritative-deadline view model. The 5h30 constant
// stays available as a POLICY fallback only; it is never the first answer.
import { remainingTime, type RemainingTime } from "@/lib/domain/metrics";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

interface UsageState {
  sec: number;
  active: boolean;
  at: number;
  ageSec: number | null;
}

interface TelemetryState {
  progress: Any | null;
  progressLost: boolean;
  mirror: MirrorModel | null;
  speedHistory: number[];
  logLines: string[];
  logPaused: boolean;
  clockOffsetMs: number;
  runStartedAtMs: number | null;
  sessionStartedAtMs: number | null;
  /**
   * [R-METRICS / #212] The server-published session deadline
   * (/api/progress `sessionEnd` = min(githubDeadline, keepAliveDeadline,
   * watcherDeadline)). Null when the server did not publish one or it did not
   * parse. This is the AUTHORITATIVE remaining-time source when present.
   */
  sessionEndMs: number | null;
  /** The raw `sessionEnd` string, kept so a re-parse is never needed. */
  sessionEndRaw: string;
  /** [R-METRICS] epoch-ms of the last successful /api/progress answer. */
  progressAtMs: number | null;
  /** [R-METRICS] epoch-ms of the last successful /ping wire sample. */
  rttAtMs: number | null;
  wire: WireState | null;
  rttSamples: number[];
  httpRtt: number | null;
  wsLive: boolean;
  /** [F94 §3.5] Does the SERVER advertise a /ws endpoint? Informational only:
   *  it must never gate whether we TRY to connect (that gate was the deadlock
   *  that left the pill reading "idle" forever). */
  wsAvailable: boolean;
  /** [F95 §3.4 / R4] the reconnect ladder is EXHAUSTED. Distinct from
   *  `wsLive === false`, which is also true during a healthy retry: this one
   *  means "stop pretending, tell the operator and offer a button". */
  wsDead: boolean;
  /** [F95 §3.4 / R4] how many consecutive reconnect attempts have failed. */
  wsAttempts: number;
  /** [F95 §3.4 / R4] why the last attempt failed, machine-readable. */
  wsDeadReason: string;
  /** [F96 §2.1] epoch-ms of the last successful /ws open. Feeds the diagnostic
   *  bundle's webSocket.lastConnect - without it the bundle could only say
   *  "not connected", never whether it EVER connected. */
  wsLastConnectAt: number | null;
  /** [F96 §2.1] epoch-ms of the last /ws close. */
  wsLastDisconnectAt: number | null;
  /** [F96 §2.1] close code + reason of the last /ws close, as the browser
   *  reported them (e.g. "1006" / ""). This is the ONLY witness of why the
   *  socket died; the reconnect ladder cannot distinguish a refused upgrade
   *  from a network drop. */
  wsLastDisconnectReason: string;
  /** [F101 §2.4 / N4] epoch-ms of the last keepalive seen from the server
   *  (the app-level {"type":"ping"} every 20s, or ANY frame). The watchdog in
   *  useDashboardPolling force-reconnects 30s after this stops moving, which
   *  is what turns a half-open socket from "idle forever" into a recovery. */
  wsLastPingAt: number | null;
  rdpUsage: UsageState | null;
  rdpLogonFallback: { sec: number; at: number } | null;
  usageFrozen: boolean;
  serverNow: () => number;
  setProgress: (d: Any) => void;
  setLogPaused: (v: boolean) => void;
  setWire: (w: WireState | null | undefined, httpRtt: number | null) => void;
  setWsLive: (v: boolean) => void;
  setWsAvailable: (v: boolean) => void;
  /** [F95 §3.4 / R4] publish the ladder-exhausted state (attempts reset on any
   *  successful open). */
  setWsDead: (v: boolean, reason?: string) => void;
  setWsAttempts: (n: number) => void;
  /** [F96 §2.1] record a successful socket open. */
  setWsConnectedAt: (atMs: number) => void;
  /** [F101 §2.4 / N4] record a keepalive receipt (server PING or any frame). */
  setWsLastPingAt: (atMs: number) => void;
  /** [F96 §2.1] record a socket close with the browser's own code/reason. */
  setWsDisconnectedAt: (atMs: number, reason: string) => void;
  /** [F95 §3.4 / R4] manual reconnect requested by the operator. Bumped so the
   *  polling hook can watch it and rebuild the socket immediately. */
  wsReconnectNonce: number;
  requestWsReconnect: () => void;
  setUsage: (u: UsageState | null) => void;
  setLogonFallback: (v: { sec: number; at: number } | null) => void;
  setUsageFrozen: (v: boolean) => void;
  sessionExpired: boolean;
  setSessionExpired: (v: boolean) => void;
}

export const useTelemetryStore = create<TelemetryState>((set, get) => ({
  progress: null,
  progressLost: false,
  mirror: null,
  speedHistory: [],
  logLines: [],
  logPaused: false,
  clockOffsetMs: 0,
  runStartedAtMs: null,
  sessionStartedAtMs: null,
  sessionEndMs: null,
  sessionEndRaw: "",
  progressAtMs: null,
  rttAtMs: null,
  wire: null,
  rttSamples: [],
  httpRtt: null,
  wsLive: false,
  wsAvailable: false,
  wsDead: false,
  wsAttempts: 0,
  wsDeadReason: "",
  wsLastConnectAt: null,
  wsLastDisconnectAt: null,
  wsLastDisconnectReason: "",
  wsLastPingAt: null,
  wsReconnectNonce: 0,
  rdpUsage: null,
  rdpLogonFallback: null,
  usageFrozen: false,
  sessionExpired: false,

  serverNow: () => Date.now() + get().clockOffsetMs,

  setProgress: (d) => {
    if (!d) {
      set({ progressLost: true });
      return;
    }
    const patch: Partial<TelemetryState> = { progress: d, progressLost: false, progressAtMs: Date.now() };
    if (d.serverTs) {
      const st = parseTs(d.serverTs);
      if (!isNaN(st)) patch.clockOffsetMs = st - Date.now();
    }
    // [R-METRICS / #212] RUN IDENTITY CHANGES. The old code latched
    // runStartedAtMs once and never revisited it, so a new GitHub run kept the
    // previous run's start - and therefore a remaining-time figure derived from
    // the wrong run. A change of more than 1s is a new run: re-seat the start
    // AND drop the cached deadline, because a deadline that belonged to the old
    // run must never be rendered against the new one.
    const incomingRun =
      parseFirst(d.runStartedAt, d.startedAt) ;
    if (incomingRun != null) {
      const cur = get().runStartedAtMs;
      if (cur == null || Math.abs(cur - incomingRun) > 1000) {
        patch.runStartedAtMs = incomingRun;
        patch.sessionEndMs = null;
        patch.sessionEndRaw = "";
      }
    }
    if (!get().sessionStartedAtMs && d.sessionStartedAt) {
      const ss = parseTs(d.sessionStartedAt);
      if (!isNaN(ss)) patch.sessionStartedAtMs = ss;
    }
    // [R-METRICS / #212] the authoritative deadline. Only a value that parses
    // is stored; an empty string or garbage leaves sessionEndMs null so the UI
    // falls back to the (labelled) policy window instead of NaN.
    // Absent key != empty value. A payload that omits `sessionEnd` entirely
    // says nothing about the deadline, so the cached one stays; a payload that
    // carries an empty (or unparseable) value is an explicit "no deadline" and
    // clears it. Treating the two alike would drop a good deadline on every
    // partial frame.
    if (Object.prototype.hasOwnProperty.call(d, "sessionEnd")) {
      const rawEnd = d.sessionEnd == null ? "" : String(d.sessionEnd);
      if (rawEnd) {
        const end = parseTs(rawEnd);
        patch.sessionEndRaw = rawEnd;
        patch.sessionEndMs = isNaN(end) ? null : end;
      } else {
        patch.sessionEndRaw = "";
        patch.sessionEndMs = null;
      }
    }
    const mirror = mirrorModel(d, get().speedHistory);
    patch.mirror = mirror;
    patch.speedHistory = mirror.speedHistory;
    patch.logLines = Array.isArray(d.log) ? d.log.map(String) : [];
    set(patch as TelemetryState);
  },

  setLogPaused: (v) => set({ logPaused: v }),

  setWire: (w, httpRtt) => {
    const samples = get().rttSamples.slice();
    const finite = typeof httpRtt === "number" && Number.isFinite(httpRtt) ? httpRtt : null;
    if (finite != null) {
      samples.push(finite);
      if (samples.length > 60) samples.shift();
    }
    // [R-METRICS / #211] `rttAtMs` is what lets the UI say HOW OLD a sample is.
    // A number without a timestamp cannot be judged stale, and a stale number
    // presented as live is the exact failure mode this work removes.
    set({
      wire: w !== undefined ? w : get().wire,
      httpRtt: finite,
      rttSamples: samples,
      rttAtMs: Date.now(),
    });
  },

  setWsLive: (v) => set({ wsLive: v }),
  setWsAvailable: (v) => set({ wsAvailable: v }),
  setWsDead: (v, reason) => set({ wsDead: v, wsDeadReason: v ? String(reason || "ladder-exhausted") : "" }),
  setWsAttempts: (n) => set({ wsAttempts: n }),
  setWsConnectedAt: (atMs) => set({ wsLastConnectAt: atMs }),
  setWsDisconnectedAt: (atMs, reason) => set({ wsLastDisconnectAt: atMs, wsLastDisconnectReason: String(reason || "") }),
  setWsLastPingAt: (atMs) => set({ wsLastPingAt: atMs }),
  requestWsReconnect: () => set((st) => ({ wsReconnectNonce: st.wsReconnectNonce + 1, wsDead: false })),
  setUsage: (u) => set({ rdpUsage: u }),
  setLogonFallback: (v) => set({ rdpLogonFallback: v }),
  setUsageFrozen: (v) => set({ usageFrozen: v }),
  setSessionExpired: (v) => set({ sessionExpired: v }),
}));

export function elapsedSeconds(runStartedAtMs: number | null, now: number): number | null {
  if (!runStartedAtMs || !Number.isFinite(runStartedAtMs) || !Number.isFinite(now)) return null;
  return Math.max(0, (now - runStartedAtMs) / 1000);
}

/**
 * [R-METRICS / #212] Remaining session seconds.
 *
 * The old signature returned the 5h30 POLICY WINDOW when the run start was
 * unknown, which rendered a confident 05:30:00 with nothing behind it. The
 * new contract returns the server-published deadline when it exists, the
 * labelled policy window second, and `null` when neither is knowable.
 */
export function remainingTimeFromStore(args: {
  sessionEndMs: number | null;
  runStartedAtMs: number | null;
  now: number;
  policyWindowMs?: number;
}): RemainingTime {
  return remainingTime({
    sessionEndMs: args.sessionEndMs,
    runStartedAtMs: args.runStartedAtMs,
    nowMs: args.now,
    policyWindowMs: args.policyWindowMs == null ? SESSION_WINDOW_MS : args.policyWindowMs,
  });
}

/** Back-compat shim: the number only. Prefer remainingTimeFromStore (it names
 *  the basis). Kept so an old call site cannot silently keep a false 05:30:00 -
 *  it now gets `null`, which renders as an unknown state. */
export function remainingSeconds(sessionEndMs: number | null, runStartedAtMs: number | null, now: number): number | null {
  return remainingTimeFromStore({ sessionEndMs, runStartedAtMs, now }).seconds;
}

/** First value that parses to a finite epoch-ms. */
function parseFirst(...raws: unknown[]): number | null {
  for (const r of raws) {
    if (r == null || r === "") continue;
    const t = parseTs(r);
    if (!isNaN(t) && Number.isFinite(t)) return t;
  }
  return null;
}
