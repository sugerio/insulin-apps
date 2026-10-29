// Invitations: OWNER and ADMIN invite an e-mail address with a role; only a signed-in user whose confirmed address is
// the invited one can accept. The link itself grants nothing.
import type { Context } from '../context.ts'
import { authUrl } from '../context.ts'
import { newId } from '../crypto.ts'
import {
  acceptInvitation as acceptForUser, claimResend, countOpenInvitations, declineInvitation as declineForUser,
  deleteInvitation, findInvitation, insertInvitation, restoreResend, revokeInvitation as markRevoked, type InvitationRow,
} from '../db/invitations.ts'
import { ORG_INVITATION_LIMIT, countOrgInvitationMail } from '../db/mail.ts'
import { countMembers, findMembership } from '../db/orgs.ts'
import { findUserByEmail } from '../db/users.ts'
import { field } from '../http/request.ts'
import { htmlResponse, redirect } from '../http/response.ts'
import { safeReturnTo } from '../http/return-to.ts'
import { log } from '../log.ts'
import { invitationMail } from '../mail/templates.ts'
import { sendMail } from '../mail/transport.ts'
import { MAIL_FAILED } from '../pages/auth.tsx'
import { invitationPage, type InvitationView } from '../pages/orgs.tsx'
import { afterPost, notFoundPage } from '../pages/status.tsx'
import { canHandleInvitation, canManageMembers, grantableRoles, isRole, ROLE_LABELS } from '../roles.ts'
import { requireSession } from '../auth/guard.ts'
import { loadSession, switchActiveOrg, type Session } from '../auth/session.ts'
import { normalizeEmail } from '../validate.ts'
import { actorChanged, backToOrg, memberOf, notAllowed, renderOrg } from './orgs.ts'

export const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000
export const RESEND_GAP_MS = 10 * 60 * 1000
export const PENDING_LIMIT = 50
export const MEMBER_LIMIT = 100

function invitationLink(ctx: Context, id: string): string {
  return authUrl(ctx, `/invitations/${id}`)
}

export async function invite(ctx: Context, [orgId]: string[]): Promise<Response> {
  const found = await memberOf(ctx, orgId!)
  if (found instanceof Response) return found
  const { session, membership } = found
  if (!canManageMembers(membership.role)) return notAllowed(ctx, session)
  const db = ctx.config.db
  const problem = (error: string, status: number) => renderOrg(ctx, session, membership, { error, status })

  const email = normalizeEmail(field(ctx.form, 'email'))
  if (!email) return problem('Enter a valid email address to invite.', 400)
  const role = field(ctx.form, 'role')
  if (!isRole(role)) return problem('Choose a role.', 400)
  if (!grantableRoles(membership.role).includes(role)) return problem(`Your role can't invite someone as ${ROLE_LABELS[role]}.`, 403)

  const invitee = await findUserByEmail(db, email)
  if (invitee && await findMembership(db, membership.org_id, invitee.id)) return problem('That person is already a member.', 409)
  if (await countMembers(db, membership.org_id) >= MEMBER_LIMIT) return problem(`This organization has reached its limit of ${MEMBER_LIMIT} members.`, 409)
  if (await countOpenInvitations(db, membership.org_id, ctx.now) >= PENDING_LIMIT) {
    return problem(`This organization already has ${PENDING_LIMIT} pending invitations. Revoke some before inviting more people.`, 409)
  }
  if (await countOrgInvitationMail(db, membership.org_id, ctx.now) >= ORG_INVITATION_LIMIT) {
    return problem(`This organization has sent ${ORG_INVITATION_LIMIT} invitation emails in the last day, the most allowed. Try again tomorrow.`, 429)
  }

  const id = newId()
  const created = await insertInvitation(db, {
    id, orgId: membership.org_id, email, role, invitedBy: session.user.id, now: ctx.now, expiresAt: ctx.now + INVITATION_TTL_MS, pendingLimit: PENDING_LIMIT,
  })
  if (!created) {
    // The insert re-checks the inviter's role and the pending cap itself; work out which condition stopped it.
    const changed = await actorChanged(ctx, session, membership)
    if (changed) return changed
    if (await countOpenInvitations(db, membership.org_id, ctx.now) >= PENDING_LIMIT) {
      return problem(`This organization already has ${PENDING_LIMIT} pending invitations. Revoke some before inviting more people.`, 409)
    }
    return problem('There is already a pending invitation for that address. You can resend it below.', 409)
  }
  const outcome = await sendMail(ctx, 'invitation', email, invitationMail(session.user.name, membership.org_name, role, invitationLink(ctx, id)), membership.org_id)
  if (outcome === 'failed') {
    await deleteInvitation(db, id)
    return problem(MAIL_FAILED, 503)
  }
  log('invitation_created', { org: membership.org_id, invitation: id, by: session.user.id, role, emailed: outcome === 'sent' })
  return backToOrg(ctx, membership.org_id, outcome === 'sent' ? 'invited' : 'invitation-saved')
}

/** A pending invitation of the member's organization that their role may handle, or the response to send instead. */
async function managedInvitation(ctx: Context, orgId: string, invitationId: string) {
  const found = await memberOf(ctx, orgId)
  if (found instanceof Response) return found
  const { session, membership } = found
  if (!canManageMembers(membership.role)) return notAllowed(ctx, session)
  const invitation = await findInvitation(ctx.config.db, invitationId)
  if (!invitation || invitation.org_id !== membership.org_id || invitation.status !== 'pending') return notFoundPage(ctx)
  if (!canHandleInvitation(membership.role, invitation.role)) return notAllowed(ctx, session)
  return { session, membership, invitation }
}

