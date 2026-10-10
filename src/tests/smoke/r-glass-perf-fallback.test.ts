// [R-GLASS / #213 §8 + §10] The measured fallback.
//
// #213 §10's acceptance is "the fallback working and the layer count held", not
// a claim of universal smoothness. So the important properties here are the
// ones that keep the fallback safe: it is ONE-WAY (a slow frame must never
// produce a quality-toggle loop), it wins over an explicit frosted request, and
// it does not exist at all until something measured a slow p95.
//
// It lives in its own file because the latch is module-level by design: one
// file gets to trip it, and no other suite inherits a tripped latch.
import { describe, expect, it } from "vitest";
import { currentQualityEnv, isPerfFallbackActive, perfFallbackReason, resolveQuality, tripPerfFallback } from "@/lib/glass/quality";
import { __perfWatchdog } from "@/lib/glass/perfWatchdog";

/** The env the app actually passes: the live one, with backdrop support on. */
const env = () => ({ ...currentQualityEnv(), supports: true });

describe("R-GLASS-d: measured performance fallback", () => {
  it("is inactive until something measures a slow p95", () => {
    // this file owns the latch; the first assertion is the clean state
    expect(perfFallbackReason()).toBe("");
    expect(resolveQuality("frosted", env())).toBe("frosted");
  });

  it("uses the threshold the issue proposed (p95 > 50ms)", () => {
    expect(__perfWatchdog.TRIP_P95_MS).toBe(50);
    expect(__perfWatchdog.SAMPLE_FRAMES).toBeGreaterThan(0);
  });

  it("trips to opaque for EVERY quality request and never switches back", () => {
    expect(isPerfFallbackActive()).toBe(false);
    tripPerfFallback("test: p95 80ms > 50ms");
    expect(isPerfFallbackActive()).toBe(true);
    // an explicit frosted request loses to a measured failure
    expect(resolveQuality("frosted", env())).toBe("opaque");
    expect(resolveQuality("clear", env())).toBe("opaque");
    expect(resolveQuality("auto", env())).toBe("opaque");
    // a second trip is a no-op, and there is deliberately no un-trip
    tripPerfFallback("test: again");
    expect(isPerfFallbackActive()).toBe(true);
    expect(resolveQuality("frosted", env())).toBe("opaque");
    expect(perfFallbackReason()).toContain("p95");
  });
});
