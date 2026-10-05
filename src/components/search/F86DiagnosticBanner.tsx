// [F86 §A.3] Diagnostic banner v2 - "/#/search?diag=1" only. Supersedes the F85
// banner on the Search surface (F85DiagnosticBanner.tsx stays in the tree: its
// four checks are still asserted byte-for-byte by tests/f85-f84-symbols.test.js
// and its own smoke test; this component renders the same four from the same
// probes and ADDS the launch-path diagnostics the F86 operator flow needs).
//
// WHY THE EXTRA CHIPS: the operator's 10-site test ends at "click a link -> it
// opens in RDP Chrome". When that visibly fails the old surface had exactly one
// sentence ("Could not open in RDP") and no way to tell a stale bundle from a
// server whose launch mechanism cannot reach a desktop. The banner now shows:
//
//   auto-https / www-tolerance / no-fallback / download-to-RDP   (F84 probes)
//   Launch tier: 1|2|3        GET /api/launch-url/diag -> activeTier
//   Last launch: <ts> ok|fail GET /api/launch-url/diag -> lastLaunchAt/lastResult
//
// "Launch tier: 3" is NOT a failure by itself - it is the rung the server's boot
// probe expects to work (1 = interactive desktop, 2 = console logon, 3 = the
// named-pipe helper). A tier line showing "3" plus "Last launch: ... fail" is the
// honest "no interactive session" case the F86 spec asks to see instead of a
// silent toast. `ui: <sha7>` stays comparable with the merge sha, exactly like F85.
import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { apiBase } from "@/lib/api";
import { launchUrl } from "@/lib/launchUrl";

/** Same source as the F77 bottom-bar badge (src/components/layout/AppShell.tsx). */
export const UI_SHA7: string = (import.meta.env.VITE_BUILD_SHA as string | undefined) || "dev";

interface VersionFeatures {
  autoHttps?: boolean;
  wwwTolerance?: boolean;
  noFallback?: boolean;
  downloadToRdp?: boolean;
  launchTiers?: boolean;
}

interface VersionInfo {
  sha7?: string;
  features?: VersionFeatures;
}

interface LaunchHistoryRow {
  at?: string;
  host?: string;
  url?: string;
  tier?: number;
  ok?: boolean;
  detail?: string;
}

interface LaunchDiag {
  activeTier?: number;
  lastLaunchAt?: string;
  lastResult?: string;
  lastDetail?: string;
  interactiveSessionDetected?: boolean;
  msedgePath?: string;
  chromePath?: string;
  logPath?: string;
  /** [F87 §D.1] the server's launch history (newest last). */
  history?: LaunchHistoryRow[];
  /** [F88 §B.1] last 20 lines of %USERPROFILE%\.ghrdp\launch-url-verbose.log. */
  verboseLog?: string[];
  verboseLogPath?: string;
}

/** [F87 §D.1] A self-test row, used only for the download-dir probe here. */
interface SelfTestDirRow {
  downloadDir?: string;
  downloadDirOk?: boolean;
}

/** [F87 §D.1] The last five launches, newest first, hostname only (never a
 *  path - the log posture of the F86 ladder). */
export function lastFiveLaunches(history: LaunchHistoryRow[] | undefined): Array<{ host: string; tier: number; ok: boolean; at: string }> {
  const rows = Array.isArray(history) ? history : [];
  return rows
    .slice(-5)
    .reverse()
    .map((h) => {
      let host = String(h.host || "");
      if (!host && h.url) {
        try {
          host = new URL(String(h.url)).hostname;
        } catch {
          host = "";
        }
      }
      return { host: host || "?", tier: Number(h.tier || 0), ok: h.ok === true, at: String(h.at || "") };
    });
}

/** [F87 §D.1] The example.com test launch target - the only hard-coded URL. */
export const DIAG_TEST_LAUNCH_URL = "https://example.com/";

export interface DiagFeature {
  key: string;
  label: string;
  ok: boolean;
}

