import { evidenceMessage } from './worker-kms-evidence.ts';
import { syntheticTimestampQuery } from './worker-tsa-transport.ts';
import { verifyRfc3161Candidate } from './worker-rfc3161-verifier.ts';

/**
 * The managed seal of a completed envelope: an ECDSA P-256 signature by a KMS key over the
 * evidence manifest (source, signature events, outputs; see local-test-evidence.ts), then an
 * RFC 3161 timestamp over that signature from an external TSA. Unlike the local HMAC test
 * seal, neither part can be recomputed, so a seal is made once, stored, and verified later
 * against the manifest rebuilt from the stored records.
 */

export type TsaTrust = { url: string; roots: Uint8Array[]; policies: string[]; signerSpkiSha256: string[]; missingAccuracyMs: number };
export type ManagedSeal = {
  format: 'esign-managed-seal-v1';
  manifest: string;
  signature: { algorithm: 'ECDSA_P256_SHA256'; keyArn: string; publicKey: string; publicKeySha256: string; value: string };
  timestamp: { tsaUrl: string; nonce: string; response: string; time: number };
};
export type Sealer = {
  keyArn: string;
  publicKeySpki: Uint8Array;
  /** Signs evidenceMessage(input) with the key and returns the 64-byte P1363 signature. */
  signEvidence(input: Uint8Array): Promise<Uint8Array>;
  tsa: TsaTrust;
  fetch: typeof fetch;
};
export type SealTrust = { publicKeySha256: string[]; tsa: TsaTrust };
export type VerifiedSeal = { keyArn: string; publicKeySha256: string; timestampTime: number; tsaUrl: string };

const MAX_TSA_RESPONSE = 65536;
const TSA_TIMEOUT_MS = 15000;
/** How far a fresh timestamp may be from this Worker's clock. */
const FRESH_WINDOW_MS = 5 * 60 * 1000;

const text = new TextEncoder();
const hex = (bytes: Uint8Array) => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
const unhex = (value: string) => Uint8Array.from(value.match(/../g) ?? [], b => parseInt(b, 16));
const b64 = (bytes: Uint8Array) => btoa(Array.from(bytes, b => String.fromCharCode(b)).join(''));
const unb64 = (value: string) => Uint8Array.from(atob(value), c => c.charCodeAt(0));
const sha256 = async (bytes: Uint8Array) => new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes)));

async function verifySignature(spki: Uint8Array, signature: Uint8Array, input: Uint8Array): Promise<boolean> {
  const key = await crypto.subtle.importKey('spki', Uint8Array.from(spki), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  return crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, Uint8Array.from(signature), Uint8Array.from(evidenceMessage(input)));
}

function tsaPolicy(tsa: TsaTrust, now: number) {
  return { roots: tsa.roots, now, maxAgeMs: FRESH_WINDOW_MS, maxFutureSkewMs: FRESH_WINDOW_MS, missingAccuracyMs: tsa.missingAccuracyMs,
    allowedPolicies: tsa.policies, allowedSignerSpkiSha256: tsa.signerSpkiSha256,
    // Revocation is not checked yet (no OCSP/CRL fetching in the Worker); stated on the certificate.
    checkRevocation: async () => true };
}

async function requestTimestamp(url: string, query: Uint8Array, fetcher: typeof fetch): Promise<Uint8Array> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TSA_TIMEOUT_MS);
  try {
    const response = await fetcher(new Request(url, { method: 'POST', headers: { 'content-type': 'application/timestamp-query', accept: 'application/timestamp-reply' }, body: Uint8Array.from(query), redirect: 'manual', signal: controller.signal }));
    if (response.status !== 200 || response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/timestamp-reply') throw new Error(`TSA response rejected (${response.status})`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length === 0 || bytes.length > MAX_TSA_RESPONSE) throw new Error('TSA response size rejected');
    return bytes;
  } finally { clearTimeout(timer); }
}

/** Signs and timestamps a manifest. Both parts are verified before the seal is returned. */
export async function sealManifest(manifest: string, sealer: Sealer, now: () => number = Date.now): Promise<ManagedSeal> {
  const input = text.encode(manifest);
  const signature = await sealer.signEvidence(input);
  if (signature.length !== 64 || !await verifySignature(sealer.publicKeySpki, signature, input)) throw new Error('KMS signature rejected');
  const nonce = crypto.getRandomValues(new Uint8Array(16)); nonce[0] = 1;
  const response = await requestTimestamp(sealer.tsa.url, syntheticTimestampQuery(await sha256(signature), nonce), sealer.fetch);
  const { time } = await verifyRfc3161Candidate(response, signature, nonce, tsaPolicy(sealer.tsa, now()));
  return {
    format: 'esign-managed-seal-v1',
    manifest,
    signature: { algorithm: 'ECDSA_P256_SHA256', keyArn: sealer.keyArn, publicKey: b64(sealer.publicKeySpki), publicKeySha256: hex(await sha256(sealer.publicKeySpki)), value: b64(signature) },
    timestamp: { tsaUrl: sealer.tsa.url, nonce: hex(nonce), response: b64(response), time },
  };
}

/**
 * Verifies a stored seal against the manifest rebuilt from the records: the same manifest, a
 * trusted key, a valid signature, and a valid timestamp over that signature, judged as of the
 * timestamp's own time (certificate validity is checked at that time).
 */
export async function verifyManagedSeal(seal: ManagedSeal, manifest: string, trust: SealTrust): Promise<VerifiedSeal> {
  if (!seal || seal.format !== 'esign-managed-seal-v1' || seal.manifest !== manifest || seal.signature?.algorithm !== 'ECDSA_P256_SHA256') throw new Error('Seal does not match the records');
  const spki = unb64(seal.signature.publicKey), signature = unb64(seal.signature.value), publicKeySha256 = hex(await sha256(spki));
  if (publicKeySha256 !== seal.signature.publicKeySha256 || !trust.publicKeySha256.includes(publicKeySha256)) throw new Error('Untrusted seal key');
  if (signature.length !== 64 || !await verifySignature(spki, signature, text.encode(manifest))) throw new Error('Invalid seal signature');
  if (seal.timestamp?.tsaUrl !== trust.tsa.url || !/^[0-9a-f]{32}$/.test(seal.timestamp.nonce) || !Number.isSafeInteger(seal.timestamp.time)) throw new Error('Invalid seal timestamp');
  const { time } = await verifyRfc3161Candidate(unb64(seal.timestamp.response), signature, unhex(seal.timestamp.nonce), tsaPolicy(trust.tsa, seal.timestamp.time));
  if (time !== seal.timestamp.time) throw new Error('Invalid seal timestamp');
  return { keyArn: seal.signature.keyArn, publicKeySha256, timestampTime: time, tsaUrl: seal.timestamp.tsaUrl };
}
