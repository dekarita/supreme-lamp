// [F96 §2.2/§2.3] THE DIAGNOSTIC BUNDLE.
//
// WHY: every F93-F95 diagnosis was made from a screenshot, because the operator
// cannot paste code, run a debugger, or read the runner's logs. The server route
// /api/diag/comprehensive (payloads/ghrdp-server.ps1) answers the SERVER half of
// "which subsystem is broken, and why"; this module answers the CLIENT half and
// merges the two, so ONE pasted JSON file carries both sides of every symptom.
//
// THE MERGE IS THE POINT: the server can prove the watcher never started and
// that the F28 scanner accepted a type-2 logon, but it CANNOT see the operator's
// browser - the viewing mode, the socket's close code, the reconnect count all
// live here. Without this merge the operator would have to describe the browser,
// which is exactly what they cannot do.
//
// Nothing in here reads a credential: the bundle deliberately carries usernames,
// hostnames and IP addresses only, and the dash token travels in the request
// header exactly as every other read route sends it.
import { apiBase, getKey } from "@/lib/api";
import { explainViewingMode, readManualWebDesktop, resolveViewingMode } from "@/lib/launchUrl";
import { useTelemetryStore } from "@/stores/telemetryStore";

/** The server's document, plus the two client-merged blocks. Loose on purpose:
 *  a NEW server key must never break the download (the bundle is a diagnostic,
 *  not a contract), and a bundle from an older server build must still merge. */
export type DiagBundle = Record<string, unknown> & {
  webSocket?: Record<string, unknown>;
  viewingMode?: Record<string, unknown>;
  advisories?: string[];
};

function iso(atMs: number | null): string | null {
  if (!atMs || !Number.isFinite(atMs)) return null;
  try {
    return new Date(atMs).toISOString();
  } catch {
    return null;
  }
}

/**
 * [F96 §2.1] The client half of the bundle.
 *
 * `status` is deliberately a three-way and NOT a boolean:
 *   connected    - a socket is open right now;
 *   disconnected - the F95 ladder is exhausted (wsDead), i.e. this is a REAL
 *                  verdict the operator should act on;
 *   idle         - no socket, ladder still retrying: transient, not a verdict.
 * Collapsing `idle` into `disconnected` would report a healthy 1s retry as a
 * fault, which is the same class of lie the F93/F95 work removed.
 */
export function clientDiagOverlay(): Record<string, unknown> {
  const st = useTelemetryStore.getState();
  const status = st.wsDead ? "disconnected" : st.wsLive ? "connected" : "idle";
  const view = explainViewingMode();
  const resolved = resolveViewingMode();
  const manual = readManualWebDesktop();
  return {
    webSocket: {
      endpoint: (typeof location !== "undefined" ? (location.protocol === "https:" ? "wss://" : "ws://") + location.host : "") + "/ws",
      status,
      lastConnect: iso(st.wsLastConnectAt),
      lastDisconnect: iso(st.wsLastDisconnectAt),
      disconnectReason: st.wsLastDisconnectReason || (st.wsDeadReason ? st.wsDeadReason : null),
      reconnectAttempts: st.wsAttempts,
      wsLive: st.wsLive,
      wsAvailable: st.wsAvailable,
      wsDead: st.wsDead,
      ladderExhaustedReason: st.wsDeadReason || null,
      clientMerged: true,
    },
    viewingMode: {
      detected: view.label,
      manualOverride: manual ? "WEB_DESKTOP (manual)" : null,
      detectionReasoning: [
        "client: " + view.reason,
        "client: resolved mode=" + resolved.mode + " detected=" + resolved.detected + " confirmed=" + resolved.confirmed,
        "client: host=" + view.signals.host + " viewport=" + view.signals.viewport + " dpr=" + view.signals.dpr + " framed=" + view.signals.framed,
        "client: manualWebDesktop=" + (manual || "not set"),
      ],
      clientMerged: true,
    },
    clientInfo: {
      userAgent: typeof navigator !== "undefined" ? String(navigator.userAgent) : "",
      origin: typeof location !== "undefined" ? String(location.origin) : "",
      dashTokenPresent: Boolean(getKey()),
      visibilityState: typeof document !== "undefined" ? String(document.visibilityState || "") : "",
      capturedAt: new Date().toISOString(),
    },
  };
}

