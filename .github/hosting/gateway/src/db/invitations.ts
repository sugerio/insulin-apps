import { appAdmin, type GrantInput, type GrantRole } from './grants.ts'
import { invitableDomain } from './orgs.ts'
import { domainOf } from './sso.ts'
import type { Role } from '../roles.ts'

export type InvitationStatus = 'pending' | 'accepted' | 'declined' | 'revoked' | 'expired'

export interface InvitationRow {
  id: string
  org_id: string
  org_name: string
  email: string
  role: Role
  invited_by: string | null
  inviter_name: string | null
  status: InvitationStatus
  created_at: number
  expires_at: number
  last_sent_at: number
}

const SELECT = `SELECT i.id, i.org_id, o.name AS org_name, i.email, i.role, i.invited_by, u.name AS inviter_name,
    i.status, i.created_at, i.expires_at, i.last_sent_at
  FROM invitations i JOIN orgs o ON o.id = i.org_id LEFT JOIN users u ON u.id = i.invited_by`

/** An app an APPS invitation grants. */
export interface InvitationGrantRow {
  invitation_id: string
  app: string
  role: GrantRole
  custom_role_id: string | null
  custom_role_name: string | null
}

/**
 * Who may act on an invitation, as SQL on `invitations` (organization ?O, actor ?A, app ?P): an OWNER; an ADMIN for a
 * role other than OWNER; or, with an app, that app's admin for a specific-apps invitation to that app alone.
 */
function mayHandle(org: string, actor: string, app: string): string {
  return `(EXISTS (SELECT 1 FROM memberships a WHERE a.org_id = ${org} AND a.user_id = ${actor}
      AND (a.role = 'OWNER' OR (a.role = 'ADMIN' AND invitations.role <> 'OWNER')))
    OR (${app} IS NOT NULL AND invitations.role = 'APPS'
      AND NOT EXISTS (SELECT 1 FROM invitation_grants og WHERE og.invitation_id = invitations.id AND og.app <> ${app})
      AND ${appAdmin(org, actor, app)}))`
}

/**
 * Who may invite for role `role` into organization `org`, as SQL (each argument names a parameter): an OWNER, or an ADMIN
 * for a role other than OWNER; with an app, that app's admin, for specific-apps access to it. `app` names the app
 * parameter too, so every statement binds it.
 */
function mayInvite(appName: string | null, org: string, role: string, actor: string, app: string): string {
  return appName
    ? `(${role} = 'APPS' AND ${appAdmin(org, actor, app)})`
    : `(${app} IS NULL AND EXISTS (SELECT 1 FROM memberships a WHERE a.org_id = ${org} AND a.user_id = ${actor}
        AND (a.role = 'OWNER' OR (a.role = 'ADMIN' AND ${role} <> 'OWNER'))))`
}

/** The grants of these invitations, by invitation id. */
export async function listInvitationGrants(db: D1Database, ids: string[]): Promise<Map<string, InvitationGrantRow[]>> {
  const grouped = new Map<string, InvitationGrantRow[]>()
  if (!ids.length) return grouped
  const { results } = await db.prepare(
    `SELECT g.invitation_id, g.app, g.role, g.custom_role_id, c.name AS custom_role_name
     FROM invitation_grants g LEFT JOIN custom_roles c ON c.id = g.custom_role_id
     WHERE g.invitation_id IN (SELECT value FROM json_each(?1)) ORDER BY g.app`,
  ).bind(JSON.stringify(ids)).all<InvitationGrantRow>()
  for (const row of results) grouped.set(row.invitation_id, [...(grouped.get(row.invitation_id) ?? []), row])
  return grouped
}

export function findInvitation(db: D1Database, id: string): Promise<InvitationRow | null> {
  return db.prepare(`${SELECT} WHERE i.id = ?1`).bind(id).first<InvitationRow>()
}

/** Pending invitations of an organization, newest first, including ones that have expired but were not answered. */
export async function listOrgInvitations(db: D1Database, orgId: string): Promise<InvitationRow[]> {
  const { results } = await db.prepare(`${SELECT} WHERE i.org_id = ?1 AND i.status = 'pending' ORDER BY i.created_at DESC`)
    .bind(orgId).all<InvitationRow>()
  return results
}

/** Open invitations for an e-mail address, for the invitee's home page. */
export async function listInvitationsFor(db: D1Database, email: string, now: number): Promise<InvitationRow[]> {
  const { results } = await db.prepare(
    `${SELECT} WHERE i.email = ?1 AND i.status = 'pending' AND i.expires_at > ?2 ORDER BY i.created_at DESC`,
  ).bind(email, now).all<InvitationRow>()
  return results
}

