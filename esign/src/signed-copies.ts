import { deliveryPdf, type DeliveryEvidence } from './delivery-pdf.ts';
import { AUDIT, recordAuditQuietly } from './audit.ts';
import type { SinkMailer } from './otp-mail-sink.ts';

/**
 * Once an envelope is completed, every signer is emailed one copy of the record: the signed PDF
 * followed by its certificate of completion (the delivery PDF), so that they can keep it
 * (ESIGN Act / UETA). Each copy is reserved before sending, so concurrent runs (after the last
 * signature, the cron) send it once; a reservation whose send failed is retried after a while.
 */

/** How long a reservation without a sent copy blocks another attempt. */
const RETRY_AFTER_MS = 15 * 60 * 1000;

const hex = (bytes: Uint8Array) => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');

export async function sendSignedCopies(db: D1Database, bucket: R2Bucket, tenantId: string, envelopeId: string, evidence: Uint8Array | DeliveryEvidence, mailer: SinkMailer, now = Date.now()): Promise<{ sent: number; skipped: number }> {
  const envelope = await db.prepare('SELECT status FROM envelopes WHERE id=? AND tenant_id=?').bind(envelopeId, tenantId).first<{ status: string }>();
  if (envelope?.status !== 'COMPLETED') throw new Error('Envelope not completed');
  const tasks = (await db.prepare("SELECT id,recipient_name,recipient_email FROM tasks WHERE envelope_id=? AND status='SIGNED' ORDER BY routing_order").bind(envelopeId).all<{ id: string; recipient_name: string; recipient_email: string }>()).results;
  let delivery: { bytes: Uint8Array; sha256: string } | null = null;
  let sent = 0, skipped = 0;
  for (const task of tasks) {
    const reserved = await db.prepare('INSERT INTO copy_deliveries (envelope_id,task_id,reserved_at) VALUES (?,?,?) ON CONFLICT(envelope_id,task_id) DO UPDATE SET reserved_at=excluded.reserved_at WHERE copy_deliveries.sent_at IS NULL AND copy_deliveries.reserved_at<?')
      .bind(envelopeId, task.id, now, now - RETRY_AFTER_MS).run();
    if (reserved.meta.changes !== 1) { skipped++; continue; }
    try {
      if (!delivery) {
        const built = await deliveryPdf(db, bucket, tenantId, envelopeId, evidence);
        const bytes = Uint8Array.from(built.bytes);
        delivery = { bytes, sha256: hex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))) };
      }
      await mailer.send(task.recipient_email, 'Your signed document',
        [`Hello ${task.recipient_name},`, '', 'Everyone has signed. Attached is the signed document, followed by its certificate of completion. Keep it for your records.', '', `Envelope: ${envelopeId}`, `Attachment SHA-256: ${delivery.sha256}`].join('\n'),
        [{ disposition: 'attachment', filename: `signed-${envelopeId}.pdf`, type: 'application/pdf', content: delivery.bytes }]);
      await db.prepare('UPDATE copy_deliveries SET sent_at=? WHERE envelope_id=? AND task_id=?').bind(now, envelopeId, task.id).run();
      await recordAuditQuietly(db, { envelopeId, taskId: task.id, type: AUDIT.copySent, detail: { to: task.recipient_email, delivery: 'email', attachmentSha256: delivery.sha256 } });
      sent++;
    } catch {
      console.error(`E-sign: could not send the signed copy for envelope ${envelopeId}; it is retried later`);
    }
  }
  return { sent, skipped };
}

/** Completed envelopes (in the last week) with a signer whose copy has not been sent. */
export async function envelopesOwingCopies(db: D1Database, now = Date.now(), limit = 25): Promise<{ id: string; tenant_id: string }[]> {
  return (await db.prepare(`SELECT e.id,e.tenant_id FROM envelopes e WHERE e.status='COMPLETED' AND e.created_at>? AND EXISTS (
      SELECT 1 FROM tasks t WHERE t.envelope_id=e.id AND t.status='SIGNED' AND NOT EXISTS (SELECT 1 FROM copy_deliveries d WHERE d.envelope_id=e.id AND d.task_id=t.id AND d.sent_at IS NOT NULL))
    ORDER BY RANDOM() LIMIT ?`).bind(now - 7 * 24 * 60 * 60 * 1000, limit).all<{ id: string; tenant_id: string }>()).results;
}
