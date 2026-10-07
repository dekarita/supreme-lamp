// [F106 §5] Who may see the Labs entry in the sidebar.
//
// The sidebar's 11 entries are a LOCKED contract - three artefacts pin that list
// (launch-gates.yml's F56-c python step, src/tests/smoke/sidebar-nav.test.tsx and
// f76-sidebar-search.test.tsx), and #163 derived the sections from it. So the lab
// does NOT get a 12th entry by default: it is reachable as the deep link
// `/#/lab` the F105 registry already reserved (labRoutePattern).
//
// Two ways the entry appears, both observable and neither persistent:
//   1. `VITE_F106_LABS=true` at build time (a deploy that wants the tool in the
//      sidebar can have it without touching the locked list), or
//   2. the operator is ALREADY on a lab route - then the entry is the way back to
//      the index, which makes the tool discoverable from inside itself:
//      `/#/lab/files` -> sidebar shows "Labs".
// No storage, no cookie: closing the tab ends it, so a scenario or a nav entry
// can never be inherited by a later, ordinary dashboard visit.
import { FEATURE_REGISTRY, featureLabPath } from "@/lib/featureRegistry";
import { labIndexPath } from "./labCore";

/** The build-time flag name, exported so the gate pins the literal. */
export const LAB_ENTRY_FLAG = "VITE_F106_LABS";

/** The index path, derived from the registry's pattern (never hand-written). */
export function labIndexRoute(): string {
  return labIndexPath(FEATURE_REGISTRY.labRoutePattern);
}

/** Is the current hash a lab route? Pure enough to test with a string. */
export function isLabRouteHash(hash: string | null | undefined): boolean {
  const h = String(hash == null ? "" : hash);
  const index = labIndexRoute();
  if (h === "#" + index || h === index) return true;
  // any `#/lab/<id>` (or the pattern's own shape) counts as "inside the lab"
  return h.startsWith("#" + index + "/") || h.startsWith(index + "/");
}

/** The deep link to one section's lab (a thin pass-through to the registry). */
export function labRouteFor(id: Parameters<typeof featureLabPath>[0]): string {
  return featureLabPath(id);
}

/**
 * Should the sidebar render the Labs entry?
 * `hash` is injectable so a test can assert both branches without touching
 * window.location.
 */
export function labEntryVisible(hash?: string | null): boolean {
  let flagged = false;
  try {
    flagged = String(import.meta.env.VITE_F106_LABS || "") === "true";
  } catch {
    flagged = false;
  }
  if (flagged) return true;
  const h = hash == null ? (typeof window === "undefined" ? "" : window.location.hash || "") : hash;
  return isLabRouteHash(h);
}
