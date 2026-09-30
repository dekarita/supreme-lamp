// [F56-d §3] F46 per-run key encryption helper for own-cred modal.
// Client encrypts creds with WebCrypto AES-GCM using per-run key fetched from /api/config mirrorKey
// fallback generates ephemeral key, POSTs to /api/fetch with enc blob + key wipe, memory-only.

export interface EncryptedCred {
  userEnc: string; // base64 nonce(12)+tag(16)+ct
  passEnc: string;
  keyB64: string; // per-run key base64 (32B) - server decrypts in memory then wipes
  iv?: string; // legacy alias
}

function b64FromBytes(b: Uint8Array): string {
  let s = '';
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

async function getPerRunKey(): Promise<{ keyBytes: Uint8Array; keyB64: string }> {
  // Try fetch /api/config mirrorKey
  try {
    const token = (() => {
      try { return localStorage.getItem('ghrdp-dash-token') || '' } catch { return '' }
    })();
    const headers: Record<string, string> = {};
    if (token) headers['X-Dash-Token'] = token;
    const res = await fetch('/api/config', { headers });
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
