// Two-step sign-in: the user's TOTP state, recovery codes and pending sign-in challenges. Every rule that races (a code
// used twice, a challenge answered twice, turning it on or off while the credentials change) is one statement or batch.

export interface MfaRow {
  email: string
  totp_secret: string | null
  totp_pending: string | null
  totp_enabled_at: number | null
  totp_last_step: number
  /** Wrong app codes in a row; at the limit, app codes are refused until `totp_locked_until`. */
  totp_failures: number
  totp_locked_until: number | null
  credential_version: number
}

export interface ChallengeRow {
  id_hash: string
  user_id: string
  credential_version: number
  method: string
  next: string
  /** The organization a single sign-on signs in to, made the session's active one. */
  active_org_id: string | null
  attempts: number
  expires_at: number
}

export function findMfa(db: D1Database, userId: string): Promise<MfaRow | null> {
  return db.prepare(
    `SELECT email, totp_secret, totp_pending, totp_enabled_at, totp_last_step, totp_failures, totp_locked_until, credential_version
     FROM users WHERE id = ?1`,
  ).bind(userId).first<MfaRow>()
}

/**
 * Counts a wrong app code, in one statement. At the `limit`-th in a row, app codes are refused until `now + lockMs`
 * and the count starts again. Returns whether this one set the lock (the caller tells the person once).
 */
export async function recordCodeFailure(db: D1Database, userId: string, now: number, limit: number, lockMs: number): Promise<boolean> {
  const row = await db.prepare(
    `UPDATE users SET
       totp_locked_until = CASE WHEN totp_failures + 1 >= ?3 THEN ?2 + ?4 ELSE totp_locked_until END,
       totp_failures = CASE WHEN totp_failures + 1 >= ?3 THEN 0 ELSE totp_failures + 1 END
     WHERE id = ?1 AND totp_secret IS NOT NULL
     RETURNING totp_locked_until`,
  ).bind(userId, now, limit, lockMs).first<{ totp_locked_until: number | null }>()
  return row?.totp_locked_until === now + lockMs
}

/** A right code (or recovery code) ends a run of wrong ones. */
export async function clearCodeFailures(db: D1Database, userId: string): Promise<void> {
  await db.prepare('UPDATE users SET totp_failures = 0, totp_locked_until = NULL WHERE id = ?1 AND (totp_failures > 0 OR totp_locked_until IS NOT NULL)')
    .bind(userId).run()
}

export async function countRecoveryCodes(db: D1Database, userId: string): Promise<number> {
  const row = await db.prepare('SELECT COUNT(*) AS count FROM mfa_recovery_codes WHERE user_id = ?1 AND used_at IS NULL')
    .bind(userId).first<{ count: number }>()
  return row?.count ?? 0
}

/** Keeps a sealed secret for setting up, while two-step sign-in is off and the credentials are the verified ones. */
export async function setPendingSecret(db: D1Database, userId: string, sealed: string, verifiedVersion: number, now: number): Promise<boolean> {
  const result = await db.prepare(
    'UPDATE users SET totp_pending = ?2, updated_at = ?4 WHERE id = ?1 AND totp_secret IS NULL AND credential_version = ?3',
  ).bind(userId, sealed, verifiedVersion, now).run()
  return result.meta.changes > 0
}

export async function clearPendingSecret(db: D1Database, userId: string, now: number): Promise<void> {
  await db.prepare('UPDATE users SET totp_pending = NULL, updated_at = ?2 WHERE id = ?1').bind(userId, now).run()
}

/** Sessions of the user from before their current credential version: no longer valid, so their rows go. */
function staleSessions(db: D1Database, userId: string): D1PreparedStatement {
  return db.prepare('DELETE FROM sessions WHERE user_id = ?1 AND credential_version < (SELECT credential_version FROM users WHERE id = ?1)')
    .bind(userId)
}

function newVersion(result: D1Result | undefined): number | null {
  const row = result?.results?.[0] as { credential_version?: unknown } | undefined
  return typeof row?.credential_version === 'number' ? row.credential_version : null
}

/**
 * Turns two-step sign-in on with the pending secret the request confirmed a code for: the secret moves in, the code's
 * step counts as used, the recovery codes are replaced, and the credential version rises (every session ends; the
 * caller starts a fresh one for this browser). Only while the pending secret and the credential version are still the
 * ones the request read. Returns the new version, or null.
 */
export async function enableMfa(db: D1Database, change: { userId: string; pending: string; verifiedVersion: number; step: number; codeHashes: string[]; now: number }): Promise<number | null> {
  // The sealed secret is unique (a random IV), so "the user's secret is this one" tells later statements the first won.
  const [enabled] = await db.batch([
    db.prepare(
      `UPDATE users SET totp_secret = totp_pending, totp_pending = NULL, totp_enabled_at = ?4, totp_last_step = ?5,
         credential_version = credential_version + 1, updated_at = ?4
       WHERE id = ?1 AND totp_secret IS NULL AND totp_pending = ?2 AND credential_version = ?3
       RETURNING credential_version`,
    ).bind(change.userId, change.pending, change.verifiedVersion, change.now, change.step),
    db.prepare('DELETE FROM mfa_recovery_codes WHERE user_id = ?1 AND (SELECT totp_secret FROM users WHERE id = ?1) = ?2')
      .bind(change.userId, change.pending),
    db.prepare(
      `INSERT INTO mfa_recovery_codes (user_id, code_hash, created_at)
       SELECT ?1, value, ?3 FROM json_each(?4) WHERE (SELECT totp_secret FROM users WHERE id = ?1) = ?2`,
    ).bind(change.userId, change.pending, change.now, JSON.stringify(change.codeHashes)),
    staleSessions(db, change.userId),
  ])
  return newVersion(enabled)
}

