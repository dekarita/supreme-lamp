// [F41 plan §4.16-§4.18 + §3] AppShell: TopBar (sticky) + Sidebar
// (240px/64px, sticky, <1024 overlay) + Main (max-w-1600) + BottomBar (32px,
// sticky, the ONLY surface allowed to render the four time fields + clock -
// enforced by tests/smoke/bottom-bar-time.test.ts + scripts/check-bottom-bar-time.mjs).
//
// [R-GLASS / #213] The chrome is now ONE glass surface (the sticky TopBar) with
// the sidebar, the status bar and the mobile bar as paint-only nested surfaces.
// That is the compositor budget from #213 §6 made structural: exactly one
// element may own `backdrop-filter` in the normal shell.
//
// [R-UX / #214] Responsive instead of compressed: the phone gets a 5-slot
// primary bar (Overview / Search / Files / Mirror / More) and the tablet keeps
// the desktop sidebar, chosen from available space rather than device branding.
// Safe-area insets, 44px targets and a visible drawer close replace the
// hover-only affordances the old shell relied on.
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { Activity, ChevronsLeft, ClipboardList, Clock, Database, FlaskConical, Folder, Globe, KeyRound, Menu, Moon, MoreHorizontal, Search, Settings, Sun, Type, X, Zap } from "lucide-react";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { CommandPalette } from "@/components/layout/CommandPalette";
// [M2 §2.3] Both fences below are INSIDE the shell's own ChromeBoundary, so they
// are the closer boundary for their own subtree: a crash in the palette or the
// logon banner nulls that surface only, and never reaches the shell's fence.
import ChromeBoundary from "@/components/primitives/ChromeBoundary";
import { useThemeStore, useScaleStore, useLangStore, useSidebarStore } from "@/stores/prefsStore";
// [F106 §5] The Labs entry: flag-gated (VITE_F106_LABS) or shown while the operator
// is inside the lab, and rendered OUTSIDE <nav> on purpose - the 11-entry NAV list
// is a locked contract (F56-c + two smoke suites pin every href and the order), so
// the lab must not become a 12th entry by accident. See src/lib/lab/labFlags.ts.
import { labEntryVisible, labIndexRoute } from "@/lib/lab/labFlags";
import { useTelemetryStore } from "@/stores/telemetryStore";
import { useSessionStore } from "@/stores/sessionStore";
import { Chip } from "@/components/primitives/Chip";
import { LogonGateBanner } from "@/components/domain/LogonGateBanner";
import { cn } from "@/lib/cn";
import { fmtHMS, pad2 } from "@/lib/format";
import { elapsedSeconds, remainingTimeFromStore } from "@/stores/telemetryStore";
import { logonRowText, rdpUsageSeconds } from "@/lib/domain/native";
import { useNow } from "@/lib/useNow";
import { logButtonAction } from "@/lib/collectorAgent";
// [R-GLASS] the shared glass primitive + the decorative backdrop.
import GlassContainer from "@/components/primitives/GlassContainer";
import AppBackdrop from "@/components/layout/AppBackdrop";
import { useVisualQualityRootAttribute } from "@/lib/glass/useVisualQuality";
// [R-UX / #214 §4] Escape + focus trap + focus restoration for the mobile drawer.
import { useOverlayA11y } from "@/lib/useOverlayA11y";

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

  // [#214 §4] 44px minimum on every top-bar control; the glyph stays 20px.
  const barBtn =
    "tap-44 inline-flex items-center justify-center gap-1 px-2 text-xs font-medium rounded-md border border-default text-secondary hover:bg-raised hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-base whitespace-nowrap";

  return (
    <GlassContainer
      as="header"
      surface="backdrop"
      variant="tinted"
      radius="none"
      role="banner"
      data-testid="app-topbar"
      className={cn(
        "sticky top-0 z-40 flex items-center gap-3 px-4 safe-x",
        // [#214 §6] the iOS status bar / notch.
        "pt-[max(0.5rem,env(safe-area-inset-top))] pb-2 min-h-14"
      )}
      style={{ borderTop: "none", borderLeft: "none", borderRight: "none" }}
    >
      <button
        data-testid="topbar-mobile-menu"
        type="button"
        className="tap-44 -ml-2 inline-flex items-center justify-center rounded-md text-secondary hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent lg:hidden"
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
            onClick={() => {
              const _start = performance.now();
              requestWsReconnect();
              logButtonAction({
                feature: "websocket",
                action: "reconnect",
                params: {},
                result: { requested: true },
                elapsedMs: Math.round(performance.now() - _start),
              });
            }}
            className="px-2 py-0.5 text-xs rounded-md border border-danger/50 text-danger font-medium hover:bg-danger/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent whitespace-nowrap min-h-[32px]"
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
          className={barBtn}
        >
          {t("toggle.classicUi.short")}
        </a>
        <button
          data-testid="topbar-lang-toggle"
          id="langToggle"
          type="button"
          onClick={toggleLang}
          aria-label={t("toggle.language.label")}
          className={barBtn}
        >
          {lang === "si" ? t("toggle.language.shortEn") : t("toggle.language.shortSi")}
        </button>
        <button
          data-testid="topbar-text-scale-toggle"
          id="textScaleToggle"
          type="button"
          onClick={cycleScale}
          aria-pressed={scale !== "comfort"}
          aria-label={t("toggle.scale.label") + ": " + t("toggle.scale." + scale)}
          title={t("toggle.scale.label") + ": " + t("toggle.scale." + scale)}
          className={cn(barBtn, "inline-flex items-center gap-1")}
        >
          <Type className="size-3.5" aria-hidden />
          <span id="textScaleLabel">{scale === "comfort" ? "Aa" : scale === "large" ? "A+" : "A++"}</span>
        </button>
        <button
          data-testid="topbar-theme-toggle"
          id="themeToggle"
          type="button"
          onClick={toggleTheme}
          aria-pressed={theme === "light"}
          aria-label={t("toggle.theme.label")}
          title={t("toggle.theme.label")}
          className={cn(barBtn, "inline-flex items-center gap-1")}
        >
          {theme === "light" ? <Sun className="size-3.5" aria-hidden /> : <Moon className="size-3.5" aria-hidden />}
          <span id="themeLabel" className="hidden sm:inline">{theme}</span>
        </button>
      </div>
    </GlassContainer>
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
  // [F99 §3] Collector — live feature probes (POST /api/collector/run 1/5 min)
  { to: "/collector", key: "nav.collector", labelKey: "sidebar.collector", icon: ClipboardList, id: "f99.collector.nav" },
  { to: "/settings", key: "nav.settings", icon: Settings },
];

