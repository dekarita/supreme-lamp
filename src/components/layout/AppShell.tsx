// [F41 plan §4.16-§4.18 + §3] AppShell: TopBar (48px, sticky) + Sidebar
// (240px/64px, sticky, <1024 overlay) + Main (max-w-1600) + BottomBar (32px,
// sticky, the ONLY surface allowed to render the four time fields + clock -
// enforced by tests/smoke/bottom-bar-time.test.ts + scripts/check-bottom-bar-time.mjs).
import { NavLink, Outlet } from "react-router-dom";
import { Activity, ChevronsLeft, Clock, Database, Globe, KeyRound, Menu, Moon, Settings, Sun, Type, Zap } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useThemeStore, useScaleStore, useLangStore, useSidebarStore } from "@/stores/prefsStore";
import { useTelemetryStore } from "@/stores/telemetryStore";
import { useSessionStore } from "@/stores/sessionStore";
import { Chip } from "@/components/primitives/Chip";
import { cn } from "@/lib/cn";
import { fmtHMS, pad2 } from "@/lib/format";
import { elapsedSeconds, remainingSeconds } from "@/stores/telemetryStore";
import { logonRowText, rdpUsageSeconds } from "@/lib/domain/native";
import { useNow } from "@/lib/useNow";

function clockText(ms: number): string {
  const d = new Date(ms);
  return pad2(d.getHours()) + ":" + pad2(d.getMinutes()) + ":" + pad2(d.getSeconds());
}

function TopBar() {
  const { t } = useTranslation();
  const theme = useThemeStore((s) => s.theme);
  const toggleTheme = useThemeStore((s) => s.toggle);
  const scale = useScaleStore((s) => s.scale);
  const cycleScale = useScaleStore((s) => s.cycle);
  const lang = useLangStore((s) => s.lang);
  const toggleLang = useLangStore((s) => s.toggle);
  const setMobileOpen = useSidebarStore((s) => s.setMobileOpen);
  const wsLive = useTelemetryStore((s) => s.wsLive);
  const progressLost = useTelemetryStore((s) => s.progressLost);
  const mirror = useTelemetryStore((s) => s.mirror);
  const serverNow = useTelemetryStore((s) => s.serverNow);
  useNow(1000);

  const connTone = progressLost ? "danger" : "success";
  const connText = progressLost ? t("activity.connection") + ": lost (retrying)" : t("activity.connection") + ": live";
  const watcherActive = !!mirror;
  const mirrorOn = !!(mirror && (mirror.files.length > 0 || mirror.pubDot !== ""));

  return (
    <header role="banner" data-testid="topbar" className="sticky top-0 z-40 h-12 bg-surface border-b border-default flex items-center px-4 gap-3">
      <button
        type="button"
        className="lg:hidden text-secondary hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded"
        aria-label={t("sidebar.menu")}
        onClick={() => setMobileOpen(true)}
      >
        <Menu className="size-5" aria-hidden />
      </button>
      <div className="flex items-center gap-2 shrink-0">
        <span className="inline-block size-2 rounded-full bg-accent" aria-hidden />
        <Activity className="size-4 text-accent" aria-hidden />
        <h1 className="text-sm font-semibold text-primary whitespace-nowrap">{t("app.title")}</h1>
      </div>
      <div role="status" aria-live="polite" id="topbarChips" className="hidden md:flex items-center gap-2 min-w-0 overflow-x-auto">
        <Chip id="pillConn" tone={connTone} dot title="Actual result of the last data fetch">
          {connText}
        </Chip>
        <Chip id="pillMirror" tone={mirrorOn ? "success" : "neutral"} dot title="Mirror ON only when mirroring was enabled AND the watcher heartbeat is under 15s old">
          {t("activity.mirror")}: {mirrorOn ? "ON" : "OFF"}
        </Chip>
        <Chip id="pillWatcher" tone={watcherActive ? "success" : "neutral"} dot title="Watcher heartbeats every 5s. ACTIVE = heartbeat younger than 15s">
          {t("activity.watcher")}: {watcherActive ? "ACTIVE" : "IDLE"}
        </Chip>
        <Chip id="pillRust" tone={wsLive ? "success" : "neutral"} dot title="Rust WebSocket bridge (port 7332). LIVE = /ws connected">
          {t("activity.websocket")}: {wsLive ? "live" : "idle"}
        </Chip>
        <Chip id="pillClock" tone="neutral" dot title="Server-side timestamp of the data below" className="font-mono">
          {t("activity.clock")}: {clockText(serverNow())}
        </Chip>
      </div>
      <div className="ml-auto flex items-center gap-1 shrink-0">
        <a
          id="classicUiLink"
          href="?ui=v1"
          className="px-2 py-1 text-xs font-medium rounded-md border border-default text-secondary hover:bg-raised hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          {t("nav.classicUi")}
        </a>
        <button
          id="langToggle"
          type="button"
          onClick={toggleLang}
          aria-label={t("toggle.language.label")}
          className="px-2 py-1 text-xs font-medium rounded-md border border-default text-secondary hover:bg-raised hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          {lang === "si" ? t("toggle.language.shortEn") : t("toggle.language.shortSi")}
        </button>
        <button
          id="textScaleToggle"
          type="button"
          onClick={cycleScale}
          aria-pressed={scale !== "comfort"}
          aria-label={t("toggle.scale.label") + ": " + t("toggle.scale." + scale)}
          title={t("toggle.scale.label") + ": " + t("toggle.scale." + scale)}
          className="px-2 py-1 text-xs font-medium rounded-md border border-default text-secondary hover:bg-raised hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent inline-flex items-center gap-1"
        >
          <Type className="size-3.5" aria-hidden />
          <span id="textScaleLabel">{scale === "comfort" ? "Aa" : scale === "large" ? "A+" : "A++"}</span>
        </button>
        <button
          id="themeToggle"
          type="button"
          onClick={toggleTheme}
          aria-pressed={theme === "light"}
          aria-label={t("toggle.theme.label")}
          title={t("toggle.theme.label")}
          className="px-2 py-1 text-xs font-medium rounded-md border border-default text-secondary hover:bg-raised hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent inline-flex items-center gap-1"
        >
          {theme === "light" ? <Sun className="size-3.5" aria-hidden /> : <Moon className="size-3.5" aria-hidden />}
          <span id="themeLabel">{theme}</span>
        </button>
      </div>
    </header>
  );
}

