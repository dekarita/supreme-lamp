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
import { useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { apiBase } from "@/lib/api";

/** Same source as the F77 bottom-bar badge (src/components/layout/AppShell.tsx). */
const UI_SHA7: string = (import.meta.env.VITE_BUILD_SHA as string | undefined) || "dev";

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

interface LaunchDiag {
  activeTier?: number;
  lastLaunchAt?: string;
  lastResult?: string;
  lastDetail?: string;
  interactiveSessionDetected?: boolean;
  msedgePath?: string;
  chromePath?: string;
}

export interface DiagFeature {
  key: string;
  label: string;
  ok: boolean;
}

export function F86DiagnosticBanner() {
  const { t } = useTranslation();
  const [params] = useSearchParams();
  const [version, setVersion] = useState<VersionInfo | null>(null);
  const [diag, setDiag] = useState<LaunchDiag | null>(null);
  const [probed, setProbed] = useState(false);
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
  const tierOk = tier === "1" || tier === "2";
  const lastAt = diag?.lastLaunchAt || "";
  const lastResult = diag?.lastResult || "";

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
      {probed && !version ? <span data-testid="f85-diag-server-missing"> ({t("search.diag.noServer")})</span> : null}
    </div>
  );
}

export default F86DiagnosticBanner;