export function F86DiagnosticBanner() {
  const { t } = useTranslation();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [version, setVersion] = useState<VersionInfo | null>(null);
  const [diag, setDiag] = useState<LaunchDiag | null>(null);
  const [probed, setProbed] = useState(false);
  // [F87 §D.1] the "test launch" outcome + the download-dir probe.
  const [testLaunch, setTestLaunch] = useState<{ busy: boolean; text: string; ok: boolean | null }>({ busy: false, text: "", ok: null });
  const [dir, setDir] = useState<{ path: string; ok: boolean | null }>({ path: "", ok: null });
  const enabled = params.get("diag") === "1";

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    void (async () => {
      try {
        const r = await fetch(apiBase() + "/api/version", { cache: "no-store" });
        const body = (await r.json().catch(() => null)) as VersionInfo | null;
        if (alive) setVersion(r.ok ? body : null);
      } catch {
        if (alive) setVersion(null);
      }
      // [F86 §A.3] The launch-path probe. A server that predates F86 answers
      // 404 here: that renders as "Launch tier: ?" rather than a green check.
      try {
        const r2 = await fetch(apiBase() + "/api/launch-url/diag", { cache: "no-store" });
        const body2 = (await r2.json().catch(() => null)) as LaunchDiag | null;
        if (alive) setDiag(r2.ok ? body2 : null);
      } catch {
        if (alive) setDiag(null);
      }
      if (alive) setProbed(true);
    })();
    return () => {
      alive = false;
    };
  }, [enabled]);

  if (!enabled) return null;

  // [F87 §D.1] One real launch of example.com through the F86 ladder; the
  // chip reports the rung that answered (or the failure key) - the two-second
  // "does a window open in RDP" check the operator does first.
  const runTestLaunch = async () => {
    setTestLaunch({ busy: true, text: "...", ok: null });
    const out = await launchUrl(DIAG_TEST_LAUNCH_URL);
    if (out.ok) setTestLaunch({ busy: false, ok: true, text: t("search.diag.testLaunchOk", { tier: out.tier || "?" }) });
    else setTestLaunch({ busy: false, ok: false, text: t("search.diag.testLaunchFail", { reason: t(out.reason || "search.launchUrl.failed") }) });
    // re-read the diag so "Last launch" and the history follow.
    try {
      const r2 = await fetch(apiBase() + "/api/launch-url/diag", { cache: "no-store" });
      const body2 = (await r2.json().catch(() => null)) as LaunchDiag | null;
      if (r2.ok && body2) setDiag(body2);
    } catch {
      /* the chip already shows the outcome */
    }
  };

  // [F87 §D.1] Download-dir probe: the self-test route's downloadDir stub for
  // ONE site (archive.org) - directory path + writable, nothing downloaded.
  const probeDir = async () => {
    setDir({ path: "...", ok: null });
    try {
      const r = await fetch(apiBase() + "/api/f87-selftest?noRateLimit=1", {
        method: "POST",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sites: ["archive.org"] }),
      });
      const body = (await r.json().catch(() => null)) as { results?: SelfTestDirRow[] } | null;
      const row = body?.results?.[0];
      if (r.ok && row) setDir({ path: String(row.downloadDir || ""), ok: row.downloadDirOk === true });
      else setDir({ path: "", ok: false });
    } catch {
      setDir({ path: "", ok: false });
    }
  };

  const f = version?.features;
  // A missing probe result is a MISSING checkmark, never a green one.
  const launchHandle = (() => {
    try {
      return typeof (window as unknown as { launchUrl?: unknown }).launchUrl === "function";
    } catch {
      return false;
    }
  })();
  const features: DiagFeature[] = [
    { key: "autoHttps", label: "auto-https", ok: f?.autoHttps === true },
    { key: "wwwTolerance", label: "www-tolerance", ok: f?.wwwTolerance === true },
    { key: "noFallback", label: "no-fallback", ok: launchHandle },
    { key: "downloadToRdp", label: "download-to-RDP", ok: f?.downloadToRdp === true },
  ];
  const activeCount = features.filter((x) => x.ok).length;
  const tier = typeof diag?.activeTier === "number" && diag.activeTier > 0 ? String(diag.activeTier) : "?";
  const tierOk = tier === "0" || tier === "1" || tier === "2";
  const lastAt = diag?.lastLaunchAt || "";
  const lastResult = diag?.lastResult || "";
  const serverSha = version?.sha7 || "";
  // [F87 §D.1] a bundle built from a different commit than the server serves.
  const shaMismatch = Boolean(serverSha) && serverSha !== "?" && UI_SHA7 !== "dev" && serverSha !== UI_SHA7;
  const recent = lastFiveLaunches(diag?.history);

  return (
    <div
      id="f86.diag.banner"
      data-testid="f86-diag-banner"
      role="status"
      aria-live="polite"
      data-active-count={activeCount}
      data-probed={probed ? "1" : "0"}
      data-launch-tier={tier}
      className="rounded-md border border-default bg-raised px-3 py-2 text-xs text-secondary font-mono flex flex-wrap items-center gap-x-2 gap-y-1"
    >
      <span className="text-primary">{t("search.diag.title")}{" "}</span>
      {features.map((x) => (
        <span key={x.key} data-testid={"f85-diag-" + x.key} data-ok={x.ok ? "1" : "0"}>
          {x.ok ? "\u2713" : "\u2717"} {x.label}
        </span>
      ))}
      {/* [F86 §A.3] the launch-tier chip */}
      <span
        id="f86.diag.launchTier"
        data-testid="f86-diag-launch-tier"
        data-tier={tier}
        data-ok={tierOk ? "1" : "0"}
        className={"rounded px-1.5 py-0.5 " + (tierOk ? "bg-accent/10 text-primary" : "bg-raised text-warning")}
      >
        {t("search.diag.launchTier", { tier })}
      </span>
      <span id="f86.diag.lastLaunch" data-testid="f86-diag-last-launch">
        {t("search.diag.lastLaunch", { at: lastAt || (probed ? "—" : "..."), result: lastResult || "—" })}
      </span>
      <span data-testid="f85-diag-sha">
        | ui: {UI_SHA7} | server: {version?.sha7 || (probed ? "?" : "...")}
      </span>
      {shaMismatch ? (
        <span data-testid="f87-diag-sha-mismatch" className="text-warning">
          {t("search.diag.shaMismatch")}
        </span>
      ) : null}
      {probed && !version ? <span data-testid="f85-diag-server-missing"> ({t("search.diag.noServer")})</span> : null}
      {/* [F87 §D.1] second line: test launch, last five launches, download dir, self-test shortcut */}
      <div className="basis-full flex flex-wrap items-center gap-x-2 gap-y-1 pt-1 border-t border-default">
        <button
          id="f87.diag.testLaunch"
          data-testid="f87-diag-test-launch"
          type="button"
          disabled={testLaunch.busy}
          onClick={() => void runTestLaunch()}
          className="h-8 px-2 rounded border border-default text-primary hover:bg-accent/10 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          {t("search.diag.testLaunch")}
        </button>
        {testLaunch.text ? (
          <span data-testid="f87-diag-test-launch-result" data-ok={testLaunch.ok === null ? "" : testLaunch.ok ? "1" : "0"} className={testLaunch.ok === false ? "text-danger" : "text-primary"}>
            {testLaunch.text}
          </span>
        ) : null}
        <span data-testid="f87-diag-recent" className="text-tertiary">
          {t("search.diag.recent")}{" "}
          {recent.length === 0
            ? "—"
            : recent.map((r, i) => (
                <span key={r.at + r.host + i} data-testid="f87-diag-recent-row" data-ok={r.ok ? "1" : "0"} className={r.ok ? "" : "text-danger"}>
                  {r.host} t{r.tier} {r.ok ? "ok" : "fail"} {r.at}
                  {i < recent.length - 1 ? "; " : ""}
                </span>
              ))}
        </span>
        <button
          id="f87.diag.probeDir"
          data-testid="f87-diag-probe-dir"
          type="button"
          onClick={() => void probeDir()}
          className="h-8 px-2 rounded border border-default text-primary hover:bg-accent/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          {t("search.diag.downloadDir")}
        </button>
        {dir.path || dir.ok !== null ? (
          <span data-testid="f87-diag-download-dir" data-ok={dir.ok === null ? "" : dir.ok ? "1" : "0"} className={dir.ok === false ? "text-danger" : ""}>
            {dir.path || "?"} {dir.ok === null ? "" : dir.ok ? "\u2713" : "\u2717"}
          </span>
        ) : null}
        <button
          id="f87.diag.selfTest"
          data-testid="f87-diag-selftest-link"
          type="button"
          onClick={() => navigate("/search?selftest=1")}
          className="ml-auto h-8 px-2 rounded border border-default text-primary hover:bg-accent/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          {t("search.diag.selfTestShortcut")}
        </button>
      </div>
      {/* [F88 §B.4] verbose launch-url log: last 20 lines, copyable for F89. */}
      <details id="f88.diag.verboseLog" data-testid="f88-verbose-log" className="basis-full pt-1 border-t border-default">
        <summary className="cursor-pointer text-primary select-none">{t("search.diag.verboseLog")}</summary>
        <pre data-testid="f88-verbose-log-body" className="mt-1 whitespace-pre-wrap text-[10px] text-tertiary max-h-40 overflow-auto">
          {(diag?.verboseLog ?? []).join("\n") || "—"}
        </pre>
        <button
          id="f88.diag.verboseCopy"
          data-testid="f88-verbose-log-copy"
          type="button"
          onClick={() => {
            try {
              void navigator.clipboard?.writeText((diag?.verboseLog ?? []).join("\n"));
            } catch {
              /* clipboard can be denied; the log stays visible to select */
            }
          }}
          className="mt-1 h-8 px-2 rounded border border-default text-primary hover:bg-accent/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          {t("copy.action")}
        </button>
      </details>
    </div>
  );
}

