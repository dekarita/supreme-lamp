// [F41] Telemetry store - /api/progress (mirror + log + run clocks), /ping
// wire state, /health ws probe, and the 1s tick values (bottom bar + banner).
import { create } from "zustand";
import { parseTs, SESSION_WINDOW_MS } from "@/lib/format";
import { mirrorModel, type MirrorModel } from "@/lib/domain/progress";
import type { WireState } from "@/lib/domain/connProbe";

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
  wire: WireState | null;
  rttSamples: number[];
  httpRtt: number | null;
  wsLive: boolean;
  rdpUsage: UsageState | null;
  rdpLogonFallback: { sec: number; at: number } | null;
  usageFrozen: boolean;
  serverNow: () => number;
  setProgress: (d: Any) => void;
  setLogPaused: (v: boolean) => void;
  setWire: (w: WireState | null | undefined, httpRtt: number | null) => void;
  setWsLive: (v: boolean) => void;
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
  wire: null,
  rttSamples: [],
  httpRtt: null,
  wsLive: false,
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
    const patch: Partial<TelemetryState> = { progress: d, progressLost: false };
    if (d.serverTs) {
      const st = parseTs(d.serverTs);
      if (!isNaN(st)) patch.clockOffsetMs = st - Date.now();
    }
    if (!get().runStartedAtMs && d.runStartedAt) {
      const rs = parseTs(d.runStartedAt);
      if (!isNaN(rs)) patch.runStartedAtMs = rs;
    } else if (!get().runStartedAtMs && d.startedAt) {
      const rs2 = parseTs(d.startedAt);
      if (!isNaN(rs2)) patch.runStartedAtMs = rs2;
    }
    if (!get().sessionStartedAtMs && d.sessionStartedAt) {
      const ss = parseTs(d.sessionStartedAt);
      if (!isNaN(ss)) patch.sessionStartedAtMs = ss;
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
    if (httpRtt != null) {
      samples.push(httpRtt);
      if (samples.length > 60) samples.shift();
    }
    set({ wire: w !== undefined ? w : get().wire, httpRtt, rttSamples: samples });
  },

  setWsLive: (v) => set({ wsLive: v }),
  setUsage: (u) => set({ rdpUsage: u }),
  setLogonFallback: (v) => set({ rdpLogonFallback: v }),
  setUsageFrozen: (v) => set({ usageFrozen: v }),
  setSessionExpired: (v) => set({ sessionExpired: v }),
}));

export function elapsedSeconds(runStartedAtMs: number | null, now: number): number | null {
  if (!runStartedAtMs) return null;
  return Math.max(0, (now - runStartedAtMs) / 1000);
}

export function remainingSeconds(runStartedAtMs: number | null, now: number): number {
  const el = elapsedSeconds(runStartedAtMs, now);
  if (el == null) return SESSION_WINDOW_MS / 1000;
  return Math.max(0, SESSION_WINDOW_MS / 1000 - el);
}
