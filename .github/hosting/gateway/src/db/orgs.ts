import type { Role } from '../roles.ts'

export interface OrgRow {
  id: string
  name: string
  created_at: number
}

export interface MembershipRow {
  org_id: string
  org_name: string
  role: Role
  created_at: number
}

export interface MemberRow {
  user_id: string
  name: string
  email: string
  role: Role
  created_at: number
}

const ROLE_ORDER = `CASE m.role WHEN 'OWNER' THEN 0 WHEN 'ADMIN' THEN 1 WHEN 'EDITOR' THEN 2 WHEN 'USER' THEN 3 ELSE 4 END`

// Keeps every organization with at least one OWNER: a statement guarded by this changes an OWNER's membership only
// while another OWNER remains. Each guard runs inside a single SQL statement, so concurrent requests cannot race it.
const ANOTHER_OWNER = `(SELECT COUNT(*) FROM memberships o WHERE o.org_id = ?1 AND o.role = 'OWNER') > 1`

// Every privileged mutation re-reads the actor's role inside its own statement (the organization is ?1). The page
// checked the role earlier, but a member whose role was lowered, or who was removed, since then must change nothing.

export async function createOrg(db: D1Database, org: { id: string; name: string; userId: string; now: number }): Promise<void> {
  await db.batch([
    db.prepare('INSERT INTO orgs (id, name, created_by, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)')
      .bind(org.id, org.name, org.userId, org.now),
    db.prepare("INSERT INTO memberships (org_id, user_id, role, created_at, updated_at) VALUES (?1, ?2, 'OWNER', ?3, ?3)")
      .bind(org.id, org.userId, org.now),
  ])
}

export function findMembership(db: D1Database, orgId: string, userId: string): Promise<MembershipRow | null> {
  return db.prepare(
    `SELECT m.org_id, o.name AS org_name, m.role, m.created_at FROM memberships m JOIN orgs o ON o.id = m.org_id
     WHERE m.org_id = ?1 AND m.user_id = ?2`,
  ).bind(orgId, userId).first<MembershipRow>()
}

/** The user's memberships, oldest first: the first one is the default active organization. */
export async function listMemberships(db: D1Database, userId: string): Promise<MembershipRow[]> {
  const { results } = await db.prepare(
    `SELECT m.org_id, o.name AS org_name, m.role, m.created_at FROM memberships m JOIN orgs o ON o.id = m.org_id
     WHERE m.user_id = ?1 ORDER BY m.created_at, m.org_id`,
  ).bind(userId).all<MembershipRow>()
  return results
}

export async function listMembers(db: D1Database, orgId: string): Promise<MemberRow[]> {
  const { results } = await db.prepare(
    `SELECT m.user_id, u.name, u.email, m.role, m.created_at FROM memberships m JOIN users u ON u.id = m.user_id
     WHERE m.org_id = ?1 ORDER BY ${ROLE_ORDER}, u.name COLLATE NOCASE, u.email`,
  ).bind(orgId).all<MemberRow>()
  return results
}

export async function countMembers(db: D1Database, orgId: string): Promise<number> {
  const row = await db.prepare('SELECT COUNT(*) AS count FROM memberships WHERE org_id = ?1').bind(orgId).first<{ count: number }>()
  return row?.count ?? 0
}

export async function countOwners(db: D1Database, orgId: string): Promise<number> {
  const row = await db.prepare("SELECT COUNT(*) AS count FROM memberships WHERE org_id = ?1 AND role = 'OWNER'")
    .bind(orgId).first<{ count: number }>()
  return row?.count ?? 0
}

/** Renames the organization if `actorId` is still one of its OWNERs. */
export async function renameOrg(db: D1Database, orgId: string, actorId: string, name: string, now: number): Promise<boolean> {
  const result = await db.prepare(
    `UPDATE orgs SET name = ?2, updated_at = ?3 WHERE id = ?1
       AND EXISTS (SELECT 1 FROM memberships a WHERE a.org_id = ?1 AND a.user_id = ?4 AND a.role = 'OWNER')`,
  ).bind(orgId, name, now, actorId).run()
  return result.meta.changes > 0
}

/**
 * Removes the organization from the gateway if `actorId` is still one of its OWNERs; memberships and invitations
 * cascade, sessions forget it.
 */
export async function deleteOrg(db: D1Database, orgId: string, actorId: string): Promise<boolean> {
  const result = await db.prepare(
    `DELETE FROM orgs WHERE id = ?1
       AND EXISTS (SELECT 1 FROM memberships a WHERE a.org_id = ?1 AND a.user_id = ?2 AND a.role = 'OWNER')`,
  ).bind(orgId, actorId).run()
  return result.meta.changes > 0
}

/**
 * Changes a member's role if it is still `current` (so a concurrent change is never overwritten); when an OWNER loses
 * the role, another OWNER remains; and `actorId` may still make the change: an OWNER, or an ADMIN when neither the
 * current nor the new role is OWNER. Returns false otherwise.
 */
export async function changeRole(db: D1Database, change: { orgId: string; userId: string; current: Role; next: Role; actorId: string; now: number }): Promise<boolean> {
  const result = await db.prepare(
    `UPDATE memberships SET role = ?4, updated_at = ?5
     WHERE org_id = ?1 AND user_id = ?2 AND role = ?3
       AND (?3 <> 'OWNER' OR ?4 = 'OWNER' OR ${ANOTHER_OWNER})
       AND EXISTS (SELECT 1 FROM memberships a WHERE a.org_id = ?1 AND a.user_id = ?6
         AND (a.role = 'OWNER' OR (a.role = 'ADMIN' AND ?3 <> 'OWNER' AND ?4 <> 'OWNER')))`,
  ).bind(change.orgId, change.userId, change.current, change.next, change.now, change.actorId).run()
  return result.meta.changes > 0
}

/**
 * Removes another member if their role is still `current`, they are not the last OWNER, and `actorId` may still remove
 * them: an OWNER, or an ADMIN when the member is not an OWNER. Returns false otherwise.
 */
export async function removeMember(db: D1Database, orgId: string, userId: string, current: Role, actorId: string): Promise<boolean> {
  const result = await db.prepare(
    `DELETE FROM memberships WHERE org_id = ?1 AND user_id = ?2 AND role = ?3
       AND (?3 <> 'OWNER' OR ${ANOTHER_OWNER})
       AND EXISTS (SELECT 1 FROM memberships a WHERE a.org_id = ?1 AND a.user_id = ?4
         AND (a.role = 'OWNER' OR (a.role = 'ADMIN' AND ?3 <> 'OWNER')))`,
  ).bind(orgId, userId, current, actorId).run()
  return result.meta.changes > 0
}

/** Leaves the organization (anyone may) unless that would remove its last OWNER. Returns false otherwise. */
export async function leaveOrg(db: D1Database, orgId: string, userId: string, current: Role): Promise<boolean> {
  const result = await db.prepare(
    `DELETE FROM memberships WHERE org_id = ?1 AND user_id = ?2 AND role = ?3
       AND (?3 <> 'OWNER' OR ${ANOTHER_OWNER})`,
  ).bind(orgId, userId, current).run()
  return result.meta.changes > 0
}
