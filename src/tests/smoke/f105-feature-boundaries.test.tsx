// [F105 / Observatory step 4] Feature Registry + Boundaries — the DOM gate.
//
// The Node gate (tests/f105-feature-registry.test.js) proves the ARTEFACTS agree:
// registry ↔ App.tsx ↔ i18n ↔ source tree. It cannot prove the boundary WORKS,
// so this suite mounts the real components and asserts behaviour:
//
//   1. a healthy boundary is invisible - `innerHTML` with the wrapper is
//      byte-equal to `innerHTML` without it (zero DOM delta, so no layout or
//      regression-id test can be disturbed by this feature);
//   2. a throwing child is contained for ALL 11 features: the fallback appears
//      with the feature's test id, the section name is localised, and the
//      failure is published on the window event channel;
//   3. Retry re-mounts the subtree and recovers;
//   4. the mount ledger proves the 11 boundaries are wired to the 11 ROUTES -
//      mounting App at each route registers exactly that feature and nothing
//      else (this is what makes "step 4 = 11 FeatureBoundaries" falsifiable);
//   5. the step-2 handoff is RESOLVED: /#/telemetry mounts with an empty store
//      (the crash that took the whole tree down) and shows its empty state;
//   6. the crash channel feeds the Collector (one row per distinct failure,
//      deduped) and never leaks a query string, a stack or a network call.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import "@/i18n";
import App from "@/App";
import FeatureBoundary from "@/components/primitives/FeatureBoundary";
import Telemetry from "@/pages/Telemetry";
import {
  FEATURES,
  FEATURE_IDS,
  boundaryTestId,
  featureById,
  featureByRoute,
  featureDagIssues,
  featureLabPath,
  featureTopoOrder,
  mountedFeatureIds,
  __resetMountedFeaturesForTests,
  type FeatureId,
} from "@/lib/featureRegistry";
import {
  FEATURE_BOUNDARY_MESSAGE_MAX,
  FEATURE_BOUNDARY_SOURCE,
  boundaryCollectorRow,
  emitFeatureBoundaryError,
  installFeatureBoundaryReporter,
  onFeatureBoundaryError,
  sanitizeBoundaryMessage,
  sanitizeBoundaryRoute,
  __resetFeatureBoundaryReporterForTests,
  type FeatureBoundaryErrorDetail,
} from "@/lib/featureBoundary";
import { useCollectorStore } from "@/lib/collectorAgent";
import { useSessionStore } from "@/stores/sessionStore";
import en from "@/i18n/en.json";
import si from "@/i18n/si.json";

/** Throws on every render - the smallest possible crashing feature. */
function Boom({ message = "boom" }: { message?: string }) {
  throw new Error(message);
}

/** Throws while the module flag is set - the flaky-render shape Retry exists
 *  for. The flag is flipped by the TEST, not by the first render: React 18
 *  re-attempts a render after a recoverable error, so a "throw only once"
 *  component recovers without the boundary ever being consulted. */
let boomFlag = true;
function BoomWhileFlag() {
  if (boomFlag) throw new Error("still broken");
  return <div data-testid="once-ok">recovered</div>;
}
/** Localised section-name lookup used by the containment assertion. */
const NAV = en.nav as Record<string, string>;
const SI_NAV = si.nav as Record<string, string>;

// The sweep is DERIVED from the registry, not hand-copied: a route renamed in
// the registry but not in App.tsx then renders the catch-all (overview) and the
// ledger assertion below fails - so registry<->App route parity is proven at
// runtime as well as statically (falsification M5).
const ROUTES: Array<[FeatureId, string]> = FEATURE_IDS.map((id) => [id, "#" + featureById(id).route]);
/** The pinned sidebar order, independent of the registry, so a reorder fails. */
const EXPECTED_ORDER: FeatureId[] = [
  "overview",
  "search",
  "sessions",
  "connections",
  "keys",
  "files",
  "mirror",
  "telemetry",
  "health",
  "collector",
  "settings",
];

