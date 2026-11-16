export interface SessionRow {
  id_hash: string
  user_id: string
  active_org_id: string | null
  credential_version: number
  created_at: number
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
    `SELECT s.id_hash, s.user_id, s.active_org_id, s.credential_version, s.created_at, s.last_seen_at, s.expires_at,
       u.email, u.name, u.email_verified_at, (u.password_hash IS NOT NULL) AS has_password,
       m.role AS active_role, o.name AS active_org_name
     FROM sessions s
     JOIN users u ON u.id = s.user_id AND u.credential_version = s.credential_version AND u.status = 'active'
     LEFT JOIN orgs o ON o.id = s.active_org_id AND o.status = 'active'
     LEFT JOIN memberships m ON m.org_id = o.id AND m.user_id = s.user_id
     WHERE s.id_hash = ?1 AND s.expires_at > ?2`,
  ).bind(idHash, now).first<SessionRow>()
}

/**
 * Creates a session under the credential version the sign-in verified, only if that is still the user's version and
 * the account is active: a password reset, a suspension or a disabling (DESIGN.md §11.3) that lands between the check
 * and this insert means no session. False in that case. The sign-in counts as activity.
 */
export async function insertSession(db: D1Database, session: {
  idHash: string
  userId: string
  activeOrgId: string | null
  credentialVersion: number
  now: number
  expiresAt: number
}): Promise<boolean> {
  const [result] = await db.batch([
    db.prepare(
      `INSERT INTO sessions (id_hash, user_id, active_org_id, credential_version, created_at, last_seen_at, expires_at)
       SELECT ?1, ?2, ?3, ?4, ?5, ?5, ?6 FROM users WHERE id = ?2 AND credential_version = ?4 AND status = 'active'`,
    ).bind(session.idHash, session.userId, session.activeOrgId, session.credentialVersion, session.now, session.expiresAt),
    db.prepare('UPDATE users SET last_active_at = ?2 WHERE id = ?1 AND EXISTS (SELECT 1 FROM sessions WHERE id_hash = ?3)')
      .bind(session.userId, session.now, session.idHash),
    activeOrgStamp(db, session.idHash, session.now),
  ])
  return (result?.meta.changes ?? 0) > 0
}

/**
 * Notes the session's organization as active now, if it is still active and the person still a member: an
 * organization the operators suspended, or one the person left, never looks used (the console's "last active").
 */
function activeOrgStamp(db: D1Database, idHash: string, now: number): D1PreparedStatement {
  return db.prepare(
    `UPDATE orgs SET last_active_at = ?2 WHERE status = 'active' AND id = (
       SELECT s.active_org_id FROM sessions s JOIN memberships m ON m.org_id = s.active_org_id AND m.user_id = s.user_id
       WHERE s.id_hash = ?1)`,
  ).bind(idHash, now)
}

/**
 * Slides the session's expiry (at most once an hour), and notes the person and the session's organization as active
 * then: the operator console's "last active", to within an hour.
 */
export async function touchSession(db: D1Database, idHash: string, now: number, expiresAt: number): Promise<void> {
  await db.batch([
    db.prepare('UPDATE sessions SET last_seen_at = ?2, expires_at = ?3 WHERE id_hash = ?1').bind(idHash, now, expiresAt),
    db.prepare('UPDATE users SET last_active_at = ?2 WHERE id = (SELECT user_id FROM sessions WHERE id_hash = ?1)').bind(idHash, now),
    activeOrgStamp(db, idHash, now),
  ])
}

/** Moves the session to an organization (the caller checked the membership), which counts as using it. */
export async function setSessionOrg(db: D1Database, idHash: string, orgId: string, now: number): Promise<void> {
  await db.batch([
    db.prepare('UPDATE sessions SET active_org_id = ?2 WHERE id_hash = ?1').bind(idHash, orgId),
    activeOrgStamp(db, idHash, now),
  ])
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
