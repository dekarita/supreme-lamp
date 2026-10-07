// [F107 §5] export.ts - the operator-facing half of the `.mcrec` v2 bundle.
//
// ASSEMBLE IN THE TAB, LEAVE ON A CLICK. The bundle merges the live session
// (timeline + mutation descriptors + screenshots) with the stored-session index
// from IndexedDB and the F105 registry snapshot. The ONLY egress is a file the
// operator downloads by clicking Export - the same posture step 3 established for
// the clipboard bundle: nothing leaves the machine by itself.
//
// The download goes through a documented seam (setExportDownload) so the DOM gate
// can capture the exact bytes without a real anchor click; the gate pins that the
// shipped default (Blob + object URL + anchor) is the one wired in production.
import { buildBundleV2, bundleV2Text, validateBundleV2, type DvrBundleV2 } from "./exportCore";
import { dvrFullHandle, registrySnapshot, storedSessionDetail, storedSessions } from "./session";

export interface ExportResult {
  ok: boolean;
  reason: string;
  filename: string;
  bytes: number;
  bundle: DvrBundleV2 | null;
}

type Downloader = (filename: string, text: string) => Promise<boolean> | boolean;

/** The shipped downloader: Blob -> object URL -> one anchor click -> revoke. */
const defaultDownloader: Downloader = (filename, text) => {
  try {
    if (typeof document === "undefined" || typeof URL === "undefined") return false;
    const blob = new Blob([text], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => {
      try {
        URL.revokeObjectURL(url);
      } catch {
        /* ignore */
      }
    }, 1000);
    return true;
  } catch {
    return false;
  }
};

let downloader: Downloader = defaultDownloader;

/** The DOCUMENTED test seam; pass null to restore the shipped default. */
export function setExportDownload(fn: Downloader | null): Downloader {
  const prev = downloader;
  downloader = fn || defaultDownloader;
  return prev;
}

/** True when the shipped (non-injected) downloader is active. */
export function isDefaultDownloaderActive(): boolean {
  return downloader === defaultDownloader;
}

function buildSha(): string {
  try {
    return String((import.meta.env.VITE_BUILD_SHA as string | undefined) || "dev");
  } catch {
    return "dev";
  }
}

function lang(): string {
  try {
    return String((typeof document !== "undefined" && document.documentElement.lang) || "en");
  } catch {
    return "en";
  }
}

function route(): string {
  try {
    if (typeof window === "undefined") return "";
    return String(window.location.hash || window.location.pathname || "");
  } catch {
    return "";
  }
}

/**
 * Assemble + download the v2 bundle. With a live session it exports that one;
 * `opts.timelineOnly` exports the stored index even when no session is live
 * (the Collector's per-session Export uses the same path).
 */
export async function exportDvrV2(opts?: { now?: number; filename?: string }): Promise<ExportResult> {
  const now = opts?.now ?? Date.now();
  try {
    const h = dvrFullHandle();
    const stored = await storedSessions();
    const bundle = buildBundleV2(
      {
        timeline: h ? h.timeline() : [],
        mutations: h ? h.mutations() : [],
        shots: h ? h.shots() : [],
        sessions: stored.value || [],
        features: registrySnapshot(),
        target: { route: route(), buildSha: buildSha(), lang: lang(), ui: "v2" },
      },
      { now: now }
    );
    const check = validateBundleV2(bundle);
    if (!check.ok) return { ok: false, reason: "invalid-bundle:" + check.reason, filename: "", bytes: 0, bundle: null };
    const text = bundleV2Text(bundle);
    const filename = opts?.filename || "ghrdp-dvr-" + (h ? h.sessionId() : "index") + ".mcrec";
    const done = await Promise.resolve(downloader(filename, text));
    return { ok: !!done, reason: done ? "" : "download-refused", filename: filename, bytes: text.length, bundle: bundle };
  } catch (err) {
    return { ok: false, reason: "export-error:" + String((err && (err as Error).name) || "unknown"), filename: "", bytes: 0, bundle: null };
  }
}

/**
 * Export ONE stored session (its meta + its shots) as a v2 bundle. The timeline
 * and mutation buffers are live-session state and cannot be recovered for a past
 * session, so they are honestly empty - the storage index + shots + registry
 * snapshot still make the file a valid `.mcrec` v2.
 */
export async function exportStoredSessionV2(sessionId: string, opts?: { now?: number }): Promise<ExportResult> {
  const now = opts?.now ?? Date.now();
  try {
    const detail = await storedSessionDetail(sessionId);
    if (!detail.ok || !detail.meta) return { ok: false, reason: "session-not-found:" + detail.reason, filename: "", bytes: 0, bundle: null };
    const live = dvrFullHandle();
    const isLive = live && live.sessionId() === sessionId;
    const bundle = buildBundleV2(
      {
        timeline: isLive ? live.timeline() : [],
        mutations: isLive ? live.mutations() : [],
        shots: detail.shots,
        sessions: [detail.meta],
        features: registrySnapshot(),
        target: { route: route(), buildSha: buildSha(), lang: lang(), ui: "v2" },
      },
      { now: now }
    );
    const check = validateBundleV2(bundle);
    if (!check.ok) return { ok: false, reason: "invalid-bundle:" + check.reason, filename: "", bytes: 0, bundle: null };
    const text = bundleV2Text(bundle);
    const filename = "ghrdp-dvr-" + sessionId + ".mcrec";
    const done = await Promise.resolve(downloader(filename, text));
    return { ok: !!done, reason: done ? "" : "download-refused", filename: filename, bytes: text.length, bundle: bundle };
  } catch (err) {
    return { ok: false, reason: "export-error:" + String((err && (err as Error).name) || "unknown"), filename: "", bytes: 0, bundle: null };
  }
import { buildFullBundle, type FullSession } from "./full-core";
export function exportSession(session: FullSession): string {
  return JSON.stringify(buildFullBundle(session));
}
export function downloadSession(session: FullSession): void {
  const blob = new Blob([exportSession(session)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `session-${session.id}.mcrec`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