const NAV = [
  { to: "/", key: "nav.overview", icon: Activity },
  { to: "/sessions", key: "nav.sessions", icon: Clock },
  { to: "/connections", key: "nav.connections", icon: Globe },
  { to: "/keys", key: "nav.keys", icon: KeyRound },
  { to: "/mirror", key: "nav.mirror", icon: Database },
  { to: "/telemetry", key: "nav.telemetry", icon: Zap },
  { to: "/settings", key: "nav.settings", icon: Settings },
];

function Sidebar() {
  const { t } = useTranslation();
  const collapsed = useSidebarStore((s) => s.collapsed);
  const toggleCollapsed = useSidebarStore((s) => s.toggleCollapsed);
  const mobileOpen = useSidebarStore((s) => s.mobileOpen);
  const setMobileOpen = useSidebarStore((s) => s.setMobileOpen);

  return (
    <>
      <div className={cn("fixed inset-0 z-40 bg-black/40 lg:hidden", mobileOpen ? "block" : "hidden")} onClick={() => setMobileOpen(false)} aria-hidden />
      <aside
        aria-label={t("sidebar.nav")}
        data-testid="sidebar"
        className={cn(
          "sticky top-12 self-start h-[calc(100vh-5rem)] bg-surface border-r border-default",
          "flex flex-col shrink-0 transition-[width] duration-med z-40",
          collapsed ? "w-16" : "w-60",
          "max-lg:fixed max-lg:inset-y-0 max-lg:left-0 max-lg:top-0 max-lg:h-full max-lg:w-60 max-lg:z-50",
          mobileOpen ? "max-lg:block" : "max-lg:hidden"
        )}
      >
        <nav aria-label={t("sidebar.nav")} className="flex-1 overflow-y-auto py-3">
          {NAV.map((item) => {
            const Icon = item.icon;
            return (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.to === "/"}
                onClick={() => setMobileOpen(false)}
                className={({ isActive }) =>
                  cn(
                    "flex items-center gap-3 px-3 py-2 mx-2 rounded-md text-sm",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
                    isActive ? "bg-accent/10 text-accent font-medium" : "text-secondary hover:bg-raised hover:text-primary"
                  )
                }
              >
                <Icon className="size-5 shrink-0" aria-hidden />
                <span className={cn("truncate", collapsed && "lg:hidden")}>{t(item.key)}</span>
              </NavLink>
            );
          })}
        </nav>
        <button
          type="button"
          onClick={toggleCollapsed}
          aria-label={collapsed ? t("sidebar.expand") : t("sidebar.collapse")}
          aria-pressed={collapsed}
          data-testid="sidebar-collapse"
          className="mx-2 mb-3 p-2 rounded-md text-tertiary hover:bg-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent hidden lg:block"
        >
          <ChevronsLeft className={cn("size-4 transition-transform duration-fast", collapsed && "rotate-180")} aria-hidden />
        </button>
      </aside>
    </>
  );
}

