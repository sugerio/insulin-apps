/**
 * SHA-256 (FIPS 180-4) in plain TypeScript. WebCrypto is asynchronous, and the engine computes payload hashes, chain
 * links and replay hashes inside synchronous replays and dry runs, the same way in the browser and the Worker. Tests
 * check it against WebCrypto.
 */

// Int32Array, not Uint32Array: reads stay in int32 range, so V8 keeps the rounds in 32-bit integer arithmetic.
const K = new Int32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01,
  0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
  0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08,
  0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const ENCODER = new TextEncoder();
const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));
// Scratch space for the message schedule, reused: sha256 is synchronous and never re-entered.
const W = new Int32Array(64);

export function sha256(input: Uint8Array): Uint8Array {
  const length = input.length;
  // Message + 0x80 + zero padding + 64-bit big-endian bit length, rounded up to 64-byte blocks.
  const blocks = Math.ceil((length + 9) / 64);
  const p = new Uint8Array(blocks * 64);
  p.set(input);
  p[length] = 0x80;
  const bitLength = length * 8;
  const view = new DataView(p.buffer);
  view.setUint32(p.length - 8, Math.floor(bitLength / 0x100000000));
  view.setUint32(p.length - 4, bitLength >>> 0);

  const w = W;
  let h0 = 0x6a09e667 | 0;
  let h1 = 0xbb67ae85 | 0;
  let h2 = 0x3c6ef372 | 0;
  let h3 = 0xa54ff53a | 0;
  let h4 = 0x510e527f | 0;
  let h5 = 0x9b05688c | 0;
  let h6 = 0x1f83d9ab | 0;
  let h7 = 0x5be0cd19 | 0;
  // Every sum is truncated with `| 0` pairwise, so no intermediate leaves int32 (and the engine never needs doubles).
  for (let offset = 0; offset < p.length; offset += 64) {
    for (let i = 0, o = offset; i < 16; i++, o += 4) w[i] = (p[o]! << 24) | (p[o + 1]! << 16) | (p[o + 2]! << 8) | p[o + 3]!;
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15]!;
      const y = w[i - 2]!;
      const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
      const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
      w[i] = (((s1 + w[i - 7]!) | 0) + ((s0 + w[i - 16]!) | 0)) | 0;
    }
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;
    for (let i = 0; i < 64; i++) {
      const s1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (((s1 + ch) | 0) + ((h + ((K[i]! + w[i]!) | 0)) | 0)) | 0;
      const s0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (s0 + maj) | 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }
    h0 = (h0 + a) | 0;
    h1 = (h1 + b) | 0;
    h2 = (h2 + c) | 0;
    h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0;
    h5 = (h5 + f) | 0;
    h6 = (h6 + g) | 0;
    h7 = (h7 + h) | 0;
  }

  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  outView.setInt32(0, h0);
  outView.setInt32(4, h1);
  outView.setInt32(8, h2);
  outView.setInt32(12, h3);
  outView.setInt32(16, h4);
  outView.setInt32(20, h5);
  outView.setInt32(24, h6);
  outView.setInt32(28, h7);
  return out;
}

export function utf8(text: string): Uint8Array {
  return ENCODER.encode(text);
}

export function toHex(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) text += HEX[byte];
  return text;
}

/** Lowercase hex SHA-256 of a UTF-8 string or of bytes. */
export function sha256Hex(input: string | Uint8Array): string {
  return toHex(sha256(typeof input === "string" ? utf8(input) : input));
}
