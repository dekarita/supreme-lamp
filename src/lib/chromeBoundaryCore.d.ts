// [M2 §1] Types for the chrome-fence core (src/lib/chromeBoundaryCore.js).
// Hand-written, like the other cores: the union below is the ONLY closed list of
// surface ids in TypeScript, and `tests/m2-chrome-unfencing.test.js` asserts it
// is byte-equal to the JS table's id set — so a surface added to one artefact
// without the other fails CI instead of rendering an unfenced overlay.

export type ChromeSurfaceId =
  | "toasts"
  | "diag-drawer"
  | "collector-bridge"
  | "dvr-fab"
  | "debug-hud"
  | "version-gate"
  | "dash-token-gate"
  | "logon-banner"
  | "command-palette"
  | "shell";

export interface ChromeSurfaceDescriptor {
  id: ChromeSurfaceId;
  /** The exact JSX child the fence wraps (pinned by the Node gate). */
  mount: string;
  /** Where the child is mounted. */
  file: string;
  /** What the operator stops seeing while the surface is nulled. */
  lost: string;
}

export declare const CHROME_SUBJECT_PREFIX: "chrome:";
export declare const CHROME_BOUNDARY_SOURCE: "chrome-boundary";
export declare const CHROME_BOUNDARY_RETRY_MS: number;
export declare const CHROME_BOUNDARY_MAX_RETRIES: number;
export declare const CHROME_BOUNDARY_KIND: "chrome";
export declare const CHROME_SURFACES: readonly ChromeSurfaceDescriptor[];
export declare const CHROME_SURFACE_IDS: readonly ChromeSurfaceId[];

export declare function isChromeSurfaceId(value: unknown): value is ChromeSurfaceId;
export declare function chromeSurfaceById(id: unknown): ChromeSurfaceDescriptor | null;
export declare function chromeSubject(id: unknown): `chrome:${string}`;

export interface ChromeRetryDecision {
  retry: boolean;
  attempt: number;
  budget: number;
}

export declare function chromeRetryDecision(retriesSoFar: unknown): ChromeRetryDecision;

export interface ChromeBoundaryRowDetail {
  surface: string;
  message?: string;
  route?: string;
  count?: number;
  ts?: string;
}

export interface ChromeBoundaryCollectorRow {
  feature: string;
  action: "renderError";
  params: Record<string, unknown>;
  result: Record<string, unknown>;
  source: string;
  error?: string;
  verdict: { status: "fail"; reason: string; suggestedFix: string; relatedIssue: string };
}

export declare function chromeBoundaryCollectorRow(detail: ChromeBoundaryRowDetail): ChromeBoundaryCollectorRow;
