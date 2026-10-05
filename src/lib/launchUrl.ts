// [F81 §4.2/Q1=B] launchUrl(): POST /api/launch-url with the validated URL.
// The server route sanitises the URL (https only, no userinfo, <=2048) and
// schedules a one-shot Interactive task running `cmd /c start "" "<url>"`
// for the active console user.
//
// [F84 §2.3] NO SILENT FALLBACK. The previous contract returned
// `{ok:false, fallback:true}` after calling window.open(url, "_blank") - a
// partial deploy (or a 500 / a dropped connection) silently opened the link in
// the operator's LOCAL browser instead of the RDP session, which is exactly the
// failure this feature exists to prevent. The contract is now
// `Promise<{ok, reason?, code?}>` with NO window.open: every failure surfaces a
// visible reason key the caller renders in a toast (with a Retry affordance).
// `reason` is an i18n key, never an English literal.
import { getKey } from "@/lib/api";
import { useLaunchChoiceStore } from "@/stores/launchChoiceStore";
// [F94 §3.6] CGNAT_RE: the tailnet range (100.64.0.0/10) viewing-mode detection
// must recognise, or a production tailnet-IP dashboard reads as "public".
import { CGNAT_RE } from "@/lib/format";

const SAFE_SCHEME = /^https:\/\//i;
const MAX_LEN = 2048;

// ===========================================================================
// [F90 §C.1] VIEWING MODE - "whose browser is running this dashboard?"
//
// This is the question the whole launch feature turns on, and it cannot be
// answered from the hostname alone, so it is answered from three signals in
// priority order. Anything unproven degrades to "unknown", which keeps the
// F86 backend ladder (the behaviour that already works today).
// ===========================================================================
export type ViewingMode = "web-desktop" | "tailscale-local" | "unknown";

const LOCAL_HOST = /^localhost$|^127\.0\.0\.1$/i;
const TAILNET_HOST = /\.tail[a-z0-9]+\.ts\.net$/i;
// [F94 §3.6] CGNAT (100.64.0.0/10) is the TAILSCALE range - the exact address a
// production WEB DESKTOP dashboard is served from. Missing it classified every
// tailnet-IP dashboard as "public", so detection fell through to "unknown" on
// the real deployment and the badge was unexplainable. Reuses the repo's single
// CGNAT_RE (src/lib/format.ts) rather than a second copy of the octet maths.
const PRIVATE_HOST = /^(10|172|192)\./i;

/**
 * The runner's remote desktop runs at a handful of FIXED geometries with a
 * device pixel ratio of exactly 1 (no OS or browser scaling is applied inside
 * the session). A laptop browser almost always reports a fractional or >1 ratio,
 * or a viewport shaped by a window the operator resized. Matching both is a
 * heuristic, not a proof - which is why the badge (§C.3) is CLICKABLE and the
 * operator's choice wins over every signal below.
 */
const SESSION_GEOMETRIES: ReadonlyArray<readonly [number, number]> = [
  [1024, 768],
  [1280, 720],
  [1280, 800],
  [1280, 1024],
  [1366, 768],
  [1600, 900],
  [1920, 1080],
];

export const VIEWING_MODE_STORAGE_KEY = "f90.viewingMode";
export const VIEWING_MODE_PARAM = "viewingMode";

function readStoredMode(): ViewingMode | null {
  try {
    const v = window.localStorage.getItem(VIEWING_MODE_STORAGE_KEY);
    if (v === "web-desktop" || v === "tailscale-local" || v === "unknown") return v;
  } catch {
    // A locked-down storage area is not a reason to break the page.
  }
  return null;
}

export function setViewingMode(mode: ViewingMode): void {
  try {
    window.localStorage.setItem(VIEWING_MODE_STORAGE_KEY, mode);
  } catch {
    /* ignore */
  }
}

export function isRunnerSizedViewport(w: number, h: number, dpr: number): boolean {
  if (dpr !== 1) return false;
  return SESSION_GEOMETRIES.some(([gw, gh]) => gw === w && gh === h);
}

/**
 * [F90 §C.1] Returns the mode, or "unknown" when nothing is provable.
 *
 *   1. an explicit operator choice (URL param or localStorage) always wins;
 *   2. loopback means the browser IS the session - a laptop cannot load the
 *      runner's own 127.0.0.1, so this one is proof, not a guess;
 *   3. a tailnet / RFC1918 host is ambiguous, so it needs the viewport to look
 *      like the fixed session geometry before claiming "web-desktop".
 */
