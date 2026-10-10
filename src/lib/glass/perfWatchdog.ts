// [R-GLASS / #213 §8] The performance fallback the issue asks for:
// "demonstrated performance problems select the redesigned opaque mode".
//
// WHAT IT MEASURES. Real rAF frame spacing on THIS browser, because that is
// the only signal that can distinguish "the machine can afford a blur" from
// "the spec says blur is cheap". #213 §10's threshold (p95 < 32ms during
// scroll, fallback if p95 > 50ms) is the trigger, labelled
// PROPOSED_FOR_VALIDATION in the issue and used here as the trip point.
//
// WHAT IT DELIBERATELY DOES NOT DO.
//   * It never switches BACK. The latch is one-way: a slow frame must not
//     produce an unstable quality-toggle loop, and switching frosted ->
//     opaque -> frosted -> opaque forever is worse than either state.
//   * It does not run continuously. Three bounded samples (mount, first
//     scroll, first overlay open) is enough to catch a machine that cannot
//     composite a blur, and it leaves no rAF loop running afterwards.
//   * It does not guess from hardware strings, `deviceMemory` or a UA sniff.
import { useEffect } from "react";
import { tripPerfFallback, isPerfFallbackActive } from "./quality";

const SAMPLE_FRAMES = 45;
const TRIP_P95_MS = 50;

let samplesTaken = 0;
const MAX_SAMPLES = 3;

function resetWatchdogForTests(): void {
  samplesTaken = 0;
}

/**
 * Measure one burst of frames and trip the opaque latch when the p95 is over
 * the threshold. Returns the measured p95 (ms) or null when nothing ran.
 */
function measureBurst(reason: string): Promise<number | null> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame !== "function") return resolve(null);
    const gaps: number[] = [];
    let last = performance.now();
    let raf = 0;
    function tick() {
      const now = performance.now();
      gaps.push(now - last);
      last = now;
      if (gaps.length < SAMPLE_FRAMES) {
        raf = requestAnimationFrame(tick);
        return;
      }
      const sorted = gaps.slice().sort((a, b) => a - b);
      const p95 = sorted[Math.floor(sorted.length * 0.95)];
      if (p95 > TRIP_P95_MS) tripPerfFallback(`${reason}: p95 ${Math.round(p95)}ms > ${TRIP_P95_MS}ms`);
      resolve(Math.round(p95 * 100) / 100);
    }
    raf = requestAnimationFrame(tick);
    // Hard stop: a page that never produces 45 frames must not leak a rAF loop.
    setTimeout(() => {
      cancelAnimationFrame(raf);
      resolve(null);
    }, 4000);
  });
}

/**
 * Mount once, at the shell. `active` is false when the resolved quality is
 * already opaque - there is nothing to measure then.
 */
export function useGlassPerfWatchdog(active: boolean): void {
  useEffect(() => {
    if (!active || isPerfFallbackActive()) return undefined;
    let cancelled = false;

    async function sample(reason: string) {
      if (cancelled || isPerfFallbackActive() || samplesTaken >= MAX_SAMPLES) return;
      samplesTaken += 1;
      await measureBurst(reason);
    }

    // 1. right after the shell paints
    const mountTimer = window.setTimeout(() => void sample("mount"), 800);
    // 2. the first real scroll (the workload #213 §10 names)
    let scrolled = false;
    const onScroll = () => {
      if (scrolled) return;
      scrolled = true;
      void sample("scroll");
    };
    window.addEventListener("scroll", onScroll, { passive: true, once: true });

    return () => {
      cancelled = true;
      window.clearTimeout(mountTimer);
      window.removeEventListener("scroll", onScroll);
    };
  }, [active]);
}

/** Test seam. */
export const __perfWatchdog = { resetWatchdogForTests, SAMPLE_FRAMES, TRIP_P95_MS };
