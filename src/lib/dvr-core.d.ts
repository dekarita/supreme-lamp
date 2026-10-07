// [F-DVR-LITE §2] Types for the pure DVR ring core (src/lib/dvr-core.js).
// Hand-written, like src/search/custom-source-core.d.ts, because the implementation
// is plain JS so the Node gate in `node --test tests/*.test.js` can import and
// EXERCISE the shipped rules with no DOM and no build step.

export declare const DVR_FORMAT: string;
export declare const DVR_VERSION: number;
export declare const DVR_WINDOW_MS: number;
export declare const DVR_MAX_ENTRIES: number;
export declare const DVR_KINDS: string[];

/** What one ring entry holds. `kind` is the discriminator; the rest is per-kind. */
export interface DvrCoreEntry {
  seq: number;
  at: number;
  kind: "click" | "settle" | "route";
  [field: string]: unknown;
}

export interface DvrRingOptions {
  windowMs?: number;
  maxEntries?: number;
}

export interface DvrRing {
  windowMs: number;
  maxEntries: number;
  push(entry: Omit<DvrCoreEntry, "seq" | "at"> & { at?: number }, now: number): DvrCoreEntry;
  prune(now: number): number;
  list(now: number): DvrCoreEntry[];
  size(now: number): number;
  clear(): number;
  readonly seq: number;
}

export declare function createRing(opts?: DvrRingOptions): DvrRing;

export interface DvrCounts {
  count: number;
  byKind: Record<string, number>;
  firstAt: number;
  lastAt: number;
  spanMs: number;
}

export declare function ringStats(entries: DvrCoreEntry[]): DvrCounts;

export interface DvrTarget {
  route: string;
  buildSha: string;
  lang: string;
  ui: string;
}

export interface DvrBundle {
  format: string;
  version: number;
  createdAt: string;
  windowMs: number;
  maxEntries: number;
  target: DvrTarget;
  counts: DvrCounts;
  entries: DvrCoreEntry[];
}

export declare function buildBundle(
  entries: DvrCoreEntry[],
  target: Partial<DvrTarget>,
  opts?: { now?: number; windowMs?: number; maxEntries?: number }
): DvrBundle;

export declare function bundleText(bundle: DvrBundle): string;
export declare function toBase64(bytes: Uint8Array): string;
export declare function fromBase64(text: string): Uint8Array | null;
export declare function byteLength(text: string): number;
export declare function encodeEnvelope(codec: "gzip" | "plain", base64: string): string;
export declare function decodeEnvelope(text: string): { codec: "gzip" | "plain"; base64: string; bytes: Uint8Array } | null;
