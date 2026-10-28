export interface UserRow {
  id: string
  email: string
  name: string
  password_hash: string | null
  email_verified_at: number | null
  google_sub: string | null
  orgs_created: number
  /** Raised by every password set, change or reset and other security changes; sessions must match it. */
  credential_version: number
  created_at: number
  updated_at: number
}

export function findUserByEmail(db: D1Database, email: string): Promise<UserRow | null> {
  return db.prepare('SELECT * FROM users WHERE email = ?1').bind(email).first<UserRow>()
}

export function findUserById(db: D1Database, id: string): Promise<UserRow | null> {
  return db.prepare('SELECT * FROM users WHERE id = ?1').bind(id).first<UserRow>()
}

export function findUserByGoogleSub(db: D1Database, sub: string): Promise<UserRow | null> {
  return db.prepare('SELECT * FROM users WHERE google_sub = ?1').bind(sub).first<UserRow>()
}

/** Inserts a user; false when the e-mail address (or Google subject) is already taken. */
export async function insertUser(db: D1Database, user: {
  id: string
  email: string
  name: string
  passwordHash: string | null
  verifiedAt: number | null
  googleSub: string | null
  now: number
}): Promise<boolean> {
  const result = await db.prepare(
    `INSERT INTO users (id, email, name, password_hash, email_verified_at, google_sub, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7) ON CONFLICT DO NOTHING`,
  ).bind(user.id, user.email, user.name, user.passwordHash, user.verifiedAt, user.googleSub, user.now).run()
  return result.meta.changes > 0
}

export async function setUserName(db: D1Database, id: string, name: string, now: number): Promise<void> {
  await db.prepare('UPDATE users SET name = ?2, updated_at = ?3 WHERE id = ?1').bind(id, name, now).run()
}

/**
 * Sets a password (a change, or a first password) only if the credential version is still the one the request
 * verified, and raises it. In the same transaction the current session moves to the new version and every other
 * session ends. False when the credentials changed meanwhile: a reset that landed after this request verified the
 * old password is never overwritten.
 */
export async function changePassword(db: D1Database, change: {
  userId: string
  passwordHash: string
  verifiedVersion: number
  sessionHash: string
  now: number
}): Promise<boolean> {
  // The fresh hash has a random salt, so "the user now has this hash" tells the later statements that the first won.
  const [updated] = await db.batch([
    db.prepare(
      `UPDATE users SET password_hash = ?2, credential_version = credential_version + 1, updated_at = ?4
       WHERE id = ?1 AND credential_version = ?3`,
    ).bind(change.userId, change.passwordHash, change.verifiedVersion, change.now),
    db.prepare(
      `UPDATE sessions SET credential_version = credential_version + 1
       WHERE id_hash = ?2 AND user_id = ?1 AND credential_version = ?3
         AND (SELECT password_hash FROM users WHERE id = ?1) = ?4`,
    ).bind(change.userId, change.sessionHash, change.verifiedVersion, change.passwordHash),
    db.prepare(
      `DELETE FROM sessions WHERE user_id = ?1 AND id_hash <> ?2 AND (SELECT password_hash FROM users WHERE id = ?1) = ?3`,
    ).bind(change.userId, change.sessionHash, change.passwordHash),
  ])
  return (updated?.meta.changes ?? 0) > 0
}

/**
 * A password reset (the link proved the inbox): sets the password, confirms the address, raises the credential
 * version and ends every session, in one transaction. Returns the new version, for the session that follows.
 */
export async function resetPassword(db: D1Database, userId: string, passwordHash: string, now: number): Promise<number | null> {
  const [updated] = await db.batch([
    db.prepare(
      `UPDATE users SET password_hash = ?2, email_verified_at = COALESCE(email_verified_at, ?3),
         credential_version = credential_version + 1, updated_at = ?3
       WHERE id = ?1 RETURNING credential_version`,
    ).bind(userId, passwordHash, now),
    db.prepare('DELETE FROM sessions WHERE user_id = ?1').bind(userId),
  ])
  const row = updated?.results?.[0] as { credential_version?: unknown } | undefined
  return typeof row?.credential_version === 'number' ? row.credential_version : null
}

