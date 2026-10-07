// [F106 §1] Types for the pure Feature Lab core (src/lib/lab/labCore.js).
// Hand-written, like src/lib/dvr-core.d.ts (step 3) and
// src/search/custom-source-core.d.ts (F58), because the implementation is plain
// JS so `node --test tests/*.test.js` can import and EXECUTE the shipped rules.
export declare const LAB_FORMAT: string;
export declare const LAB_VERSION: number;
export declare const LAB_SCENARIOS: LabScenarioId[];
export declare const LAB_MOCKABLE_METHODS: string[];
export declare const LAB_MOCK_HEADER: string;
export declare const LAB_MAX_LEDGER: number;
export declare const LAB_PATH_FALLBACK: string;

export type LabScenarioId = "passthrough" | "empty200" | "error500" | "offline";

export interface LabLedgerRow {
  method: string;
  path: string;
  /** "passthrough" | "response" | "network-error" - what the lab did with it. */
  kind: string;
  scenario: string;
  count: number;
  firstSeq: number;
  lastSeq: number;
}

export interface LabObservation {
  method?: string;
  path?: string;
  kind?: string;
  scenario?: string;
}

export interface LabDecision {
  kind: "passthrough" | "response" | "network-error";
  method: string;
  path: string;
  scenario: string;
  /** present on passthrough: "method" (a write) or "scenario" (nothing forced). */
  reason?: string;
  status?: number;
  statusText?: string;
  body?: unknown;
  /** present on network-error. */
  message?: string;
}

export declare function normalizeRequestPath(input: unknown): string;
export declare function normalizeMethod(method: unknown): string;
export declare function isMockableMethod(method: unknown): boolean;
export declare function pathSlug(path: unknown): string;
export declare function labIndexPath(pattern: unknown): string;
export declare function scenarioFor(scenarios: Record<string, LabScenarioId> | null, path: string): LabScenarioId;
export declare function mockBody(scenario: string): unknown;
export declare function resolveMock(
  scenarios: Record<string, LabScenarioId> | null,
  method: unknown,
  url: unknown
): LabDecision;

export interface LabLedger {
  readonly max: number;
  record(row: LabObservation): LabLedgerRow;
  list(): LabLedgerRow[];
  size(): number;
  seq(): number;
  clear(): number;
}

export declare function createLedger(max?: number): LabLedger;
export declare function mergeLedgerRow(
  list: LabLedgerRow[] | null | undefined,
  row: LabObservation,
  max?: number
): LabLedgerRow[];
export declare function ledgerSummary(list: LabLedgerRow[] | null | undefined): {
  paths: number;
  requests: number;
  /** requests on rows whose LATEST outcome was a mock (see the core comment). */
  mockedLastSeen: number;
};

export interface LabReportInput {
  ts?: string;
  feature?: string;
  route?: string;
  build?: string;
  enabled?: boolean;
  scenarios?: Record<string, LabScenarioId>;
  ledger?: LabLedgerRow[];
  mounted?: string[];
}

export declare function labReport(state: LabReportInput): {
  format: string;
  version: number;
  ts: string;
  feature: string;
  route: string;
  build: string;
  mocks: string;
  scenarios: Record<string, LabScenarioId>;
  summary: { paths: number; requests: number; mockedLastSeen: number };
  ledger: LabLedgerRow[];
  mounted: string[];
};