/** [F90 §C.1] Raw detection: what the signals SAY, before any safety gate. */
export function detectViewingMode(search?: string): ViewingMode {
  if (typeof window === "undefined") return "unknown";
  const params = new URLSearchParams(search ?? window.location.search);
  const forced = params.get(VIEWING_MODE_PARAM);
  if (forced === "web-desktop" || forced === "tailscale-local" || forced === "unknown") return forced;

  const stored = readStoredMode();
  if (stored) return stored;

  const host = String(window.location.hostname || "");
  if (LOCAL_HOST.test(host) && isRunnerSizedViewport(window.innerWidth, window.innerHeight, window.devicePixelRatio)) {
    return "web-desktop";
  }
  if (TAILNET_HOST.test(host) || PRIVATE_HOST.test(host) || CGNAT_RE.test(host)) {
    return isRunnerSizedViewport(window.innerWidth, window.innerHeight, window.devicePixelRatio)
      ? "web-desktop"
      : "tailscale-local";
  }
  return "unknown";
}

// ===========================================================================
// [F94 §3.6] VIEWING MODE DIAGNOSIS - "Unknown" must never be a dead end.
//
// The operator's badge read "දර්ශනය: Unknown" with nothing else: no reason, no
// signal list, no way to tell a genuinely ambiguous host from a bug. Detection
// kept three signals (hostname, viewport geometry, device pixel ratio) and
// discarded the reasoning that produced the answer, so a laptop on a public
// preview host and a runner session with a fractional DPR both collapsed into
// the same word.
//
// `explainViewingMode()` keeps the F90 decision EXACTLY as it was (same mode,
// same safety gate - `resolveViewingMode()` is untouched and still the thing
// the launch path calls) and ADDS the reasoning as data: a display label, a
// machine-readable reason, and the raw signals. The badge renders all three.
// ===========================================================================

export type HostKind = "loopback" | "tailnet" | "private" | "public" | "empty";

export interface ViewingModeSignals {
  host: string;
  hostKind: HostKind;
  /** true when the dashboard is running inside another page's frame. */
  framed: boolean;
  /** true when the viewport exactly matches a known session geometry @ dpr 1. */
  runnerSized: boolean;
  dpr: number;
  viewport: string;
  /** true when the stored/URL operator choice overrode the signals. */
  confirmed: boolean;
}

export interface ViewingModeDiagnosis {
  /** The mode the launch path acts on (identical to resolveViewingMode().mode). */
  mode: ViewingMode;
  /** What the signals alone suggested. */
  detected: ViewingMode;
  /** Operator-facing label: LOCAL DEV | WEB DESKTOP | Tailscale local |
   *  "Unknown - ambiguous signals". Never a bare "Unknown". */
  label: string;
  /** Machine-readable reason, safe to log and to show. */
  reason: string;
  signals: ViewingModeSignals;
}

export function hostKindOf(host: string): HostKind {
  const h = String(host || "").toLowerCase();
  if (!h) return "empty";
  if (LOCAL_HOST.test(h)) return "loopback";
  if (TAILNET_HOST.test(h)) return "tailnet";
  if (CGNAT_RE.test(h)) return "tailnet"; // 100.64/10 IS the tailnet, not generic RFC1918
  if (PRIVATE_HOST.test(h)) return "private";
  return "public";
}

/** True when this page is inside a frame (a parent document exists). */
export function isFramed(): boolean {
  try {
    if (typeof window === "undefined") return false;
    return window.self !== window.top;
  } catch {
    // A cross-origin parent throws on the read - which itself proves there IS
    // a parent document.
    return true;
  }
}

/**
 * [F94 §3.6] The diagnosis. `label` is always specific: a loopback host is
 * LOCAL DEV even when the geometry does not match a runner session (the
 * browser is on the machine the dashboard is served from), a tailnet host
 * without a parent frame is Tailscale local, and anything else names its
 * signals instead of hiding behind one word.
 */
