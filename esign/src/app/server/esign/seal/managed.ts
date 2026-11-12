import { evidenceMessage } from './signing.ts';
import { trustedSealKey, type SealKey } from './keys.ts';
import { timestampQuery, verifyRfc3161Timestamp } from './tsa.ts';
import { buildEvidenceManifest, commitSeal } from './evidence.ts';
import type { DeliveryEvidence } from '../delivery-pdf.ts';
import { AUDIT, auditTrail, recordAudit, type AuditEvent } from '../audit.ts';
import type { BlobStore } from '../blob-store.ts';

/**
 * The managed seal of a completed envelope: an ECDSA P-256 signature with the Worker's seal key
 * (keys.ts, config.ts) over the evidence manifest (source, signature events, outputs; see
 * evidence.ts), then an RFC 3161 timestamp over that signature from an external TSA. Unlike the
 * local HMAC test seal, neither part can be recomputed, so a seal is made once, stored, and verified later
 * against the manifest rebuilt from the stored records.
 */

export type TsaTrust = { url: string; roots: Uint8Array[]; policies: string[]; issuerSpkiSha256: string[]; missingAccuracyMs: number };
export type ManagedSeal = {
  format: 'esign-managed-seal-v2';
  manifest: string;
  /** keyId: the SHA-256 of publicKey (the SubjectPublicKeyInfo, base64), as in keys.ts. */
  signature: { algorithm: 'ECDSA_P256_SHA256'; keyId: string; publicKey: string; value: string };
  timestamp: { tsaUrl: string; nonce: string; response: string; time: number };
};
export type Sealer = {
  keyId: string;
  publicKeySpki: Uint8Array;
  /** Signs evidenceMessage(input) with the key and returns the 64-byte P1363 signature. */
  signEvidence(input: Uint8Array): Promise<Uint8Array>;
  tsa: TsaTrust;
  fetch: typeof fetch;
};
/** The trusted seal keys (keys.ts) and timestamp authority. */
export type SealTrust = { keys: readonly SealKey[]; tsa: TsaTrust };
export type VerifiedSeal = { keyId: string; timestampTime: number; tsaUrl: string };

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
    allowedPolicies: tsa.policies, allowedIssuerSpkiSha256: tsa.issuerSpkiSha256,
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
  const keyId = hex(await sha256(sealer.publicKeySpki));
  if (keyId !== sealer.keyId) throw new Error('Seal key mismatch');
  const input = text.encode(manifest);
  const signature = await sealer.signEvidence(input);
  if (signature.length !== 64 || !await verifySignature(sealer.publicKeySpki, signature, input)) throw new Error('Seal signature rejected');
  const nonce = crypto.getRandomValues(new Uint8Array(16)); nonce[0] = 1;
  const response = await requestTimestamp(sealer.tsa.url, timestampQuery(await sha256(signature), nonce), sealer.fetch);
  const { time } = await verifyRfc3161Timestamp(response, signature, nonce, tsaPolicy(sealer.tsa, now()));
  return {
    format: 'esign-managed-seal-v2',
    manifest,
    signature: { algorithm: 'ECDSA_P256_SHA256', keyId, publicKey: b64(sealer.publicKeySpki), value: b64(signature) },
    timestamp: { tsaUrl: sealer.tsa.url, nonce: hex(nonce), response: b64(response), time },
  };
}

/**
 * Verifies a stored seal against the manifest rebuilt from the records: the same manifest, a
 * valid signature, a valid timestamp over that signature, judged as of the timestamp's own time
 * (certificate validity is checked at that time), and a key trusted in keys.ts at that time.
 */
