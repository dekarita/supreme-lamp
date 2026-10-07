// [F105 §4] featureBoundary.ts — the crash report channel.
//
// A FeatureBoundary catches a render error and holds the section's fallback in
// place. That alone is the difference between "the Settings page is broken" and
// "Mission Control is down", but it is not yet DIAGNOSABLE: the operator sees a
// card and the DVR (F107), the HUD (F109) and the Collector have no row for it.
// So the boundary publishes the failure as a window CustomEvent - the same
// mechanism F98/F104 already use for cross-module signalling - and this module
// carries both halves:
//
//   emitFeatureBoundaryError   (producer: the boundary component)
//   onFeatureBoundaryError     (any consumer: tests, HUD, DVR recorder)
//   installFeatureBoundaryReporter (the F100/F101/F104 consumer: writes ONE
//                                   Collector row per distinct failure so the
//                                   §"Global clicks" feed and the clipboard
//                                   .mcrec both contain it)
//
// PRIVACY / PRIVACY-ADJACENT RULES, inherited from F104's capture:
//   - the message is truncated to FEATURE_BOUNDARY_MESSAGE_MAX chars,
//   - the route is cut at the first "?" or "#" so a dash token can never be
//     recorded (that is exactly the F94 leak class),
//   - no stack and no component tree is ever recorded, in the event or the row.
//
// SECURITY: this module performs NO network I/O, NO storage writes and touches
// no endpoint. tests/f105-feature-registry.test.js enforces that statically,
// so the crash-report path can never grow into an upload path (the F-DVR-LITE
// lesson from #169: the GitHub write path was removed on purpose and must not
// come back through a diagnostic channel).
import { logButtonAction, type ButtonAction } from "@/lib/collectorAgent";
import type { FeatureId } from "@/lib/featureRegistry";

/** [F105 §4.1] the event name every consumer subscribes to. */
export const FEATURE_BOUNDARY_EVENT = "ghrdp:feature-boundary-error";
/** [F105 §4.2] provenance tag on the Collector row the reporter writes. */
export const FEATURE_BOUNDARY_SOURCE = "feature-boundary";
/** [F105 §4.3] message cap - a stack-shaped string must not reach the store. */
export const FEATURE_BOUNDARY_MESSAGE_MAX = 300;
/** [F105 §4.4] same failure inside this window is one row (React can re-throw
 *  during recovery; a chatty boundary must not flood the 500-row store). */
export const FEATURE_BOUNDARY_DEDUP_MS = 5_000;
/** [F105 §4.4] hard session cap on reporter rows - a crash loop records this
 *  many and then stops, keeping the rest of the store useful. */
export const FEATURE_BOUNDARY_MAX_ROWS = 20;

export interface FeatureBoundaryErrorDetail {
  feature: FeatureId;
  /** Localised section name, resolved by the boundary (t(navKey)). */
  section: string;
  /** Truncated, single-line error message. Never a stack. */
  message: string;
  /** Route with query/fragment stripped (no token can survive). */
  route: string;
  /** How many times this boundary caught in this mount (1-based). */
  count: number;
  /** ISO timestamp, minted at catch time. */
  ts: string;
}

/** Strip a raw Error message down to what is safe to show and to record. */
export function sanitizeBoundaryMessage(raw: unknown): string {
  let s = "";
  try {
    s = typeof raw === "string" ? raw : raw instanceof Error ? String(raw.message || raw) : String(raw ?? "");
  } catch {
    s = "";
  }
  s = s.replace(/\s+/g, " ").trim();
  if (!s) return "unknown render error";
  return s.length > FEATURE_BOUNDARY_MESSAGE_MAX ? s.slice(0, FEATURE_BOUNDARY_MESSAGE_MAX) + "…" : s;
}