/**
 * Turns two-step sign-in off, while the secret and the credential version are still the ones the request checked a
 * code against; the recovery codes go, and the credential version rises. Returns the new version, or null.
 */
export async function disableMfa(db: D1Database, change: { userId: string; secret: string; verifiedVersion: number; now: number }): Promise<number | null> {
  const [disabled] = await db.batch([
    db.prepare(
      `UPDATE users SET totp_secret = NULL, totp_pending = NULL, totp_enabled_at = NULL, totp_last_step = 0,
         credential_version = credential_version + 1, updated_at = ?4
       WHERE id = ?1 AND totp_secret = ?2 AND credential_version = ?3
       RETURNING credential_version`,
    ).bind(change.userId, change.secret, change.verifiedVersion, change.now),
    db.prepare('DELETE FROM mfa_recovery_codes WHERE user_id = ?1 AND (SELECT totp_secret FROM users WHERE id = ?1) IS NULL')
      .bind(change.userId),
    staleSessions(db, change.userId),
  ])
  return newVersion(disabled)
}

/**
 * Records `step` as the last accepted one, if it is later than any accepted before and the secret is still `secret`.
 * Exactly one of two concurrent submissions of the same code gets true.
 */
export async function consumeStep(db: D1Database, userId: string, secret: string, step: number): Promise<boolean> {
  const result = await db.prepare(
    `UPDATE users SET totp_last_step = ?3, totp_failures = 0, totp_locked_until = NULL
     WHERE id = ?1 AND totp_secret = ?2 AND totp_last_step < ?3`,
  ).bind(userId, secret, step).run()
  return result.meta.changes > 0
}

/** Uses a recovery code once; true only for the one request that marks it used. */
export async function consumeRecoveryCode(db: D1Database, userId: string, codeHash: string, now: number): Promise<boolean> {
  const result = await db.prepare(
    `UPDATE mfa_recovery_codes SET used_at = ?3 WHERE user_id = ?1 AND code_hash = ?2 AND used_at IS NULL
       AND (SELECT totp_secret FROM users WHERE id = ?1) IS NOT NULL`,
  ).bind(userId, codeHash, now).run()
  return result.meta.changes > 0
}

/** Replaces every recovery code with new ones, while the secret is still `secret`. */
export async function replaceRecoveryCodes(db: D1Database, userId: string, secret: string, codeHashes: string[], now: number): Promise<boolean> {
  const [, inserted] = await db.batch([
    db.prepare('DELETE FROM mfa_recovery_codes WHERE user_id = ?1 AND (SELECT totp_secret FROM users WHERE id = ?1) = ?2').bind(userId, secret),
    db.prepare(
      `INSERT INTO mfa_recovery_codes (user_id, code_hash, created_at)
       SELECT ?1, value, ?3 FROM json_each(?4) WHERE (SELECT totp_secret FROM users WHERE id = ?1) = ?2`,
    ).bind(userId, secret, now, JSON.stringify(codeHashes)),
  ])
  return (inserted?.meta.changes ?? 0) > 0
}

export async function insertChallenge(db: D1Database, challenge: {
  idHash: string; userId: string; credentialVersion: number; method: string; next: string; activeOrgId: string | null; now: number; expiresAt: number
}): Promise<void> {
  await db.prepare(
    `INSERT INTO mfa_challenges (id_hash, user_id, credential_version, method, next, active_org_id, created_at, expires_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
  ).bind(challenge.idHash, challenge.userId, challenge.credentialVersion, challenge.method, challenge.next, challenge.activeOrgId,
    challenge.now, challenge.expiresAt).run()
}

export function findChallenge(db: D1Database, idHash: string, now: number): Promise<ChallengeRow | null> {
  return db.prepare(
    `SELECT id_hash, user_id, credential_version, method, next, active_org_id, attempts, expires_at FROM mfa_challenges
     WHERE id_hash = ?1 AND expires_at > ?2`,
  ).bind(idHash, now).first<ChallengeRow>()
}

/** Counts one attempt against the challenge; null once it has had `limit` attempts (or expired). */
export async function countAttempt(db: D1Database, idHash: string, now: number, limit: number): Promise<number | null> {
  const row = await db.prepare(
    'UPDATE mfa_challenges SET attempts = attempts + 1 WHERE id_hash = ?1 AND expires_at > ?2 AND attempts < ?3 RETURNING attempts',
  ).bind(idHash, now, limit).first<{ attempts: number }>()
  return row?.attempts ?? null
}

/** Answers the challenge: true for the one request that deletes it, so a challenge signs in once. */
export async function takeChallenge(db: D1Database, idHash: string): Promise<boolean> {
  const result = await db.prepare('DELETE FROM mfa_challenges WHERE id_hash = ?1').bind(idHash).run()
  return result.meta.changes > 0
}

/** Deletes up to `limit` expired challenges (housekeeping). */
export function pruneChallengesStatement(db: D1Database, now: number, limit: number): D1PreparedStatement {
  return db.prepare('DELETE FROM mfa_challenges WHERE id_hash IN (SELECT id_hash FROM mfa_challenges WHERE expires_at <= ?1 LIMIT ?2)')
    .bind(now, limit)
}