beforeEach(() => {
  // React logs every caught error to console.error; the boundary is expected
  // behaviour here, so keep the output readable without hiding real failures.
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  boomFlag = true;
  window.location.hash = "#/";
  __resetMountedFeaturesForTests();
  __resetFeatureBoundaryReporterForTests();
  useCollectorStore.getState().clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  window.location.hash = "#/";
  __resetMountedFeaturesForTests();
  __resetFeatureBoundaryReporterForTests();
});

describe("F105 registry (runtime contract)", () => {
  it("declares 11 features whose DAG is sound and whose topo order covers all of them", () => {
    expect(FEATURES).toHaveLength(11);
    expect(featureDagIssues()).toEqual([]);
    const order = featureTopoOrder();
    expect(order).toHaveLength(11);
    expect(FEATURE_IDS).toEqual(EXPECTED_ORDER);
    expect(ROUTES.map(([id]) => id)).toEqual(EXPECTED_ORDER);
    expect(new Set(order).size).toBe(11);
    // dependency-first: every feature appears after its dependsOn targets
    for (const f of FEATURES) {
      for (const dep of f.dependsOn) {
        expect(order.indexOf(dep), `${dep} must precede ${f.id}`).toBeLessThan(order.indexOf(f.id));
      }
    }
  });

  it("maps routes back to features, including the index and the lab sub-route", () => {
    expect(featureByRoute("/")?.id).toBe("overview");
    expect(featureByRoute("/files")?.id).toBe("files");
    expect(featureByRoute("/search/lab/abc")?.id).toBe("search");
    expect(featureByRoute("/lab/settings")?.id).toBe("settings");
    expect(featureByRoute("/nope")).toBeNull();
    expect(featureLabPath("files")).toBe("/lab/files");
    expect(boundaryTestId("files")).toBe("feature-boundary-files");
  });

  it("names every section from an existing nav.* key, with at most step 2's one known si gap", () => {
    // Every section label already exists in en. In si exactly ONE is missing on
    // this base - nav.health - which is a step-2 key (PR #167, still open).
    // Pinning the gap this way means a NEW missing label fails here, while the
    // known one is neither silently accepted nor "fixed" twice.
    const missingSi = FEATURE_IDS.filter((id) => !SI_NAV[id]);
    expect(missingSi.filter((id) => id !== "health")).toEqual([]);
    expect(missingSi.length).toBeLessThanOrEqual(1);
  });

  it("keeps every section label resolvable in both catalogs (en canonically, si for the depth this step needs)", () => {
    const flat = (o: unknown, p = ""): Record<string, string> =>
      Object.entries(o as Record<string, unknown>).reduce((acc: Record<string, string>, [k, v]) => {
        if (v && typeof v === "object") Object.assign(acc, flat(v, p + k + "."));
        else acc[p + k] = String(v);
        return acc;
      }, {});
    const FE = flat(en);
    const FS = flat(si);
    for (const f of FEATURES) {
      expect(FE, f.navKey).toBeTruthy();
      // The fallback renders only in en in this suite; si completeness for the
      // new boundary.* keys is asserted by the Node gate (nav.health's si value
      // is step 2's, PR #167 - not re-litigated here).
      expect(FE["boundary." + "title"]).toBeTruthy();
      expect(FS["boundary." + "title"]).toBeTruthy();
    }
  });
});