/**
 * Cut at the first "?" - and at the first "#" that is NOT at index 0, because
 * this app is a HashRouter: the route itself starts with "#" (#/files), so a
 * naive split on "#" would erase the one thing worth recording (that bug was
 * caught by the F105 gate: the footer recorded "/" for every crash). A trailing
 * fragment after a path still gets cut, so neither a query string nor a
 * fragment can carry a token into a row (F94's `?key=` is the exact reason).
 */
export function sanitizeBoundaryRoute(raw: unknown): string {
  try {
    const s = String(raw || "");
    const cuts = [s.indexOf("?"), s.indexOf("#", 1)].filter((i) => i >= 0);
    const cut = cuts.length ? Math.min(...cuts) : -1;
    const out = cut >= 0 ? s.slice(0, cut) : s;
    return out || "/";
  } catch {
    return "/";
  }
}

/** Publish one boundary failure. Never throws - a crash report must not crash. */
export function emitFeatureBoundaryError(detail: FeatureBoundaryErrorDetail): void {
  try {
    if (typeof window === "undefined" || typeof CustomEvent !== "function") return;
    window.dispatchEvent(new CustomEvent(FEATURE_BOUNDARY_EVENT, { detail }));
  } catch {
    /* ignore */
  }
}

/** Subscribe to boundary failures. Returns the unsubscribe function. */
export function onFeatureBoundaryError(handler: (detail: FeatureBoundaryErrorDetail) => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  const listener = (ev: Event): void => {
    try {
      const detail = (ev as CustomEvent).detail as FeatureBoundaryErrorDetail;
      if (detail && detail.feature) handler(detail);
    } catch {
      /* a consumer must never break the page it observes */
    }
  };
  try {
    window.addEventListener(FEATURE_BOUNDARY_EVENT, listener);
  } catch {
    return () => undefined;
  }
  return () => {
    try {
      window.removeEventListener(FEATURE_BOUNDARY_EVENT, listener);
    } catch {
      /* ignore */
    }
  };
}

/** The Collector row a boundary failure produces (pure - the reporter writes it). */
export function boundaryCollectorRow(detail: FeatureBoundaryErrorDetail): Omit<ButtonAction, "id" | "ts"> {
  return {
    feature: detail.feature,
    action: "renderError",
    params: { section: detail.section, route: detail.route, count: detail.count, ts: detail.ts },
    result: { captured: true },
    source: FEATURE_BOUNDARY_SOURCE,
    error: detail.message,
    verdict: {
      status: "fail",
      reason: "FeatureBoundary caught a render error in the " + detail.feature + " section",
      suggestedFix: "use Retry section; if it re-crashes, Copy error and paste it into the next Arena session",
      relatedIssue: "#165",
    },
  };
}

let reporterInstalled = false;
let reporterRows = 0;
let lastKey = "";
let lastAt = 0;

/**
 * [F105 §4.4] Install the Collector consumer exactly once. Idempotent by
 * construction (a second call returns the first uninstaller), because
 * main.tsx is not the only place that may want the feed and double-installing
 * would double every row.
 */
export function installFeatureBoundaryReporter(): () => void {
  if (reporterInstalled) return () => undefined;
  reporterInstalled = true;
  const off = onFeatureBoundaryError((detail) => {
    const key = detail.feature + "|" + detail.message;
    const now = Date.now();
    if (key === lastKey && now - lastAt < FEATURE_BOUNDARY_DEDUP_MS) return;
    if (reporterRows >= FEATURE_BOUNDARY_MAX_ROWS) return;
    lastKey = key;
    lastAt = now;
    reporterRows += 1;
    try {
      logButtonAction(boundaryCollectorRow(detail));
    } catch {
      /* the collector must never break the page that just broke */
    }
  });
  return () => {
    off();
    reporterInstalled = false;
  };
}

/** Test-only: forget the install flag AND the per-session row budget. */
export function __resetFeatureBoundaryReporterForTests(): void {
  reporterInstalled = false;
  reporterRows = 0;
  lastKey = "";
  lastAt = 0;
}
