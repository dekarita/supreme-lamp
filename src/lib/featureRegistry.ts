// [F105 §1] featureRegistry.ts — the Observatory's map of Mission Control.
//
// WHY THIS EXISTS. #163 (the inventory) is a document; F106 (lab pages),
// F107 (DVR), F108 (replay viewer), F109 (HUD) and F110 (live patch) all need
// the same facts as DATA: which section owns which files, which route answers
// for it, which feature it reads shared state from, what a boundary fallback
// must be named. A document cannot be imported; a hand-copied list drifts. So
// the facts live in feature-registry.json (importable by BOTH the app and the
// Node gate) and this module is the typed, validating face of them.
//
// THE DAG CONTRACT (the part that makes this more than a list). Every edge is
// an explicit claim with a source citation, and tests/f105-feature-registry.test.js
// enforces three no-lying rules:
//   1. no edge without evidence  - every dependsOn/navigatesTo pair has >= 1
//      row in `evidence[]`, so an invented dependency cannot be added quietly;
//   2. no evidence without an edge - a citation for an edge that is not in the
//      graph is itself a failure (the graph is not allowed to under-declare);
//   3. the citation must resolve - the named file exists AND contains the named
//      symbol, so the evidence is checkable, not decorative.
// Two edge kinds, because they answer two different Observatory questions:
//   dependsOn    (state)  - "mounting this feature in isolation (F106) needs
//                           that feature's state warm, or the render lies";
//   navigatesTo  (route)  - "a replay of this feature (F108) may end up on
//                           that route, so its bundle must be reachable".
//
// SCOPE NOTE: ownership is over src/pages/** only. The 41 shared components in
// src/components/** are deliberately owned by NO feature - they are chrome or
// cross-feature primitives (the same reason there are 11 boundaries and not
// 50), and a file can be imported by two features without belonging to either.
import registryData from "./feature-registry.json";

/**
 * [F105 §1.2] The 11 sections, in sidebar order. This union is the only
 * hand-written copy of the id list and tests/f105-feature-registry.test.js
 * asserts it is byte-equal to the JSON's id set - so a 12th section cannot be
 * added to one artefact without the other.
 */
export type FeatureId =
  | "overview"
  | "search"
  | "sessions"
  | "connections"
  | "keys"
  | "files"
  | "mirror"
  | "telemetry"
  | "health"
  | "collector"
  | "settings";

export type FeatureDependencyKind = "state" | "route";

export interface FeatureEvidence {
  from: FeatureId;
  to: FeatureId;
  kind: FeatureDependencyKind;
  file: string;
  symbol: string;
}

export interface FeatureDescriptor {
  id: FeatureId;
  /** Sidebar position 1..11 - the order AppShell.NAV renders. */
  order: number;
  /** react-router path inside the HashRouter ("/" for the index route). */
  route: string;
  routeKind: "index" | "path";
  /** JSX element name used in App.tsx (a few pages export a named function). */
  component: string;
  /** Existing i18n key for the section name (nav.*) - never a new key. */
  navKey: string;
  /** Globs, relative to the repo root, that THIS feature exclusively owns. */
  owns: string[];
  /** Sub-route of this feature that is NOT in the sidebar (F72 Lab), if any. */
  labRoute?: string;
  dependsOn: FeatureId[];
  navigatesTo: FeatureId[];
  /** Store hooks the feature's own files read (verified to appear there). */
  stores: string[];
  /** Endpoint literals the feature's own files call (verified to appear there). */
  endpoints: string[];
}

interface FeatureRegistryData {
  version: number;
  contract: string;
  labRoutePattern: string;
  features: FeatureDescriptor[];
  evidence: FeatureEvidence[];
}

const DATA = registryData as unknown as FeatureRegistryData;

/** The registry document, verbatim: the Observatory reads this, not a copy. */
export const FEATURE_REGISTRY = DATA;

export const FEATURES: readonly FeatureDescriptor[] = DATA.features;

/** Sidebar order (1..11) - the F106 lab index order. */
export const FEATURE_IDS: readonly FeatureId[] = FEATURES.map((f) => f.id);

/** [F105 §2] fallback test-id prefix: `<prefix><featureId>`. F104's capture,
 *  F106's lab and F107's DVR all address the boundary by test id. */
export const FEATURE_BOUNDARY_TESTID_PREFIX = "feature-boundary-";

/** The boundary wrapper's test id for a feature ("feature-boundary-files"). */
export function boundaryTestId(id: FeatureId): string {
  return FEATURE_BOUNDARY_TESTID_PREFIX + id;
}

/** [F106 contract] `/#/lab/<feature>` - derived, never stored twice. */
export function featureLabPath(id: FeatureId): string {
  return DATA.labRoutePattern.replace(":featureId", id);
}

export function featureById(id: FeatureId): FeatureDescriptor {
  const f = FEATURES.find((x) => x.id === id);
  if (!f) throw new Error("unknown feature: " + String(id));
  return f;
}

/** Do the concrete path and a `:param` pattern describe the same route? */
function routeMatches(pattern: string, path: string): boolean {
  const p = pattern.split("/");
  const q = path.split("/");
  if (p.length !== q.length) return false;
  return p.every((seg, i) => (seg.startsWith(":") ? q[i].length > 0 : seg === q[i]));
}

/**
 * Route lookup for the DVR/replay: exact path, the index route, and a lab
 * sub-route (both this app's `#/search/lab/<id>` form and the F106
 * `#/lab/<feature>` form). Accepts a bare path or a hash-prefixed one.
 */