export default F86DiagnosticBanner;

// ===========================================================================
// [F90 §C.3] VIEWING-MODE BADGE - persistent, NOT gated behind ?diag=1.
//
// The F86 banner above is deliberately diag-only (it renders nothing unless
// asked, so the normal surface and every existing screenshot stay byte-identical).
// This badge is the opposite on purpose: "where will my link open?" is the one
// fact the operator needs BEFORE clicking, so it is always on screen.
//
// It is also CLICKABLE. Detection is a heuristic (loopback is proof, a tailnet
// host plus a session-shaped viewport is only a strong hint), so the operator's
// explicit choice is stored and beats every signal on the next load. A badge
// that lies about the mode is worse than no badge.
// ===========================================================================
import {
  VIEWING_MODE_PARAM,
  resolveViewingMode,
  setViewingMode,
  type ViewingMode,
} from "@/lib/launchUrl";

const MODE_META: Record<ViewingMode, { tone: string; labelKey: string; helpKey: string }> = {
  "web-desktop": {
    tone: "border-emerald-500/60 text-emerald-400",
    labelKey: "viewingMode.badge.webDesktop",
    helpKey: "viewingMode.help.webDesktop",
  },
  "tailscale-local": {
    tone: "border-amber-500/60 text-amber-400",
    labelKey: "viewingMode.badge.tailscaleLocal",
    helpKey: "viewingMode.help.tailscaleLocal",
  },
  unknown: {
    tone: "border-default text-secondary",
    labelKey: "viewingMode.badge.unknown",
    helpKey: "viewingMode.help.unknown",
  },
};

