// [F41] Mirror/progress view model - port of the F38 ui.html render() mirror
// section (honest overall percent capped at 99.9 until done==total, 6-stat
// grid, active file, speed history, roots, publish status, file rows).
import { fmtBytes, fmtDurShort } from "../format";
import { asList } from "./telescope";
import { mirrorBytes, mirrorPercent, mirrorTransfer } from "./mirrorBytes";

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
  // [F46 §4] encryption honesty: what the WORKER reported, never what the card
  // wishes. `encryptedAny` is true only when a file row carries encrypted=True.
  encryptMode: string;
  encryptRequested: boolean;
  encryptedAny: boolean;
  // [F47 §3] the algorithm the worker actually used for the encrypted rows
  // (AES-256-GCM | AES-256-CBC-PBKDF2 | '' when nothing was encrypted).
  encAlg: string;
  plaintextElected: boolean;
  encryptionDefect: boolean;
  // [F46 §1] the complete, untruncated failure reason per file plus the raw
  // attempt records behind it (the same table the mirror-diag artifact carries).
  files: {
    name: string;
    phase: string;
    pct: number;
    size: string;
    status: string;
    error: string;
    link: string;
    expired: boolean;
    host: string;
    encrypted: string;
    encryptMode: string;
    statusLabel: string;
    byteCounts: string;
    attempts: { n: number; line: string }[];
  }[];
  speedHistory: number[];
}

