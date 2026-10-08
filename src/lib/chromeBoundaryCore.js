// [M2 §1] chromeBoundaryCore.js — the pure half of the chrome fence.
//
// WHY THIS EXISTS. F105 (Observatory step 4) fenced the 11 SECTION routes and
// recorded, as handoff #1, that "global chrome is intentionally unfenced ... a
// crash in one of those overlays still blanks the app". That is the failure this
// step closes: React unmounts the WHOLE tree when a render throws and no
// boundary catches it, so today a bad toast payload takes the dashboard down.
//
// WHY PLAIN JS. The fence's decision logic (which surfaces exist, how many
// automatic retries are allowed, what a crash row looks like) is pure and must
// run under `node --test tests/*.test.js` against the SHIPPED code, not a copy
// of it (§GATE-EXECUTES-SHIPPED-CODE). The React half is
// src/components/primitives/ChromeBoundary.tsx; the window half is
// src/lib/chromeBoundary.ts.
//
// THE RENDER POLICY, AND WHY IT IS NULL. F105's card is right for a section: the
// operator asked for that section, and a card naming it is the useful answer.
// Chrome is the opposite — it is an overlay the operator never asked for, and a
// card about the crash is WORSE than the missing overlay (it would paint over
// the dashboard, which is still working). So a crashed chrome surface renders
// NOTHING, and it is instead (a) recorded as a Collector row through the same
// crash channel the sections use, and (b) retried on a bounded schedule, because
// a silently-neutered overlay must not stay dead for the whole session if the
// crash was transient.
//
// WHAT IS *LOST* WHEN A SURFACE CRASHES IS ENUMERATED, NOT ASSUMED. Every entry
// in CHROME_SURFACES carries `lost`, the honest answer to "what does the
// operator stop seeing". The Node gate refuses a surface without one, so a
// future chrome surface cannot be fenced without stating its blast radius.

/** The shared crash channel's subject namespace for chrome (`chrome:toasts`). */
export const CHROME_SUBJECT_PREFIX = "chrome:";
/** Provenance tag on the Collector row a chrome failure produces. The section
 *  fence's tag is `feature-boundary` (F105) — two tags, so a reader can never
 *  confuse "a section is broken" with "an overlay is broken". */
export const CHROME_BOUNDARY_SOURCE = "chrome-boundary";
/** Automatic retry spacing. A crashed overlay is re-mounted once per interval
 *  until it either recovers or the attempt budget below is spent. */
export const CHROME_BOUNDARY_RETRY_MS = 2000;
/** Attempts per surface per session. 3 keeps a deterministic crash from
 *  flapping (it settles after ~6 s) while letting a transient one recover. */
export const CHROME_BOUNDARY_MAX_RETRIES = 3;
/** The event detail's discriminant. F105's original detail has no `kind`, and
 *  that is load-bearing: every F105 row/test written before this step still
 *  means "a route fence" (absent kind == "feature"). */
export const CHROME_BOUNDARY_KIND = "chrome";

/**
 * THE SURFACES. `id` is the ChromeBoundary prop (and the `chrome:<id>` subject);
 * `mount` is the exact JSX child the fence wraps (byte-identical to what the app
 * rendered before this step); `file` is where it is mounted; `lost` is what the
 * operator stops seeing while the surface is nulled.
 *
 * Order is mounting order: App.tsx chrome first, then the two inside AppShell,
 * then `shell` LAST because it is the OUTERMOST fence — a crash in it must be
 * caught by ChromeBoundary before the inner command palette / logon banner
 * fences are reached. (An inner boundary is the closer one, so nesting order in
 * this table is documentation; the code's nesting is what enforces it.)
 */