export async function verifyManagedSeal(seal: ManagedSeal, manifest: string, trust: SealTrust): Promise<VerifiedSeal> {
  if (!seal || seal.format !== 'esign-managed-seal-v2' || seal.manifest !== manifest || seal.signature?.algorithm !== 'ECDSA_P256_SHA256' || typeof seal.signature.publicKey !== 'string') throw new Error('Seal does not match the records');
  const spki = unb64(seal.signature.publicKey), signature = unb64(seal.signature.value), keyId = hex(await sha256(spki));
  if (keyId !== seal.signature.keyId || !trust.keys.some(key => key.spki === seal.signature.publicKey && key.id === keyId)) throw new Error('Untrusted seal key');
  if (signature.length !== 64 || !await verifySignature(spki, signature, text.encode(manifest))) throw new Error('Invalid seal signature');
  if (seal.timestamp?.tsaUrl !== trust.tsa.url || !/^[0-9a-f]{32}$/.test(seal.timestamp.nonce) || !Number.isSafeInteger(seal.timestamp.time)) throw new Error('Invalid seal timestamp');
  const { time } = await verifyRfc3161Timestamp(unb64(seal.timestamp.response), signature, unhex(seal.timestamp.nonce), tsaPolicy(trust.tsa, seal.timestamp.time));
  if (time !== seal.timestamp.time) throw new Error('Invalid seal timestamp');
  // Trusted only for seals timestamped while the key was in use: a retired key seals nothing new.
  if (!trustedSealKey(trust.keys, seal.signature.publicKey, time)) throw new Error('Seal key not in use at the timestamp');
  return { keyId, timestampTime: time, tsaUrl: seal.timestamp.tsaUrl };
}

// --- Sealing and verifying an envelope --------------------------------------------------------
/**
 * Completing an envelope with the managed seal (above). The seal is made once,
 * verified, stored in the object store and recorded in seals (mode KEY_TSA); a retry after a
 * failure reuses the stored seal rather than signing and timestamping again. Every read verifies
 * it against the evidence rebuilt from the records.
 */

export type ManagedEvidenceConfig = { sealer: Sealer; trust: SealTrust };

const bufferHex = (bytes: ArrayBuffer) => hex(new Uint8Array(bytes));
export const managedEvidenceKey = (envelopeId: string) => `envelopes/${envelopeId}/managed-evidence.json`;

/**
 * What is sealed: the evidence manifest and the audit trail recorded up to sealing. Seals made
 * before the audit trail existed covered the manifest alone, and are verified that way.
 */
const SEALED_FORMAT = 'esign-sealed-evidence-v2';
const sealedContent = (manifest: string, audit: AuditEvent[]) => JSON.stringify({ format: SEALED_FORMAT, manifest, audit });
function sealedAuditIds(content: string): number[] | null {
  try {
    const parsed = JSON.parse(content) as { format?: unknown; audit?: unknown };
    if (parsed?.format !== SEALED_FORMAT || !Array.isArray(parsed.audit)) return null;
    return parsed.audit.map(event => (event as { id: number }).id);
  } catch { return null; }
}

async function readStoredSeal(bucket: BlobStore, objectKey: string): Promise<{ seal: ManagedSeal; sha256: string } | null> {
  const object = await bucket.get(objectKey);
  if (!object) return null;
  const bytes = await object.arrayBuffer();
  return { seal: JSON.parse(new TextDecoder().decode(bytes)) as ManagedSeal, sha256: bufferHex(await crypto.subtle.digest('SHA-256', bytes)) };
}

/** Seals a FINALIZING envelope (or confirms an already completed one) and marks it COMPLETED. */
export async function finalizeManagedEvidence(db: D1Database, bucket: BlobStore, tenantId: string, envelopeId: string, config: ManagedEvidenceConfig): Promise<VerifiedSeal> {
  const built = await buildEvidenceManifest(db, bucket, tenantId, envelopeId);
  const objectKey = managedEvidenceKey(envelopeId);
  let stored = await readStoredSeal(bucket, objectKey);
  if (!stored) {
    const seal = await sealManifest(sealedContent(built.manifest, await auditTrail(db, envelopeId)), config.sealer);
    // Stored seals are never replaced, so one that wouldn't verify (a key keys.ts doesn't trust at
    // the timestamp's time) must never be stored: the envelope stays FINALIZING and is retried.
    await verifyManagedSeal(seal, seal.manifest, config.trust);
    const bytes = text.encode(JSON.stringify(seal));
    const put = await bucket.put(objectKey, bytes, { onlyIf: { etagDoesNotMatch: '*' }, httpMetadata: { contentType: 'application/json' } });
    // Losing a race to a concurrent attempt: keep the seal that was stored first.
    stored = put ? { seal, sha256: bufferHex(await crypto.subtle.digest('SHA-256', bytes)) } : await readStoredSeal(bucket, objectKey);
    if (!stored) throw new Error('Evidence conflict');
  }
  const verified = (await verifyStoredSeal(db, envelopeId, stored.seal, built.manifest, config.trust)).seal;
  const completed = await commitSeal(db, tenantId, envelopeId, { mode: 'KEY_TSA', objectKey, sha256: stored.sha256, keyId: verified.keyId, timestampTime: verified.timestampTime });
  if (completed) await recordAudit(db, { envelopeId, type: AUDIT.completed, detail: { seal: 'KEY_TSA', timestampTime: verified.timestampTime } });
  return verified;
}

