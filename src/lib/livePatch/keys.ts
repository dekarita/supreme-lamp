// [F110b / maintenance step M1] keys.ts - the signer pin, and nothing else.
//
// THE PIN IS EMPTY IN THIS BUILD, and that is the shipped state, not a TODO. A
// public key is only a trust anchor if it matches a private key somebody actually
// holds; inventing one here would produce a dashboard that "verifies Ed25519"
// against a key that can sign nothing, which is worse than not having the path at
// all. So the pin ships blank and every Ed25519 frame is refused with
// `no-signer-pin` until the operator supplies one (docs/F110B-SIGNING.md).
//
// THREE sources, in this order, and a conflict refuses rather than picks a winner:
//   1. the test seam (setSignerPinOverride) - tests only, and it is assertable;
//   2. PATCH_PUBLIC_KEY_B64 below - the committed pin, if the operator prefers a
//      code change over a build variable;
//   3. import.meta.env.VITE_PATCH_PUBLIC_KEY - build-time injection, which is how a
//      pinned key reaches a CI-built bundle without editing source.
// There is deliberately NO fourth source: not localStorage, not a query string, not
// a fetched document. A pin that can be changed by the thing it is authenticating
// is not a pin - and adding a storage key here would also move F111's derived
// storage inventory (25 keys) for no benefit.
import { PATCH_ED25519_PUBLIC_KEY_B64_LEN, parsePinnedPublicKey, pinFingerprint } from "./signatureCore";

/** The operator-committed pin. Empty = fail closed. 44 chars of standard base64 when set. */
export const PATCH_PUBLIC_KEY_B64 = "";

/** Build-time injection (`VITE_PATCH_PUBLIC_KEY=… vite build`). Public key material, so not a secret. */
function buildEnvPin(): string {
  try {
    const env = import.meta.env as Record<string, unknown> | undefined;
    const v = env && typeof env.VITE_PATCH_PUBLIC_KEY === "string" ? env.VITE_PATCH_PUBLIC_KEY : "";
    return v.trim();
  } catch {
    return "";
  }
}

let pinOverride: string | null = null;

/**
 * Test seam, mirroring setPatchMacProvider: the DOM gate must be able to prove the
 * pinned half of the matrix without a rebuild. `null` restores the shipped sources.
 */
export function setSignerPinOverride(b64: string | null): void {
  pinOverride = typeof b64 === "string" ? b64 : null;
}

export function isSignerPinDefault(): boolean {
  return pinOverride === null;
}

export interface SignerPin {
  ok: boolean;
  reason: string;
  b64: string;
}

/** Resolve + validate the pin. Total: an invalid pin is `ok:false`, never a throw. */
export function resolveSignerPin(): SignerPin {
  const override = pinOverride === null ? "" : pinOverride.trim();
  const committed = PATCH_PUBLIC_KEY_B64.trim();
  const fromEnv = pinOverride === null ? buildEnvPin() : "";
  // Two non-empty sources that disagree is an operator mistake, and guessing which
  // one they meant is how a revoked key keeps verifying. Refuse instead.
  const present = [override, committed, fromEnv].filter((s) => s.length > 0);
  const distinct: string[] = [];
  for (const p of present) if (distinct.indexOf(p) < 0) distinct.push(p);
  if (distinct.length > 1) return { ok: false, reason: "pin-conflict", b64: "" };
  const candidate = distinct.length === 1 ? distinct[0] : "";
  const parsed = parsePinnedPublicKey(candidate);
  return parsed.ok ? { ok: true, reason: "", b64: parsed.b64 } : { ok: false, reason: parsed.reason, b64: "" };
}

export interface SignerPinStatus {
  pinned: boolean;
  reason: string;
  fingerprint: string;
  expectedChars: number;
}

/** What the Settings card shows: pinned or not, why not, and which key if so. */
export function signerPinStatus(): SignerPinStatus {
  const pin = resolveSignerPin();
  return {
    pinned: pin.ok,
    reason: pin.ok ? "" : pin.reason,
    fingerprint: pin.ok ? pinFingerprint(pin.b64) : "",
    expectedChars: PATCH_ED25519_PUBLIC_KEY_B64_LEN,
  };
}
