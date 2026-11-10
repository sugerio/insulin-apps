// <app>.<domain>/settings/users (DESIGN.md §3): everyone who can use the app in the active organization. People whose
// access comes from their organization role are listed but managed on the apex; the app's admins invite people to this
// app, change their role in it and remove them from it. Forms carry the organization's id, so a switch of the active
// organization in another tab can't redirect a change.
import { appAccess, type AppAccess } from '../access.ts'
import type { HostedApp } from '../config.ts'
import type { Context } from '../context.ts'
import { apexUrl } from '../context.ts'
import { newId } from '../crypto.ts'
import { listAppGrants, listCustomRoles, removeGrant, upsertGrant } from '../db/grants.ts'
import {
  claimResend, countOpenInvitations, deleteInvitation, findInvitation, insertInvitation, listInvitationGrants,
  listOrgInvitations, restoreResend, revokeInvitation, type InvitationRow,
} from '../db/invitations.ts'
import { ORG_INVITATION_LIMIT, countOrgInvitationMail } from '../db/mail.ts'
import { countMembers, findMembership, listMembers, listMemberships, type MembershipRow } from '../db/orgs.ts'
import { findUserByEmail } from '../db/users.ts'
import { field } from '../http/request.ts'
import { htmlResponse, redirect } from '../http/response.ts'
import { log } from '../log.ts'
import { invitationMail } from '../mail/templates.ts'
import { sendMail } from '../mail/transport.ts'
import { MAIL_FAILED } from '../pages/auth.tsx'
import { appUsersPage } from '../pages/app-settings.tsx'
import { noAppAccessPage, notAllowedPage, notFoundPage } from '../pages/status.tsx'
import { canHandleInvitation } from '../roles.ts'
import { requireSession } from '../auth/guard.ts'
import { activeOrg, type Session } from '../auth/session.ts'
import { normalizeEmail } from '../validate.ts'
import { accessPhrase, grantLabel, parseGrant } from './access-forms.ts'
import { INVITATION_TTL_MS, MEMBER_LIMIT, PENDING_LIMIT, RESEND_GAP_MS, invitationLink } from './invitations.ts'
import type { Problem } from './orgs.ts'

const NOTICES: Record<string, string> = {
  invited: 'Invitation sent.',
  'invitation-saved': 'Invitation saved, but we couldn\'t email it right now: that address has received several emails recently. Use Resend later.',
  'access-added': 'They have access to this app now.',
  'role-changed': 'The role was changed.',
  removed: 'They no longer have access to this app.',
  'invitation-revoked': 'Invitation revoked.',
  'invitation-resent': 'Invitation sent again.',
}

export interface AppMember {
  session: Session
  membership: MembershipRow
  access: AppAccess
}

/** The signed-in user's access to this app in `orgId` (the active organization, or a form's), or the page to show. */
export async function appMember(ctx: Context, app: HostedApp, orgId: string | null): Promise<AppMember | Response> {
  const session = await requireSession(ctx)
  if (session instanceof Response) return session
  const id = orgId ?? (await activeOrg(ctx, session))?.id
  if (!id) return redirect(apexUrl(ctx, '/orgs/new'), 302)
  const membership = await findMembership(ctx.config.db, id, session.user.id)
  if (!membership) return notFoundPage(ctx)
  const access = await appAccess(ctx.config.db, app, membership.org_id, session.user.id, membership.role)
  if (!access) return noAppAccessPage(ctx, session, { id: membership.org_id, name: membership.org_name, role: membership.role }, app)
  return { session, membership, access }
}

/** An app admin, for a POST: the organization comes from the form. */
export async function appAdminOf(ctx: Context, app: HostedApp): Promise<AppMember | Response> {
  const found = await appMember(ctx, app, field(ctx.form, 'org_id') || null)
  if (found instanceof Response) return found
  return found.access.admin ? found : notAllowedPage(ctx, found.session)
}

/** Pending invitations that give this app (an organization role reaches every app, so those count too). */
function forThisApp(invitations: InvitationRow[], grants: Map<string, { app: string }[]>, app: HostedApp): InvitationRow[] {
  return invitations.filter((invitation) => invitation.role !== 'APPS' || (grants.get(invitation.id) ?? []).some((grant) => grant.app === app.name))
}

export async function renderAppUsers(ctx: Context, app: HostedApp, member: AppMember, problem: Problem | null = null): Promise<Response> {
  const db = ctx.config.db
  const orgId = member.membership.org_id
  const [members, grants, customRoles, invitations, memberships] = await Promise.all([
    listMembers(db, orgId),
    listAppGrants(db, orgId, app.name),
    listCustomRoles(db, orgId),
    member.access.admin ? listOrgInvitations(db, orgId) : Promise.resolve([]),
    listMemberships(db, member.session.user.id),
  ])
  const invitationGrants = await listInvitationGrants(db, invitations.map((invitation) => invitation.id))
  return htmlResponse(appUsersPage(ctx, member.session, app, {
    orgId,
    orgName: member.membership.org_name,
    orgRole: member.membership.role,
    access: member.access,
    members,
    grants,
    customRoles: customRoles.filter((role) => role.app === app.name),
    invitations: member.access.admin ? forThisApp(invitations, invitationGrants, app) : [],
    invitationGrants,
    notice: problem ? null : NOTICES[ctx.url.searchParams.get('notice') ?? ''] ?? null,
    error: problem?.error ?? null,
  }, memberships), { status: problem?.status ?? 200 })
}