export async function countOpenInvitations(db: D1Database, orgId: string, now: number): Promise<number> {
  const row = await db.prepare("SELECT COUNT(*) AS count FROM invitations WHERE org_id = ?1 AND status = 'pending' AND expires_at > ?2")
    .bind(orgId, now).first<{ count: number }>()
  return row?.count ?? 0
}

/**
 * Creates a pending invitation, with its app grants for a specific-apps invitation, in one batch whose insert also
 * requires the inviter (`invitedBy`) still to be allowed to invite for this role (an OWNER, or an ADMIN for a non-OWNER
 * role; with `app`, that app's admin for an invitation to that app alone), the organization to have fewer than
 * `pendingLimit` open invitations, so concurrent requests cannot exceed it, and, while the organization invites only
 * people in its verified domains, the address to be in one of them now. An expired pending invitation for the same
 * address is closed first. False when a condition fails or an open invitation for the address exists (the partial
 * unique index allows one per organization and address).
 */
export async function insertInvitation(db: D1Database, invitation: {
  id: string
  orgId: string
  email: string
  role: Role
  grants: GrantInput[]
  /** An invitation made from an app's people page: its inviter needs only to be that app's admin. */
  app: string | null
  invitedBy: string
  now: number
  expiresAt: number
  pendingLimit: number
}): Promise<boolean> {
  const grants = JSON.stringify(invitation.grants.map((grant) => ({ app: grant.app, role: grant.role, customRoleId: grant.customRoleId })))
  // Closing an expired invitation for the address makes room for the new one; it too needs an inviter allowed now.
  const [, inserted] = await db.batch([
    db.prepare(
      `UPDATE invitations SET status = 'expired' WHERE org_id = ?1 AND email = ?2 AND status = 'pending' AND expires_at <= ?3
         AND ${mayInvite(invitation.app, '?1', '?4', '?5', '?6')}`,
    ).bind(invitation.orgId, invitation.email, invitation.now, invitation.role, invitation.invitedBy, invitation.app),
    db.prepare(
      `INSERT INTO invitations (id, org_id, email, role, invited_by, status, created_at, expires_at, last_sent_at)
       SELECT ?1, ?2, ?3, ?4, ?5, 'pending', ?6, ?7, ?6
       WHERE ${mayInvite(invitation.app, '?2', '?4', '?5', '?9')}
         AND (SELECT COUNT(*) FROM invitations p WHERE p.org_id = ?2 AND p.status = 'pending' AND p.expires_at > ?6) < ?8
         AND ${invitableDomain('?2', '?10')}
       ON CONFLICT DO NOTHING`,
    ).bind(invitation.id, invitation.orgId, invitation.email, invitation.role, invitation.invitedBy, invitation.now,
      invitation.expiresAt, invitation.pendingLimit, invitation.app, domainOf(invitation.email)),
    db.prepare(
      `INSERT INTO invitation_grants (invitation_id, org_id, app, role, custom_role_id)
       SELECT ?1, ?2, json_extract(value, '$.app'), json_extract(value, '$.role'), json_extract(value, '$.customRoleId')
       FROM json_each(?3)
       WHERE EXISTS (SELECT 1 FROM invitations i WHERE i.id = ?1 AND i.role = 'APPS' AND i.created_at = ?4)`,
    ).bind(invitation.id, invitation.orgId, grants, invitation.now),
  ])
  return (inserted?.meta.changes ?? 0) > 0
}

export async function deleteInvitation(db: D1Database, id: string): Promise<void> {
  await db.prepare('DELETE FROM invitations WHERE id = ?1').bind(id).run()
}

/**
 * Revokes a pending invitation if `actorId` may still handle it (an OWNER, or an ADMIN for a non-OWNER role; with
 * `app`, that app's admin for an invitation to that app alone).
 */
export async function revokeInvitation(db: D1Database, id: string, actorId: string, now: number, app: string | null = null): Promise<boolean> {
  const result = await db.prepare(
    `UPDATE invitations SET status = 'revoked', responded_at = ?2
     WHERE id = ?1 AND status = 'pending' AND ${mayHandle('invitations.org_id', '?3', '?4')}`,
  ).bind(id, now, actorId, app).run()
  return result.meta.changes > 0
}

