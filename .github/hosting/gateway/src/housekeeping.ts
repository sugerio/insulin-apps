// Retention: expired sessions, used or expired e-mail tokens, expired two-step sign-in challenges and single sign-on
// requests, mail-log rows older than two days, expired OAuth requests, codes, tokens and grants (and clients nobody
// uses), apps' hourly metrics past three days and daily ones past 400, and the operator console's expired sessions and
// sign-ins, old job records and Cloudflare snapshots, are deleted in small batches, after every state-changing request
// (and by the Worker's scheduled handler, if a cron is configured). Each run deletes at most `limit` rows per table, so
// no request pays for a backlog.
import { pruneMailLogStatement } from './db/mail.ts'
import { pruneMetricsStatements } from './db/metrics.ts'
import { pruneChallengesStatement } from './db/mfa.ts'
import { pruneOAuthStatements } from './db/oauth.ts'
import { pruneSessionsStatement } from './db/sessions.ts'
import { pruneSsoRequestsStatement } from './db/sso.ts'
import { pruneTokensStatement } from './db/tokens.ts'
import { pruneSuperStatements } from './super/db.ts'

export const HOUSEKEEPING_BATCH = 200

export async function housekeeping(db: D1Database, now: number, limit = HOUSEKEEPING_BATCH): Promise<void> {
  await db.batch([
    pruneSessionsStatement(db, now, limit),
    pruneTokensStatement(db, now, limit),
    pruneChallengesStatement(db, now, limit),
    pruneMailLogStatement(db, now, limit),
    ...pruneOAuthStatements(db, now, limit),
    pruneSsoRequestsStatement(db, now, limit),
    ...pruneMetricsStatements(db, now, limit),
    ...pruneSuperStatements(db, now, limit),
  ])
}