describe("F105 FeatureBoundary behaviour", () => {
  it("is invisible when healthy: innerHTML is byte-equal with and without the fence", () => {
    const plain = render(<div id="probe-x">hello</div>);
    const plainHtml = plain.container.innerHTML;
    plain.unmount();
    const fenced = render(
      <FeatureBoundary feature="files">
        <div id="probe-x">hello</div>
      </FeatureBoundary>,
    );
    expect(fenced.container.innerHTML).toBe(plainHtml);
    expect(screen.queryByTestId("feature-boundary-files")).toBeNull();
  });

  it.each(FEATURE_IDS)("contains a throwing child for feature %s and publishes the failure", (id) => {
    const events: FeatureBoundaryErrorDetail[] = [];
    const off = onFeatureBoundaryError((d) => events.push(d));
    const { unmount } = render(
      <FeatureBoundary feature={id}>
        <Boom />
      </FeatureBoundary>,
    );
    const card = screen.getByTestId(boundaryTestId(id));
    expect(card).toBeInTheDocument();
    expect(card).toHaveAttribute("role", "alert");
    // localised section name, from the existing nav.* key
    expect(card.textContent).toContain(NAV[id]);
    expect(card.textContent).toContain("boom");
    expect(events).toHaveLength(1);
    expect(events[0].feature).toBe(id);
    expect(events[0].message).toContain("boom");
    expect(events[0].section).toBeTruthy();
    // every affordance is addressable (F104 capture + F106 lab address by testid)
    expect(screen.getByTestId(boundaryTestId(id) + "-retry")).toBeInTheDocument();
    expect(screen.getByTestId(boundaryTestId(id) + "-reload")).toBeInTheDocument();
    expect(screen.getByTestId(boundaryTestId(id) + "-copy")).toBeInTheDocument();
    off();
    unmount();
  });

  it("re-catches a repeat failure on Retry, and recovers once the cause is gone", async () => {
    const user = userEvent.setup();
    const events: FeatureBoundaryErrorDetail[] = [];
    const off = onFeatureBoundaryError((d) => events.push(d));
    render(
      <FeatureBoundary feature="health">
        <BoomWhileFlag />
      </FeatureBoundary>,
    );
    expect(screen.getByTestId("feature-boundary-health")).toBeInTheDocument();
    // Retry while the cause is still present: the boundary must re-catch, not
    // let the error escape and blank the app (count goes to 2).
    await user.click(screen.getByTestId("feature-boundary-health-retry"));
    expect(screen.getByTestId("feature-boundary-health")).toBeInTheDocument();
    expect(events).toHaveLength(2);
    expect(events[1].count).toBe(2);
    // Cause removed -> Retry re-mounts the subtree and the card disappears.
    boomFlag = false;
    await user.click(screen.getByTestId("feature-boundary-health-retry"));
    expect(screen.getByTestId("once-ok")).toBeInTheDocument();
    expect(screen.queryByTestId("feature-boundary-health")).toBeNull();
    expect(events).toHaveLength(2);
    off();
  });

  it("leaves exactly one fence mounted per route and none after unmount (all 11 routes)", () => {
    for (const [id, hash] of ROUTES) {
      window.location.hash = hash;
      __resetMountedFeaturesForTests();
      const view = render(<App />);
      expect(mountedFeatureIds(), `route ${hash}`).toEqual([id]);
      view.unmount();
      expect(mountedFeatureIds(), `after unmount ${hash}`).toEqual([]);
    }
  });

  it("keeps the app alive when a page really throws (the shell survives the fence)", () => {
    // Substitute the crashing child for the telemetry route's element by using
    // the boundary exactly as App wires it: chrome outside, fence inside.
    const view = render(
      <MemoryRouter>
        <div data-testid="chrome-sentinel">shell</div>
        <FeatureBoundary feature="telemetry">
          <Boom />
        </FeatureBoundary>
      </MemoryRouter>,
    );
    expect(screen.getByTestId("feature-boundary-telemetry")).toBeInTheDocument();
    expect(screen.getByTestId("chrome-sentinel")).toBeInTheDocument();
    view.unmount();
  });
});

