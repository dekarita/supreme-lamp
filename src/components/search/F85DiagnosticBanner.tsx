// [F85 §3] Diagnostic banner - "/#/search?diag=1" only.
//
// WHY IT EXISTS: after a merge, the operator's browser can still be holding a
// stale ui-dist bundle (or the runner can be serving a server whose F84 routes
// never shipped). Both failures look identical from the UI - "nothing
// happened" - and both cost a full re-dispatch cycle to diagnose. This banner
// puts the four F84 capabilities on screen with a per-feature check that comes
// from a REAL probe:
//
//   auto-https      GET /api/version -> features.autoHttps      (server bytes)
//   www-tolerance   GET /api/version -> features.wwwTolerance   (server bytes)
//   no-fallback     typeof window.launchUrl === "function"      (THIS bundle)
//   download-to-RDP GET /api/version -> features.downloadToRdp  (server bytes)
//
// The no-fallback check is deliberately client-side: it is the one flag that
// proves the RUNNING bundle is the one that was built with F84 (the server
// cannot see which zip the browser loaded). The ui sha7 printed at the end is
// the same import.meta.env.VITE_BUILD_SHA the F77 bottom-bar badge uses, so
// `ui: <sha7>` can be compared with the merge sha before testing a single site.
//
// The banner renders ONLY when ?diag=1 is present: it never appears in the
// operator's normal surface, never changes an existing screenshot, and never
// blocks the page (a failed /api/version renders "..." + the missing marks).
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
}

interface VersionInfo {
  sha7?: string;
  features?: VersionFeatures;
}

/** [F85 §3] One checkable capability. `label` is a technical token (the same
 *  words the F84 contract uses), so it stays untranslated like a MIME type. */
export interface DiagFeature {
  key: string;
  label: string;
  ok: boolean;
}

export function F85DiagnosticBanner() {
  const { t } = useTranslation();
  const [params] = useSearchParams();
  const [version, setVersion] = useState<VersionInfo | null>(null);
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
      } finally {
        if (alive) setProbed(true);
      }
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

  return (
    <div
      id="f85.diag.banner"
      data-testid="f85-diag-banner"
      role="status"
      aria-live="polite"
      data-active-count={activeCount}
      data-probed={probed ? "1" : "0"}
      className="rounded-md border border-default bg-raised px-3 py-2 text-xs text-secondary font-mono"
    >
      <span className="text-primary">{t("search.diag.title")}{" "}</span>
      {features.map((x) => (
        <span key={x.key} data-testid={"f85-diag-" + x.key} data-ok={x.ok ? "1" : "0"} className="mr-2">
          {x.ok ? "\u2713" : "\u2717"} {x.label}
        </span>
      ))}
      <span data-testid="f85-diag-sha">
        | ui: {UI_SHA7} | server: {version?.sha7 || (probed ? "?" : "...")}
      </span>
      {probed && !version ? <span data-testid="f85-diag-server-missing"> ({t("search.diag.noServer")})</span> : null}
    </div>
  );
}

export default F85DiagnosticBanner;
