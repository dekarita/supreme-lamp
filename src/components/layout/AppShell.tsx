// [F41 plan §4.16-§4.18 + §3] AppShell: TopBar (48px, sticky) + Sidebar
// (240px/64px, sticky, <1024 overlay) + Main (max-w-1600) + BottomBar (32px,
// sticky, the ONLY surface allowed to render the four time fields + clock -
// enforced by tests/smoke/bottom-bar-time.test.ts + scripts/check-bottom-bar-time.mjs).
import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { Activity, ChevronsLeft, Clock, Database, Folder, Globe, KeyRound, Menu, Moon, Search, Settings, Sun, Type, Zap } from "lucide-react";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { CommandPalette } from "@/components/layout/CommandPalette";
import { useThemeStore, useScaleStore, useLangStore, useSidebarStore } from "@/stores/prefsStore";
import { useTelemetryStore } from "@/stores/telemetryStore";
import { useSessionStore } from "@/stores/sessionStore";
import { Chip } from "@/components/primitives/Chip";
import { LogonGateBanner } from "@/components/domain/LogonGateBanner";
import { cn } from "@/lib/cn";
import { fmtHMS, pad2 } from "@/lib/format";
import { elapsedSeconds, remainingSeconds } from "@/stores/telemetryStore";
import { logonRowText, rdpUsageSeconds } from "@/lib/domain/native";
import { useNow } from "@/lib/useNow";

function clockText(ms: number): string {
  const d = new Date(ms);
  return pad2(d.getHours()) + ":" + pad2(d.getMinutes()) + ":" + pad2(d.getSeconds());
}

