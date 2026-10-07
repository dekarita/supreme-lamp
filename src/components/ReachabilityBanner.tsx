// [F103 §3 / R2] REACHABILITY BANNER
//
// Why this exists: the operator clicked 18 buttons, got 18 warn/fail rows, and
// had no way to know the backend was never reached at all (bundle
// fdd57261-button-actions.json: status=0, elapsedMs=null, ws=live). The
// Collector could explain it only after a run, on one page, inside an expanded
// row. This banner says it on EVERY page, before anything is clicked.
//
// Behaviour: probe GET /api/health with a 2s deadline on mount, then every
// 10s. While it does not answer, the banner is shown; the moment it answers,
// the banner disappears. [Troubleshoot] deep-links to the Collector's
// reachability panel (/#/collector?troubleshoot=reachability).
import { useEffect, useState } from "react";
import { backendOrigin, pageOrigin, probeHealth, probeOptions, isMixedContent, classifyStatus0Cached } from "@/lib/reachability";

export const REACHABILITY_POLL_MS = 10000;
export const REACHABILITY_TIMEOUT_MS = 2000;

export function ReachabilityBanner() {
  const [reachable, setReachable] = useState<boolean | null>(null);
  const [category, setCategory] = useState<string>("network");

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const tick = async () => {
      const r = await probeHealth(REACHABILITY_TIMEOUT_MS);
      if (!alive) return;
      if (r.ok) {
        setReachable(true);
      } else {
        // Measure the preflight so the banner (and the Collector verdicts)
        // can name the real cause instead of listing three guesses.
        if (!isMixedContent()) {
          await probeOptions("/api/health", REACHABILITY_TIMEOUT_MS).catch(() => null);
        }
        if (!alive) return;
        setCategory(classifyStatus0Cached().category);
        setReachable(false);
      }
      timer = setTimeout(() => void tick(), REACHABILITY_POLL_MS);
    };

    void tick();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, []);

  if (reachable !== false) return null;

  return (
    <div
      data-testid="reachability-banner"
      data-category={category}
      role="alert"
      className="w-full border-b border-warning/40 bg-warning/10 px-4 py-2 text-xs text-primary"
    >
      <span aria-hidden>⚠️</span>{" "}
      <strong>Backend unreachable from this origin</strong>{" "}
      <span className="font-mono text-secondary" data-testid="reachability-banner-pair">
        ({pageOrigin()} → {backendOrigin()})
      </span>
      . Buttons will fail with status=0 until this is fixed. Likely causes: CORS preflight blocked, mixed HTTPS→HTTP content, or the runner is offline.{" "}
      <a data-testid="reachability-troubleshoot" className="underline text-accent" href="#/collector?troubleshoot=reachability">
        [Troubleshoot]
      </a>
    </div>
  );
}

export default ReachabilityBanner;