export function explainViewingMode(search?: string): ViewingModeDiagnosis {
  const state = resolveViewingMode(search);
  const host = typeof window !== "undefined" ? String(window.location.hostname || "") : "";
  const kind = hostKindOf(host);
  const dpr = typeof window !== "undefined" ? Number(window.devicePixelRatio || 1) : 1;
  const vw = typeof window !== "undefined" ? Number(window.innerWidth || 0) : 0;
  const vh = typeof window !== "undefined" ? Number(window.innerHeight || 0) : 0;
  const framed = isFramed();
  const runnerSized = isRunnerSizedViewport(vw, vh, dpr);
  const signals: ViewingModeSignals = {
    host,
    hostKind: kind,
    framed,
    runnerSized,
    dpr,
    viewport: vw + "x" + vh,
    confirmed: state.confirmed,
  };

  // 1. loopback -> LOCAL DEV (the browser is on the serving machine; a laptop
  //    cannot load someone else's 127.0.0.1).
  if (kind === "loopback") {
    return {
      ...state,
      label: "LOCAL DEV",
      reason: runnerSized
        ? "loopback-host+runner-sized-viewport"
        : "loopback-host-not-runner-sized-viewport(" + signals.viewport + "@dpr" + dpr + ")",
      signals,
    };
  }
  // 2. tailnet / RFC1918 -> the operator's own machine unless the geometry says
  //    otherwise; a parent frame corroborates an embedded session view.
  if (kind === "tailnet" || kind === "private") {
    if (state.detected === "web-desktop") {
      return {
        ...state,
        label: "WEB DESKTOP",
        reason: kind + "-host+runner-sized-viewport" + (framed ? "+framed" : ""),
        signals,
      };
    }
    return {
      ...state,
      label: "Tailscale local",
      reason: kind + "-host+viewport-" + signals.viewport + "@dpr" + dpr + "-not-a-session-geometry",
      signals,
    };
  }
  // 3. everything else: name the ambiguity instead of shrugging.
  const why =
    kind === "empty"
      ? "no-hostname-available"
      : "public-host(" + host + ")+viewport-" + signals.viewport + "@dpr" + dpr + (framed ? "+framed" : "+top-level");
  return {
    ...state,
    label: "Unknown - ambiguous signals",
    reason: why,
    signals,
  };
}

export interface ViewingModeState {
  /** The mode `launchUrl()` will ACT ON. */
  mode: ViewingMode;
  /** What the hostname + viewport signals alone suggested. */
  detected: ViewingMode;
  /** True when the mode came from the operator (URL param or a stored choice). */
  confirmed: boolean;
}

/**
 * [F90 §C.1] The mode the launch path is allowed to act on.
 *
 * `web-desktop` is the one mode that CHANGES behaviour (it opens the link in
 * the dashboard's own browser and skips the server ladder), so a guess is not
 * good enough for it. The cost of being wrong is asymmetric:
 *
 *   false "web-desktop" -> the link opens in whatever browser is running the
 *                          dashboard, which is EXACTLY the silent
 *                          wrong-machine failure F84/F85 removed;
 *   false "unknown"     -> the server ladder runs, which is today's behaviour
 *                          and is correct in every case.
 *
 * So an inferred "web-desktop" is downgraded to "unknown" until the operator
 * confirms it (badge, or ?viewingMode=web-desktop). Everything else - including
 * "tailscale-local", which only ever ADDS an explicit choice and never opens a
 * window - is acted on as detected.
 */
export function resolveViewingMode(search?: string): ViewingModeState {
  if (typeof window === "undefined") return { mode: "unknown", detected: "unknown", confirmed: false };
  const params = new URLSearchParams(search ?? window.location.search);
  const forced = params.get(VIEWING_MODE_PARAM);
  const stored = readStoredMode();
  const confirmed =
    forced === "web-desktop" || forced === "tailscale-local" || forced === "unknown" || stored !== null;
  const detected = detectViewingMode(search);
  const mode = confirmed ? detected : detected === "web-desktop" ? "unknown" : detected;
  return { mode, detected, confirmed };
}