function back(notice: string): Response {
  return redirect(`/settings/users?notice=${notice}`, 303)
}

export async function appUsers(ctx: Context): Promise<Response> {
  const app = ctx.app!
  const found = await appMember(ctx, app, null)
  if (found instanceof Response) return found
  return renderAppUsers(ctx, app, found)
}

export async function inviteToApp(ctx: Context): Promise<Response> {
  const app = ctx.app!
  const found = await appAdminOf(ctx, app)
  if (found instanceof Response) return found
  const { session, membership } = found
  const db = ctx.config.db
  const orgId = membership.org_id
  const problem = (error: string, status: number) => renderAppUsers(ctx, app, found, { error, status })

  const email = normalizeEmail(field(ctx.form, 'email'))
  if (!email) return problem('Enter a valid email address to invite.', 400)
  const customRoles = await listCustomRoles(db, orgId)
  const grant = parseGrant(app, field(ctx.form, 'role'), customRoles)
  if (!grant || grant === 'invalid') return problem('Choose a role.', 400)

  const invitee = await findUserByEmail(db, email)
  const existing = invitee ? await findMembership(db, orgId, invitee.id) : null
  if (existing && invitee) {
    if (existing.role !== 'APPS') return problem('That person already has access to every app through their organization role.', 409)
    if (!(await upsertGrant(db, { orgId, userId: invitee.id, grant, actorId: session.user.id, now: ctx.now }))) {
      return (await stillAdmin(ctx, app, found)) ?? problem('That person\'s access changed meanwhile. Reload the page and try again.', 409)
    }
    log('app_access_added', { org: orgId, app: app.name, user: invitee.id, by: session.user.id })
    return back('access-added')
  }
  if (await countMembers(db, orgId) >= MEMBER_LIMIT) return problem(`This organization has reached its limit of ${MEMBER_LIMIT} members.`, 409)
  const pendingFull = `This organization already has ${PENDING_LIMIT} pending invitations. Revoke some before inviting more people.`
  if (await countOpenInvitations(db, orgId, ctx.now) >= PENDING_LIMIT) return problem(pendingFull, 409)
  if (await countOrgInvitationMail(db, orgId, ctx.now) >= ORG_INVITATION_LIMIT) {
    return problem(`This organization has sent ${ORG_INVITATION_LIMIT} invitation emails in the last day, the most allowed. Try again tomorrow.`, 429)
  }
  const id = newId()
  if (!(await insertInvitation(db, {
    id, orgId, email, role: 'APPS', grants: [grant], app: app.name, invitedBy: session.user.id, now: ctx.now, expiresAt: ctx.now + INVITATION_TTL_MS, pendingLimit: PENDING_LIMIT,
  }))) {
    const changed = await stillAdmin(ctx, app, found)
    if (changed) return changed
    if (await countOpenInvitations(db, orgId, ctx.now) >= PENDING_LIMIT) return problem(pendingFull, 409)
    return problem('There is already a pending invitation for that address.', 409)
  }
  const label = grantLabel({ role: grant.role, custom_role_name: customRoles.find((role) => role.id === grant.customRoleId)?.name ?? null })
  const phrase = accessPhrase(ctx.config, 'APPS', [{ app: app.name, role: grant.role, custom_role_name: label }])
  const outcome = await sendMail(ctx, 'invitation', email, invitationMail(session.user.name, membership.org_name, phrase, invitationLink(ctx, id)), orgId)
  if (outcome === 'failed') {
    await deleteInvitation(db, id)
    return problem(MAIL_FAILED, 503)
  }
  log('invitation_created', { org: orgId, invitation: id, by: session.user.id, role: 'APPS', app: app.name, emailed: outcome === 'sent' })
  return back(outcome === 'sent' ? 'invited' : 'invitation-saved')
}

/** After a guarded write changed nothing: the actor's own access to the app changed meanwhile, or null. */
export async function stillAdmin(ctx: Context, app: HostedApp, member: AppMember): Promise<Response | null> {
  const fresh = await appAccess(ctx.config.db, app, member.membership.org_id, member.session.user.id)
  if (fresh?.admin) return null
  return notAllowedPage(ctx, member.session)
}

/** A specific-apps member with a grant for this app, whom the actor manages here. */
async function appGrantee(ctx: Context, app: HostedApp, member: AppMember, userId: string) {
  const target = await findMembership(ctx.config.db, member.membership.org_id, userId)
  if (!target || target.role !== 'APPS') return null
  const grants = await listAppGrants(ctx.config.db, member.membership.org_id, app.name)
  return grants.find((grant) => grant.user_id === userId) ?? null
}