export function mirrorModel(d: Any, prevHistory: number[]): MirrorModel {
  const pData = (d && d.progress) || d || {};
  const agg = pData.agg || {};
  const telemetry = pData.telemetry || {};
  const tot = Number(agg.total) || 0;
  const dn = Number(agg.done) || 0;
  const act = pData.active || {};
  const diag = pData.mirrorDiag || {};
  const live = !!act.name && (act.phase === "http" || act.phase === "upload");
  const transfer = mirrorTransfer(act, live);
  const liveBytes = agg.bytesSent ?? agg.bytesDone;
  const pct = mirrorPercent(liveBytes, agg.bytesTotal);
  const spd = transfer.speed;
  let speedHistory: number[];
  const hs = pData.speedHistory && pData.speedHistory.length ? pData.speedHistory.slice(-90) : null;
  if (hs) speedHistory = hs;
  else {
    speedHistory = prevHistory.slice();
    speedHistory.push(spd);
    if (speedHistory.length > 90) speedHistory.shift();
  }
  let eta = dn === tot && tot > 0 ? "done" : "-";
  if (spd > 0 && transfer.window > 0n && !transfer.stalled) {
    const totalBytes = mirrorBytes(agg.bytesTotal);
    const sentBytes = mirrorBytes(liveBytes);
    eta = fmtDurShort(Number(totalBytes > sentBytes ? totalBytes - sentBytes : 0n) / spd);
  }
  let encryptMode = String((live && act.encryptMode) || pData.encryptMode || diag.encryptMode || d.encryptMode || "none");
  if (!encryptMode) encryptMode = "none";
  const encryptRequested = encryptMode === "all" || encryptMode === "media-plain";
  let encryptedAny = false;
  const encAlg = String(diag.encAlg || "");
  const files = asList(pData.files).slice(0, 50).map((f: Any) => {
    const rowLive = ["active", "uploading", "stalled"].includes(f.status) && ["http", "upload"].includes(f.phase);
    const rowTransfer = mirrorTransfer(rowLive && act.name === f.name ? act : f.progress || f, rowLive);
    let pf = f.bytesSent !== undefined ? mirrorPercent(f.bytesSent, f.size) : Number(f.pct) || 0;
    if (rowLive && act.name === f.name) pf = mirrorPercent(transfer.sent, transfer.size);
    const mode = String(f.encryptMode || encryptMode);
    const isExpired = f.status === "expired";
    return {
      name: String(f.name ?? ""),
      phase: String(f.phase ?? ""),
      pct: pf,
      size: fmtBytes(f.size),
      status: rowTransfer.stalled ? "stalled" : String(f.status || "pending"),
      statusLabel: rowTransfer.label || String(f.status || "pending"),
      encryptMode: mode,
      byteCounts: mirrorBytes(f.bytesSent).toString() + " / " + mirrorBytes(f.size).toString() + " bytes",
      error: f.error ? String(f.error) : "",
      link: isExpired ? "" : f.link ? String(f.link) : "",
      expired: isExpired,
      host: f.host ? String(f.host) : "",
      encrypted: f.encrypted ? String(f.encrypted) : "False",
      attempts: asList(f.attempts).map((a: Any) => ({
        n: Number(a && a.n) || 0,
        line:
          "attempt " +
          String((a && a.n) ?? "?") +
          " host=" +
          String((a && a.host) ?? "-") +
          " phase=" +
          String((a && a.phase) ?? "-") +
          " status=" +
          String(a && a.status !== null && a.status !== undefined && a.status !== "" ? a.status : "-") +
          " msg=" +
          String((a && a.msg) ?? "") +
          " ms=" +
          String((a && a.ms) ?? 0) +
          " encryptMode=" + String((a && a.encryptMode) || mode),
      })),
    };
  });
  for (const row of files) if (row.encrypted === "True") encryptedAny = true;
  const plaintextElected = pData.mirrorPlaintextElection === true || d.mirrorPlaintextElection === true;
  const encryptionDefect = asList(pData.files).some((f: Any) =>
    (f.auto === "True" || f.auto === true || diag.optIn) && String(f.encryptMode || encryptMode) !== "all"
  );
  let pubDot: "" | "ok" | "warn" = "";
  let pubTxt = "Mirror disabled";
  if (live) {
    pubDot = "warn";
    pubTxt = transfer.label || "Uploading " + String(act.name);
  } else if (dn > 0 || files.some((f) => f.status === "done")) {
    pubDot = "ok";
    pubTxt = Math.max(dn, files.filter((f) => f.status === "done").length) + " uploaded";
  } else if (files.some((f) => f.status === "active")) {
    pubDot = "warn";
    pubTxt = "Preparing encrypted upload";
  } else if (files.some((f) => f.status === "failed") || Number(agg.failed) > 0) {
    pubDot = "warn";
    pubTxt = "Upload failed - see labeled reason";
  } else if (tot > 0 || files.length > 0) {
    pubDot = "warn";
    pubTxt = "Queued: " + Math.max(tot - dn, files.length) + " files";
  } else if (d.mirrorIndexUrl || d.rentryNewUrl) {
    pubDot = "ok";
    pubTxt = "Indexes published";
  } else if (d.mirror || diag.autoUpload === "downloads-always-on") {
    pubDot = "warn";
    pubTxt = diag.autoUpload === "downloads-always-on" ? "Downloads auto-upload ready" : "Waiting for first upload...";
  }
  return {
    pct,
    pctText: pct.toFixed(1) + "%",
    done: dn + "/" + tot,
    failed: String(Number(agg.failed) || 0),
    bytes: fmtBytes(liveBytes),
    bytesSub: "of " + fmtBytes(agg.bytesTotal),
    speed: transfer.stalled ? transfer.label : fmtBytes(spd) + "/s",
    scans: String(Number(telemetry.scans) || 0),
    scansSub: "last: " + (telemetry.lastScan ? String(telemetry.lastScan).substring(11, 19) : "-"),
    eta,
    activeName: act && act.name ? String(act.name) : "idle - no active file",
    activePhase: act && act.name ? String(act.phase || "-") + (transfer.label ? " · " + transfer.label : "") : "-",
    activePct: act && act.name ? mirrorPercent(transfer.sent, transfer.size) : 0,
    activeBytes: act && act.name ? fmtBytes(transfer.sent) + " / " + fmtBytes(transfer.size) : "0 B / 0 B",
    roots: asList(telemetry.roots).map((r: Any) => String(r)),
    pubDot,
    pubTxt,
    encryptMode,
    encryptRequested,
    encryptedAny,
    encAlg,
    plaintextElected,
    encryptionDefect,
    files,
    speedHistory,
  };
}