/**
 * [R-UX / #214 §5] The phone's PRIMARY bar: 5 slots including "More".
 * There is deliberately no "/downloads" entry — downloads live in the
 * explorer's progress rail and the search fetch card, and #214 forbids
 * inventing a route to make a nav list look tidy. "More" opens the SAME
 * 11-destination drawer the desktop sidebar becomes below lg.
 */
const MOBILE_PRIMARY: NavItem[] = [
  NAV[0],
  NAV[1],
  NAV[5],
  NAV[6],
];

function Sidebar() {
  const { t } = useTranslation();
  const collapsed = useSidebarStore((s) => s.collapsed);
  const toggleCollapsed = useSidebarStore((s) => s.toggleCollapsed);
  const mobileOpen = useSidebarStore((s) => s.mobileOpen);
  const setMobileOpen = useSidebarStore((s) => s.setMobileOpen);
  // [F106 §5] the Labs entry navigates imperatively (it is a button, not a link)
  const navigate = useNavigate();
  // [F77 §2.1] NO visibility gate on the Search entry (was: F69 §1.4 lane flag +
  // F76 filter). NAV is the locked 9-entry list and every item renders; there is
  // no lane/gate/enabled field left on any entry, so no /diag answer, store
  // field or cached flag can drop an item. Other lanes were never filtered here.
  const visibleNav = NAV;
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const drawerRef = useRef<HTMLElement | null>(null);
  // [#214 §4] Escape closes the drawer, Tab is trapped inside it, and focus
  // returns to the control that opened it. The Android back gesture is NOT the
  // only way out any more: the drawer has a visible close button.
  useOverlayA11y({ open: mobileOpen, onClose: () => setMobileOpen(false), containerRef: drawerRef });

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
      <div className={cn("fixed inset-0 z-40 bg-black/50 lg:hidden", mobileOpen ? "block" : "hidden")} onClick={() => setMobileOpen(false)} aria-hidden />
      <GlassContainer
        as="aside"
        surface="nested"
        variant="tinted"
        radius="none"
        aria-label={t("sidebar.nav")}
        data-testid="sidebar"
        ref={drawerRef as React.Ref<HTMLElement>}
        className={cn(
          "self-start border-r flex flex-col shrink-0 transition-[width] duration-med z-40",
          // [#214 §6] clear the safe area on the phone, where the drawer is a
          // full-height overlay.
          "pt-[max(0px,env(safe-area-inset-top))] pb-[max(0px,env(safe-area-inset-bottom))] pl-[max(0px,env(safe-area-inset-left))]",
          collapsed ? "w-16" : "w-60",
          "lg:sticky lg:top-14 lg:h-[calc(100dvh-5.5rem)]",
          "max-lg:fixed max-lg:inset-y-0 max-lg:left-0 max-lg:top-0 max-lg:h-full max-lg:w-[min(17rem,85vw)] max-lg:z-50",
          mobileOpen ? "max-lg:block" : "max-lg:hidden"
        )}
        style={{ borderTop: "none", borderBottom: "none", borderLeft: "none" }}
      >
        {/* [#214 §7] Rendered only while the drawer is OPEN: a control that
            belongs to an overlay should not exist in the accessibility tree
            when that overlay is closed (and it must not be the Android back
            gesture alone that gets the operator out). */}
        {mobileOpen ? (
          <div className="flex items-center gap-2 px-3 py-2 lg:hidden">
            <span className="text-xs font-semibold uppercase tracking-wide text-tertiary">{t("sidebar.nav")}</span>
            <button
              ref={closeRef}
              type="button"
              onClick={() => setMobileOpen(false)}
              aria-label={t("sidebar.close")}
              data-testid="sidebar-close"
              className="tap-44 ml-auto inline-flex items-center justify-center rounded-md text-secondary hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              <X className="size-5" aria-hidden />
            </button>
          </div>
        ) : null}
        <nav aria-label={t("sidebar.nav")} className="flex-1 overflow-y-auto py-1 lg:py-3">
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
                    // [#214 §4] 44px tall rows, and the name stays VISIBLE even
                    // when the desktop sidebar is collapsed - on a touch device
                    // a `title` attribute is not an accessible name.
                    "flex items-center gap-3 px-3 mx-2 rounded-md text-sm min-h-[44px]",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-inset",
                    isActive
                      ? "bg-accent/15 text-accent font-semibold shadow-[inset_2px_0_0_0_var(--color-accent)]"
                      : "text-secondary hover:bg-raised/60 hover:text-primary"
                  )
                }
              >
                <Icon className="size-5 shrink-0" aria-hidden />
                <span className={cn("truncate", collapsed && "lg:hidden")}>{label}</span>
                {/* Collapsed desktop: the name is still in the accessible name
                    and still in the DOM, so a focus ring lands on something a
                    screen reader can announce. */}
                {collapsed ? <span className="sr-only lg:not-sr-only lg:hidden">{label}</span> : null}
              </NavLink>
            );
          })}
        </nav>
        {/* [F106 §5] The lab entry. A BUTTON, not a NavLink, and outside <nav>: the
            locked 11-entry list (and every test that counts `nav a`) is untouched.
            Hidden by default - the lab's stable entry point is the deep link
            `/#/lab`; this appears when VITE_F106_LABS=true or when the operator is
            already on a lab route (so there is a way back to the index). */}
        {labEntryVisible() ? (
          <button
            type="button"
            data-testid="lab-nav-entry"
            onClick={() => {
              setMobileOpen(false);
              navigate(labIndexRoute());
            }}
            className="mx-2 mb-1 flex items-center gap-3 px-3 rounded-md text-sm text-secondary hover:bg-raised/60 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent min-h-[44px]"
          >
            <FlaskConical className="size-5 shrink-0" aria-hidden />
            <span className={cn("truncate", collapsed && "lg:hidden")}>{t("featureLab.entry")}</span>
          </button>
        ) : null}
        <button
          type="button"
          onClick={toggleCollapsed}
          aria-label={collapsed ? t("sidebar.expand") : t("sidebar.collapse")}
          aria-pressed={collapsed}
          data-testid="sidebar-collapse"
          className="tap-44 mx-2 mb-3 inline-flex items-center justify-center rounded-md text-tertiary hover:bg-raised/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent hidden lg:inline-flex"
        >
          <ChevronsLeft className={cn("size-4 transition-transform duration-fast", collapsed && "rotate-180")} aria-hidden />
        </button>
      </GlassContainer>
    </>
  );
}

