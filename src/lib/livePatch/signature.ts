// [F110b / maintenance step M1] signature.ts - the browser half of the Ed25519
// verifier: WebCrypto in, `{ok, reason}` out, and a swappable provider so a gate can
// prove the chain with a second implementation (the same seam convention as F110a's
// setPatchMacProvider / F107's setShotRasterizer).
//
// FAIL CLOSED, THREE WAYS. A missing `crypto.subtle`, a thrown import, and a thrown
// verify all answer `{ok:false}` - never `ok:true`, never a throw that could break
// the socket handler that called us. That matters more than it looks, because of a
// fact measured in this very sandbox: on Node v22.22.3 (and therefore in jsdom)
// `crypto.subtle.sign({name:"Ed25519"})` reproduces RFC 8032 test vector 1
// byte-for-byte, while `crypto.subtle.verify({name:"Ed25519"})` returns **false for
// that same published, valid signature** (node:crypto's verify returns true for it).
// A runtime whose verify is broken must refuse patches, and with this shape it does:
// the refusal surfaces in the audit log as `sig-crypto-unavailable`, which is a
// support gap, not an attack - and tests/f110b-signing.test.js measures the
// environment each run so the claim cannot age silently.
//
// Browser support for Ed25519 in WebCrypto is NOT verified from this sandbox (no
// Chromium here - the standing fact since Observatory step 4). The honest statement
// is: verify support is recent and uneven, so the pinned path must stay optional and
// fail closed, and the operator's own browser is where it gets confirmed.
import { base64ToBytes, bytesToBase64, canonicalPatchV2, PATCH_ED25519_SIGNATURE_BYTES } from "./signatureCore";

export interface SignatureCheck {
  ok: boolean;
  reason: string;
}

export interface SignResult {
  ok: boolean;
  reason: string;
  value?: string;
}

/** Verify `canonical` against a base64 Ed25519 signature and a base64 public key. */
export type SignatureVerifyProvider = (canonical: string, sigB64: string, pubB64: string) => Promise<SignatureCheck>;

/** Standard-alphabet base64 -> bytes, via the core's decoder (no host API, one implementation). */
function b64Bytes(b64: string): Uint8Array | null {
  const dec = base64ToBytes(b64);
  if (!dec.ok || !dec.bytes) return null;
  const out = new Uint8Array(dec.bytes.length);
  for (let i = 0; i < dec.bytes.length; i += 1) out[i] = dec.bytes[i] & 0xff;
  return out;
}

const ED25519 = { name: "Ed25519" } as unknown as Algorithm;

/** WebCrypto Ed25519 verify. Total: `{ok:false}` on every failure mode. */
export async function webCryptoVerifyEd25519(canonical: string, sigB64: string, pubB64: string): Promise<SignatureCheck> {
  try {
    if (typeof crypto === "undefined" || !crypto.subtle) return { ok: false, reason: "crypto-unavailable" };
    if (typeof canonical !== "string" || canonical.length === 0) return { ok: false, reason: "bad-signature" };
    const sig = b64Bytes(sigB64);
    const pub = b64Bytes(pubB64);
    if (!sig || sig.byteLength !== PATCH_ED25519_SIGNATURE_BYTES || !pub) return { ok: false, reason: "bad-signature" };
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey("raw", pub as unknown as BufferSource, ED25519, false, ["verify"]);
    const ok = await crypto.subtle.verify(ED25519, key, enc.encode(canonical), sig as unknown as BufferSource);
    return ok === true ? { ok: true, reason: "" } : { ok: false, reason: "bad-signature" };
  } catch {
    // an unsupported algorithm throws NotSupportedError in some engines and returns
    // false in others; both are "this runtime cannot prove this frame".
    return { ok: false, reason: "crypto-unavailable" };
  }
}

let signatureProvider: SignatureVerifyProvider | null = null;

/** Inject a verifier (tests, or a host without Ed25519). Null restores the shipped one. */
export function setPatchSignatureProvider(fn: SignatureVerifyProvider | null): void {
  signatureProvider = typeof fn === "function" ? fn : null;
}

export function isDefaultSignatureProviderActive(): boolean {
  return signatureProvider === null;
}

export async function verifyPatchSignatureEd25519(canonical: string, sigB64: string, pubB64: string): Promise<SignatureCheck> {
  if (signatureProvider) {
    try {
      const res = await signatureProvider(canonical, sigB64, pubB64);
      return res && res.ok === true ? { ok: true, reason: "" } : { ok: false, reason: res && res.reason ? res.reason : "bad-signature" };
    } catch {
      return { ok: false, reason: "provider-failed" };
    }
  }
  return webCryptoVerifyEd25519(canonical, sigB64, pubB64);
}

/**
 * Sign a v2 frame - the OPERATOR/FIXTURE side, kept here so the signer and the
 * verifier cannot disagree about the bytes (both call canonicalPatchV2).
 *
 * The private key is a caller argument and nothing else: it is never read from
 * storage, never fetched, never derived from the dash token, and this file has no
 * key of its own. In production the operator signs off-box with
 * scripts/f110b-sign-patch.mjs; this function exists so a gate can prove the whole
 * chain (sign -> wire -> verify -> apply) and so a dev fixture can be produced in a
 * browser console without a second implementation drifting from the verifier.
 */
export async function signPatchFrameEd25519(frame: Record<string, unknown>, privateKeyPkcs8B64: string): Promise<SignResult> {
  try {
    if (typeof crypto === "undefined" || !crypto.subtle) return { ok: false, reason: "crypto-unavailable" };
    const keyBytes = b64Bytes(privateKeyPkcs8B64);
    if (!keyBytes) return { ok: false, reason: "no-signing-key" };
    const canonical = canonicalPatchV2(frame as never);
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey("pkcs8", keyBytes as unknown as BufferSource, ED25519, false, ["sign"]);
    const sig = await crypto.subtle.sign(ED25519, key, enc.encode(canonical));
    const sigB64 = bytesToBase64(Array.from(new Uint8Array(sig)));
    return {
      ok: true,
      reason: "",
      value: JSON.stringify(Object.assign({}, frame, { sig: sigB64 })),
    };
  } catch {
    return { ok: false, reason: "no-signing-key" };
  }
}