// [F43] one-release escape to classic v1. Prefer a relative '?ui=v1' so the
// ticket key is not required in the href; when the current URL already carries
// a query, rebuild via URLSearchParams (never a second literal '?').
function classicUiHref(base?: string): string {
  try {
    if (base == null && typeof location !== "undefined") {
      const sp = new URLSearchParams(location.search || "");
      sp.set("ui", "v1");
      const q = sp.toString();
      return q ? `?${q}` : "?ui=v1";
    }
    const raw = String(base || "?");
    const qAt = raw.indexOf("?");
    const norm = qAt >= 0 ? raw.slice(0, qAt + 1) + raw.slice(qAt + 1).replace(/\?/g, "&") : raw + "?";
    const u = new URL(norm, "http://local.invalid");
    u.searchParams.set("ui", "v1");
    return "?" + u.searchParams.toString();
  } catch {
    return "?ui=v1";
  }
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
  const wsAvailable = useTelemetryStore((s) => s.wsAvailable);
  // [F95 §3.4 / R4] ladder-exhausted state + the operator's Reconnect button.
  const wsDead = useTelemetryStore((s) => s.wsDead);
  const wsDeadReason = useTelemetryStore((s) => s.wsDeadReason);
  const wsAttempts = useTelemetryStore((s) => s.wsAttempts);
  const requestWsReconnect = useTelemetryStore((s) => s.requestWsReconnect);
  const progressLost = useTelemetryStore((s) => s.progressLost);
  const mirror = useTelemetryStore((s) => s.mirror);
  const serverNow = useTelemetryStore((s) => s.serverNow);
  useNow(1000);

  const connTone = progressLost ? "danger" : "success";
  const connText = progressLost ? t("activity.connection") + ": lost (retrying)" : t("activity.connection") + ": live";
  const watcherActive = !!mirror;
  const mirrorOn = !!(mirror && (mirror.files.length > 0 || mirror.pubDot !== ""));

  return (
    <header role="banner" className="sticky top-0 z-40 h-12 bg-surface border-b border-default flex items-center px-4 gap-3">
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
        {/* [F94 §3.5] "idle" used to be permanent and unexplained: /health
            hardcodes ws=$false and the connect path was gated on that flag, so
            the socket never opened. Now the pill reports the REAL state of our
            socket and names the endpoint's absence when that is the answer. */}
        <Chip
          id="pillRust"
          tone={wsLive ? "success" : wsDead ? "danger" : wsAvailable ? "warning" : "neutral"}
          dot
          title={
            wsLive
              ? "WebSocket bridge connected (/ws open)"
              : wsDead
                ? "WebSocket bridge DISCONNECTED - the 1s/3s/10s/30s reconnect ladder was exhausted after " +
                  wsAttempts +
                  " attempts (" + (wsDeadReason || "ladder-exhausted") + "). Use Reconnect, or reload with the dashboard ?key= if the session expired."
                : wsAvailable
                  ? "The server advertises /ws but no socket is open yet - retrying on the 1s/3s/10s/30s ladder"
                  : "This server exposes no /ws endpoint (the PowerShell dashboard server replies ws=false); live progress arrives by HTTP polling every 3s"
          }
        >
          {/* [F95 §3.4 / R4] "idle (no endpoint)" was the operator's verbatim
              pill text and it was a dead end: the socket could fail forever and
              still read "idle". A dead bridge now says DISCONNECTED and offers
              the one action that fixes it. */}
          {t("activity.websocket")}:{" "}
          {wsLive
            ? "live"
            : wsDead
              ? "DISCONNECTED"
              : wsAvailable
                ? "idle (retrying)"
                : "idle (no endpoint)"}
        </Chip>
        {wsDead ? (
          <button
            type="button"
            id="f95.wsReconnect"
            data-testid="ws-reconnect"
            onClick={() => requestWsReconnect()}
            className="px-2 py-0.5 text-xs rounded-md border border-danger/50 text-danger font-medium hover:bg-danger/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent whitespace-nowrap"
          >
            {t("activity.wsReconnect")}
          </button>
        ) : null}
        <Chip id="pillClock" tone="neutral" dot title="Server-side timestamp of the data below" className="font-mono">
          {t("activity.clock")}: {clockText(serverNow())}
        </Chip>
      </div>
      <div className="ml-auto flex items-center gap-1 shrink-0">
        <a
          id="classicUiLink"
          data-testid="classic-ui-link"
          href={classicUiHref()}
          rel="noopener"
          title={t("toggle.classicUi.title")}
          aria-label={t("toggle.classicUi.label")}
          className="px-2 py-1 text-xs font-medium rounded-md border border-default text-secondary hover:bg-raised hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent whitespace-nowrap"
        >
          {t("toggle.classicUi.short")}
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

// [F76 §2.1] 9 entries. Search moves to slot 2 (directly under Overview) so the
// high-frequency surface is visible without scrolling; the remaining entries keep
// their F56-c relative order (File Explorer above Mirror, Alt+E; ids unchanged:
// f57.explorer.nav / f56.search.nav). labelKey is additive: it lets the Search
// item render the dedicated sidebar.search catalog entry while nav.search stays
// the fallback (and the F56 i18n parity namespace keeps counting nav.search).
// [F77 §2.4] the 7-char sha of the ui bundle, stamped by vite.config define from
// build-ui.yml's GITHUB_SHA (fallback path in main.yml exports it too). "dev"
// means the operator is looking at an un-stamped local build.
const UI_SHA7: string = (import.meta.env.VITE_BUILD_SHA as string | undefined) || "dev";

interface NavItem {
  to: string;
  key: string;
  icon: typeof Activity;
  id?: string;
  hint?: string;
  labelKey?: string;
}

const NAV: NavItem[] = [
  { to: "/", key: "nav.overview", icon: Activity },
  { to: "/search", key: "nav.search", labelKey: "sidebar.search", icon: Search, id: "f56.search.nav", hint: "Alt+F" },
  { to: "/sessions", key: "nav.sessions", icon: Clock },
  { to: "/connections", key: "nav.connections", icon: Globe },
  { to: "/keys", key: "nav.keys", icon: KeyRound },
  { to: "/files", key: "nav.files", icon: Folder, id: "f57.explorer.nav", hint: "Alt+E" },
  { to: "/mirror", key: "nav.mirror", icon: Database },
  { to: "/telemetry", key: "nav.telemetry", icon: Zap },
  // [F92 §6.3] the self-test dashboard (/#/health): one row per F92 check,
  // each row's "fix" cell names the one-cell patch. Runs §13 step 4-6.
  { to: "/health", key: "nav.health", labelKey: "sidebar.health", icon: Activity, id: "f92.health.nav" },
  { to: "/settings", key: "nav.settings", icon: Settings },
];

function Sidebar() {
  const { t } = useTranslation();
  const collapsed = useSidebarStore((s) => s.collapsed);
  const toggleCollapsed = useSidebarStore((s) => s.toggleCollapsed);
  const mobileOpen = useSidebarStore((s) => s.mobileOpen);
  const setMobileOpen = useSidebarStore((s) => s.setMobileOpen);
  // [F77 §2.1] NO visibility gate on the Search entry (was: F69 §1.4 lane flag +
  // F76 filter). NAV is the locked 9-entry list and every item renders; there is
  // no lane/gate/enabled field left on any entry, so no /diag answer, store
  // field or cached flag can drop an item. Other lanes were never filtered here.
  const visibleNav = NAV;
  // [F77 §2.2] one-shot purge of lane flags an OLDER bundle may have cached in this
  // browser (the stale-dashboard vector). Idempotent; storage-less hosts ignored.
  useEffect(() => {
    try {
      window.localStorage.removeItem("__GHRDP_SEARCH_ENABLED");
      window.localStorage.removeItem("f56.search.enabled");
      window.localStorage.removeItem("ghrdp.lane.search");
    } catch {
      /* private mode / no storage: nothing to purge */
    }
  }, []);

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
          {visibleNav.map((item) => {
            const Icon = item.icon;
            // [F76 §2.1] sidebar.* label wins; nav.* stays the translated fallback
            // when a catalog predates the F76 keys.
            const label = item.labelKey ? t(item.labelKey, { defaultValue: t(item.key) }) : t(item.key);
            return (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.to === "/"}
                id={item.id}
                title={item.hint ? t(item.key) + " (" + item.hint + ")" : undefined}
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
                <span className={cn("truncate", collapsed && "lg:hidden")}>{label}</span>
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
    <footer role="contentinfo" className="sticky bottom-0 z-40 h-8 bg-surface border-t border-default flex items-center px-4 gap-6 overflow-x-auto">
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
      {/* [F77 §2.4] which ui-dist-<sha> bundle is actually loaded (hard-reload proof) */}
      <span
        id="uiShaBadge"
        data-testid="ui-sha-badge"
        title={"ui bundle sha " + UI_SHA7}
        className="font-mono text-[10px] text-tertiary whitespace-nowrap"
      >
        {"ui: " + UI_SHA7}
      </span>
    </footer>
  );
}

function useSessionNative() {
  return useSessionStore((s) => s.native);
}

export function AppShell() {
  const { t } = useTranslation();
  const navigate = useNavigate();

  // [F56-c] File Explorer = Alt+E, Search = Alt+F (session §1). Ctrl+K is
  // handled by CommandPalette (Plan §D: opens the palette; Search command
  // prefills /search without submitting).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey) return;
      const k = (e.key || "").toLowerCase();
      if (e.altKey && k === "e") {
        e.preventDefault();
        navigate("/files");
      } else if (e.altKey && k === "f") {
        e.preventDefault();
        navigate("/search");
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navigate]);

  return (
    <div className="min-h-screen bg-base text-primary flex flex-col">
      <a href="#main" className="skip-link">
        {t("app.skipToMain")}
      </a>
      <TopBar />
      {/* [F93 §2.1] Logon gate banner: top of EVERY route, self-hiding once a
          type-10 4624 is observed (no dismiss, no stale opt-out). */}
      <LogonGateBanner />
      <div className="flex flex-1 min-h-0">
        <Sidebar />
        <Main />
      </div>
      <BottomBar />
      <CommandPalette />
    </div>
  );
}
