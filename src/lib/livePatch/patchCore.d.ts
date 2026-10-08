// [F110] Hand-written types for the pure Live Patch core (patchCore.js) - the same
// convention as debugHudCore.d.ts / storageCore.d.ts: the .js is the shipping
// implementation the Node gate executes, this file is its typed face.
export type PatchVerdict = "applied" | "rejected" | "duplicate" | "ignored-not-patch" | "ignored-disarmed";
export type PatchOp = "toggle-off" | "toggle-on";
export type PatchAuditKind = "patch" | "rollback";

export declare const PATCH_FRAME_TYPE: "patch";
export declare const PATCH_CHANNEL_URL: "/ws";
export declare const PATCH_MAC_DOMAIN: "ghrdp-patch-v1";
export declare const PATCH_SCHEMA_VERSION: 1;
export declare const PATCH_FIELD_ORDER: string[];
export declare const PATCH_SIGNED_FIELDS: string[];
export declare const PATCH_OPS: PatchOp[];
export declare const PATCH_MAC_KEY_MIN: number;
export declare const PATCH_SIG_DISPLAY_CHARS: number;
export declare const PATCH_AUDIT_MAX_ROWS: number;
export declare const PATCH_AUDIT_DB: "ghrdp-patches";
export declare const PATCH_AUDIT_DB_VERSION: number;
export declare const PATCH_AUDIT_STORE: "audit";
export declare const PATCH_ARM_KEY: "f110:armed";
export declare const PATCH_MAX_AGE_MS: number;
export declare const PATCH_MAX_SKEW_MS: number;
export declare const PATCH_VERDICTS: PatchVerdict[];
export declare const PATCH_REJECT_REASONS: string[];

export interface PatchMessage {
  v: number;
  type: string;
  id: string;
  op: PatchOp;
  feature: string;
  ts: number;
  exp: number;
  sig: string;
}

export interface PatchAuditRow {
  seq?: number;
  kind: PatchAuditKind;
  id: string;
  op: string;
  feature: string;
  verdict: PatchVerdict | "";
  reason: string;
  /** the sender's own clock (frame `ts`), epoch ms; 0 when the frame never parsed */
  sentAt: number;
  /** this client's clock, ISO; "" when unavailable */
  seenAt: string;
  /** the first PATCH_SIG_DISPLAY_CHARS of the MAC - never the whole authenticator */
  sig8: string;
  /** the toggle state THIS CLIENT had before this patch applied */
  prev: "off" | "on" | "";
}

export interface PatchVerifyResult {
  ok: boolean;
  reason: string;
  msg?: PatchMessage;
}

export interface PatchDecision {
  verdict: PatchVerdict;
  reason: string;
  row: PatchAuditRow;
  msg?: PatchMessage;
}

export interface PatchRollbackStep {
  feature: string;
  off: boolean;
}

export interface PatchAuditSummary {
  applied: number;
  rejected: number;
  duplicate: number;
  ignored: number;
  total: number;
  lastSeenAt: string;
}

export declare function parseArmed(raw: unknown): boolean;
export declare function isPatchFrame(obj: unknown): boolean;
export declare function canonicalPatch(msg: Partial<PatchMessage> | null | undefined): string;
export declare function verifyPatchFrame(
  obj: unknown,
  opts?: { now?: number; knownFeatures?: readonly string[] }
): PatchVerifyResult;
export declare function verifyPatchSignature(msg: Partial<PatchMessage> | null | undefined, macHex: unknown): { ok: boolean; reason: string };
export declare function redactSignature(sig: unknown): string;
export declare function buildAuditRow(
  msg: Partial<PatchMessage> | null | undefined,
  verdict: string,
  reason: string,
  opts?: { now?: number; prev?: string }
): PatchAuditRow;
export declare function buildRollbackRow(count: number, opts?: { now?: number }): PatchAuditRow;
export declare function decidePatch(input: {
  frame: unknown;
  now: number;
  knownFeatures: readonly string[];
  secretLength: number;
  macHex?: string;
  appliedIds?: string[];
  prev?: string;
}): PatchDecision;
export declare function trimAuditRows(rows: PatchAuditRow[] | null | undefined, max?: number): PatchAuditRow[];
export declare function appliedPatchIds(rows: PatchAuditRow[] | null | undefined): string[];
export declare function rollbackPlan(rows: PatchAuditRow[] | null | undefined): PatchRollbackStep[];
export declare function summarizeAudit(rows: PatchAuditRow[] | null | undefined): PatchAuditSummary;
export declare function toggleSurfaceActive(hudEnabled: unknown, patchArmed: unknown): boolean;