export interface LaunchOutcome {
  ok: boolean;
  /** i18n key for the visible failure message (never an English literal). */
  reason?: string;
  /** Server code or a transport marker, for logs/tests only. */
  code?: string;
  /** [F87 §D.2] The F86 ladder rung that did the work (1-3), from the 200
   *  body, so a result card can say "opened via tier N" without the banner. */
  tier?: number;
  /** [F87 §D.2] The rung's detail string (e.g. "direct-spawn"). */
  tierDetail?: string;
  /** [F90 §C.1] The viewing mode the launch was resolved under. */
  mode?: ViewingMode;
  /** [F90 §C.2] true when the link was opened by the dashboard's OWN browser
   *  (web-desktop): no server round trip, no rung. */
  viaWindowOpen?: boolean;
  /** [F90 §C.2] true when the operator must choose explicitly; the URL is
   *  carried on the outcome and nothing has been opened. */
  needsChoice?: boolean;
  /** [F90 §C.2] the URL awaiting the operator's decision. */
  url?: string;
}

export function isSafeLaunchUrl(raw: string): boolean {
  const url = String(raw || "").trim();
  if (!url || url.length > MAX_LEN) return false;
  if (!SAFE_SCHEME.test(url)) return false;
  try {
    const u = new URL(url);
    if (u.protocol !== "https:") return false;
    if (u.username || u.password) return false;
    return true;
  } catch {
    return false;
  }
}

/** Server codes -> i18n keys (F84 §2.3). Anything unknown is the generic
 *  launch failure, so a new server code can never render an empty toast. */
function reasonForCode(code: string): string {
  if (code === "NO_ACTIVE_SESSION") return "search.launchUrl.noSession";
  if (code === "RATE_LIMITED") return "search.launchUrl.rateLimited";
  return "search.launchUrl.failed";
}

// [F85 §3] Feature-DETECTION handle. The diagnostic banner must be able to
// prove the no-fallback contract is in the RUNNING bundle (`typeof
// window.launchUrl === "function"`) instead of believing a server flag: a
// stale ui-dist zip would otherwise print a checkmark for code it does not
// contain. This exports nothing new to the operator - it is the same function
// the result cards call - and it is installed once from src/main.tsx.
export function installLaunchUrlHandle(): void {
  try {
    if (typeof window === "undefined") return;
    (window as unknown as { launchUrl?: typeof launchUrl }).launchUrl = launchUrl;
  } catch {
    // A locked-down window object is not a reason to break the app; the banner
    // simply reports the check as missing.
  }
}

// [F88 §B.4] The visible failure line: the rung that failed + the reason +
// a 1-click pointer to the diag panel (/#/search?diag=1). No tier in the
// outcome (validation/transport) falls back to the F84 reason + retry line.
export function launchFailureToast(
  out: LaunchOutcome,
  t: (key: string, opts?: Record<string, unknown>) => string,
): string {
  // [F90 §C.2] a pending operator choice is not a failure toast - the modal is
  // already on screen; a second "could not open in RDP" line would contradict it.
  if (out.needsChoice) return "";
  if (typeof out.tier === "number" && out.tier >= 0) {
    return t("search.launchUrl.failedTier", { tier: out.tier, reason: t(out.reason || "search.launchUrl.failed") });
  }
  return t(out.reason || "search.launchUrl.failed") + " — " + t("search.launchUrl.retry");
}

export async function launchUrl(raw: string): Promise<LaunchOutcome> {
  const url = String(raw || "").trim();
  if (!isSafeLaunchUrl(url)) return { ok: false, reason: "search.launchUrl.failed", code: "VALIDATION_ERROR" };

  // [F90 §C.2] Mode A - the dashboard IS the RDP session's browser, so a plain
  // window.open lands in that same browser. No round trip, no rung that can
  // fail. A blocked popup is NOT a silent fallback: it falls through to the
  // ladder below rather than pretending it worked.
  const { mode } = resolveViewingMode();
  if (mode === "web-desktop") {
    try {
      const win = window.open(url, "_blank", "noopener,noreferrer");
      if (win) return { ok: true, mode, viaWindowOpen: true };
    } catch {
      /* fall through to the ladder */
    }
  }

  const out = await launchUrlViaServer(url);
  out.mode = mode;

  // [F90 §C.2] Mode B - the ladder could not reach a desktop and the dashboard
  // is running in the OPERATOR's own browser. window.open here would open the
  // link on the wrong machine and look like a success, so instead of guessing
  // we hand the URL to the operator.
  if (!out.ok && mode === "tailscale-local") {
    const reason = out.reason || "search.launchUrl.failed";
    useLaunchChoiceStore.getState().open(url, reason);
    return { ok: false, mode, needsChoice: true, url, reason, code: out.code };
  }
  return out;
}

