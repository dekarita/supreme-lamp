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
import { Toasts } from "@/components/primitives/Feedback";
import { DiagSideDrawer } from "@/components/domain/DiagSideDrawer";
import { CollectorRunBridge } from "@/components/domain/CollectorRunBridge";
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
        <Route element={<AppShell />}>
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
          <Route path="*" element={fence("overview", <Overview />)} />
        </Route>
      </Routes>
      <Toasts />
      <DiagSideDrawer />
      {/* [F102 §2.1] Collector "Click now" navigates to the button's page */}
      <CollectorRunBridge />
      {/* [F92 §6.4] full-screen modal iff /api/f92-selftest says the bundle
          and the backend were built from different commits. */}
      <VersionGate />
      {/* [F94 §3.1] Last, so it paints on top: an unauthorised dashboard has
          nothing useful to show behind a modal it cannot dismiss. */}
      <DashTokenGate />
      </HashRouter>
    </>
  );
}
