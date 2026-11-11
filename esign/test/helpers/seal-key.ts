// A synthetic seal key, shaped as the Worker gets its ESIGN_SEAL_KEY binding: a non-extractable ECDSA P-256 private
// key that can only sign, with the entry seal/keys.ts would list for its public half.
import type { SealKey } from '../../src/app/server/esign/seal/keys.ts';

const P256 = { name: 'ECDSA', namedCurve: 'P-256' } as const;
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');
const hex = (bytes: ArrayBuffer) => Buffer.from(bytes).toString('hex');

export type TestSealKey = { privateKey: CryptoKey; spki: Uint8Array; entry: SealKey };

/** A fresh key in use since `from` (a minute ago by default), and until `until` when given. */
export async function makeSealKey({ from = Date.now() - 60_000, until }: { from?: number; until?: number } = {}): Promise<TestSealKey> {
  const pair = await crypto.subtle.generateKey(P256, true, ['sign', 'verify']);
  // Imported again as Cloudflare imports a secret_key: from PKCS #8, not extractable, sign only.
  const privateKey = await crypto.subtle.importKey('pkcs8', await crypto.subtle.exportKey('pkcs8', pair.privateKey), P256, false, ['sign']);
  const spki = new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey));
  const entry: SealKey = { id: hex(await crypto.subtle.digest('SHA-256', spki)), spki: b64(spki), from: new Date(from).toISOString(), ...(until === undefined ? {} : { until: new Date(until).toISOString() }) };
  return { privateKey, spki, entry };
}