/** Deep-ish merge: the client block wins key-by-key, so a server key we do not
 *  know about survives into the downloaded file. */
export function mergeDiagBundle(server: DiagBundle): DiagBundle {
  const client = clientDiagOverlay();
  const out: DiagBundle = { ...server };
  for (const [group, block] of Object.entries(client)) {
    const existing = out[group];
    if (existing && typeof existing === "object" && !Array.isArray(existing) && block && typeof block === "object") {
      out[group] = { ...(existing as Record<string, unknown>), ...(block as Record<string, unknown>) };
    } else {
      out[group] = block;
    }
  }
  const advisories = Array.isArray(out.advisories) ? out.advisories.slice() : [];
  advisories.push("client: webSocket.status/viewingMode/clientInfo come from the OPERATOR'S BROWSER (clientMerged=true); every other key comes from the runner.");
  out.advisories = advisories;
  return out;
}

export type DiagFetch =
  | { ok: true; bundle: DiagBundle }
  | { ok: false; errorKey: string; status?: number };

/** GET /api/diag/comprehensive and merge the client half over it. */
export async function fetchComprehensiveDiag(): Promise<DiagFetch> {
  const key = getKey();
  const url = apiBase() + "/api/diag/comprehensive" + (key ? "?key=" + encodeURIComponent(key) : "");
  try {
    const r = await fetch(url, { cache: "no-store", headers: key ? { "X-Dash-Token": key } : undefined });
    if (r.status === 429) return { ok: false, errorKey: "diagBundle.errors.rateLimited", status: 429 };
    if (!r.ok) return { ok: false, errorKey: "diagBundle.errors.server", status: r.status };
    const body = (await r.json()) as DiagBundle;
    return { ok: true, bundle: mergeDiagBundle(body) };
  } catch {
    // The request never reached the server. The F95 lesson: name the transport
    // failure instead of collapsing it into "something went wrong".
    return { ok: false, errorKey: "diagBundle.errors.transport" };
  }
}

/** f96-diag-<UTC stamp>.json - sortable, and unique per download. */
export function diagFileName(at: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp =
    at.getUTCFullYear().toString() +
    p(at.getUTCMonth() + 1) +
    p(at.getUTCDate()) +
    "-" +
    p(at.getUTCHours()) +
    p(at.getUTCMinutes()) +
    p(at.getUTCSeconds());
  return "f96-diag-" + stamp + ".json";
}

/** Triggers the download via a Blob URL (relative URL, no server round-trip). */
export function downloadDiagBundle(bundle: DiagBundle): string {
  const name = diagFileName();
  const text = JSON.stringify(bundle, null, 2);
  const blob = new Blob([text], { type: "application/json" });
  const href = URL.createObjectURL(blob);
  try {
    const a = document.createElement("a");
    a.href = href;
    a.download = name;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    // Revoke on the next tick: revoking synchronously can cancel the download
    // in some browsers.
    window.setTimeout(() => URL.revokeObjectURL(href), 10_000);
  }
  return name;
}

export type GlanceColor = "green" | "red" | "amber";

export interface DiagGlance {
  launcher: GlanceColor;
  watcher: GlanceColor;
  ws: GlanceColor;
  logon: string;
  details: string[];
}

function pick(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const part of path.split(".")) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/**
 * [F96 §2.3] AT-A-GLANCE VERDICTS - the four subsystems the operator keeps
 * reporting on, each green/red/amber from the bundle's own evidence. `amber` is
 * used where the bundle genuinely does not know (never rounded to green), and
 * `logon` is a WORD not a colour, because "type-2" vs "none" is the whole
 * question the banner gets wrong.
 */
