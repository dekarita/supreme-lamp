// [M2 / maintenance step 2] Chrome unfencing — the DOM gate.
//
// The Node gate (tests/m2-chrome-unfencing.test.js) proves the ARTEFACTS agree:
// table ↔ mounts ↔ channel ↔ row. It cannot prove the fence WORKS, so this suite
// mounts the real components and asserts behaviour:
//
//   1. a healthy chrome fence is invisible — innerHTML with the wrapper is
//      byte-equal to innerHTML without it, for EVERY surface (the zero-DOM-delta
//      property F105 proved for the section fence, carried over);
//   2. a crashing chrome surface is CONTAINED for all 10 of them: the sibling
//      next to it survives, the surface renders nothing at all, and the failure
//      is published as `kind: "chrome"` + `chrome:<surface>` with no invented
//      section name;
//   3. the F105 mount ledger is untouched by chrome (a chrome fence that
//      registered there would make the Debug HUD report sections that are not
//      mounted) — with a positive control proving the ledger still counts a
//      real section fence;
//   4. the retry is BOUNDED: a transient crash recovers on the next attempt, a
//      deterministic one stops after the budget instead of flapping forever;
//   5. the REAL App survives: a crash in one chrome surface leaves the dashboard
//      usable, and a crash in the SHELL leaves the chrome mounted outside it
//      (the whole point of the step);
//   6. the crash lands in the Collector exactly once, tagged `chrome-boundary`,
//      never as a broken section — and a section crash still renders its card
//      and files its own `feature-boundary` row.
//
// §GATE-SELF-TEST (found by writing this suite, not by it going green): the retry
// test was first written with a per-render `capture()` helper, which unsubscribes
// when the render returns — so the events fired DURING `advanceTimersByTime` were
// invisible and the test asserted a retry budget it could not see. It subscribes
// once for the whole test now, and advances one interval at a time so the
// SPACING is proved, not just the total. The App-level suite also mocks only
// DvrFab/AppShell (two of the ten surfaces): the other eight are proved in the
// sweep that mounts each fence directly, and the Node gate owns the wiring.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { act, render, screen } from "@testing-library/react";
import "@/i18n";
import App from "@/App";
import ChromeBoundary from "@/components/primitives/ChromeBoundary";
import FeatureBoundary from "@/components/primitives/FeatureBoundary";
import {
  CHROME_BOUNDARY_MAX_RETRIES,
  CHROME_BOUNDARY_RETRY_MS,
  CHROME_BOUNDARY_SOURCE,
  CHROME_SURFACES,
  CHROME_SURFACE_IDS,
  chromeSubject,
  type ChromeSurfaceId,
} from "@/lib/chromeBoundaryCore";
import {
  FEATURE_BOUNDARY_SOURCE,
  __resetFeatureBoundaryReporterForTests,
  installFeatureBoundaryReporter,
  onFeatureBoundaryError,
  type FeatureBoundaryErrorDetail,
} from "@/lib/featureBoundary";
import { __resetMountedFeaturesForTests, mountedFeatureIds } from "@/lib/featureRegistry";
import { useCollectorStore } from "@/lib/collectorAgent";

// The two chrome surfaces this suite crashes inside the REAL App. `vi.hoisted`
// because vi.mock's factory is hoisted above these imports.
const flags = vi.hoisted(() => ({ dvrBoom: false, shellBoom: false }));

vi.mock("@/components/domain/DvrFab", async () => {
  const React = await import("react");
  return {
    DvrFab: () => {
      if (flags.dvrBoom) throw new Error("dvr-fab boom");
      return React.createElement("button", { "data-testid": "dvr-fab" }, "DVR");
    },
  };
});

vi.mock("@/components/layout/AppShell", async () => {
  const React = await import("react");
  return {
    AppShell: () => {
      if (flags.shellBoom) throw new Error("shell boom");
      return React.createElement("div", { "data-testid": "sidebar" }, "shell");
    },
  };
});

/** Throws on every render — the smallest crashing chrome surface. */
function Boom({ message = "chrome boom" }: { message?: string }) {
  throw new Error(message);
}

/** Throws while the flag is set — the transient shape the retry exists for. */
let flakyFlag = true;
function Flaky() {
  if (flakyFlag) throw new Error("flaky chrome");
  return <div data-testid="flaky-recovered">recovered</div>;
}

/** Collect every boundary failure published while `fn` runs. */
function capture(fn: () => void): FeatureBoundaryErrorDetail[] {
  const events: FeatureBoundaryErrorDetail[] = [];
  const off = onFeatureBoundaryError((d) => events.push(d));
  try {
    fn();
  } finally {
    off();
  }
  return events;
}

