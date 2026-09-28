/** SHA-1 identity (not authentication): shared root + POSIX path input.
 * S4 server must use UTF-8 SHA1(root + path), lowercase hex, identically.
 * Synchronous so legacy migration remains usable without a secure context.
 */
export function computeId(root: string, path: string): string {
  const input = new TextEncoder().encode(root + path);
  const length = Math.ceil((input.length + 9) / 64) * 64;
  const buffer = new Uint8Array(length);
  buffer.set(input);
  buffer[input.length] = 128;
  const view = new DataView(buffer.buffer);
  const bits = input.length * 8;
  view.setUint32(length - 8, Math.floor(bits / 4294967296));
  view.setUint32(length - 4, bits >>> 0);
  const h = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0];
  const w = new Int32Array(80);
  const rol = (n: number, shift: number) => (n << shift) | (n >>> (32 - shift));
  for (let offset = 0; offset < length; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getInt32(offset + i * 4);
    for (let i = 16; i < 80; i++) w[i] = rol(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
    let [a, b, c, d, e] = h;
    for (let i = 0; i < 80; i++) {
      const f = i < 20 ? (b & c) | (~b & d) : i < 40 ? b ^ c ^ d : i < 60 ? (b & c) | (b & d) | (c & d) : b ^ c ^ d;
      const k = i < 20 ? 0x5a827999 : i < 40 ? 0x6ed9eba1 : i < 60 ? 0x8f1bbcdc : 0xca62c1d6;
      const next = (rol(a, 5) + f + e + k + w[i]) | 0;
      e = d; d = c; c = rol(b, 30); b = a; a = next;
    }
    for (const [i, value] of [a, b, c, d, e].entries()) h[i] = (h[i] + value) | 0;
  }
  return h.map((value) => (value >>> 0).toString(16).padStart(8, '0')).join('');
}