export async function revokeInvitation(ctx: Context, [orgId, invitationId]: string[]): Promise<Response> {
  const found = await managedInvitation(ctx, orgId!, invitationId!)
  if (found instanceof Response) return found
  if (!(await markRevoked(ctx.config.db, found.invitation.id, found.session.user.id, ctx.now))) {
    return (await actorChanged(ctx, found.session, found.membership)) ?? notFoundPage(ctx)
  }
  log('invitation_revoked', { org: found.membership.org_id, invitation: found.invitation.id, by: found.session.user.id })
  return backToOrg(ctx, found.membership.org_id, 'invitation-revoked')
}

export async function resendInvitation(ctx: Context, [orgId, invitationId]: string[]): Promise<Response> {
  const found = await managedInvitation(ctx, orgId!, invitationId!)
  if (found instanceof Response) return found
  const { session, membership, invitation } = found
  const db = ctx.config.db
  const problem = (error: string, status: number) => renderOrg(ctx, session, membership, { error, status })
  if (ctx.now - invitation.last_sent_at < RESEND_GAP_MS) return problem('An invitation can be sent again once every 10 minutes.', 429)
  if (!(await claimResend(db, invitation, session.user.id, ctx.now, RESEND_GAP_MS, ctx.now + INVITATION_TTL_MS))) {
    return (await actorChanged(ctx, session, membership)) ?? problem('An invitation can be sent again once every 10 minutes.', 429)
  }
  const outcome = await sendMail(ctx, 'invitation', invitation.email,
    invitationMail(session.user.name, membership.org_name, invitation.role, invitationLink(ctx, invitation.id)), membership.org_id)
  if (outcome !== 'sent') {
    await restoreResend(db, invitation, ctx.now)
    return problem(outcome === 'failed' ? MAIL_FAILED : 'We can\'t email that invitation right now: the address has received several emails recently, or this organization has sent its daily maximum. Try again later.', outcome === 'failed' ? 503 : 429)
  }
  log('invitation_resent', { org: membership.org_id, invitation: invitation.id, by: session.user.id })
  return backToOrg(ctx, membership.org_id, 'invitation-resent')
}

function isOpen(ctx: Context, invitation: InvitationRow | null): invitation is InvitationRow {
  return invitation !== null && invitation.status === 'pending' && invitation.expires_at > ctx.now
}

function viewFor(ctx: Context, session: Session | null, invitation: InvitationRow | null): InvitationView {
  if (!isOpen(ctx, invitation)) return 'closed'
  if (!session) return 'signed-out'
  return session.user.verified && session.user.email === invitation.email ? 'open' : 'mismatch'
}

const VIEW_STATUS: Record<InvitationView, number> = { 'signed-out': 200, open: 200, mismatch: 403, closed: 410 }

export async function invitationView(ctx: Context, [invitationId]: string[]): Promise<Response> {
  const invitation = await findInvitation(ctx.config.db, invitationId!)
  if (!invitation) return notFoundPage(ctx)
  const session = await loadSession(ctx)
  const view = viewFor(ctx, session, invitation)
  return htmlResponse(invitationPage(ctx, session, invitation, view), { status: VIEW_STATUS[view] })
}

async function answerable(ctx: Context, invitationId: string): Promise<{ session: Session; invitation: InvitationRow } | Response> {
  const session = await requireSession(ctx, invitationLink(ctx, invitationId))
  if (session instanceof Response) return session
  const invitation = await findInvitation(ctx.config.db, invitationId)
  if (!invitation) return notFoundPage(ctx)
  const view = viewFor(ctx, session, invitation)
  if (view !== 'open') return htmlResponse(invitationPage(ctx, session, invitation, view), { status: VIEW_STATUS[view] })
  return { session, invitation }
}

export async function acceptInvitation(ctx: Context, [invitationId]: string[]): Promise<Response> {
  const found = await answerable(ctx, invitationId!)
  if (found instanceof Response) return found
  const { session, invitation } = found
  const db = ctx.config.db
  if (!(await acceptForUser(db, invitation.id, session.user.id, session.user.email, ctx.now, MEMBER_LIMIT))) {
    const full = await countMembers(db, invitation.org_id) >= MEMBER_LIMIT
    const error = full ? `This organization has reached its limit of ${MEMBER_LIMIT} members. Ask its owners to make room.` : null
    const fresh = await findInvitation(db, invitation.id)
    return htmlResponse(invitationPage(ctx, session, fresh, full ? 'open' : 'closed', error), { status: 409 })
  }
  const membership = await findMembership(db, invitation.org_id, session.user.id)
  if (membership) await switchActiveOrg(ctx, session, { id: membership.org_id, name: membership.org_name, role: membership.role })
  log('invitation_accepted', { org: invitation.org_id, invitation: invitation.id, user: session.user.id })
  return afterPost(ctx, safeReturnTo(ctx, field(ctx.form, 'return_to')) ?? authUrl(ctx, `/orgs/${invitation.org_id}?notice=joined`))
}

export async function declineInvitation(ctx: Context, [invitationId]: string[]): Promise<Response> {
  const found = await answerable(ctx, invitationId!)
  if (found instanceof Response) return found
  await declineForUser(ctx.config.db, found.invitation.id, found.session.user.email, ctx.now)
  log('invitation_declined', { org: found.invitation.org_id, invitation: found.invitation.id, user: found.session.user.id })
  return redirect(authUrl(ctx, '/?notice=invitation-declined'), 303)
}
