// Retention: expired sessions, used or expired e-mail tokens, and mail-log rows older than two days are deleted in
// small batches, after every state-changing request (and by the Worker's scheduled handler, if a cron is configured).
// Each run deletes at most `limit` rows per table, so no request pays for a backlog.
import { pruneMailLogStatement } from './db/mail.ts'
import { pruneSessionsStatement } from './db/sessions.ts'
import { pruneTokensStatement } from './db/tokens.ts'

export const HOUSEKEEPING_BATCH = 200

export async function housekeeping(db: D1Database, now: number, limit = HOUSEKEEPING_BATCH): Promise<void> {
  await db.batch([
    pruneSessionsStatement(db, now, limit),
    pruneTokensStatement(db, now, limit),
    pruneMailLogStatement(db, now, limit),
  ])
}