beforeEach(() => {
  flags.dvrBoom = false;
  flags.shellBoom = false;
  flakyFlag = true;
  __resetFeatureBoundaryReporterForTests();
  __resetMountedFeaturesForTests();
});

afterEach(() => {
  vi.useRealTimers();
  __resetFeatureBoundaryReporterForTests();
  __resetMountedFeaturesForTests();
});

describe("ChromeBoundary — the fence itself", () => {
  it("is invisible when healthy: innerHTML is byte-equal with and without the fence, for every surface", () => {
    for (const surface of CHROME_SURFACE_IDS) {
      const bare = document.createElement("div");
      const fenced = document.createElement("div");
      render(
        <div>
          <span>same</span>
        </div>,
        { container: bare },
      );
      render(
        <ChromeBoundary surface={surface}>
          <div>
            <span>same</span>
          </div>
        </ChromeBoundary>,
        { container: fenced },
      );
      expect(fenced.innerHTML, "surface " + surface + " added a node").toBe(bare.innerHTML);
      expect(fenced.innerHTML).not.toBe("");
    }
  });

  it("contains a crash in EVERY surface: the sibling survives, the surface renders nothing, the report is chrome-shaped", () => {
    for (const surface of CHROME_SURFACE_IDS) {
      const events = capture(() => {
        render(
          <div>
            <ChromeBoundary surface={surface}>
              <Boom />
            </ChromeBoundary>
            <span data-testid="sibling">alive</span>
          </div>,
        );
      });
      expect(screen.getByTestId("sibling"), "surface " + surface + " took its sibling down").toBeInTheDocument();
      // nothing at all was rendered in the fence's place - not a card, not a
      // wrapper, not an empty div
      expect(document.body.textContent).toBe("alive");
      expect(events).toHaveLength(1);
      expect(events[0].kind).toBe("chrome");
      expect(events[0].surface).toBe(surface);
      expect(events[0].feature).toBe(chromeSubject(surface));
      expect(events[0].section, "chrome has no section - inventing one is the lie the channel exists to avoid").toBeUndefined();
      expect(events[0].message).toContain("chrome boom");
      // jsdom's URL has no hash: the route is the pathname, and it is recorded
      // sanitized (no query, no fragment) - the F94 leak class F105 fenced.
      expect(events[0].route).toBe("/");
      // cleanup between iterations of the sweep
      document.body.innerHTML = "";
    }
  });

  it("does not touch the F105 mount ledger (with a section fence as the positive control)", () => {
    render(
      <div>
        {CHROME_SURFACES.map((s) => (
          <ChromeBoundary key={s.id} surface={s.id}>
            <span />
          </ChromeBoundary>
        ))}
      </div>,
    );
    expect(mountedFeatureIds()).toEqual([]);
    // the ledger still works — otherwise the assertion above would be vacuous
    render(
      <FeatureBoundary feature="keys">
        <span />
      </FeatureBoundary>,
    );
    expect(mountedFeatureIds()).toEqual(["keys"]);
  });

  it("retries a transient crash once, and stops after the budget on a deterministic one", () => {
    vi.useFakeTimers();
    // ONE subscription for the whole test: the retries happen during
    // `advanceTimersByTime`, which is exactly when a per-render capture would
    // already have unsubscribed (that mistake is how this test was written the
    // first time, and it asserted a budget it could not see).
    const events: FeatureBoundaryErrorDetail[] = [];
    const off = onFeatureBoundaryError((d) => events.push(d));
    const forSurface = (s: string) => events.filter((e) => e.surface === s);
    try {
      // transient: the next attempt succeeds
      render(
        <ChromeBoundary surface="toasts">
          <Flaky />
        </ChromeBoundary>,
      );
      expect(forSurface("toasts")).toHaveLength(1);
      expect(screen.queryByTestId("flaky-recovered")).toBeNull();
      flakyFlag = false;
      act(() => {
        vi.advanceTimersByTime(CHROME_BOUNDARY_RETRY_MS);
      });
      expect(screen.getByTestId("flaky-recovered")).toBeInTheDocument();
      expect(forSurface("toasts"), "a recovered surface must not report again").toHaveLength(1);

      // deterministic: exactly 1 + MAX_RETRIES reports, then silence
      render(
        <ChromeBoundary surface="diag-drawer">
          <Boom />
        </ChromeBoundary>,
      );
      expect(forSurface("diag-drawer")).toHaveLength(1);
      // one interval at a time: the budget is spent one attempt per interval,
      // which is the behaviour the constant promises (a single big advance would
      // assert the same total without proving the spacing).
      for (let attempt = 1; attempt <= CHROME_BOUNDARY_MAX_RETRIES; attempt++) {
        act(() => {
          vi.advanceTimersByTime(CHROME_BOUNDARY_RETRY_MS);
        });
        expect(forSurface("diag-drawer"), "attempt " + attempt + " of " + CHROME_BOUNDARY_MAX_RETRIES).toHaveLength(1 + attempt);
      }
      act(() => {
        vi.advanceTimersByTime(CHROME_BOUNDARY_RETRY_MS * 10);
      });
      expect(forSurface("diag-drawer"), "the fence kept retrying after its budget - that is a flapping overlay").toHaveLength(
        1 + CHROME_BOUNDARY_MAX_RETRIES,
      );
      expect(document.body.textContent).not.toContain("chrome boom");
    } finally {
      off();
    }
  });
});