async function launchUrlViaServer(url: string): Promise<LaunchOutcome> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const key = getKey();
  if (key) headers["X-Dash-Token"] = key;
  try {
    const r = await fetch("/api/launch-url", {
      method: "POST",
      cache: "no-store",
      headers,
      body: JSON.stringify({ url }),
    });
    // [F87 §B/§D.2] ALWAYS consume the body. The F86 200 carries {tier,
    // tierDetail}; and an unread fetch body keeps the request "loading" in
    // Chromium, which is exactly what left the ten-site spec's response read
    // hanging. A malformed body is still a successful launch.
    let body: { code?: string; messageKey?: string; tier?: number; tierDetail?: string; reason?: string } | null = null;
    try {
      body = (await r.json()) as { code?: string; messageKey?: string; tier?: number; tierDetail?: string } | null;
    } catch {
      body = null;
    }
    if (r.ok) {
      const out: LaunchOutcome = { ok: true };
      if (typeof body?.tier === "number" && body.tier > 0) out.tier = body.tier;
      if (typeof body?.tierDetail === "string" && body.tierDetail) out.tierDetail = body.tierDetail;
      return out;
    }
    const code = String(body?.code || String(r.status));
    // [F88 §B.4] the 500/503 bodies carry `tier` (the last rung that tried) -
    // surface it so the toast can name the failed rung.
    const out: LaunchOutcome = { ok: false, reason: reasonForCode(code), code };
    if (typeof body?.tier === "number" && body.tier >= 0 && out.tier === undefined) out.tier = body.tier;
    return out;
  } catch {
    // No window.open. A dropped connection is a visible failure, not a
    // silent switch to the operator's local browser.
    return { ok: false, reason: "search.launchUrl.failed", code: "transport" };
  }
}

// ===========================================================================
// [F91 §B.1] MIRROR MODE - the operator's final launch architecture.
//
// WHY this exists (all four operator decisions land here): clicking a result
// used to be ONE attempt to make the runner open a window, and every failure
// class (no console user, dead ladder, offline server) landed on the operator
// as an error toast. Mirror mode splits the click in two INDEPENDENT halves:
//
//   1. the local browser opens IMMEDIATELY - the user sees their result
//      without waiting on anything, and
//   2. the same URL is queued to the persistent launcher service on the runner
//      (payloads/ghrdp-rdp-launcher.ps1 drains C:\ProgramData\ghrdp\
//      launcher-queue within ~500 ms and opens it in the session's Edge/Chrome).
//
// The queue half is BEST-EFFORT: if it fails (route down, service not
// installed yet, rate limit) the toast says "Opened locally ✓ (RDP launcher:
// <reason>)" - an INFO line, never an error, and never "Could not open in
// RDP" (F91 §-1 replaces that string repo-wide). The F84/F85 no-fallback
// contract is NOT weakened: `launchUrl()` above still never opens a local tab
// after a failed server call, and the F86 banner keeps using it as the pure
// ladder probe. openMirrored is a DIFFERENT, explicitly operator-approved
// semantic: local open is the DESIGN, not a fallback.
// ===========================================================================
export interface MirrorOutcome {
  /** true when the local tab was opened (false only when the URL fails the
   *  https validation, in which case NOTHING is queued either). */
  localOpened: boolean;
  /** true when the RDP launcher accepted (200) the queue write. */
  rdpOk: boolean;
  /** machine-readable queue failure marker (logs/tests, never user text). */
  rdpReason: string;
  /** the queue job id, when the write succeeded. */
  jobId?: string;
}

export type LauncherMode = "navigate" | "download" | "explorer" | "noop";

/** Explorer jobs carry a LOCAL folder path (never a URL); mirror the exact
 *  server fence (Test-F91QueueJob) client-side so a bad path is refused here
 *  with a visible reason instead of silently 400ing. */