export async function changeAppRole(ctx: Context, [userId]: string[]): Promise<Response> {
  const app = ctx.app!
  const found = await appAdminOf(ctx, app)
  if (found instanceof Response) return found
  const orgId = found.membership.org_id
  if (!(await appGrantee(ctx, app, found, userId!))) return notFoundPage(ctx)
  const grant = parseGrant(app, field(ctx.form, 'role'), await listCustomRoles(ctx.config.db, orgId))
  if (!grant || grant === 'invalid') return renderAppUsers(ctx, app, found, { error: 'Choose a role.', status: 400 })
  if (!(await upsertGrant(ctx.config.db, { orgId, userId: userId!, grant, actorId: found.session.user.id, now: ctx.now }))) {
    return (await stillAdmin(ctx, app, found)) ?? notFoundPage(ctx)
  }
  log('app_role_changed', { org: orgId, app: app.name, user: userId, by: found.session.user.id })
  return back('role-changed')
}

export async function removeFromApp(ctx: Context, [userId]: string[]): Promise<Response> {
  const app = ctx.app!
  const found = await appAdminOf(ctx, app)
  if (found instanceof Response) return found
  const orgId = found.membership.org_id
  if (!(await appGrantee(ctx, app, found, userId!))) return notFoundPage(ctx)
  if (!(await removeGrant(ctx.config.db, { orgId, userId: userId!, app: app.name, actorId: found.session.user.id }))) {
    return (await stillAdmin(ctx, app, found)) ?? notFoundPage(ctx)
  }
  log('app_access_removed', { org: orgId, app: app.name, user: userId, by: found.session.user.id })
  return back('removed')
}

/**
 * A pending invitation the actor may handle from this app's page: as an OWNER or ADMIN, any their role reaches; as the
 * app's admin otherwise, one that gives this app alone.
 */
async function appInvitation(ctx: Context, app: HostedApp, member: AppMember, invitationId: string): Promise<InvitationRow | null> {
  const invitation = await findInvitation(ctx.config.db, invitationId)
  if (!invitation || invitation.org_id !== member.membership.org_id || invitation.status !== 'pending') return null
  if (canHandleInvitation(member.membership.role, invitation.role)) return invitation
  const grants = (await listInvitationGrants(ctx.config.db, [invitation.id])).get(invitation.id) ?? []
  return invitation.role === 'APPS' && grants.length > 0 && grants.every((grant) => grant.app === app.name) ? invitation : null
}

export async function revokeAppInvitation(ctx: Context, [invitationId]: string[]): Promise<Response> {
  const app = ctx.app!
  const found = await appAdminOf(ctx, app)
  if (found instanceof Response) return found
  const invitation = await appInvitation(ctx, app, found, invitationId!)
  if (!invitation) return notFoundPage(ctx)
  if (!(await revokeInvitation(ctx.config.db, invitation.id, found.session.user.id, ctx.now, app.name))) {
    return (await stillAdmin(ctx, app, found)) ?? notFoundPage(ctx)
  }
  log('invitation_revoked', { org: found.membership.org_id, invitation: invitation.id, by: found.session.user.id, app: app.name })
  return back('invitation-revoked')
}

export async function resendAppInvitation(ctx: Context, [invitationId]: string[]): Promise<Response> {
  const app = ctx.app!
  const found = await appAdminOf(ctx, app)
  if (found instanceof Response) return found
  const db = ctx.config.db
  const invitation = await appInvitation(ctx, app, found, invitationId!)
  if (!invitation) return notFoundPage(ctx)
  const tooSoon = 'An invitation can be sent again once every 10 minutes.'
  if (ctx.now - invitation.last_sent_at < RESEND_GAP_MS) return renderAppUsers(ctx, app, found, { error: tooSoon, status: 429 })
  if (!(await claimResend(db, invitation, found.session.user.id, ctx.now, RESEND_GAP_MS, ctx.now + INVITATION_TTL_MS, app.name))) {
    return (await stillAdmin(ctx, app, found)) ?? renderAppUsers(ctx, app, found, { error: tooSoon, status: 429 })
  }
  const grants = (await listInvitationGrants(db, [invitation.id])).get(invitation.id) ?? []
  const outcome = await sendMail(ctx, 'invitation', invitation.email,
    invitationMail(found.session.user.name, found.membership.org_name, accessPhrase(ctx.config, invitation.role, grants), invitationLink(ctx, invitation.id)), invitation.org_id)
  if (outcome !== 'sent') {
    await restoreResend(db, invitation, ctx.now)
    return renderAppUsers(ctx, app, found, {
      error: outcome === 'failed' ? MAIL_FAILED : 'We can\'t email that invitation right now: the address has received several emails recently, or this organization has sent its daily maximum. Try again later.',
      status: outcome === 'failed' ? 503 : 429,
    })
  }
  log('invitation_resent', { org: invitation.org_id, invitation: invitation.id, by: found.session.user.id, app: app.name })
  return back('invitation-resent')
}