export function markVerifiedStatement(db: D1Database, id: string, now: number): D1PreparedStatement {
  return db.prepare('UPDATE users SET email_verified_at = COALESCE(email_verified_at, ?2), updated_at = ?2 WHERE id = ?1')
    .bind(id, now)
}

/**
 * Links a Google account to an existing user found by e-mail. If that account was never verified, it is marked
 * verified AND its password is cleared (a credential change, so the version rises): whoever chose that password
 * never proved they own the address (account pre-hijacking). False when the user already has a Google account linked.
 */
export async function linkGoogle(db: D1Database, id: string, sub: string, now: number): Promise<boolean> {
  const result = await db.prepare(
    `UPDATE users SET google_sub = ?2,
       password_hash = CASE WHEN email_verified_at IS NULL THEN NULL ELSE password_hash END,
       credential_version = credential_version + CASE WHEN email_verified_at IS NULL THEN 1 ELSE 0 END,
       email_verified_at = COALESCE(email_verified_at, ?3),
       updated_at = ?3
     WHERE id = ?1 AND google_sub IS NULL`,
  ).bind(id, sub, now).run()
  return result.meta.changes > 0
}

/** Undoes a sign-up whose verification e-mail could not be sent, so trying again starts afresh. */
export async function deleteUnverifiedUser(db: D1Database, id: string): Promise<void> {
  await db.prepare('DELETE FROM users WHERE id = ?1 AND email_verified_at IS NULL').bind(id).run()
}

/** Counts one more organization against the user's lifetime limit; false when the limit is reached. */
export async function reserveOrgCreation(db: D1Database, id: string, limit: number, now: number): Promise<boolean> {
  const result = await db.prepare('UPDATE users SET orgs_created = orgs_created + 1, updated_at = ?3 WHERE id = ?1 AND orgs_created < ?2')
    .bind(id, limit, now).run()
  return result.meta.changes > 0
}

export async function releaseOrgCreation(db: D1Database, id: string): Promise<void> {
  await db.prepare('UPDATE users SET orgs_created = orgs_created - 1 WHERE id = ?1 AND orgs_created > 0').bind(id).run()
}

// An organization the user may not leave behind: they are its only OWNER and it has other members.
const BLOCKING_ORGS = `
  SELECT m.org_id FROM memberships m
  WHERE m.user_id = ?1 AND m.role = 'OWNER'
    AND NOT EXISTS (SELECT 1 FROM memberships o WHERE o.org_id = m.org_id AND o.role = 'OWNER' AND o.user_id <> ?1)
    AND EXISTS (SELECT 1 FROM memberships x WHERE x.org_id = m.org_id AND x.user_id <> ?1)`

export async function orgsBlockingDeletion(db: D1Database, userId: string): Promise<{ id: string; name: string }[]> {
  const { results } = await db.prepare(
    `SELECT o.id, o.name FROM orgs o WHERE o.id IN (${BLOCKING_ORGS}) ORDER BY o.name`,
  ).bind(userId).all<{ id: string; name: string }>()
  return results
}

/**
 * Deletes the account, and with it every organization where the user is the only member, unless an organization
 * would be left without an OWNER (checked inside the same transaction). Sessions, tokens and memberships cascade.
 */
export async function deleteAccount(db: D1Database, userId: string): Promise<boolean> {
  const [, deleted] = await db.batch([
    db.prepare(
      `DELETE FROM orgs WHERE id IN (
         SELECT m.org_id FROM memberships m WHERE m.user_id = ?1
           AND NOT EXISTS (SELECT 1 FROM memberships o WHERE o.org_id = m.org_id AND o.user_id <> ?1))
       AND NOT EXISTS (${BLOCKING_ORGS})`,
    ).bind(userId),
    db.prepare(`DELETE FROM users WHERE id = ?1 AND NOT EXISTS (${BLOCKING_ORGS})`).bind(userId),
  ])
  return (deleted?.meta.changes ?? 0) > 0
}
