// Hand-written type surface for src/lib/ci/inventoryCore.js (repo convention: a pure
// `*Core.js` ships beside a `.d.ts` so `tsc -p tsconfig.build.json` checks the callers
// without the core itself being transpiled).

/** Strings shaped like a feature id that are process artefacts, never shipped features. */
export declare const NAMED_FEATURE_DENYLIST: string[];

/** The classification vocabulary for a derived storage surface. */
export declare const STORAGE_CLASSIFICATIONS: string[];

/** Legal `status` values for a step-ledger entry. */
export declare const LEDGER_STATUSES: string[];

/**
 * Directories that are inventory tooling rather than storage surfaces. Excluded from the
 * derived inventory by the gate; pinned to exactly this list so it cannot widen into a
 * hiding place.
 */
export declare const INVENTORY_TOOLING_PREFIXES: string[];

/** True when `path` is inventory tooling rather than a shipping storage surface. */
export declare function isInventoryTooling(path: string): boolean;

/** Feature ids (`F105`, `F-DVR-LITE`, …) named by a title/label, deduplicated, denylist filtered. */
export declare function extractFeatureIds(text: string): string[];

/** One PR that carried a roadmap step. */
export interface StepLedgerEntry {
  step: number;
  number: number | null;
  branch: string | null;
  featureIds: string[];
  status: string;
  title: string;
  /** Set when this entry is the repair that a `merged-then-retired` entry cites. */
  repair?: boolean;
  /** The PR that retired this one; required when status is `merged-then-retired`. */
  retiredBy?: number;
  /** Ids the title names that this entry deliberately does NOT ship. */
  titleNamesButDoesNotShip?: string[];
  /** Why the waiver above exists; required when a waiver is used. */
  waiverWhy?: string;
  /** Excludes the entry from the roadmap-agreement rules (e.g. a halt record). */
  inRoadmap?: boolean;
  [extra: string]: unknown;
}

export interface DuplicateStepVerdict {
  ids: string[];
  matches: Array<{ id: string; entry: StepLedgerEntry }>;
  verdict: "duplicate-merged" | "sibling-open" | "prior-retired" | "unique";
  blocking: boolean;
  label: string | null;
  reason: string;
}

/** The double-ship detector: would shipping this PR repeat a step already merged or in flight? */
export declare function detectDuplicateStep(input: {
  title: string;
  number?: number | null;
  ledger: StepLedgerEntry[];
}): DuplicateStepVerdict;

/** Violations of ledger self-consistency (empty array = consistent). */
export declare function assertNoDoubleShip(ledger: StepLedgerEntry[]): Array<{ rule: string; featureId?: string; detail: string }>;

/** Keeps declared featureIds honest against each entry's own title. */
export declare function ledgerTitleConsistency(ledger: StepLedgerEntry[]): Array<{ rule: string; detail: string }>;

export interface RoadmapLine {
  step: number;
  repair: boolean;
  checked: boolean;
  label: string;
  ids: string[];
  /** PRs cited in the strict `PR **#N**` form only - never prose cross-references. */
  prs: number[];
  /** The first `arena/…` on the line, i.e. that line's own head branch. */
  branch: string | null;
}

/** Parse the roadmap checkbox lines out of docs/OBSERVATORY-STATE.md. */
export declare function parseRoadmap(markdown: string): RoadmapLine[];

/** Ledger <-> roadmap disagreements (empty array = the two documents agree). */
export declare function ledgerVsRoadmap(ledger: StepLedgerEntry[], markdown: string): Array<{ rule: string; detail: string }>;

/** Identifier -> string-literal map, collected across files so key constants resolve. */
export declare function collectStringConsts(sources: Array<{ path: string; text: string }>): Map<string, { value: string; path: string }>;

/** `live` | `migration` | `purged` | `dead-read`, derived from the operations performed. */
export declare function classifyStorageKey(ops: Iterable<string> | string[]): string;

export interface DerivedStorageKey {
  key: string;
  kind: "localStorage" | "indexedDB";
  ops: string[];
  paths: string[];
  evidence: Array<{ path: string; op: string; cite: string }>;
  classification: string;
}

export interface StorageScan {
  keys: DerivedStorageKey[];
  /** Key-shaped literals the scanner correctly rejected, with the files they appear in. */
  lookalikes: Array<{ value: string; paths: string[] }>;
  filesScanned: number;
}

/** Derive the browser-persistence inventory from source text. No fs, no DOM. */
export declare function scanSources(sources: Array<{ path: string; text: string }>): StorageScan;

export interface StorageInventoryDiff {
  undeclared: Array<{ key: string; classification: string; paths: string[] }>;
  stale: Array<{ key: string; declaredIn?: string[] }>;
  classificationMismatch: Array<{ key: string; declared: string; derived: string; ops: string[] }>;
  kindMismatch: Array<{ key: string; declared: string; derived: string }>;
  citationMismatch: Array<{ key: string; citedButNotUsing: string[]; derivedFrom: string[]; unresolvable: string[] }>;
  agreed: string[];
}

/** Diff the derived inventory against src/lib/ci/storageInventory.json. */
export declare function diffStorageInventory(
  scan: { keys: DerivedStorageKey[] },
  declared: { keys: Array<Record<string, unknown>> }
): StorageInventoryDiff;