export const CHROME_SURFACES = [
  {
    id: "toasts",
    mount: "<Toasts />",
    file: "src/App.tsx",
    lost: "every toast - feedback, error and the 8s action button (the click still happens, only its report is invisible)",
  },
  {
    id: "diag-drawer",
    mount: "<DiagSideDrawer />",
    file: "src/App.tsx",
    lost: "the diagnostic side drawer (all 11 sections keep working)",
  },
  {
    id: "collector-bridge",
    mount: "<CollectorRunBridge />",
    file: "src/App.tsx",
    lost: "the F102 bridge that walks the Collector's \"Click now\" to the button's page (the click still lands in the store)",
  },
  {
    id: "dvr-fab",
    mount: "<DvrFab />",
    file: "src/App.tsx",
    lost: "the DVR handle and - because SessionListModal renders inside it - the sessions modal opened from the FAB",
  },
  {
    id: "debug-hud",
    mount: "<DebugHUD />",
    file: "src/App.tsx",
    lost: "the Shift+F12 Debug HUD (it is default-off, so most sessions lose nothing new)",
  },
  {
    id: "version-gate",
    mount: "<VersionGate />",
    file: "src/App.tsx",
    lost: "the F92 stale-bundle warning (the bundle keeps running; the ui-sha badge in the bottom bar still names the build)",
  },
  {
    id: "dash-token-gate",
    mount: "<DashTokenGate />",
    file: "src/App.tsx",
    lost: "the F94 missing-token gate - writes go unprotected by the LOCAL prompt and are refused by the server (403), which is the authority",
  },
  {
    id: "logon-banner",
    mount: "<LogonGateBanner />",
    file: "src/components/layout/AppShell.tsx",
    lost: "the F93 logon gate banner (the bottom bar's last-logon row still reports the same fact)",
  },
  {
    id: "command-palette",
    mount: "<CommandPalette />",
    file: "src/components/layout/AppShell.tsx",
    lost: "Ctrl+K and the palette (the sidebar, the Alt+E/Alt+F hotkeys and every route stay reachable)",
  },
  {
    id: "shell",
    mount: "<AppShell />",
    file: "src/App.tsx",
    lost: "the layout itself (top bar, sidebar, main, bottom bar) - the page keeps the chrome OUTSIDE the routes: toasts, the DVR handle, the HUD and the gates",
  },
];

export const CHROME_SURFACE_IDS = CHROME_SURFACES.map((s) => s.id);

/** Type guard for an untrusted value (a row read back, a test fixture). */
export function isChromeSurfaceId(value) {
  return typeof value === "string" && CHROME_SURFACE_IDS.indexOf(value) >= 0;
}

/** The descriptor for a surface, or null. Never throws: a crash report about an
 *  unknown surface must not itself crash. */
export function chromeSurfaceById(id) {
  for (const s of CHROME_SURFACES) if (s.id === id) return s;
  return null;
}

/** The shared channel's subject id for a chrome surface: `chrome:<id>`. */
export function chromeSubject(id) {
  return CHROME_SUBJECT_PREFIX + String(id == null ? "" : id);
}

/**
 * The retry policy, as a pure decision. `retriesSoFar` is how many automatic
 * re-mounts this surface has already spent; the first catch therefore spends
 * attempt 1 and leaves the budget at MAX - 1.
 */
export function chromeRetryDecision(retriesSoFar) {
  const spent = Number.isFinite(Number(retriesSoFar)) ? Math.max(0, Math.floor(Number(retriesSoFar))) : 0;
  return { retry: spent < CHROME_BOUNDARY_MAX_RETRIES, attempt: spent + 1, budget: CHROME_BOUNDARY_MAX_RETRIES };
}

/**
 * The Collector row one chrome failure produces (pure — the reporter writes it).
 * Same F100 ButtonAction shape and the same `renderError` action as F105's
 * section row, so the Collector page renders both provenances with one renderer;
 * `source` and `feature` keep them apart.
 */
export function chromeBoundaryCollectorRow(detail) {
  const d = detail || {};
  const surface = String(d.surface == null ? "" : d.surface);
  const known = chromeSurfaceById(surface);
  return {
    feature: chromeSubject(surface),
    action: "renderError",
    params: { surface, route: d.route, count: d.count, ts: d.ts },
    result: { captured: true, kind: CHROME_BOUNDARY_KIND },
    source: CHROME_BOUNDARY_SOURCE,
    error: d.message,
    verdict: {
      status: "fail",
      reason:
        "ChromeBoundary caught a render error in the " +
        (known ? known.id : surface || "unknown") +
        " chrome surface (it renders null while it is broken)",
      suggestedFix:
        "lost while broken: " +
        (known ? known.lost : "unknown surface") +
        " - the surface retries itself " +
        CHROME_BOUNDARY_MAX_RETRIES +
        " times, then stays null until a reload",
      relatedIssue: "#165",
    },
  };
}