/** Checks a stored seal against the records: the manifest, and the audit events it covered. */
async function verifyStoredSeal(db: D1Database, envelopeId: string, seal: ManagedSeal, manifest: string, trust: SealTrust): Promise<{ seal: VerifiedSeal; sealed: AuditEvent[]; afterSeal: AuditEvent[] }> {
  const trail = await auditTrail(db, envelopeId);
  const ids = sealedAuditIds(seal.manifest);
  if (!ids) return { seal: await verifyManagedSeal(seal, manifest, trust), sealed: [], afterSeal: trail };
  // The sealed events are those up to the last one sealed; any other event in that range was inserted.
  const last = ids.length ? ids[ids.length - 1] : 0;
  const sealed = trail.filter(event => event.id <= last), afterSeal = trail.filter(event => event.id > last);
  return { seal: await verifyManagedSeal(seal, sealedContent(manifest, sealed), trust), sealed, afterSeal };
}

/** The verified evidence of a completed envelope with a managed seal; throws if anything does not hold. */
export async function verifyManagedEvidence(db: D1Database, bucket: BlobStore, tenantId: string, envelopeId: string, trust: SealTrust) {
  const built = await buildEvidenceManifest(db, bucket, tenantId, envelopeId);
  const row = await db.prepare("SELECT object_key,sha256 FROM seals WHERE envelope_id=? AND mode='KEY_TSA'").bind(envelopeId).first<{ object_key: string; sha256: string }>();
  const stored = row && await readStoredSeal(bucket, row.object_key);
  if (!row || !stored || row.object_key !== managedEvidenceKey(envelopeId) || stored.sha256 !== row.sha256) throw new Error('Evidence integrity failure');
  const { seal, sealed, afterSeal } = await verifyStoredSeal(db, envelopeId, stored.seal, built.manifest, trust);
  return { source: built.source, signatures: built.signatures, identities: built.identities, finalArtifactId: built.finalArtifactId, finalSha256: built.finalSha256, seal, audit: { sealed, afterSeal } };
}

/** Whether an envelope was completed with the managed seal (and not the local test seal). */
export async function hasManagedEvidence(db: D1Database, envelopeId: string): Promise<boolean> {
  return !!await db.prepare("SELECT 1 FROM seals WHERE envelope_id=? AND mode='KEY_TSA'").bind(envelopeId).first();
}

/** The delivery PDF's evidence and certificate notes for a managed seal. */
export const managedDelivery = (db: D1Database, bucket: BlobStore, tenantId: string, envelopeId: string, trust: SealTrust): DeliveryEvidence => ({
  verify: () => verifyManagedEvidence(db, bucket, tenantId, envelopeId, trust),
  // The mark and notes are in every delivered PDF, which is rebuilt on each read and must match the
  // stored one byte for byte: they keep the name E-sign had, rather than renaming the file (delivery-v2).
  mark: 'Sealed by E-sign',
  notes: [
    'The signed PDF and its evidence (the original, each signing record and the events above) are signed with E-sign\'s seal key (ECDSA P-256) and timestamped by an RFC 3161 time-stamping authority. The seal covers the signed PDF, not these certificate pages.',
    'The full evidence, with every fingerprint and event, is on the certificate of completion in E-sign. Revocation of the time-stamping authority\'s certificate is not checked.',
  ],
  name: 'delivery-v2', format: 'esign-delivery-v2',
});
