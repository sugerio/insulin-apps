import { buildEvidenceManifest, commitSeal } from './local-test-evidence.ts';
import { sealManifest, verifyManagedSeal, type ManagedSeal, type Sealer, type SealTrust, type VerifiedSeal } from './managed-seal.ts';
import type { DeliveryEvidence } from './delivery-pdf.ts';
import { AUDIT, auditTrail, recordAudit, type AuditEvent } from './audit.ts';

/**
 * Completing an envelope with the managed seal (managed-seal.ts). The seal is made once,
 * stored in R2 and recorded in seals (mode KMS_TSA); a retry after a failure reuses the stored
 * seal rather than signing and timestamping again. Every read verifies it against the
 * evidence rebuilt from the records.
 */

export type ManagedEvidenceConfig = { sealer: Sealer; trust: SealTrust };

const text = new TextEncoder();
const hex = (bytes: ArrayBuffer) => Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
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

async function readStoredSeal(bucket: R2Bucket, objectKey: string): Promise<{ seal: ManagedSeal; sha256: string } | null> {
  const object = await bucket.get(objectKey);
  if (!object) return null;
  const bytes = await object.arrayBuffer();
  return { seal: JSON.parse(new TextDecoder().decode(bytes)) as ManagedSeal, sha256: hex(await crypto.subtle.digest('SHA-256', bytes)) };
}

/** Seals a FINALIZING envelope (or confirms an already completed one) and marks it COMPLETED. */
export async function finalizeManagedEvidence(db: D1Database, bucket: R2Bucket, tenantId: string, envelopeId: string, config: ManagedEvidenceConfig): Promise<VerifiedSeal> {
  const built = await buildEvidenceManifest(db, bucket, tenantId, envelopeId);
  const objectKey = managedEvidenceKey(envelopeId);
  let stored = await readStoredSeal(bucket, objectKey);
  if (!stored) {
    const seal = await sealManifest(sealedContent(built.manifest, await auditTrail(db, envelopeId)), config.sealer);
    const bytes = text.encode(JSON.stringify(seal));
    const put = await bucket.put(objectKey, bytes, { onlyIf: { etagDoesNotMatch: '*' }, httpMetadata: { contentType: 'application/json' } });
    // Losing a race to a concurrent attempt: keep the seal that was stored first.
    stored = put ? { seal, sha256: hex(await crypto.subtle.digest('SHA-256', bytes)) } : await readStoredSeal(bucket, objectKey);
    if (!stored) throw new Error('Evidence conflict');
  }
  const verified = (await verifyStoredSeal(db, envelopeId, stored.seal, built.manifest, config.trust)).seal;
  const completed = await commitSeal(db, tenantId, envelopeId, { mode: 'KMS_TSA', objectKey, sha256: stored.sha256, keyArn: verified.keyArn, timestampTime: verified.timestampTime });
  if (completed) await recordAudit(db, { envelopeId, type: AUDIT.completed, detail: { seal: 'KMS_TSA', timestampTime: verified.timestampTime } });
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
export async function verifyManagedEvidence(db: D1Database, bucket: R2Bucket, tenantId: string, envelopeId: string, trust: SealTrust) {
  const built = await buildEvidenceManifest(db, bucket, tenantId, envelopeId);
  const row = await db.prepare("SELECT object_key,sha256 FROM seals WHERE envelope_id=? AND mode='KMS_TSA'").bind(envelopeId).first<{ object_key: string; sha256: string }>();
  const stored = row && await readStoredSeal(bucket, row.object_key);
  if (!row || !stored || row.object_key !== managedEvidenceKey(envelopeId) || stored.sha256 !== row.sha256) throw new Error('Evidence integrity failure');
  const { seal, sealed, afterSeal } = await verifyStoredSeal(db, envelopeId, stored.seal, built.manifest, trust);
  return { source: built.source, signatures: built.signatures, finalArtifactId: built.finalArtifactId, finalSha256: built.finalSha256, seal, audit: { sealed, afterSeal } };
}

/** Whether an envelope was completed with the managed seal (and not the local test seal). */
export async function hasManagedEvidence(db: D1Database, envelopeId: string): Promise<boolean> {
  return !!await db.prepare("SELECT 1 FROM seals WHERE envelope_id=? AND mode='KMS_TSA'").bind(envelopeId).first();
}

/** The delivery PDF's evidence and certificate notes for a managed seal. */
export const managedDelivery = (db: D1Database, bucket: R2Bucket, tenantId: string, envelopeId: string, trust: SealTrust): DeliveryEvidence => ({
  verify: () => verifyManagedEvidence(db, bucket, tenantId, envelopeId, trust),
  banner: 'SEALED: AWS KMS SIGNATURE + RFC 3161 TIMESTAMP',
  notes: [
    'The evidence (source, signing events and signed PDF hashes) is signed with an AWS KMS key (ECDSA P-256) and timestamped by an RFC 3161 time-stamping authority; the completion certificate gives the key fingerprint and the time.',
    'Certificate revocation of the time-stamping authority is not checked. The seal covers the signed PDF, not this delivery PDF.',
  ],
  name: 'delivery-v1', format: 'esign-delivery-v1',
});