/**
 * [R-UX / #214 §5] The phone bar. Five slots, each 44px+ tall, each with a
 * visible label (icon-only navigation was explicitly rejected in #214 §5 —
 * eleven abstract glyphs are not learnable). It is a `nav` with its OWN
 * testid so the locked desktop selector `[data-testid="sidebar"] nav a`
 * counts exactly what it counted before.
 */
function MobileNav() {
  const { t } = useTranslation();
  const setMobileOpen = useSidebarStore((s) => s.setMobileOpen);
  const location = useLocation();
  return (
    <GlassContainer
      as="nav"
      surface="nested"
      variant="tinted"
      radius="none"
      aria-label={t("nav.primary")}
      data-testid="mobile-nav"
      className={cn(
        "sticky bottom-0 z-40 flex items-stretch lg:hidden safe-x border-b-0",
        "pb-[max(0.25rem,env(safe-area-inset-bottom))]"
      )}
      style={{ borderBottom: "none", borderLeft: "none", borderRight: "none" }}
    >
      {MOBILE_PRIMARY.map((item) => {
        const Icon = item.icon;
        const label = item.labelKey ? t(item.labelKey, { defaultValue: t(item.key) }) : t(item.key);
        const active = item.to === "/" ? location.pathname === "/" : location.pathname.startsWith(item.to);
        return (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.to === "/"}
            data-testid={"mobile-nav-" + (item.id || item.to.replace(/\//g, "") || "home")}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex min-h-[52px] flex-1 flex-col items-center justify-center gap-0.5 px-1 text-[11px] leading-tight",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent",
              active ? "text-accent font-semibold" : "text-secondary"
            )}
          >
            <Icon className="size-5 shrink-0" aria-hidden />
            <span className="max-w-full truncate">{label}</span>
          </NavLink>
        );
      })}
      <button
        type="button"
        data-testid="mobile-nav-more"
        onClick={() => setMobileOpen(true)}
        aria-label={t("nav.more")}
        className={cn(
          "flex min-h-[52px] flex-1 flex-col items-center justify-center gap-0.5 px-1 text-[11px] leading-tight text-secondary",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent"
        )}
      >
        <MoreHorizontal className="size-5 shrink-0" aria-hidden />
        <span className="max-w-full truncate">{t("nav.more")}</span>
      </button>
    </GlassContainer>
  );
}

