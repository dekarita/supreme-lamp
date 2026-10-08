// [F41 plan §2] App - HashRouter (the dashboard is served from a single URL;
// hash routes keep deep links working without server rewrites) + AppShell
// routes + toasts + diag side drawer + polling.
import { HashRouter, Route, Routes } from "react-router-dom";
import { useEffect, type ReactNode } from "react";
import { AppShell } from "@/components/layout/AppShell";
// [F105 §2.3] The fence. Imported here, not by the pages: a route is the only
// way a section is mounted, so wiring the boundary into the route table is what
// makes "one section crashing cannot blank Mission Control" a structural fact
// instead of a convention each page has to remember.
import FeatureBoundary from "@/components/primitives/FeatureBoundary";
import type { FeatureId } from "@/lib/featureRegistry";
// [M2 §2.3] The chrome fence. F105 fenced the 11 SECTION routes and recorded the
// rest as handoff #1 ("a crash in one of those overlays still blanks the app");
// this is the fence that closes it. It is mounted around chrome only - never
// inside <Routes> - and renders nothing when healthy.
import ChromeBoundary from "@/components/primitives/ChromeBoundary";
import type { ChromeSurfaceId } from "@/lib/chromeBoundaryCore";
import { Toasts } from "@/components/primitives/Feedback";
import { DiagSideDrawer } from "@/components/domain/DiagSideDrawer";
import { CollectorRunBridge } from "@/components/domain/CollectorRunBridge";
import { DvrFab } from "@/components/domain/DvrFab";
// [F109] Debug HUD (Shift+F12): chrome, default-off, enabled from Settings.
import DebugHUD from "@/components/DebugHUD";
import { useDashboardPolling } from "@/hooks/useDashboardPolling";
import { useLangStore } from "@/stores/prefsStore";
import i18n from "@/i18n";
import Overview from "@/pages/Overview";
import Sessions from "@/pages/Sessions";
import Connections from "@/pages/Connections";
import Keys from "@/pages/Keys";
import FileExplorer from "@/pages/FileExplorer";
import Mirror from "@/pages/Mirror";
import SearchPage from "@/pages/Search";
import LabPage from "@/pages/search/Lab";
// [F92 §6] self-test dashboard + the full-screen stale-bundle gate.
import HealthPage from "@/pages/Health";
import { VersionGate } from "@/components/domain/F92VersionGate";
import Telemetry from "@/pages/Telemetry";
import Settings from "@/pages/Settings";
import Collector from "@/pages/Collector";
// [F106 §2] The Feature Lab. `/#/lab` (index) + `/#/lab/<featureId>` (one section
// in isolation). LabRoute owns its own FeatureBoundary, built from the route
// parameter, so the 13 literal fence() calls below are untouched - and the lab is
// still fenced with the id the operator actually asked for.
import LabRoute from "@/components/lab/LabRoute";
// [F94 §3.1] The dashboard-token gate: mounted at the ROOT, outside the router,
// so it renders on every route and before any page can attempt a write the
// server would refuse with a 403. One missing ?key= produced eight of the
// operator's reported symptoms; this is where that chain is cut.
import { DashTokenGate } from "@/components/domain/DashTokenGate";
// [F77 §2.1] The /search + /search/lab routes are UNCONDITIONAL. The F69 §1.4 /
// F72 §3.1 lane guards redirected both to Overview whenever /diag echoed
// searchEnabled=false, which is the same stale-flag failure class as the hidden
// sidebar entry: a runner that answered /diag before the dispatch input landed
// pinned the whole surface away. The Navigate import stays (the catch-all route).
/**
 * [F105 §2.3] `fence(id, node)` keeps the route table readable while making the
 * boundary unskippable. `id` is a FeatureId, so a typo is a compile error and
 * an unwrapped route cannot be written by accident: `tests/f105-*.test.js`
 * asserts every registry id appears here exactly once and the smoke gate
 * asserts all 11 boundaries are mounted on their 11 routes.
 */
function fence(id: FeatureId, node: ReactNode) {
  return <FeatureBoundary feature={id}>{node}</FeatureBoundary>;
}

/**
 * [M2 §2.3] `chrome(surface, node)` keeps the chrome mounts readable while
 * making the fence unskippable — the same shape as `fence()` above, with two
 * deliberate differences: the surface id is a ChromeSurfaceId (a typo is a
 * compile error), and the function is NOT called `fence` because F105-g counts
 * exactly 13 `fence("...")` calls in this file (11 sections + the Lab sub-route
 * + the catch-all). A chrome mount that read as a section fence would move that
 * pinned number instead of failing loudly, and a section that lost its fence
 * would still be counted. `tests/m2-chrome-unfencing.test.js` pins both counts.
 */