export function F90ViewingModeBadge() {
  const { t } = useTranslation();
  const [state, setState] = useState(() => resolveViewingMode());
  const [open, setOpen] = useState(false);
  // The badge reports the mode the LAUNCH will act on (never the raw guess), so
  // it can never promise an in-RDP open the code is not going to perform.
  const mode = state.mode;
  const unconfirmedWebDesktop = state.detected === "web-desktop" && !state.confirmed && mode === "unknown";
  const meta = MODE_META[mode];

  const choose = (next: ViewingMode) => {
    setViewingMode(next);
    setState({ mode: next, detected: state.detected, confirmed: true });
    setOpen(false);
  };

  return (
    <div className="fixed top-3 right-3 z-40 flex flex-col items-end gap-1">
      <button
        id="f90.viewingMode.badge"
        data-testid="f90-viewing-mode-badge"
        data-mode={mode}
        type="button"
        title={t(meta.helpKey)}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={
          "h-7 px-2 rounded-md border bg-surface text-[11px] font-mono inline-flex items-center gap-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent " +
          meta.tone
        }
      >
        <span aria-hidden>{mode === "web-desktop" ? "✓" : mode === "tailscale-local" ? "!" : "?"}</span>
        {t("viewingMode.badge.prefix")}: {t(meta.labelKey)}
        {unconfirmedWebDesktop ? <span className="text-tertiary">{t("viewingMode.badge.unconfirmed")}</span> : null}
      </button>

      {open ? (
        <div
          data-testid="f90-viewing-mode-menu"
          role="menu"
          className="w-64 rounded-md border border-default bg-surface p-2 flex flex-col gap-1 text-xs shadow-lg"
        >
          <p className="text-tertiary px-1 pb-1">{t(meta.helpKey)}</p>
          {(Object.keys(MODE_META) as ViewingMode[]).map((m) => (
            <button
              key={m}
              type="button"
              role="menuitem"
              data-testid={"f90-viewing-mode-pick-" + m}
              onClick={() => choose(m)}
              className={
                "h-8 px-2 rounded text-left hover:bg-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent " +
                (m === mode ? "text-primary" : "text-secondary")
              }
            >
              {m === mode ? "• " : ""}
              {t(MODE_META[m].labelKey)}
            </button>
          ))}
          <p className="text-tertiary px-1 pt-1 border-t border-default">
            {t("viewingMode.badge.urlParam", { param: VIEWING_MODE_PARAM })}
          </p>
        </div>
      ) : null}
    </div>
  );
}
