// [F41] Connectivity probe view model (F11-4): badges from the /ping wire
// sample + median jitter + the c2 (Rust ws bridge) row.
import { CGNAT_RE } from "../format";

export interface WireState {
  relay?: string;
  via?: string;
  direct?: boolean;
  rtt?: number | null;
  jit?: number | null;
  hist?: number[];
}

export function connBadge(w: WireState | null | undefined): { text: string; tone: "ok" | "warn" } {
  if (!w) return { text: "PATH unknown", tone: "warn" };
  if (w.relay) return { text: "DERP " + w.relay + " via " + w.via, tone: "warn" };
  return { text: "DIRECT " + w.via, tone: "ok" };
}

export function jitMedian(a: number[]): number {
  if (a.length < 2) return 0;
  let m = 0;
  for (let k = 0; k < a.length; k++) m += a[k];
  m /= a.length;
  const d = a.map((x) => Math.abs(x - m));
  d.sort((x, y) => x - y);
  return Math.round(d[Math.floor(d.length / 2)]);
}

export function rttTone(ms: number | null): "ok" | "warn" | "bad" | "neutral" {
  if (ms == null) return "neutral";
  if (ms < 120) return "ok";
  if (ms < 300) return "warn";
  return "bad";
}

export function c2ViaText(wire: { via?: string; direct?: boolean } | null): { text: string; tone: "ok" | "warn" | "neutral" } {
  if (!wire) return { text: "path: --", tone: "neutral" };
  return {
    text: "path: " + wire.via + (wire.direct ? " (direct)" : " (relay)"),
    tone: wire.direct ? "ok" : "warn",
  };
}

export function isCgnat(ip: string): boolean {
  return CGNAT_RE.test(ip || "");
}
