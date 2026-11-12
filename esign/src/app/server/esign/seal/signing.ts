/**
 * The signature half of the managed seal (managed.ts, config.ts): the exact message the seal
 * signs, and signing it with the Worker's seal key, checked against that key's public half.
 */

// The domain separator is part of every seal's signed message. Its text predates the managed
// seal and is kept as is.
const DOMAIN = new TextEncoder().encode('esign-worker-evidence-candidate-v1\0');
const MAX_INPUT_BYTES = 1024 * 1024;
const ECDSA_P256 = { name: 'ECDSA', namedCurve: 'P-256' } as const;
const ECDSA_SHA256 = { name: 'ECDSA', hash: 'SHA-256' } as const;

/** The exact bytes an evidence signature covers: the domain separator, then the input. */
export function evidenceMessage(input: Uint8Array): Uint8Array<ArrayBuffer> {
  const message = new Uint8Array(DOMAIN.length + input.length);
  message.set(DOMAIN);
  message.set(input, DOMAIN.length);
  return message;
}

/**
 * Whether `value` is a seal key as the Worker must hold it: a private ECDSA P-256 key that can
 * sign and can't be exported, which is how a Cloudflare `secret_key` binding imported with those
 * settings reaches the Worker.
 */
export function isSealSigningKey(value: unknown): value is CryptoKey {
  if (typeof CryptoKey === 'undefined' || !(value instanceof CryptoKey)) return false;
  const algorithm = value.algorithm as { name?: string; namedCurve?: string };
  return value.type === 'private' && !value.extractable && algorithm.name === 'ECDSA' && algorithm.namedCurve === 'P-256' && value.usages.includes('sign');
}

/**
 * Signs evidenceMessage(input) with `key` and returns the 64-byte (P1363) signature, only once it
 * verifies against `spki`, the public key the seal names. A private key that isn't that public
 * key's pair is refused here, before anything is stored.
 */
export async function signEvidence(input: Uint8Array, spki: Uint8Array, key: CryptoKey): Promise<Uint8Array> {
  if (!(input instanceof Uint8Array) || input.length === 0 || input.length > MAX_INPUT_BYTES) throw new Error('Invalid seal signing input');
  const message = evidenceMessage(Uint8Array.from(input));
  try {
    const publicKey = await crypto.subtle.importKey('spki', Uint8Array.from(spki), ECDSA_P256, false, ['verify']);
    const signature = new Uint8Array(await crypto.subtle.sign(ECDSA_SHA256, key, message));
    if (signature.length !== 64 || !await crypto.subtle.verify(ECDSA_SHA256, publicKey, signature, message)) throw new Error();
    return signature;
  } catch {
    throw new Error('Seal signing failed');
  }
}