export function featureByRoute(path: string): FeatureDescriptor | null {
  const norm = (String(path || "").split("#").pop() || "/").split("?")[0] || "/";
  const hit = FEATURES.find((f) => f.route === norm || (!!f.labRoute && routeMatches(f.labRoute, norm)));
  if (hit) return hit;
  // "/lab/files" (the F106 pattern) maps back to its feature too.
  const m = norm.match(/^\/lab\/([a-z-]+)$/);
  if (m && FEATURE_IDS.includes(m[1] as FeatureId)) return featureById(m[1] as FeatureId);
  return null;
}

export interface FeatureDagIssue {
  kind:
    | "unknown-id"
    | "self-edge"
    | "cycle"
    | "duplicate-id"
    | "duplicate-order"
    | "orphan-evidence"
    | "unevidenced-edge";
  detail: string;
}

/**
 * [F105 §1.3] Validate the DAG from the data alone (the same checks the Node
 * gate re-derives from the JSON). Returns [] when the graph is sound; a
 * non-empty list is a contract violation, never a warning.
 */
export function featureDagIssues(): FeatureDagIssue[] {
  const issues: FeatureDagIssue[] = [];
  const seenIds = new Set<string>();
  const seenOrders = new Set<number>();
  for (const f of FEATURES) {
    if (seenIds.has(f.id)) issues.push({ kind: "duplicate-id", detail: f.id });
    seenIds.add(f.id);
    if (seenOrders.has(f.order)) issues.push({ kind: "duplicate-order", detail: String(f.order) });
    seenOrders.add(f.order);
  }
  const ids = new Set<string>(FEATURES.map((f) => f.id));
  for (const f of FEATURES) {
    for (const kind of ["dependsOn", "navigatesTo"] as const) {
      for (const to of f[kind]) {
        if (!ids.has(to)) issues.push({ kind: "unknown-id", detail: `${f.id} -${kind}-> ${to}` });
        if (to === f.id) issues.push({ kind: "self-edge", detail: `${f.id} -${kind}-> ${to}` });
      }
    }
  }
  // A cycle among state edges would make the F106 warm-up order undefined.
  const state = new Map<string, string[]>(FEATURES.map((f) => [f.id, f.dependsOn.filter((d) => ids.has(d))]));
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const colour = new Map<string, number>(FEATURES.map((f) => [f.id, WHITE]));
  const stack: string[] = [];
  const visit = (id: string): void => {
    colour.set(id, GRAY);
    stack.push(id);
    for (const next of state.get(id) || []) {
      const c = colour.get(next);
      if (c === GRAY) issues.push({ kind: "cycle", detail: [...stack, next].join(" -> ") });
      else if (c === WHITE) visit(next);
    }
    stack.pop();
    colour.set(id, BLACK);
  };
  for (const f of FEATURES) if (colour.get(f.id) === WHITE) visit(f.id);
  // Evidence rows must point at a real edge (no under-declaration) ...
  const cited = new Set(DATA.evidence.map((e) => `${e.from}|${e.kind}|${e.to}`));
  for (const e of DATA.evidence) {
    const from = FEATURES.find((f) => f.id === e.from);
    const declared = e.kind === "state" ? from?.dependsOn : from?.navigatesTo;
    if (!from || !(declared || []).includes(e.to)) {
      issues.push({ kind: "orphan-evidence", detail: `${e.from} -${e.kind}-> ${e.to}` });
    }
  }
  // ... and every declared edge must be cited (no over-declaration either). The
  // file-level resolution of a citation is checked by the Node gate, which has
  // fs; this runtime half is what a browser-side consumer can verify.
  for (const f of FEATURES) {
    for (const to of f.dependsOn) {
      if (!cited.has(`${f.id}|state|${to}`)) issues.push({ kind: "unevidenced-edge", detail: `${f.id} -state-> ${to}` });
    }
    for (const to of f.navigatesTo) {
      if (!cited.has(`${f.id}|route|${to}`)) issues.push({ kind: "unevidenced-edge", detail: `${f.id} -route-> ${to}` });
    }
  }
  return issues;
}

/**
 * [F106/F108] dependency-first order: every feature appears after the features
 * whose state it reads. Deterministic (sidebar order breaks ties), so a test
 * or a replay can rely on it.
 */
export function featureTopoOrder(): FeatureId[] {
  const ready: FeatureId[] = [];
  const done = new Set<FeatureId>();
  const pending = [...FEATURES].sort((a, b) => a.order - b.order);
  while (pending.length) {
    const next = pending.find((f) => f.dependsOn.every((d) => done.has(d)));
    if (!next) break; // cycle: featureDagIssues() reports it, this stops cleanly
    ready.push(next.id);
    done.add(next.id);
    pending.splice(pending.indexOf(next), 1);
  }
  return ready;
}

// ---------------------------------------------------------------------------
// [F105 §3] Boundary introspection. Each mounted FeatureBoundary registers its
// id here and de-registers on unmount. This is what lets a test prove, without
// touching the DOM shape of the pages, that the 11 wrappers are actually
// mounted on the 11 routes - and it is what F109's HUD will read to tell the
// operator which sections are alive right now.
// ---------------------------------------------------------------------------
const mounted = new Map<FeatureId, number>();

/** @internal used by FeatureBoundary only. */
export function registerMountedFeature(id: FeatureId): () => void {
  mounted.set(id, (mounted.get(id) || 0) + 1);
  return () => {
    const left = (mounted.get(id) || 1) - 1;
    if (left <= 0) mounted.delete(id);
    else mounted.set(id, left);
  };
}

/** The features whose boundary is mounted right now (sorted by sidebar order). */
export function mountedFeatureIds(): FeatureId[] {
  return FEATURE_IDS.filter((id) => mounted.has(id));
}

/** Test-only: forget the mount ledger (component unmounts own their cleanup). */
export function __resetMountedFeaturesForTests(): void {
  mounted.clear();
}
