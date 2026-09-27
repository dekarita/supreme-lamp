// [F41] Mirror/progress view model - port of the F38 ui.html render() mirror
// section (honest overall percent capped at 99.9 until done==total, 6-stat
// grid, active file, speed history, roots, publish status, file rows).
import { fmtBytes, fmtDurShort } from "../format";
import { asList } from "./telescope";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

export interface MirrorModel {
  pct: number;
  pctText: string;
  done: string;
  failed: string;
  bytes: string;
  bytesSub: string;
  speed: string;
  scans: string;
  scansSub: string;
  eta: string;
  activeName: string;
  activePhase: string;
  activePct: number;
  activeBytes: string;
  roots: string[];
  pubDot: "" | "ok" | "warn";
  pubTxt: string;
  files: { name: string; phase: string; pct: number; size: string; status: string; error: string; link: string; expired: boolean }[];
  speedHistory: number[];
}

export function mirrorModel(d: Any, prevHistory: number[]): MirrorModel {
  const pData = d || {};
  const agg = pData.agg || {};
  const telemetry = pData.telemetry || {};
  const tot = Number(agg.total) || 0;
  const dn = Number(agg.done) || 0;
  const pct = tot > 0 ? Math.min((dn / tot) * 100, dn === tot ? 100 : 99.9) : 0;
  const spd = Number(agg.speedBps) || 0;
  let speedHistory: number[];
  const hs = d.speedHistory && d.speedHistory.length ? d.speedHistory.slice(-90) : null;
  if (hs) speedHistory = hs;
  else {
    speedHistory = prevHistory.slice();
    speedHistory.push(spd);
    if (speedHistory.length > 90) speedHistory.shift();
  }
  let eta: string;
  if (spd > 0 && tot > dn) {
    const remBytes = (Number(agg.bytesTotal) || 0) - (Number(agg.bytesDone) || 0);
    eta = fmtDurShort(remBytes / spd);
  } else {
    eta = dn === tot && tot > 0 ? "done" : "-";
  }
  const act = pData.active || {};
  const files = asList(pData.files).slice(0, 50).map((f: Any) => {
    let pf = Number(f.pct) || 0;
    if (f.status === "active" && act.name && act.name === f.name) pf = Number(act.pct) || pf;
    const isExpired = f.status === "expired";
    return {
      name: String(f.name ?? ""),
      phase: String(f.phase ?? ""),
      pct: pf,
      size: fmtBytes(f.size),
      status: String(f.status || "pending"),
      error: f.error ? String(f.error) : "",
      link: isExpired ? "" : f.link ? String(f.link) : "",
      expired: isExpired,
    };
  });
  let pubDot: "" | "ok" | "warn" = "";
  let pubTxt = "Mirror disabled";
  if (d.mirrorIndexUrl || d.rentryNewUrl) {
    pubDot = "ok";
    pubTxt = "Indexes published";
  } else if (d.mirror) {
    pubDot = "warn";
    pubTxt = "Waiting for first upload...";
  }
  return {
    pct,
    pctText: pct.toFixed(1) + "%",
    done: dn + "/" + tot,
    failed: String(Number(agg.failed) || 0),
    bytes: fmtBytes(agg.bytesDone),
    bytesSub: "of " + fmtBytes(agg.bytesTotal),
    speed: fmtBytes(spd) + "/s",
    scans: String(Number(telemetry.scans) || 0),
    scansSub: "last: " + (telemetry.lastScan ? String(telemetry.lastScan).substring(11, 19) : "-"),
    eta,
    activeName: act && act.name ? String(act.name) : "idle - no active file",
    activePhase: act && act.name ? String(act.phase || "-") : "-",
    activePct: act && act.name ? Number(act.pct) || 0 : 0,
    activeBytes: act && act.name ? fmtBytes(act.bytesDone) + " / " + fmtBytes(act.bytesTotal) : "0 B / 0 B",
    roots: asList(telemetry.roots).map((r: Any) => String(r)),
    pubDot,
    pubTxt,
    files,
    speedHistory,
  };
}