/**
 * Claims a resend: succeeds once per `gap` milliseconds per invitation, even under concurrent requests, renews the
 * expiry, and requires `actorId` still to be allowed to handle the invitation and, while the organization invites only
 * people in its verified domains, the address to be in one of them now. `restoreResend` undoes it when the e-mail
 * could not be sent.
 */
export async function claimResend(db: D1Database, invitation: InvitationRow, actorId: string, now: number, gap: number, expiresAt: number, app: string | null = null): Promise<boolean> {
  const result = await db.prepare(
    `UPDATE invitations SET last_sent_at = ?3, expires_at = ?4
     WHERE id = ?1 AND status = 'pending' AND last_sent_at = ?2 AND ?3 - last_sent_at >= ?5
       AND ${mayHandle('invitations.org_id', '?6', '?7')}
       AND ${invitableDomain('invitations.org_id', '?8')}`,
  ).bind(invitation.id, invitation.last_sent_at, now, expiresAt, gap, actorId, app, domainOf(invitation.email)).run()
  return result.meta.changes > 0
}

export async function restoreResend(db: D1Database, invitation: InvitationRow, claimedAt: number): Promise<void> {
  await db.prepare('UPDATE invitations SET last_sent_at = ?2, expires_at = ?3 WHERE id = ?1 AND last_sent_at = ?4')
    .bind(invitation.id, invitation.last_sent_at, invitation.expires_at, claimedAt).run()
}

/**
 * Accepts for `userId`, whose verified address must be the invited one: adds the membership (unless they are a member
 * already, whose role stays) while the organization has room and, if it invites only people in its verified domains,
 * while the address is in one of them (an invitation made before that, or before a domain was removed, can't bring
 * anyone new in); for a specific-apps member, adds the invitation's apps they don't have yet; then marks the invitation
 * accepted, in one transaction. An organization role is never mixed with app grants: a member with one gains nothing
 * from a specific-apps invitation.
 */
export async function acceptInvitation(db: D1Database, id: string, userId: string, email: string, now: number, memberLimit: number): Promise<boolean> {
  const [, , accepted] = await db.batch([
    db.prepare(
      `INSERT INTO memberships (org_id, user_id, role, created_at, updated_at)
       SELECT i.org_id, ?2, i.role, ?3, ?3 FROM invitations i
       WHERE i.id = ?1 AND i.status = 'pending' AND i.expires_at > ?3 AND i.email = ?4
         AND (SELECT COUNT(*) FROM memberships m WHERE m.org_id = i.org_id) < ?5
         AND ${invitableDomain('i.org_id', '?6')}
         AND EXISTS (SELECT 1 FROM orgs io WHERE io.id = i.org_id AND io.status = 'active')
       ON CONFLICT DO NOTHING`,
    ).bind(id, userId, now, email, memberLimit, domainOf(email)),
    db.prepare(
      `INSERT INTO app_grants (org_id, user_id, app, role, custom_role_id, created_at, updated_at)
       SELECT i.org_id, ?2, g.app, g.role, g.custom_role_id, ?3, ?3
       FROM invitation_grants g JOIN invitations i ON i.id = g.invitation_id AND i.org_id = g.org_id
       WHERE g.invitation_id = ?1 AND i.status = 'pending' AND i.expires_at > ?3 AND i.email = ?4 AND i.role = 'APPS'
         AND (SELECT m.role FROM memberships m WHERE m.org_id = i.org_id AND m.user_id = ?2) = 'APPS'
         AND EXISTS (SELECT 1 FROM orgs io WHERE io.id = i.org_id AND io.status = 'active')
       ON CONFLICT DO NOTHING`,
    ).bind(id, userId, now, email),
    db.prepare(
      `UPDATE invitations SET status = 'accepted', responded_at = ?3
       WHERE id = ?1 AND status = 'pending' AND expires_at > ?3 AND email = ?4
         AND EXISTS (SELECT 1 FROM memberships m WHERE m.org_id = invitations.org_id AND m.user_id = ?2)`,
    ).bind(id, userId, now, email),
  ])
  return (accepted?.meta.changes ?? 0) > 0
}

export async function declineInvitation(db: D1Database, id: string, email: string, now: number): Promise<boolean> {
  const result = await db.prepare(
    "UPDATE invitations SET status = 'declined', responded_at = ?3 WHERE id = ?1 AND status = 'pending' AND email = ?2",
  ).bind(id, email, now).run()
  return result.meta.changes > 0
}
