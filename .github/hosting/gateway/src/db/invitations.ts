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
 * Creates a pending invitation, in one statement that also requires the inviter (`invitedBy`) still to be allowed to
 * invite for this role (an OWNER, or an ADMIN for a non-OWNER role) and the organization to have fewer than
 * `pendingLimit` open invitations, so concurrent requests cannot exceed it. An expired pending invitation for the same
 * address is closed first. False when a condition fails or an open invitation for the address exists (the partial
 * unique index allows one per organization and address).
 */
export async function insertInvitation(db: D1Database, invitation: {
  id: string
  orgId: string
  email: string
  role: Role
  invitedBy: string
  now: number
  expiresAt: number
  pendingLimit: number
}): Promise<boolean> {
  const [, inserted] = await db.batch([
    db.prepare("UPDATE invitations SET status = 'expired' WHERE org_id = ?1 AND email = ?2 AND status = 'pending' AND expires_at <= ?3")
      .bind(invitation.orgId, invitation.email, invitation.now),
    db.prepare(
      `INSERT INTO invitations (id, org_id, email, role, invited_by, status, created_at, expires_at, last_sent_at)
       SELECT ?1, ?2, ?3, ?4, ?5, 'pending', ?6, ?7, ?6
       WHERE EXISTS (SELECT 1 FROM memberships a WHERE a.org_id = ?2 AND a.user_id = ?5
           AND (a.role = 'OWNER' OR (a.role = 'ADMIN' AND ?4 <> 'OWNER')))
         AND (SELECT COUNT(*) FROM invitations p WHERE p.org_id = ?2 AND p.status = 'pending' AND p.expires_at > ?6) < ?8
       ON CONFLICT DO NOTHING`,
    ).bind(invitation.id, invitation.orgId, invitation.email, invitation.role, invitation.invitedBy, invitation.now, invitation.expiresAt, invitation.pendingLimit),
  ])
  return (inserted?.meta.changes ?? 0) > 0
}

export async function deleteInvitation(db: D1Database, id: string): Promise<void> {
  await db.prepare('DELETE FROM invitations WHERE id = ?1').bind(id).run()
}

/** Revokes a pending invitation if `actorId` may still handle it (an OWNER, or an ADMIN for a non-OWNER role). */
export async function revokeInvitation(db: D1Database, id: string, actorId: string, now: number): Promise<boolean> {
  const result = await db.prepare(
    `UPDATE invitations SET status = 'revoked', responded_at = ?2
     WHERE id = ?1 AND status = 'pending'
       AND EXISTS (SELECT 1 FROM memberships a WHERE a.org_id = invitations.org_id AND a.user_id = ?3
         AND (a.role = 'OWNER' OR (a.role = 'ADMIN' AND invitations.role <> 'OWNER')))`,
  ).bind(id, now, actorId).run()
  return result.meta.changes > 0
}

/**
 * Claims a resend: succeeds once per `gap` milliseconds per invitation, even under concurrent requests, renews the
 * expiry, and requires `actorId` still to be allowed to handle the invitation. `restoreResend` undoes it when the
 * e-mail could not be sent.
 */
export async function claimResend(db: D1Database, invitation: InvitationRow, actorId: string, now: number, gap: number, expiresAt: number): Promise<boolean> {
  const result = await db.prepare(
    `UPDATE invitations SET last_sent_at = ?3, expires_at = ?4
     WHERE id = ?1 AND status = 'pending' AND last_sent_at = ?2 AND ?3 - last_sent_at >= ?5
       AND EXISTS (SELECT 1 FROM memberships a WHERE a.org_id = invitations.org_id AND a.user_id = ?6
         AND (a.role = 'OWNER' OR (a.role = 'ADMIN' AND invitations.role <> 'OWNER')))`,
  ).bind(invitation.id, invitation.last_sent_at, now, expiresAt, gap, actorId).run()
  return result.meta.changes > 0
}

export async function restoreResend(db: D1Database, invitation: InvitationRow, claimedAt: number): Promise<void> {
  await db.prepare('UPDATE invitations SET last_sent_at = ?2, expires_at = ?3 WHERE id = ?1 AND last_sent_at = ?4')
    .bind(invitation.id, invitation.last_sent_at, invitation.expires_at, claimedAt).run()
}

/**
 * Accepts for `userId`, whose verified address must be the invited one: adds the membership (unless they are a member
 * already, whose role stays) while the organization has room, then marks the invitation accepted, in one transaction.
 */
export async function acceptInvitation(db: D1Database, id: string, userId: string, email: string, now: number, memberLimit: number): Promise<boolean> {
  const [, accepted] = await db.batch([
    db.prepare(
      `INSERT INTO memberships (org_id, user_id, role, created_at, updated_at)
       SELECT i.org_id, ?2, i.role, ?3, ?3 FROM invitations i
       WHERE i.id = ?1 AND i.status = 'pending' AND i.expires_at > ?3 AND i.email = ?4
         AND (SELECT COUNT(*) FROM memberships m WHERE m.org_id = i.org_id) < ?5
       ON CONFLICT DO NOTHING`,
    ).bind(id, userId, now, email, memberLimit),
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
