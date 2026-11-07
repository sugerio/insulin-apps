/** Experimental request-driven preparation. No automatic recovery or scheduler is provided. */
export async function prepareEnvelope(db: D1Database, bucket: R2Bucket, tenantId: string, envelopeId: string): Promise<void> {
  const envelope = await db.prepare(`SELECT e.status, t.object_key FROM envelopes e
    JOIN templates t ON t.id = e.template_id AND t.tenant_id = e.tenant_id
    WHERE e.id = ? AND e.tenant_id = ?`).bind(envelopeId, tenantId).first<{ status: string; object_key: string }>();
  if (!envelope) throw new Error('Envelope not found');
  if (envelope.status === 'IN_PROGRESS') return;
  if (envelope.status !== 'PROCESSING') throw new Error('Envelope not processable');
  const source = await bucket.get(envelope.object_key);
  if (!source) throw new Error('Source artifact missing');
  const bytes = await source.arrayBuffer();
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (n) => n.toString(16).padStart(2, '0')).join('');
  const key = `envelopes/${envelopeId}/d0.pdf`;
  const stored = await bucket.put(key, bytes, { onlyIf: { etagDoesNotMatch: '*' } });
  if (!stored) {
    const previous = await bucket.get(key);
    if (!previous) throw new Error('Prepared object unavailable');
    const previousHash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await previous.arrayBuffer())), (n) => n.toString(16).padStart(2, '0')).join('');
    if (previousHash !== hash) throw new Error('Prepared object conflict');
  }
  await db.batch([
    db.prepare("INSERT OR IGNORE INTO artifacts (id, envelope_id, object_key, sha256) SELECT ?, id, ?, ? FROM envelopes WHERE id = ? AND tenant_id = ? AND status = 'PROCESSING'").bind(`d0:${envelopeId}`, key, hash, envelopeId, tenantId),
    db.prepare("UPDATE envelopes SET status = 'IN_PROGRESS' WHERE id = ? AND tenant_id = ? AND status = 'PROCESSING' AND EXISTS (SELECT 1 FROM artifacts WHERE envelope_id = ? AND object_key = ? AND sha256 = ?)").bind(envelopeId, tenantId, envelopeId, key, hash),
    db.prepare("UPDATE tasks SET status = 'ACTIVE' WHERE envelope_id = ? AND routing_order = 1 AND status = 'PENDING' AND EXISTS (SELECT 1 FROM envelopes WHERE id = ? AND tenant_id = ? AND status = 'IN_PROGRESS')").bind(envelopeId, envelopeId, tenantId),
    db.prepare(`INSERT INTO preparation_assertions (ok) SELECT CASE WHEN EXISTS (
      SELECT 1 FROM envelopes e JOIN artifacts a ON a.envelope_id = e.id
      JOIN tasks t ON t.envelope_id = e.id AND t.routing_order = 1
      WHERE e.id = ? AND e.tenant_id = ? AND e.status = 'IN_PROGRESS'
        AND a.object_key = ? AND a.sha256 = ? AND t.status = 'ACTIVE'
    ) THEN 1 ELSE 0 END`).bind(envelopeId, tenantId, key, hash),
    db.prepare('DELETE FROM preparation_assertions'),
  ]);
  const result = await db.prepare('SELECT status FROM envelopes WHERE id = ? AND tenant_id = ?').bind(envelopeId, tenantId).first<{ status: string }>();
  if (result?.status !== 'IN_PROGRESS') throw new Error('Preparation did not complete');
}