export function diagAtGlance(bundle: DiagBundle | null): DiagGlance {
  const out: DiagGlance = { launcher: "amber", watcher: "amber", ws: "amber", logon: "none (no bundle yet)", details: [] };
  if (!bundle) return out;

  const boot = pick(bundle, "mainYmlBootstrap");
  const taskReg = pick(bundle, "mainYmlBootstrap.watcherTaskRegistered") === true;
  const autoOn = pick(bundle, "mainYmlBootstrap.autologonConfigured") === true;
  const shortcut = pick(bundle, "mainYmlBootstrap.startupShortcutWritten") === true;
  out.launcher = taskReg && autoOn ? "green" : taskReg || autoOn ? "amber" : "red";
  out.details.push(
    "launcher: watcherTaskRegistered=" + String(taskReg) + " autologonConfigured=" + String(autoOn) + " startupShortcutWritten=" + String(shortcut)
  );
  if (boot && typeof boot === "object" && typeof (boot as Record<string, unknown>).note === "string") {
    out.details.push("launcher note: " + String((boot as Record<string, unknown>).note));
  }

  const heartAge = pick(bundle, "watcher.watcherHeartbeatAgeSec");
  const watcherAlive = pick(bundle, "watcher.watcherAlive") === true;
  const procRun = pick(bundle, "watcher.watcherProcessRunning") === true;
  const taskState = String(pick(bundle, "watcher.scheduledTaskState") || "Unknown");
  out.watcher = watcherAlive || procRun ? "green" : heartAge === null || heartAge === undefined ? "red" : "red";
  out.details.push(
    "watcher: alive=" + String(watcherAlive) + " process=" + String(procRun) + " heartbeatAgeSec=" + String(heartAge ?? "none") + " taskState=" + taskState
  );
  const sup = pick(bundle, "watcher.supervisorAttempts");
  if (sup && typeof sup === "object") {
    out.details.push("watcher supervisor attempts: " + JSON.stringify(sup) + " lastAction=" + String(pick(bundle, "watcher.supervisorLastAction")));
  }

  const wsStatus = String(pick(bundle, "webSocket.status") || "unknown");
  const upgrade = pick(bundle, "webSocket.serverUpgradeSupported");
  out.ws = wsStatus === "connected" ? "green" : wsStatus === "disconnected" ? "red" : "amber";
  if (upgrade === false) {
    // The endpoint cannot exist on this build, so a red chip is the TRUTH and
    // the operator should stop debugging the browser.
    out.ws = "red";
    out.details.push("webSocket: serverUpgradeSupported=false - this build answers no /ws upgrade (see advisories)");
  }
  out.details.push(
    "webSocket: status=" + wsStatus + " attempts=" + String(pick(bundle, "webSocket.reconnectAttempts")) + " lastDisconnectReason=" + String(pick(bundle, "webSocket.disconnectReason") ?? "none")
  );

  const detected = pick(bundle, "logon.detected") === true;
  const ltype = pick(bundle, "logon.logonType");
  const lkind = pick(bundle, "logon.logonKind");
  out.logon = detected ? "type-" + String(ltype || "?") + (lkind ? " (" + String(lkind) + ")" : "") : "none";
  out.details.push(
    "logon: detected=" + String(detected) + " type=" + String(ltype ?? "none") + " kind=" + String(lkind ?? "none") + " scanner=" + String(pick(bundle, "logon.scannerStatus")) + " raw=" + JSON.stringify(pick(bundle, "logon.rawEventCount"))
  );
  const view = pick(bundle, "viewingMode");
  if (view && typeof view === "object") out.details.push("viewingMode: " + JSON.stringify(view));
  const errs = pick(bundle, "recentErrors");
  if (Array.isArray(errs) && errs.length) {
    out.details.push("recentErrors: " + String(errs.length) + " (last: " + JSON.stringify(errs[errs.length - 1]) + ")");
  }
  const adv = pick(bundle, "advisories");
  if (Array.isArray(adv)) for (const a of adv) out.details.push("advisory: " + String(a));
  return out;
}