function chrome(surface: ChromeSurfaceId, node: ReactNode) {
  return <ChromeBoundary surface={surface}>{node}</ChromeBoundary>;
}

export default function App() {
  useDashboardPolling();
  const lang = useLangStore((s) => s.lang);
  useEffect(() => {
    void i18n.changeLanguage(lang);
    document.documentElement.lang = lang;
  }, [lang]);

  return (
    <>
      <span id="ghrdpBuild" className="hidden" data-build={__BUILD_SHA__} aria-hidden />
      <HashRouter>
      <Routes>
        {/* [M2 §2.3] The shell is the OUTERMOST chrome fence: a crash in the
            layout itself is caught here, so the chrome mounted below (toasts,
            DVR handle, HUD, the two gates) survives it. The two fences INSIDE
            the shell (command palette, logon banner) are closer boundaries, so
            they null only themselves - see AppShell.tsx. */}
        <Route element={chrome("shell", <AppShell />)}>
          {/* [F105 §2.3] 11 features, 11 fences - one per sidebar section. The
              Lab sub-route is part of the search feature, and the catch-all is
              the overview's, so there is no unfenced page route. */}
          <Route index element={fence("overview", <Overview />)} />
          <Route path="/sessions" element={fence("sessions", <Sessions />)} />
          <Route path="/connections" element={fence("connections", <Connections />)} />
          <Route path="/keys" element={fence("keys", <Keys />)} />
          <Route path="/files" element={fence("files", <FileExplorer />)} />
          <Route path="/mirror" element={fence("mirror", <Mirror />)} />
          <Route path="/search" element={fence("search", <SearchPage />)} />
          {/* [F72 §3.1] Lab Mode sub-route (Q3: dedicated sub-route, not drawer) */}
          <Route path="/search/lab/:targetId" element={fence("search", <LabPage />)} />
          <Route path="/telemetry" element={fence("telemetry", <Telemetry />)} />
          <Route path="/health" element={fence("health", <HealthPage />)} />
          <Route path="/collector" element={fence("collector", <Collector />)} />
          <Route path="/settings" element={fence("settings", <Settings />)} />
          {/* [F106 §2] Feature Lab routes. Additive and lab-only: the 11 section
              routes above are byte-identical to their pre-F106 form, and the lab
              pattern is the one the F105 registry reserved (`labRoutePattern`).
              Related pins moved in this commit: tests/f105-feature-registry.test.js
              F105-h learns the pattern from the registry instead of a hand list. */}
          <Route path="/lab" element={<LabRoute />} />
          <Route path="/lab/:featureId" element={<LabRoute />} />
          <Route path="*" element={fence("overview", <Overview />)} />
        </Route>
      </Routes>
      {/* [M2 §2.3] THE CHROME FENCES. Every mount below is byte-identical to
          what this file rendered before M2 - only the fence around it is new -
          so the component's own test ids, props and mounting order are
          untouched (F-DVR-i's `<CollectorRunBridge />` before `<DvrFab />` and
          F109-f's `<DebugHUD />` after `</Routes>` are still literally true).
          A surface that crashes renders NOTHING (not a card): chrome is an
          overlay the operator did not ask for, and the diagnosis belongs in the
          Collector row + the Debug HUD, not painted over a working dashboard. */}
      {chrome("toasts", <Toasts />)}
      {chrome("diag-drawer", <DiagSideDrawer />)}
      {/* [F102 §2.1] Collector "Click now" navigates to the button's page */}
      {chrome("collector-bridge", <CollectorRunBridge />)}
      {/* [F-DVR-LITE §4] The diagnostic DVR handle: last 30 s of clicks, assembled
          in this tab and only ever copied by the operator (#169 option (d)). Mounted
          as chrome, like the bridge above, so every section route has it and no
          FeatureBoundary fence has to know about it. Fencing it also fences
          SessionListModal opened from the FAB, which renders inside this tree. */}
      {chrome("dvr-fab", <DvrFab />)}
      {/* [F109] The Debug HUD. Chrome like the DVR handle above - outside every
          FeatureBoundary and outside AppShell - so it still opens when a section
          or the shell has crashed. Renders nothing until Settings ▸ Debug HUD is on
          and Shift+F12 opens it. */}
      {chrome("debug-hud", <DebugHUD />)}
      {/* [F92 §6.4] full-screen modal iff /api/f92-selftest says the bundle
          and the backend were built from different commits. */}
      {chrome("version-gate", <VersionGate />)}
      {/* [F94 §3.1] Last, so it paints on top: an unauthorised dashboard has
          nothing useful to show behind a modal it cannot dismiss. */}
      {chrome("dash-token-gate", <DashTokenGate />)}
      </HashRouter>
    </>
  );
}
