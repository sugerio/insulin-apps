export interface SessionRow {
  id_hash: string
  user_id: string
  active_org_id: string | null
  credential_version: number
  last_seen_at: number
  expires_at: number
  email: string
  name: string
  email_verified_at: number | null
  has_password: number
  /** Null when the session has no active organization or the user is no longer a member of it. */
  active_role: string | null
  active_org_name: string | null
}

export function findSession(db: D1Database, idHash: string, now: number): Promise<SessionRow | null> {
  return db.prepare(
    `SELECT s.id_hash, s.user_id, s.active_org_id, s.credential_version, s.last_seen_at, s.expires_at,
       u.email, u.name, u.email_verified_at, (u.password_hash IS NOT NULL) AS has_password,
       m.role AS active_role, o.name AS active_org_name
     FROM sessions s
     JOIN users u ON u.id = s.user_id AND u.credential_version = s.credential_version
     LEFT JOIN memberships m ON m.org_id = s.active_org_id AND m.user_id = s.user_id
     LEFT JOIN orgs o ON o.id = m.org_id
     WHERE s.id_hash = ?1 AND s.expires_at > ?2`,
  ).bind(idHash, now).first<SessionRow>()
}

/**
 * Creates a session under the credential version the sign-in verified, only if that is still the user's version: a
 * password reset that lands between the check and this insert means no session. False in that case.
 */
export async function insertSession(db: D1Database, session: {
  idHash: string
  userId: string
  activeOrgId: string | null
  credentialVersion: number
  now: number
  expiresAt: number
}): Promise<boolean> {
  const result = await db.prepare(
    `INSERT INTO sessions (id_hash, user_id, active_org_id, credential_version, created_at, last_seen_at, expires_at)
     SELECT ?1, ?2, ?3, ?4, ?5, ?5, ?6 FROM users WHERE id = ?2 AND credential_version = ?4`,
  ).bind(session.idHash, session.userId, session.activeOrgId, session.credentialVersion, session.now, session.expiresAt).run()
  return result.meta.changes > 0
}

export async function touchSession(db: D1Database, idHash: string, now: number, expiresAt: number): Promise<void> {
  await db.prepare('UPDATE sessions SET last_seen_at = ?2, expires_at = ?3 WHERE id_hash = ?1').bind(idHash, now, expiresAt).run()
}

export async function setSessionOrg(db: D1Database, idHash: string, orgId: string): Promise<void> {
  await db.prepare('UPDATE sessions SET active_org_id = ?2 WHERE id_hash = ?1').bind(idHash, orgId).run()
}

export async function deleteSession(db: D1Database, idHash: string): Promise<void> {
  await db.prepare('DELETE FROM sessions WHERE id_hash = ?1').bind(idHash).run()
}

export function deleteUserSessionsStatement(db: D1Database, userId: string): D1PreparedStatement {
  return db.prepare('DELETE FROM sessions WHERE user_id = ?1').bind(userId)
}

/** Deletes up to `limit` expired sessions (housekeeping). */
export function pruneSessionsStatement(db: D1Database, now: number, limit: number): D1PreparedStatement {
  return db.prepare('DELETE FROM sessions WHERE id_hash IN (SELECT id_hash FROM sessions WHERE expires_at <= ?1 LIMIT ?2)')
    .bind(now, limit)
}