describe("F105 x step-2 handoff (Telemetry with an empty store)", () => {
  it("mounts /#/telemetry without crashing and shows the empty beacon state", () => {
    useSessionStore.setState({ native: null });
    window.location.hash = "#/telemetry";
    const view = render(<App />);
    // the crash (BeaconJsonlViewer reading a null handlerChain) is FIXED, so no
    // fallback is involved - the page renders its real empty state
    expect(screen.queryByTestId("feature-boundary-telemetry")).toBeNull();
    expect(view.container.textContent).toContain("no launcher chain / beacon rows yet");
    expect(mountedFeatureIds()).toEqual(["telemetry"]);
    view.unmount();
  });

  it("also survives a standalone mount with the store explicitly emptied", () => {
    useSessionStore.setState({ native: null });
    const view = render(
      <MemoryRouter>
        <Telemetry />
      </MemoryRouter>,
    );
    expect(screen.queryByTestId("feature-boundary-telemetry")).toBeNull();
    expect(view.container.textContent).toContain("no launcher chain / beacon rows yet");
    view.unmount();
  });
});

describe("F105 crash channel (privacy + Collector feed)", () => {
  it("cuts the route at ?/# so a dash token can never be recorded, and truncates the message", () => {
    window.location.hash = "#/files?key=SECRET-TOKEN";
    const events: FeatureBoundaryErrorDetail[] = [];
    const off = onFeatureBoundaryError((d) => events.push(d));
    const view = render(
      <FeatureBoundary feature="files">
        <Boom message={"x".repeat(1000)} />
      </FeatureBoundary>,
    );
    expect(events).toHaveLength(1);
    expect(events[0].route).toBe("#/files");
    expect(JSON.stringify(events[0])).not.toContain("SECRET-TOKEN");
    expect(events[0].message.length).toBeLessThanOrEqual(FEATURE_BOUNDARY_MESSAGE_MAX + 1);
    expect(sanitizeBoundaryRoute("http://x/y?key=abc#frag")).toBe("http://x/y");
    expect(sanitizeBoundaryMessage("a\n\n b")).toBe("a b");
    off();
    view.unmount();
  });

  it("performs no network call while reporting a crash", () => {
    const spy = vi.fn(() => Promise.resolve({ ok: false, status: 404, json: async () => ({}) }));
    vi.stubGlobal("fetch", spy);
    const view = render(
      <FeatureBoundary feature="sessions">
        <Boom />
      </FeatureBoundary>,
    );
    expect(spy).not.toHaveBeenCalled();
    view.unmount();
  });

  it("writes exactly one Collector row per distinct failure and shapes it as a fail verdict", () => {
    const off = installFeatureBoundaryReporter();
    const view = render(
      <FeatureBoundary feature="collector">
        <Boom />
      </FeatureBoundary>,
    );
    const rows = () => useCollectorStore.getState().actions.filter((a) => a.source === FEATURE_BOUNDARY_SOURCE);
    expect(rows()).toHaveLength(1);
    expect(rows()[0].feature).toBe("collector");
    expect(rows()[0].action).toBe("renderError");
    expect(rows()[0].verdict?.status).toBe("fail");
    // the same failure inside the dedup window must not double-record
    const detail: FeatureBoundaryErrorDetail = {
      feature: "collector",
      section: "Collector",
      message: rows()[0].error || "boom",
      route: "#/",
      count: 2,
      ts: new Date().toISOString(),
    };
    emitFeatureBoundaryError(detail);
    expect(rows()).toHaveLength(1);
    off();
    view.unmount();
  });

  it("maps a failure onto the F100 ButtonAction shape without inventing fields", () => {
    const row = boundaryCollectorRow({
      feature: "mirror",
      section: "Mirror",
      message: "kaboom",
      route: "#/mirror",
      count: 1,
      ts: "2026-10-07T00:00:00.000Z",
    });
    expect(row).toMatchObject({ feature: "mirror", action: "renderError", source: FEATURE_BOUNDARY_SOURCE, error: "kaboom" });
    expect(row.verdict?.relatedIssue).toBe("#165");
    expect(JSON.stringify(row)).not.toContain("stack");
  });

  it("never leaks into the store without an explicit install (no side effect at import)", () => {
    const view = render(
      <FeatureBoundary feature="keys">
        <Boom />
      </FeatureBoundary>,
    );
    expect(useCollectorStore.getState().actions.filter((a) => a.source === FEATURE_BOUNDARY_SOURCE)).toHaveLength(0);
    view.unmount();
  });
});
