import { AUDIT, recordAuditQuietly } from './audit.ts';
import type { Mailer } from './mail.ts';

/**
 * Once an envelope is completed, every signer is emailed a link to their copy of the record: the
 * signed PDF followed by its certificate of completion (the delivery PDF), so that they can keep
 * it (ESIGN Act / UETA). The mail relay sends text only, so the copy is a link to the public /copy
 * page, not an attachment: a random token (only its SHA-256 is stored) that downloads the copy once,
 * within 30 days. The page asks before downloading, so a mail scanner that opens the link uses
 * nothing up. Each notice is reserved before sending, so concurrent runs (the signing request,
 * process-due) send it once; a reservation whose send failed is retried after a while.
 */

/** How long a reservation without a sent notice blocks another attempt. */
const RETRY_AFTER_MS = 15 * 60 * 1000;
/** How long a signed-copy link works. */
export const COPY_LINK_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const hex = (bytes: Uint8Array) => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
export const linkHash = async (token: string) => hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))));

/**
 * Emails each signer of a completed envelope a link to their copy, at `origin` (the app's own).
 * The link row commits with the reservation's success only: a send that failed leaves a link nobody
 * received, which simply expires.
 */
export async function sendSignedCopies(db: D1Database, tenantId: string, envelopeId: string, mailer: Mailer, origin: string, now = Date.now()): Promise<{ sent: number; skipped: number }> {
  const envelope = await db.prepare('SELECT status FROM envelopes WHERE id=? AND tenant_id=?').bind(envelopeId, tenantId).first<{ status: string }>();
  if (envelope?.status !== 'COMPLETED') throw new Error('Envelope not completed');
  const tasks = (await db.prepare("SELECT id,recipient_name,recipient_email FROM tasks WHERE envelope_id=? AND status='SIGNED' ORDER BY routing_order").bind(envelopeId).all<{ id: string; recipient_name: string; recipient_email: string }>()).results;
  let sent = 0, skipped = 0;
  for (const task of tasks) {
    const reserved = await db.prepare('INSERT INTO copy_deliveries (envelope_id,task_id,reserved_at) VALUES (?,?,?) ON CONFLICT(envelope_id,task_id) DO UPDATE SET reserved_at=excluded.reserved_at WHERE copy_deliveries.sent_at IS NULL AND copy_deliveries.reserved_at<?')
      .bind(envelopeId, task.id, now, now - RETRY_AFTER_MS).run();
    if (reserved.meta.changes !== 1) { skipped++; continue; }
    try {
      const token = hex(crypto.getRandomValues(new Uint8Array(32)));
      await db.prepare('INSERT INTO signed_copy_links (token_hash,tenant_id,envelope_id,task_id,created_at,expires_at) VALUES (?,?,?,?,?,?)')
        .bind(await linkHash(token), tenantId, envelopeId, task.id, now, now + COPY_LINK_TTL_MS).run();
      const link = `${origin}/copy#token=${token}`;
      await mailer.send(task.recipient_email, 'Your signed document',
        [`Hello ${task.recipient_name},`, '', 'Everyone has signed. Download your copy of the signed document, followed by its certificate of completion, and keep it for your records:', '', link, '', 'The link works once, within 30 days.', '', `Envelope: ${envelopeId}`].join('\n'));
      await db.prepare('UPDATE copy_deliveries SET sent_at=? WHERE envelope_id=? AND task_id=?').bind(now, envelopeId, task.id).run();
      await recordAuditQuietly(db, { envelopeId, taskId: task.id, type: AUDIT.copySent, detail: { to: task.recipient_email, delivery: 'email' } });
      sent++;
    } catch {
      console.error(`E-sign: could not send the signed-copy notice for envelope ${envelopeId}; process-due retries it`);
    }
  }
  return { sent, skipped };
}

/**
 * Uses a signed-copy link once: the envelope and task it opens, or null when it is unknown, used or
 * expired. The use is one conditional statement, so two opens at once download it once.
 */
export async function useCopyLink(db: D1Database, token: string, now = Date.now()): Promise<{ tenantId: string; envelopeId: string; taskId: string } | null> {
  if (!/^[a-f0-9]{64}$/.test(token)) return null;
  const hash = await linkHash(token);
  const used = await db.prepare('UPDATE signed_copy_links SET used_at=? WHERE token_hash=? AND used_at IS NULL AND expires_at>?').bind(now, hash, now).run();
  if (used.meta.changes !== 1) return null;
  const row = await db.prepare('SELECT tenant_id,envelope_id,task_id FROM signed_copy_links WHERE token_hash=?').bind(hash).first<{ tenant_id: string; envelope_id: string; task_id: string }>();
  return row ? { tenantId: row.tenant_id, envelopeId: row.envelope_id, taskId: row.task_id } : null;
}

/** Makes a used link usable again, when what it opens could not be delivered. */
export async function releaseCopyLink(db: D1Database, token: string): Promise<void> {
  if (!/^[a-f0-9]{64}$/.test(token)) return;
  await db.prepare('UPDATE signed_copy_links SET used_at=NULL WHERE token_hash=?').bind(await linkHash(token)).run();
}

/** Completed envelopes (in the last week) with a signer whose notice has not been sent; of one organization, when given. */
export async function envelopesOwingCopies(db: D1Database, now = Date.now(), limit = 25, tenantId: string | null = null): Promise<{ id: string; tenant_id: string }[]> {
  return (await db.prepare(`SELECT e.id,e.tenant_id FROM envelopes e WHERE e.status='COMPLETED' AND e.created_at>?1 AND (?3 IS NULL OR e.tenant_id=?3) AND EXISTS (
      SELECT 1 FROM tasks t WHERE t.envelope_id=e.id AND t.status='SIGNED' AND NOT EXISTS (SELECT 1 FROM copy_deliveries d WHERE d.envelope_id=e.id AND d.task_id=t.id AND d.sent_at IS NOT NULL))
    ORDER BY RANDOM() LIMIT ?2`).bind(now - 7 * 24 * 60 * 60 * 1000, limit, tenantId).all<{ id: string; tenant_id: string }>()).results;
}