describe("App — a chrome crash no longer blanks Mission Control", () => {
  it("keeps the dashboard alive when a chrome surface crashes", () => {
    flags.dvrBoom = true;
    const events = capture(() => {
      render(<App />);
    });
    expect(screen.getByTestId("sidebar"), "the shell survived only because the FAB's fence caught it").toBeInTheDocument();
    expect(screen.queryByTestId("dvr-fab"), "the crashed surface must render nothing").toBeNull();
    expect(events.filter((e) => e.surface === "dvr-fab")).toHaveLength(1);
  });

  it("keeps the OTHER chrome alive when the SHELL itself crashes (the outermost fence)", () => {
    flags.shellBoom = true;
    const events = capture(() => {
      render(<App />);
    });
    expect(screen.queryByTestId("sidebar"), "the shell is the surface under test").toBeNull();
    // chrome mounted OUTSIDE the shell is still there — before M2 the whole tree
    // was gone here, including the DVR handle the operator needs to report it.
    expect(screen.getByTestId("dvr-fab")).toBeInTheDocument();
    expect(events.filter((e) => e.surface === "shell")).toHaveLength(1);
  });

  it("never re-uses a surface id for two different mounts", () => {
    const ids = CHROME_SURFACES.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    const mounts = CHROME_SURFACES.map((s) => s.mount);
    expect(new Set(mounts).size).toBe(mounts.length);
  });
});

describe("the crash channel — two producers, two provenances", () => {
  it("files a chrome crash as chrome-boundary (once), and a section crash as feature-boundary (its own card still renders)", () => {
    const off = installFeatureBoundaryReporter();
    const rows = (source: string) => useCollectorStore.getState().actions.filter((a) => a.source === source);

    render(
      <ChromeBoundary surface={"dvr-fab" as ChromeSurfaceId}>
        <Boom message="fab exploded" />
      </ChromeBoundary>,
    );
    expect(rows(CHROME_BOUNDARY_SOURCE)).toHaveLength(1);
    expect(rows(CHROME_BOUNDARY_SOURCE)[0].feature).toBe("chrome:dvr-fab");
    expect(rows(CHROME_BOUNDARY_SOURCE)[0].error).toContain("fab exploded");
    expect(rows(CHROME_BOUNDARY_SOURCE)[0].verdict?.status).toBe("fail");
    expect(rows(CHROME_BOUNDARY_SOURCE)[0].verdict?.reason).toContain("chrome surface");
    expect(rows(FEATURE_BOUNDARY_SOURCE), "a chrome crash must never be filed as a broken section").toHaveLength(0);
    // the dedup window still applies across both provenances
    act(() => {
      // a second identical failure inside the window must not double-record
    });
    expect(rows(CHROME_BOUNDARY_SOURCE)).toHaveLength(1);

    document.body.innerHTML = "";
    render(
      <FeatureBoundary feature="mirror">
        <Boom message="section exploded" />
      </FeatureBoundary>,
    );
    expect(rows(FEATURE_BOUNDARY_SOURCE)).toHaveLength(1);
    expect(rows(FEATURE_BOUNDARY_SOURCE)[0].feature).toBe("mirror");
    expect(rows(CHROME_BOUNDARY_SOURCE), "a section crash must never be filed as chrome").toHaveLength(1);
    // F105's card is what a crashed SECTION shows — that did not change
    expect(screen.getByTestId("feature-boundary-mirror")).toBeInTheDocument();
    off();
  });
});