export function isSafeExplorerPath(raw: string): boolean {
  const p = String(raw || "").trim();
  return /^[A-Za-z]:\\[^<>:"|?*]*$/.test(p);
}

/** POST /api/launcher/queue - the ONLY way anything on this side reaches the
 *  RDP session's desktop. 3 s bound so a dead runner slows down nothing. */
export async function queueLauncherJob(
  url: string,
  mode: LauncherMode,
  name = "",
): Promise<{ ok: boolean; reason: string; jobId?: string }> {
  const value = String(url || "").trim();
  if (mode === "explorer") {
    if (!isSafeExplorerPath(value)) return { ok: false, reason: "invalid-path" };
  } else if (mode === "navigate") {
    if (!isSafeLaunchUrl(value)) return { ok: false, reason: "validation" };
  } else if (value && !isSafeLaunchUrl(value)) {
    return { ok: false, reason: "validation" };
  }
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const key = getKey();
  if (key) headers["X-Dash-Token"] = key;
  const signal =
    typeof AbortSignal !== "undefined" && typeof (AbortSignal as unknown as { timeout?: unknown }).timeout === "function"
      ? (AbortSignal as unknown as { timeout: (ms: number) => AbortSignal }).timeout(3000)
      : undefined;
  try {
    const res = await fetch("/api/launcher/queue", {
      method: "POST",
      cache: "no-store",
      headers,
      body: JSON.stringify({ url: value, mode, name }),
      ...(signal ? { signal } : {}),
    });
    let body: { jobId?: string } | null = null;
    try {
      body = (await res.json()) as { jobId?: string } | null;
    } catch {
      body = null;
    }
    if (res.ok) return { ok: true, reason: "", jobId: body?.jobId };
    return { ok: false, reason: "queue-" + String(res.status) };
  } catch {
    return { ok: false, reason: "queue-timeout" };
  }
}

/** The folder part of a Windows path, for the download toast's
 *  "Open in RDP File Explorer" action (C:\...\RDP-Downloads\file.mp3 ->
 *  C:\...\RDP-Downloads). */
export function dirnameWindows(path: string): string {
  const p = String(path || "").replace(/[\\/]+$/, "");
  const i = Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/"));
  if (i === 2 && /^[A-Za-z]:/.test(p)) return p.slice(0, 3); // C:\ root keeps its separator (the explorer fence needs it)
  return i > 1 ? p.slice(0, i) : p;
}

/** Mirror-mode toast text, success-first (F91 §-1): BOTH halves pass ->
 *  mirror.openedBoth; queue half failed -> mirror.rdpOffline naming WHY.
 *  An unvalidated URL never opened anything -> mirror.blocked. */
export function mirrorToastText(out: MirrorOutcome, t: (key: string, opts?: Record<string, unknown>) => string): string {
  if (!out.localOpened) return t("mirror.blocked");
  if (out.rdpOk) return t("mirror.openedBoth");
  return t("mirror.rdpOffline", { reason: out.rdpReason || "offline" });
}

/**
 * [F91 §B.1] openMirrored(url): local tab FIRST (always, for a valid https
 * URL), queue-to-RDP in flight, success-first toast either way.
 */
export async function openMirrored(
  raw: string,
  opts?: {
    push?: (msg: string, kind?: "ok" | "warn" | "bad" | "") => void;
    t?: (key: string, options?: Record<string, unknown>) => string;
  },
): Promise<MirrorOutcome> {
  const url = String(raw || "").trim();
  if (!isSafeLaunchUrl(url)) {
    // NOT a "could not open" - the dashboard refused a URL that is not a
    // plain https link; nothing was opened ANYWHERE, and the reason is shown.
    const out: MirrorOutcome = { localOpened: false, rdpOk: false, rdpReason: "invalid-url" };
    if (opts?.push && opts?.t) opts.push(mirrorToastText(out, opts.t), "warn");
    return out;
  }
  // 1. local open FIRST - the user's half never waits on the runner's half.
  let localOpened = false;
  try {
    const win = window.open(url, "_blank", "noopener,noreferrer");
    localOpened = true;
    void win;
  } catch {
    localOpened = false;
  }
  // 2. the RDP half, with its own 3 s bound (inside queueLauncherJob).
  const queued = await queueLauncherJob(url, "navigate");
  const out: MirrorOutcome = { localOpened, rdpOk: queued.ok, rdpReason: queued.ok ? "" : queued.reason, jobId: queued.jobId };
  // 3. the toast - success-first, and the ONLY place either half is reported.
  if (opts?.push && opts?.t) opts.push(mirrorToastText(out, opts.t), out.rdpOk ? "ok" : "");
  return out;
}
