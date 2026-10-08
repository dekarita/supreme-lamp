// [F56-d §3] F46 per-run key encryption helper for own-cred modal.
// [M6] Upgraded to envelope encryption (Option C): client generates ephemeral AES-256 key,
// encrypts creds with it, then wraps the ephemeral key with the server's RSA-OAEP public key.
// The raw AES key NEVER leaves the client — only the RSA-wrapped envelope travels in the body.
// Fallback to legacy keyB64 path when server does not yet publish envelopePublicKey (phased rollout).

export interface EncryptedCred {
  userEnc: string; // base64 nonce(12)+tag(16)+ct
  passEnc: string;
  keyB64: string; // [M6] legacy field — only populated in fallback mode (no envelopePublicKey)
  iv?: string; // legacy alias
  /** [M6] RSA-OAEP-wrapped ephemeral AES key (base64). When present, the server must
   *  unwrap this with its private key instead of using keyB64 directly. */
  envelope?: string;
}

function b64FromBytes(b: Uint8Array): string {
  let s = ''
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s);
}

function bytesFromB64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function aesGcmEncrypt(plain: string, keyBytes: Uint8Array): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  // WebCrypto wants an ArrayBuffer-backed view (TS lib types a bare Uint8Array as
  // Uint8Array<ArrayBufferLike>). Copy the key bytes into a fresh ArrayBuffer for the
  // import only - process memory, wiped right after, never written to disk.
  const keyMaterial = new ArrayBuffer(keyBytes.byteLength);
  new Uint8Array(keyMaterial).set(keyBytes);
  const key = await crypto.subtle.importKey('raw', keyMaterial, { name: 'AES-GCM' }, false, ['encrypt']);
  const pt = new TextEncoder().encode(plain);
  const ctBuf = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, tagLength: 128 }, key, pt);
  try { new Uint8Array(keyMaterial).fill(0); } catch {}
  const ctBytes = new Uint8Array(ctBuf);
  // ctBuf contains ct + tag (16 bytes at end) in WebCrypto; we split tag for PowerShell format: nonce(12)+tag(16)+ct
  const tag = ctBytes.slice(ctBytes.length - 16);
  const ct = ctBytes.slice(0, ctBytes.length - 16);
  const blob = new Uint8Array(12 + 16 + ct.length);
  blob.set(iv, 0);
  blob.set(tag, 12);
  blob.set(ct, 28);
  return b64FromBytes(blob);
}

// [M6] Fetch the server's RSA-OAEP public key from /api/config alongside mirrorKey.
// Returns null if the server does not yet publish one (legacy / phased rollout).
async function fetchEnvelopePublicKey(): Promise<{ publicKeyB64: string; spkiBytes: Uint8Array } | null> {
  try {
    const res = await fetch('/api/config');
    if (res.ok) {
      const j = await res.json();
      const pk = j?.envelopePublicKey || j?.config?.envelopePublicKey || '';
      if (pk) {
        try {
          const spkiBytes = bytesFromB64(pk);
          // RSA-2048 SPKI is typically 294 bytes; RSA-4096 is 550. Accept 256-600 range.
          if (spkiBytes.length >= 256 && spkiBytes.length <= 600) {
            return { publicKeyB64: pk, spkiBytes };
          }
        } catch {}
      }
    }
  } catch {}
  return null;
}

// [M6] Wrap the ephemeral AES key with the server's RSA-OAEP public key.
// Uses RSA-OAEP with SHA-256 (matching the server's .NET RSAEncryptionPadding.OaepSHA256).
async function wrapKeyWithRsaOaep(ephemeralKey: Uint8Array, spkiBytes: Uint8Array): Promise<string> {
  const spkiBuf = new ArrayBuffer(spkiBytes.byteLength);
  new Uint8Array(spkiBuf).set(spkiBytes);
  const publicKey = await crypto.subtle.importKey(
    'spki',
    spkiBuf,
    { name: 'RSA-OAEP', hash: 'SHA-256' },
    false,
    ['encrypt']
  );
  const keyBuf = new ArrayBuffer(ephemeralKey.byteLength);
  new Uint8Array(keyBuf).set(ephemeralKey);
  const wrapped = await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, publicKey, keyBuf);
  // Wipe the key material copy
  try { new Uint8Array(keyBuf).fill(0); } catch {}
  return b64FromBytes(new Uint8Array(wrapped));
}

async function getPerRunKey(): Promise<{ keyBytes: Uint8Array; keyB64: string }> {
  // Try fetch /api/config mirrorKey
  try {
    // [M4] No dash token is sent on this request. The removed `ghrdp-dash-token` read was a
    // dead read (nothing writes that key), so this request has always gone out without one.
    // The canonical token is `ghrdp.dashToken`; sending it here is a separate decision (see
    // getDashToken() in src/api/fetch/index.ts).
    const res = await fetch('/api/config');
    if (res.ok) {
      const j = await res.json();
      const mk = j?.mirrorKey || j?.config?.mirrorKey || '';
      if (mk) {
        try {
          const kb = bytesFromB64(mk);
          if (kb.length === 32) return { keyBytes: kb, keyB64: mk };
        } catch {}
      }
    }
  } catch {}
  // Fallback ephemeral 32B key (lab)
  const rnd = crypto.getRandomValues(new Uint8Array(32));
  return { keyBytes: rnd, keyB64: b64FromBytes(rnd) };
}

export async function encryptOwnCreds(username: string, password: string): Promise<EncryptedCred> {
  // [M6] Envelope encryption path: generate ephemeral AES key, encrypt creds,
  // wrap the ephemeral key with server's RSA-OAEP public key. The raw key never
  // travels in the request body — only the RSA-wrapped envelope does.
  const envelopeKey = await fetchEnvelopePublicKey();
  if (envelopeKey) {
    // Ephemeral AES-256 key (never sent raw)
    const ephemeralKey = crypto.getRandomValues(new Uint8Array(32));
    const userEnc = await aesGcmEncrypt(username, ephemeralKey);
    const passEnc = await aesGcmEncrypt(password, ephemeralKey);
    // Wrap the ephemeral key with server's RSA-OAEP public key
    const envelope = await wrapKeyWithRsaOaep(ephemeralKey, envelopeKey.spkiBytes);
    // Wipe ephemeral key from memory (best effort)
    try { ephemeralKey.fill(0); } catch {}
    // Return with envelope; keyB64 is empty (the leak is fixed)
    return { userEnc, passEnc, keyB64: '', envelope };
  }

  // Legacy fallback: server does not publish envelopePublicKey yet.
  // This path will be removed once all servers are updated.
  const { keyBytes, keyB64 } = await getPerRunKey();
  const userEnc = await aesGcmEncrypt(username, keyBytes);
  const passEnc = await aesGcmEncrypt(password, keyBytes);
  // Wipe keyBytes from memory (best effort)
  try { keyBytes.fill(0) } catch {}
  return { userEnc, passEnc, keyB64, iv: keyB64 };
}

export function clearCredMemory(obj: { username?: string; password?: string }) {
  try {
    if (obj.username) obj.username = '';
    if (obj.password) obj.password = '';
  } catch {}
}

// Lab helper: plain base64 fallback (for tests without SubtleCrypto)
export function encryptOwnCredsPlainFallback(username: string, password: string, keyB64?: string): EncryptedCred {
  const uB64 = btoa(unescape(encodeURIComponent(username)));
  const pB64 = btoa(unescape(encodeURIComponent(password)));
  const kb = keyB64 || btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
  return { userEnc: 'plain:' + uB64, passEnc: 'plain:' + pB64, keyB64: kb, iv: kb };
}