function Main() {
  return (
    <main id="main" className="flex-1 min-w-0 min-h-0">
      {/* [#214 §8] bottom padding keeps the last row clear of the phone bar and
          the toasts, instead of relying on the operator to scroll "far enough". */}
      <div className="max-w-shell mx-auto px-4 md:px-6 py-5 pb-24 lg:pb-6">
        <Outlet />
      </div>
    </main>
  );
}

function BottomBar() {
  const { t } = useTranslation();
  const serverNow = useTelemetryStore((s) => s.serverNow);
  const runStartedAtMs = useTelemetryStore((s) => s.runStartedAtMs);
  const sessionEndMs = useTelemetryStore((s) => s.sessionEndMs);
  const usage = useTelemetryStore((s) => s.rdpUsage);
  const logonFallback = useTelemetryStore((s) => s.rdpLogonFallback);
  const native = useSessionNative();
  useNow(1000);
  const now = serverNow();

  const el = elapsedSeconds(runStartedAtMs, now);
  // [R-METRICS / #212] The remaining figure now names its own basis: the
  // server-published sessionEnd when the server published one, the labelled
  // 5h30 policy window second, and an explicit unknown state otherwise. The
  // old code rendered 05:30:00 whenever the run start was unknown, which is a
  // measured-looking number with nothing behind it.
  const rem = remainingTimeFromStore({ sessionEndMs, runStartedAtMs, now });
  const remBasisKey =
    rem.basis === "server-session-end"
      ? "connection.remainingBasis.server"
      : rem.basis === "policy-window"
        ? "connection.remainingBasis.policy"
        : "connection.remainingBasis.unknown";
  const usageSec = rdpUsageSeconds(usage, logonFallback, now);
  const rl = (native && native.rdpListener) || null;
  const row = logonRowText((rl && rl.authLast) || null, (rl && rl.logonCollector) || (native && native.logonCollector) || null, now);

  return (
    <GlassContainer
      as="footer"
      surface="nested"
      variant="tinted"
      radius="none"
      role="contentinfo"
      data-testid="app-bottombar"
      className={cn(
        "z-30 flex items-center gap-6 overflow-x-auto px-4 h-9 safe-x",
        // [#214 §8] on the phone the status row scrolls with the content
        // instead of stacking under the primary bar.
        "lg:sticky lg:bottom-0 max-lg:static"
      )}
      style={{ borderBottom: "none", borderLeft: "none", borderRight: "none" }}
    >
      <span id="status-runner-elapsed" className="bb-item font-mono text-xs text-tertiary whitespace-nowrap">
        {t("status.runnerElapsed")}{" "}
        <span id="timerElapsed" className="text-secondary" data-testid="bb-elapsed">
          {el == null ? "--:--:--" : fmtHMS(el)}
        </span>
      </span>
      <span id="status-remaining" className="bb-item font-mono text-xs text-tertiary whitespace-nowrap">
        {t("status.remaining")}{" "}
        <span
          id="timerRemaining"
          data-testid="bb-remaining"
          data-basis={rem.basis}
          data-expired={rem.expired ? "1" : "0"}
          title={t(remBasisKey)}
          className={rem.expired ? "text-danger" : rem.basis === "unknown" ? "text-tertiary" : "text-secondary"}
        >
          {rem.seconds == null ? "--:--:--" : fmtHMS(rem.seconds)}
        </span>
        <span id="timerRemainingBasis" data-testid="bb-remaining-basis" className="ml-1 text-[10px] uppercase">
          {rem.basis === "server-session-end" ? "sched" : rem.basis === "policy-window" ? "policy" : "n/a"}
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
    </GlassContainer>
  );
}

