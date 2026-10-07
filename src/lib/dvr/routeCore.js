// [F107 §privacy] Route sanitizer CORE - the pure half of DVR route capture.
//
// WHY THIS FILE EXISTS. HashRouter routes can carry credentials in the query
// string (`#/collector?token=...`). A diagnostic recorder that persists the raw
// hash therefore persists a secret - a privacy probe on the step-6 branch
// reproduced exactly that, in BOTH the v1 clipboard ring and the v2 stored
// session. The fix is one shared sanitizer applied where the route is read, so
// neither recorder can be extended into leaking it again.
//
// It lives in its own pure core (repo convention: `*Core.js` + hand-written
// `.d.ts`, no DOM, no I/O) so `node --test` can execute the SHIPPED function
// rather than a copy of it. Nothing else from the retired first step-6 variant
// survives here on purpose: `buildFullBundle` produced a SECOND `.mcrec` v2
// shape, and two producers of one envelope tag is a reader hazard for F108.
//
// CONTRACT: no I/O of any kind - no fetch, no storage, no DOM, no Node fs.

/** Longest route we are willing to keep; a hash is never this long honestly. */
export const SAFE_ROUTE_MAX_CHARS = 256;

/**
 * Strip the query string (and bound the length) of a router hash/path.
 * `#/collector?token=SECRET` -> `#/collector`.
 */
export function safeRoute(value) {
  return String(value == null ? "" : value).split("?", 1)[0].slice(0, SAFE_ROUTE_MAX_CHARS);
}
