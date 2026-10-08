// [F110b] Hand-written types for the pure Ed25519 signature core (signatureCore.js) -
// the same convention as patchCore.d.ts: the .js is the shipping implementation the
// Node gate executes, this file is its typed face.
export type PatchSigScheme = "hmac-v1" | "ed25519" | "unknown";
export type SignatureGateAction = "v1" | "v2" | "refuse";

export declare const PATCH_SIG_ALG: "ed25519";
export declare const PATCH_SIG_ALG_FIELD: "sigAlg";
export declare const PATCH_SCHEMA_VERSION_V2: 2;
export declare const PATCH_SIG_DOMAIN_V2: "ghrdp-patch-v2";
export declare const PATCH_V2_FIELD_ORDER: string[];
export declare const PATCH_V2_SIGNED_FIELDS: string[];
export declare const PATCH_ED25519_PUBLIC_KEY_BYTES: 32;
export declare const PATCH_ED25519_SIGNATURE_BYTES: 64;
export declare const PATCH_ED25519_PUBLIC_KEY_B64_LEN: 44;
export declare const PATCH_ED25519_SIGNATURE_B64_LEN: 88;
export declare const PATCH_V2_MAX_AGE_MS: number;
export declare const PATCH_V2_MAX_SKEW_MS: number;
export declare const PATCH_SIG_SCHEMES: PatchSigScheme[];
export declare const SIGNER_PIN_REASONS: string[];
export declare const PATCH_V2_ONLY_REJECT_REASONS: string[];

export interface PatchMessageV2 {
  v: number;
  sigAlg: string;
  type: string;
  id: string;
  op: "toggle-off" | "toggle-on";
  feature: string;
  ts: number;
  exp: number;
  sig: string;
}

export interface SignatureGate {
  action: SignatureGateAction;
  scheme: PatchSigScheme;
  reason: string;
}

export interface VerifyResult {
  ok: boolean;
  reason: string;
  msg?: object;
}

export interface ByteResult {
  ok: boolean;
  reason: string;
  bytes: number[] | null;
}

export interface PinResult {
  ok: boolean;
  reason: string;
  b64: string;
}

export interface SignatureVerdict {
  verdict: string;
  reason: string;
  msg?: object;
}

export declare function isV2PatchFrame(obj: unknown): boolean;
export declare function frameSignatureScheme(obj: unknown): PatchSigScheme;
export declare function base64ToBytes(b64: unknown): ByteResult;
export declare function bytesToBase64(bytes: number[] | ArrayLike<number>): string;
export declare function parsePinnedPublicKey(raw: unknown): PinResult;
export declare function pinFingerprint(b64: unknown): string;
export declare function canonicalPatchV2(msg: object | null | undefined): string;
export declare function verifyPatchV2Frame(obj: unknown, opts?: { now?: number; knownFeatures?: readonly string[] | string[] }): VerifyResult;
export declare function signatureGate(input: { frame: unknown; pinOk: boolean }): SignatureGate;
export declare function decidePatchV2(input: {
  frame: unknown;
  now: number;
  knownFeatures?: readonly string[] | string[];
  pinOk: boolean;
  sigVerified?: { ok: boolean; reason: string } | null;
  appliedIds?: string[];
}): SignatureVerdict;
