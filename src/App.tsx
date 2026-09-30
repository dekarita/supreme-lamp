// [F41 plan §2] App - HashRouter (the dashboard is served from a single URL;
// hash routes keep deep links working without server rewrites) + AppShell
// routes + toasts + diag side drawer + polling.
import { HashRouter, Route, Routes } from "react-router-dom";
import { useEffect } from "react";
import { AppShell } from "@/components/layout/AppShell";
import { Toasts } from "@/components/primitives/Feedback";
import { DiagSideDrawer } from "@/components/domain/DiagSideDrawer";
import { useDashboardPolling } from "@/hooks/useDashboardPolling";
import { useLangStore } from "@/stores/prefsStore";
import i18n from "@/i18n";
import Overview from "@/pages/Overview";
import Sessions from "@/pages/Sessions";
import Connections from "@/pages/Connections";
import Keys from "@/pages/Keys";
import FileExplorer from "@/pages/FileExplorer";
import Mirror from "@/pages/Mirror";
import Search from "@/pages/Search";
import Telemetry from "@/pages/Telemetry";
import Settings from "@/pages/Settings";

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
          <Route index element={<Overview />} />
          <Route path="/sessions" element={<Sessions />} />
          <Route path="/connections" element={<Connections />} />
          <Route path="/keys" element={<Keys />} />
          <Route path="/files" element={<FileExplorer />} />
          <Route path="/mirror" element={<Mirror />} />
          <Route path="/search" element={<Search />} />
          <Route path="/telemetry" element={<Telemetry />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="*" element={<Overview />} />
        </Route>
      </Routes>
      <Toasts />
      <DiagSideDrawer />
      </HashRouter>
    </>
  );
}
