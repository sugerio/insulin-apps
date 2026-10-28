export const RECIPIENT_LIMIT = 5
export const RECIPIENT_WINDOW_MS = 60 * 60 * 1000
export const ORG_INVITATION_LIMIT = 30
export const ORG_WINDOW_MS = 24 * 60 * 60 * 1000

/**
 * Records an e-mail about to be sent, atomically checking the caps: at most RECIPIENT_LIMIT per recipient per hour and,
 * for invitations, ORG_INVITATION_LIMIT per organization per day. Returns the log row id, or null when a cap is reached.
 */
export async function reserveMailSlot(db: D1Database, slot: { recipientHash: string; kind: string; orgId: string | null; now: number }): Promise<number | null> {
  const row = await db.prepare(
    `INSERT INTO mail_log (recipient_hash, kind, org_id, created_at)
     SELECT ?1, ?2, ?3, ?4
     WHERE (SELECT COUNT(*) FROM mail_log WHERE recipient_hash = ?1 AND created_at > ?4 - ?5) < ?6
       AND (?3 IS NULL OR (SELECT COUNT(*) FROM mail_log WHERE org_id = ?3 AND kind = 'invitation' AND created_at > ?4 - ?7) < ?8)
     RETURNING id`,
  ).bind(slot.recipientHash, slot.kind, slot.orgId, slot.now, RECIPIENT_WINDOW_MS, RECIPIENT_LIMIT, ORG_WINDOW_MS, ORG_INVITATION_LIMIT)
    .first<{ id: number }>()
  return row?.id ?? null
}

export async function releaseMailSlot(db: D1Database, id: number): Promise<void> {
  await db.prepare('DELETE FROM mail_log WHERE id = ?1').bind(id).run()
}

export async function countOrgInvitationMail(db: D1Database, orgId: string, now: number): Promise<number> {
  const row = await db.prepare("SELECT COUNT(*) AS count FROM mail_log WHERE org_id = ?1 AND kind = 'invitation' AND created_at > ?2")
    .bind(orgId, now - ORG_WINDOW_MS).first<{ count: number }>()
  return row?.count ?? 0
}

/** Mail-log rows are kept two days, longer than any cap looks back. */
export const MAIL_LOG_RETENTION_MS = 2 * ORG_WINDOW_MS

/** Deletes up to `limit` mail-log rows older than the retention (housekeeping). */
export function pruneMailLogStatement(db: D1Database, now: number, limit: number): D1PreparedStatement {
  return db.prepare('DELETE FROM mail_log WHERE id IN (SELECT id FROM mail_log WHERE created_at < ?1 ORDER BY created_at LIMIT ?2)')
    .bind(now - MAIL_LOG_RETENTION_MS, limit)
}

export interface CapturedMail {
  id: number
  recipient: string
  subject: string
  body_text: string
  created_at: number
}

export async function captureMail(db: D1Database, mail: { to: string; subject: string; text: string; html: string; now: number }): Promise<void> {
  await db.prepare('INSERT INTO mail_capture (recipient, subject, body_text, body_html, created_at) VALUES (?1, ?2, ?3, ?4, ?5)')
    .bind(mail.to, mail.subject, mail.text, mail.html, mail.now).run()
}

export async function listCapturedMail(db: D1Database, limit: number): Promise<CapturedMail[]> {
  const { results } = await db.prepare('SELECT id, recipient, subject, body_text, created_at FROM mail_capture ORDER BY id DESC LIMIT ?1')
    .bind(limit).all<CapturedMail>()
  return results
}
