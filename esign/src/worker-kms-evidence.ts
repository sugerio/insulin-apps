/**
 * The KMS half of the managed seal (managed-seal.ts, seal-config.ts): the exact message the seal
 * signs and the call that has KMS sign its digest, checked against the pinned public key.
 */
// The domain separator is part of every stored seal's signed message. Its text predates the
// managed seal and is kept as is, because changing it would break verification of existing seals.
const DOMAIN = new TextEncoder().encode('esign-worker-evidence-candidate-v1\0');
const MAX_INPUT_BYTES = 1024 * 1024;
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const typedArrayBuffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer')!.get!;
const typedArrayLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'length')!.get!;
const isUnsharedBytes = (value: unknown): value is Uint8Array =>
  value instanceof Uint8Array && typedArrayBuffer.call(value) instanceof ArrayBuffer;

/** The exact bytes an evidence signature covers: the domain separator, then the input. */
export function evidenceMessage(input: Uint8Array): Uint8Array {
  const message = new Uint8Array(DOMAIN.length + input.length);
  message.set(DOMAIN);
  message.set(input, DOMAIN.length);
  return message;
}

/** Provider signs a SHA-256 digest with ECDSA P-256 and returns IEEE P1363 r||s (64 bytes), not DER. */
export interface KmsDigestProvider {
  signDigest(digest: Uint8Array): Promise<Uint8Array>;
}

/**
 * Has `provider` (aws-kms-sign-provider.ts) sign evidenceMessage(input) and returns the signature
 * only once it verifies against `pinnedSpki`, the configured public key (KMS_PUBLIC_KEY). Inputs
 * are copied first, so a caller cannot change them while the signature is pending.
 */
export async function signKmsEvidence(input: Uint8Array, pinnedSpki: Uint8Array, provider: KmsDigestProvider): Promise<{ signature: Uint8Array }> {
  if (!isUnsharedBytes(input) || !isUnsharedBytes(pinnedSpki) || !provider || typeof provider.signDigest !== 'function') throw new Error('Invalid KMS signing input');
  const inputLength = typedArrayLength.call(input) as number;
  const spkiLength = typedArrayLength.call(pinnedSpki) as number;
  if (inputLength === 0 || inputLength > MAX_INPUT_BYTES || spkiLength === 0 || spkiLength > 1024) throw new Error('Invalid KMS signing input');
  const message = new Uint8Array(DOMAIN.length + inputLength);
  message.set(DOMAIN);
  message.set(input, DOMAIN.length);
  const spki = new Uint8Array(pinnedSpki);
  try {
    const key = await crypto.subtle.importKey('spki', spki, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', message));
    const returned = await provider.signDigest(digest);
    if (!isUnsharedBytes(returned) || typedArrayLength.call(returned) !== 64) throw new Error();
    const signature = new Uint8Array(returned);
    if (!await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, signature, message)) throw new Error();
    return { signature };
  } catch {
    throw new Error('KMS signing failed');
  }
}
