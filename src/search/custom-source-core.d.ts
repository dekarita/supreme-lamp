// [F58] Type surface for the plain-JS rule core (custom-source-core.js). The
// implementation is JS by design (the Node lab executes it directly in a vm), so
// the types live here and are the only TS-facing shape of the rules.
export interface QueryTemplate {
  method: "GET" | "POST";
  path: string;
  query?: Record<string, string>;
  placeholders: { encodedQuery: string; cursor: string; limit: string };
  [k: string]: unknown;
}

export interface SourceDescriptor {
  schemaVersion: string | number;
  id: string;
  nameKey: string;
  category: string;
  baseUrl: string;
  allowedDomains: string[];
  queryTemplate: QueryTemplate;
  licenceTag: string | { perResult: true; allowedTags?: string[] };
  licenceEvidence: { required: true; [k: string]: unknown };
  robotsCheck: { policy: string; onDisallow: "deny"; [k: string]: unknown };
  rateLimit: { requestsPerMinute: number; burst: number; concurrency: number; retryAfter: string | object; backoff: string | object; [k: string]: unknown };
  timeout: { connect: number; request: number };
  parseContract: { format: string; resultSelector: string; fieldMappings: Record<string, string>; pagination: string | object; normalizers?: string | unknown[] | Record<string, unknown> };
  downloadContract: { artifactFields: string[]; previewFields?: string[]; purchaseFields?: string[]; contentLengthRequired: true };
  transportModes: string[];
  redirectPolicy: { requireHttps: true; requireAllowlisted: true };
  [k: string]: unknown;
}

export interface SourceExtension {
  addedAt: string;
  source: string;
  enableState: "permanent" | "paused";
  /** [F78 §1.1] Lab Mode shortcut flag. Absent means true (lab-only source). */
  labMode?: boolean;
  /** [F78 §1.1] Auto-derived from baseUrl at save time (never operator-typed). */
  hostname?: string;
  [k: string]: unknown;
}

export interface ProvenanceRecord {
  fileName?: string | null;
  byteSize?: number | null;
  publisher?: string | null;
  sha256?: string | null;
  signatureStatus?: string | null;
  releasePageUrl?: string | null;
  [k: string]: unknown;
}

export interface ProvenanceVerdict {
  applies: boolean;
  fetchEnabled: boolean;
  missing: string[];
  reason: string | null;
}

export interface ValidationResult {
  ok: boolean;
  coreErrors: string[];
  extensionErrors: string[];
  errors: string[];
}

export interface PresetDef {
  presetId: string;
  formCategory: string;
  displayName: string;
  scope: string;
  baseUrl: string;
  allowedDomains: string[];
  queryTemplate: QueryTemplate;
  licenceTag: SourceDescriptor["licenceTag"];
}

export interface InstantiateResult {
  ok: boolean;
  errors: string[];
  draft: SourceDescriptor | null;
  extension?: SourceExtension;
  scope?: string;
  pinnedAllowlist?: string[];
  requireAllowlisted?: boolean;
}

export interface FanOutPlan {
  cap: number;
  selected: string[];
  dropped: string[];
}

/** [F78 §1.1] Normalized extension view: labMode always boolean, hostname
 *  always a lowercase DNS host (possibly "" when baseUrl is unusable). */
export interface NormalizedExtension {
  addedAt?: string;
  source?: string;
  enableState?: "permanent" | "paused";
  labMode: boolean;
  hostname: string;
  [k: string]: unknown;
}

export interface RedirectVerdict {
  ok: boolean;
  reason?: string;
  host?: string;
}

declare const F58: {
  F56_REQUIRED: string[];
  F58_REQUIRED: string[];
  CATEGORIES: string[];
  LICENCE_TAGS: string[];
  TRANSPORT_MODES: string[];
  ENABLE_STATES: string[];
  SOURCE_CATEGORIES: string[];
  CATEGORY_TO_F56: Record<string, string>;
  HARD: { concurrency: number; requestsPerMinute: number; burst: number; requestTimeoutSec: number; connectTimeoutSec: number; overridable: boolean };
  FAN_OUT_CAP: number;
  EXEC_EXTENSIONS: string[];
  PROVENANCE_FIELDS: string[];
  PRESETS: Record<string, PresetDef>;
  isExecutableName(name: string): boolean;
  validate(descriptor: unknown, extension: unknown): ValidationResult;
  validateCore(descriptor: unknown): string[];
  validateExtension(extension: unknown): string[];
  enforceRateLimit(descriptor: SourceDescriptor): { value: SourceDescriptor; violations: string[]; overridable: boolean };
  redirectAllowed(descriptor: SourceDescriptor | null, targetUrl: string): RedirectVerdict;
  domainAllowed(host: string, list: string[]): boolean;
  allowedHosts(descriptor: SourceDescriptor | null): string[];
  hostOf(url: string): string | null;
  evaluateProvenance(fileName: string, record: ProvenanceRecord | null): ProvenanceVerdict;
  planFanOut(entries: unknown[]): FanOutPlan;
  presetIds(): string[];
  instantiate(presetId: string, opts: Record<string, unknown>): InstantiateResult;
  /** [F78 §1.1] Hostname derived from a baseUrl ("" when unusable). */
  hostnameFor(baseUrl: unknown): string;
  /** [F78 §1.1] labMode default true; hostname lowercased ("" when absent). */
  normalizeExtension(extension: unknown): NormalizedExtension;
  /** [F78 §1.1] Save-time shape: derives hostname from baseUrl when absent. */
  withHostname(baseUrl: unknown, extension: unknown): NormalizedExtension;
  /** [F78 §1.1] The labMode!==false subset of a registry list. */
  labSources(list: unknown): unknown[];
};

export default F58;
