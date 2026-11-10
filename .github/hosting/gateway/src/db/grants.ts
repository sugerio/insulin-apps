// App grants (a specific-apps member's role in one app) and custom roles. As everywhere in the gateway, each change
// re-checks the actor inside its own statement, so a member who lost the right meanwhile changes nothing.
import type { AppRole, Role } from '../roles.ts'

export type GrantRole = AppRole | 'CUSTOM'

export interface GrantRow {
  user_id: string
  app: string
  role: GrantRole
  custom_role_id: string | null
  custom_role_name: string | null
}

export interface CustomRoleRow {
  id: string
  org_id: string
  app: string
  name: string
  description: string
  /** JSON array of permission keys. */
  permissions: string
  created_at: number
  updated_at: number
}

/** What a request needs to work out someone's access to one app (access.ts). */
export interface AccessRow {
  member_role: Role
  grant_role: GrantRole | null
  custom_role_id: string | null
  custom_role_name: string | null
  custom_permissions: string | null
}

/** A grant to write: a built-in role, or a custom role by id. */
export interface GrantInput {
  app: string
  role: GrantRole
  customRoleId: string | null
}

/**
 * The actor (?A) is an app admin of app ?P in organization ?O: an OWNER or ADMIN, or a specific-apps member whose grant
 * for that app is ADMIN. Parameter numbers are substituted by `appAdmin`.
 */
export function appAdmin(org: string, actor: string, app: string): string {
  return `EXISTS (SELECT 1 FROM memberships a WHERE a.org_id = ${org} AND a.user_id = ${actor}
    AND (a.role IN ('OWNER', 'ADMIN') OR (a.role = 'APPS' AND EXISTS (SELECT 1 FROM app_grants ag
      WHERE ag.org_id = ${org} AND ag.user_id = ${actor} AND ag.app = ${app} AND ag.role = 'ADMIN'))))`
}

/** The actor (?A) is still an OWNER of organization ?O. */
export function owner(org: string, actor: string): string {
  return `EXISTS (SELECT 1 FROM memberships a WHERE a.org_id = ${org} AND a.user_id = ${actor} AND a.role = 'OWNER')`
}

const GRANT_SELECT = `SELECT g.user_id, g.app, g.role, g.custom_role_id, c.name AS custom_role_name
  FROM app_grants g LEFT JOIN custom_roles c ON c.id = g.custom_role_id`

export async function listOrgGrants(db: D1Database, orgId: string): Promise<GrantRow[]> {
  const { results } = await db.prepare(`${GRANT_SELECT} WHERE g.org_id = ?1 ORDER BY g.app`).bind(orgId).all<GrantRow>()
  return results
}

export async function listAppGrants(db: D1Database, orgId: string, app: string): Promise<GrantRow[]> {
  const { results } = await db.prepare(`${GRANT_SELECT} WHERE g.org_id = ?1 AND g.app = ?2`).bind(orgId, app).all<GrantRow>()
  return results
}

export async function listUserGrants(db: D1Database, orgId: string, userId: string): Promise<GrantRow[]> {
  const { results } = await db.prepare(`${GRANT_SELECT} WHERE g.org_id = ?1 AND g.user_id = ?2 ORDER BY g.app`)
    .bind(orgId, userId).all<GrantRow>()
  return results
}

/** The member's role and, for app ?3, their grant and its custom role; null when they aren't a member. */
export function findAccessRow(db: D1Database, orgId: string, userId: string, app: string): Promise<AccessRow | null> {
  return db.prepare(
    `SELECT m.role AS member_role, g.role AS grant_role, g.custom_role_id, c.name AS custom_role_name,
       c.permissions AS custom_permissions
     FROM memberships m
     LEFT JOIN app_grants g ON g.org_id = m.org_id AND g.user_id = m.user_id AND g.app = ?3
     LEFT JOIN custom_roles c ON c.id = g.custom_role_id
     WHERE m.org_id = ?1 AND m.user_id = ?2`,
  ).bind(orgId, userId, app).first<AccessRow>()
}

/**
 * Gives a specific-apps member a role in one app, or changes it, while the actor is that app's admin (or, with
 * `orgAdmin`, an OWNER or ADMIN). The membership must already be APPS (the trigger refuses anything else). False when
 * nothing was written.
 */
export async function upsertGrant(db: D1Database, change: { orgId: string; userId: string; grant: GrantInput; actorId: string; now: number }): Promise<boolean> {
  const result = await db.prepare(
    `INSERT INTO app_grants (org_id, user_id, app, role, custom_role_id, created_at, updated_at)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?6
     WHERE (SELECT role FROM memberships WHERE org_id = ?1 AND user_id = ?2) = 'APPS' AND ${appAdmin('?1', '?7', '?3')}
     ON CONFLICT (org_id, user_id, app) DO UPDATE SET role = excluded.role, custom_role_id = excluded.custom_role_id,
       updated_at = excluded.updated_at`,
  ).bind(change.orgId, change.userId, change.grant.app, change.grant.role, change.grant.customRoleId, change.now, change.actorId).run()
  return result.meta.changes > 0
}

