export type TokenPurpose = 'verify_email' | 'reset_password'

export interface TokenRow {
  token_hash: string
  user_id: string
  purpose: TokenPurpose
  email: string
  return_to: string | null
  expires_at: number
}

/**
 * Stages a new token's hash next to any older ones, which keep working: they stop only when `commitToken` runs after
 * the new link was actually emailed. A request that never gets its e-mail out (capped or failed) calls `dropToken`,
 * so it can never invalidate the links a person already received.
 */
export async function stageToken(db: D1Database, token: {
  tokenHash: string
  userId: string
  purpose: TokenPurpose
  email: string
  returnTo: string | null
  now: number
  expiresAt: number
}): Promise<void> {
  await db.prepare(
    `INSERT INTO email_tokens (token_hash, user_id, purpose, email, return_to, created_at, expires_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
  ).bind(token.tokenHash, token.userId, token.purpose, token.email, token.returnTo, token.now, token.expiresAt).run()
}

/** The new link went out: older unused tokens of the same purpose stop working. */
export async function commitToken(db: D1Database, tokenHash: string, userId: string, purpose: TokenPurpose): Promise<void> {
  await db.prepare('DELETE FROM email_tokens WHERE user_id = ?1 AND purpose = ?2 AND used_at IS NULL AND token_hash <> ?3')
    .bind(userId, purpose, tokenHash).run()
}

/** The new link never went out: forget it, and leave the older ones as they were. */
export async function dropToken(db: D1Database, tokenHash: string): Promise<void> {
  await db.prepare('DELETE FROM email_tokens WHERE token_hash = ?1').bind(tokenHash).run()
}

/** A token that is unused and unexpired, without consuming it (GET pages must never consume). */
export function findUsableToken(db: D1Database, tokenHash: string, purpose: TokenPurpose, now: number): Promise<TokenRow | null> {
  return db.prepare(
    `SELECT token_hash, user_id, purpose, email, return_to, expires_at FROM email_tokens
     WHERE token_hash = ?1 AND purpose = ?2 AND used_at IS NULL AND expires_at > ?3`,
  ).bind(tokenHash, purpose, now).first<TokenRow>()
}

/** Marks the token used, atomically: of two concurrent requests with the same token, only one gets the row. */
export function consumeToken(db: D1Database, tokenHash: string, purpose: TokenPurpose, now: number): Promise<TokenRow | null> {
  return db.prepare(
    `UPDATE email_tokens SET used_at = ?3
     WHERE token_hash = ?1 AND purpose = ?2 AND used_at IS NULL AND expires_at > ?3
     RETURNING token_hash, user_id, purpose, email, return_to, expires_at`,
  ).bind(tokenHash, purpose, now).first<TokenRow>()
}

export function deleteUnusedTokensStatement(db: D1Database, userId: string): D1PreparedStatement {
  return db.prepare('DELETE FROM email_tokens WHERE user_id = ?1 AND used_at IS NULL').bind(userId)
}

/** Deletes up to `limit` tokens that expired or were used (housekeeping). */
export function pruneTokensStatement(db: D1Database, now: number, limit: number): D1PreparedStatement {
  return db.prepare(
    'DELETE FROM email_tokens WHERE token_hash IN (SELECT token_hash FROM email_tokens WHERE expires_at <= ?1 OR used_at IS NOT NULL LIMIT ?2)',
  ).bind(now, limit)
}