function useSessionNative() {
  return useSessionStore((s) => s.native);
}

export function AppShell() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  // [R-GLASS] publishes the RESOLVED quality on <html> for CSS + the browser lab.
  useVisualQualityRootAttribute();

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
    // [R-GLASS] `relative z-[1]` lifts the whole shell above the fixed
    // decorative backdrop (.app-backdrop is z-index 0).
    <div className="relative z-[1] flex min-h-[100dvh] flex-col text-primary">
      <AppBackdrop />
      <a href="#main" className="skip-link">
        {t("app.skipToMain")}
      </a>
      <TopBar />
      {/* [F93 §2.1] Logon gate banner: top of EVERY route, self-hiding once a
          type-10 4624 is observed (no dismiss, no stale opt-out).
          [M2 §2.3] Fenced: a crashing banner used to blank the page it warns
          about. The bottom bar's last-logon row still reports the same fact. */}
      <ChromeBoundary surface="logon-banner">
        <LogonGateBanner />
      </ChromeBoundary>
      <div className="flex flex-1 min-h-0">
        <Sidebar />
        <Main />
      </div>
      <BottomBar />
      <MobileNav />
      {/* [M2 §2.3] Fenced: Ctrl+K is a convenience, not the way home - every
          route stays reachable from the sidebar and the Alt+E/Alt+F hotkeys. */}
      <ChromeBoundary surface="command-palette">
        <CommandPalette />
      </ChromeBoundary>
    </div>
  );
}