/**
 * Takes one app away from a specific-apps member while the actor is that app's admin; when it was their last app,
 * they leave the organization in the same batch. False when the actor may not, or there was no such grant.
 */
export async function removeGrant(db: D1Database, change: { orgId: string; userId: string; app: string; actorId: string }): Promise<boolean> {
  const [removed] = await db.batch([
    db.prepare(`DELETE FROM app_grants WHERE org_id = ?1 AND user_id = ?2 AND app = ?3 AND ${appAdmin('?1', '?4', '?3')}`)
      .bind(change.orgId, change.userId, change.app, change.actorId),
    db.prepare(
      `DELETE FROM memberships WHERE org_id = ?1 AND user_id = ?2 AND role = 'APPS'
         AND NOT EXISTS (SELECT 1 FROM app_grants g WHERE g.org_id = ?1 AND g.user_id = ?2)`,
    ).bind(change.orgId, change.userId),
  ])
  return (removed?.meta.changes ?? 0) > 0
}

export async function listCustomRoles(db: D1Database, orgId: string): Promise<CustomRoleRow[]> {
  const { results } = await db.prepare(
    `SELECT id, org_id, app, name, description, permissions, created_at, updated_at FROM custom_roles
     WHERE org_id = ?1 ORDER BY app, name COLLATE NOCASE`,
  ).bind(orgId).all<CustomRoleRow>()
  return results
}

export function findCustomRole(db: D1Database, orgId: string, id: string): Promise<CustomRoleRow | null> {
  return db.prepare(
    'SELECT id, org_id, app, name, description, permissions, created_at, updated_at FROM custom_roles WHERE org_id = ?1 AND id = ?2',
  ).bind(orgId, id).first<CustomRoleRow>()
}

/** How many grants, pending invitations and service accounts use each of the organization's custom roles. */
export async function customRoleUse(db: D1Database, orgId: string, now: number): Promise<Map<string, number>> {
  const { results } = await db.prepare(
    `SELECT id, (SELECT COUNT(*) FROM app_grants g WHERE g.custom_role_id = c.id)
        + (SELECT COUNT(*) FROM invitation_grants ig JOIN invitations i ON i.id = ig.invitation_id
            WHERE ig.custom_role_id = c.id AND i.status = 'pending' AND i.expires_at > ?2)
        + (SELECT COUNT(*) FROM service_accounts s WHERE s.custom_role_id = c.id) AS uses
     FROM custom_roles c WHERE c.org_id = ?1`,
  ).bind(orgId, now).all<{ id: string; uses: number }>()
  return new Map(results.map((row) => [row.id, row.uses]))
}

/** Creates a custom role while the actor is still an OWNER. False when they aren't, or the name is taken. */
export async function insertCustomRole(db: D1Database, role: {
  id: string; orgId: string; app: string; name: string; description: string; permissions: string[]; actorId: string; now: number
}): Promise<boolean> {
  const result = await db.prepare(
    `INSERT INTO custom_roles (id, org_id, app, name, description, permissions, created_by, created_at, updated_at)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8 WHERE ${owner('?2', '?7')}
     ON CONFLICT DO NOTHING`,
  ).bind(role.id, role.orgId, role.app, role.name, role.description, JSON.stringify(role.permissions), role.actorId, role.now).run()
  return result.meta.changes > 0
}

/** Changes a custom role's name, description and permissions while the actor is still an OWNER. */
export async function updateCustomRole(db: D1Database, role: {
  id: string; orgId: string; name: string; description: string; permissions: string[]; actorId: string; now: number
}): Promise<boolean> {
  const result = await db.prepare(
    `UPDATE OR IGNORE custom_roles SET name = ?3, description = ?4, permissions = ?5, updated_at = ?6
     WHERE org_id = ?1 AND id = ?2 AND ${owner('?1', '?7')}`,
  ).bind(role.orgId, role.id, role.name, role.description, JSON.stringify(role.permissions), role.now, role.actorId).run()
  return result.meta.changes > 0
}

/**
 * Deletes a custom role while the actor is still an OWNER and nothing uses it: no grant, pending invitation or service
 * account. Answered invitations that named it let go of it first (their grants matter no more).
 */
export async function deleteCustomRole(db: D1Database, orgId: string, id: string, actorId: string, now: number): Promise<boolean> {
  const [, deleted] = await db.batch([
    db.prepare(
      `DELETE FROM invitation_grants WHERE custom_role_id = ?1
         AND invitation_id IN (SELECT i.id FROM invitations i WHERE i.status <> 'pending' OR i.expires_at <= ?2)`,
    ).bind(id, now),
    db.prepare(
      `DELETE FROM custom_roles WHERE org_id = ?1 AND id = ?2 AND ${owner('?1', '?3')}
         AND NOT EXISTS (SELECT 1 FROM app_grants g WHERE g.custom_role_id = ?2)
         AND NOT EXISTS (SELECT 1 FROM invitation_grants ig WHERE ig.custom_role_id = ?2)
         AND NOT EXISTS (SELECT 1 FROM service_accounts s WHERE s.custom_role_id = ?2)`,
    ).bind(orgId, id, actorId),
  ])
  return (deleted?.meta.changes ?? 0) > 0
}
