// [M2 §2] ChromeBoundary — the crash fence for GLOBAL CHROME (completes F105's
// handoff #1: "global chrome is intentionally unfenced ... a crash in one of
// those overlays still blanks the app").
//
// WHAT IT PREVENTS. React unmounts the WHOLE tree when a render throws and no
// boundary catches it. The 11 FeatureBoundaries (F105) bound the 11 *sections*;
// everything mounted OUTSIDE `<Routes>` — the toasts, the diag drawer, the
// collector bridge, the DVR handle, the Debug HUD, the two full-screen gates,
// the command palette, the logon banner, and the shell layout itself — had no
// fence at all, so one bad value in any of them took Mission Control down
// completely (chrome included).
//
// FOUR RULES, MIRRORED FROM F105 AND THEN DELIBERATELY DIFFERENT:
//   1. ZERO DOM DELTA WHEN HEALTHY. A healthy boundary returns `children`
//      directly — no wrapper node, no attribute, so no layout, regression-id or
//      F56-c/F-DVR-i/F109-f pin can notice the fence exists. (Pinned by a DOM
//      test that compares innerHTML with and without the wrapper.)
//   2. NULL ON CRASH, NOT A CARD. F105's card is right for a section the
//      operator asked for. Chrome is an overlay they did not: a crash card would
//      paint over a dashboard that is otherwise fine, and it would be a second
//      failure surface made of the same broken app. So the surface disappears,
//      and the diagnosis moves to the crash channel (the Collector row names the
//      surface and what was lost — see chromeBoundaryCore.js `lost`).
//   3. IT RETRIES ITSELF, BOUNDED. A silently-neutered overlay must not stay dead
//      for the session if the crash was transient. `chromeRetryDecision` gives
//      the budget (3 attempts, 2 s apart); after that the surface stays null
//      until a reload, and every catch is on the record.
//   4. IT DOES NOT TOUCH THE MOUNT LEDGER. `registerMountedFeature` is how F105
//      proves "11/11 sections are mounted" and what the Debug HUD's Features
//      panel READS. Registering chrome there would make the HUD report sections
//      that are not mounted — the exact reason F109 refused FeatureBoundary for
//      its own panels. Pinned by a Node rule + a DOM test.
//
// NOT A ROUTE. It is mounted around chrome, never inside `<Routes>`, and it
// renders nothing at all when healthy — so it cannot change what a route renders.
import React from "react";
import {
  CHROME_BOUNDARY_RETRY_MS,
  chromeRetryDecision,
  type ChromeSurfaceId,
} from "@/lib/chromeBoundaryCore";
import {
  emitChromeBoundaryError,
  sanitizeBoundaryMessage,
  sanitizeBoundaryRoute,
} from "@/lib/featureBoundary";

export interface ChromeBoundaryProps {
  /** One of CHROME_SURFACES (chromeBoundaryCore) — a typo is a compile error. */
  surface: ChromeSurfaceId;
  children: React.ReactNode;
}

interface ChromeBoundaryState {
  error: string | null;
  /** Catches in this mount (1-based) — reported, never rendered. */
  count: number;
  /** Automatic re-mounts already spent from the budget. */
  retries: number;
}

/**
 * [M2 §2.2] The chrome fence. Wrap exactly one surface; the child expression is
 * unchanged, so the surface's own test ids, order and props are untouched.
 */
export default class ChromeBoundary extends React.Component<ChromeBoundaryProps, ChromeBoundaryState> {
  state: ChromeBoundaryState = { error: null, count: 0, retries: 0 };
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private caughtAt = "";

  static getDerivedStateFromError(error: unknown): Partial<ChromeBoundaryState> {
    return { error: sanitizeBoundaryMessage(error) };
  }

  componentDidCatch(error: unknown, _info: React.ErrorInfo): void {
    this.caughtAt = new Date().toISOString();
    const count = this.state.count + 1;
    this.setState({ count });
    emitChromeBoundaryError({
      surface: this.props.surface,
      message: sanitizeBoundaryMessage(error),
      route: sanitizeBoundaryRoute(typeof window === "undefined" ? "/" : window.location.hash || window.location.pathname),
      count,
      ts: this.caughtAt,
    });
    const decision = chromeRetryDecision(this.state.retries);
    if (!decision.retry) return;
    // Re-mount the subtree. The fence itself stays installed, so a deterministic
    // crash lands right back here with count+1 and one fewer attempt, instead of
    // taking the app down.
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.setState({ error: null, retries: decision.attempt });
    }, CHROME_BOUNDARY_RETRY_MS);
  }

  componentWillUnmount(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  render(): React.ReactNode {
    // Rule 2: nothing on screen. Rule 1: nothing on screen when healthy either —
    // the child is returned directly, never wrapped.
    if (this.state.error !== null) return null;
    return this.props.children;
  }
}