function Main() {
  return (
    <main id="main" className="flex-1 min-w-0 min-h-0">
      <div className="max-w-shell mx-auto px-4 md:px-6 py-6">
        <Outlet />
      </div>
    </main>
  );
}

function BottomBar() {
  const { t } = useTranslation();
  const serverNow = useTelemetryStore((s) => s.serverNow);
  const runStartedAtMs = useTelemetryStore((s) => s.runStartedAtMs);
  const usage = useTelemetryStore((s) => s.rdpUsage);
  const logonFallback = useTelemetryStore((s) => s.rdpLogonFallback);
  const native = useSessionNative();
  useNow(1000);
  const now = serverNow();

  const el = elapsedSeconds(runStartedAtMs, now);
  const rem = remainingSeconds(runStartedAtMs, now);
  const usageSec = rdpUsageSeconds(usage, logonFallback, now);
  const rl = (native && native.rdpListener) || null;
  const row = logonRowText((rl && rl.authLast) || null, (rl && rl.logonCollector) || (native && native.logonCollector) || null, now);

  return (
    <footer role="contentinfo" data-testid="bottombar" className="sticky bottom-0 z-40 h-8 bg-surface border-t border-default flex items-center px-4 gap-6 overflow-x-auto">
      <span id="status-runner-elapsed" className="bb-item font-mono text-xs text-tertiary whitespace-nowrap">
        {t("status.runnerElapsed")}{" "}
        <span id="timerElapsed" className="text-secondary" data-testid="bb-elapsed">
          {el == null ? "--:--:--" : fmtHMS(el)}
        </span>
      </span>
      <span id="status-remaining" className="bb-item font-mono text-xs text-tertiary whitespace-nowrap">
        {t("status.remaining")}{" "}
        <span id="timerRemaining" className="text-secondary">
          {runStartedAtMs == null ? fmtHMS(19800) : fmtHMS(rem)}
        </span>
      </span>
      <span id="status-rdp-usage" className="bb-item font-mono text-xs text-tertiary whitespace-nowrap">
        {t("status.rdpUsage")}{" "}
        <span id="timerRdpUsage" className="text-secondary" data-testid="bb-usage">
          {usageSec.sec == null || isNaN(usageSec.sec) ? "--:--:--" : fmtHMS(usageSec.sec)}
        </span>
        <span
          id="usageState"
          className={"ml-1 text-[10px] font-medium rounded px-1 " + (usage && usage.active ? "text-success" : "text-warning")}
        >
          {usage ? (usage.active ? "live" : "frozen") : "--"}
        </span>
        <span id="c2SrvBottom" className="ml-1 text-[10px] text-tertiary">
          srv {(native && native.pingMs != null ? native.pingMs + " ms" : "--")}
        </span>
      </span>
      <span id="status-last-logon" className="bb-item font-mono text-xs text-tertiary whitespace-nowrap">
        {t("status.lastLogon")}{" "}
        <span
          id="lastRdpLogon"
          className="text-secondary"
          data-testid="bb-last-logon"
          style={{ color: row.dead || row.red ? "var(--color-danger)" : row.result === "success" ? "var(--color-success)" : row.result === "failed" ? "var(--color-warning)" : "" }}
        >
          {row.text}
        </span>
      </span>
      <span id="status-clock" className="ml-auto font-mono text-xs text-tertiary whitespace-nowrap">
        <span id="bottomClock">{clockText(now)}</span>
      </span>
    </footer>
  );
}

function useSessionNative() {
  return useSessionStore((s) => s.native);
}

export function AppShell() {
  const { t } = useTranslation();
  return (
    <div className="min-h-screen bg-base text-primary flex flex-col">
      <a href="#main" className="skip-link">
        {t("app.skipToMain")}
      </a>
      <TopBar />
      <div className="flex flex-1 min-h-0">
        <Sidebar />
        <Main />
      </div>
      <BottomBar />
    </div>
  );
}
