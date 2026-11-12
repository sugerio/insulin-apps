// Organizations: create, switch, the settings pages (people, roles, the organization itself), rename, delete, leave,
// and members' access: an organization role, or specific apps with a role in each.
import type { Context } from '../context.ts'
import { apexUrl } from '../context.ts'
import { newId } from '../crypto.ts'
import { customRoleUse, listCustomRoles, listOrgGrants, listUserGrants } from '../db/grants.ts'
import { listInvitationGrants, listInvitationsFor, listOrgInvitations } from '../db/invitations.ts'
import { ORG_REQUEST_DAILY_LIMIT, countOrgRequests } from '../db/mail.ts'
import {
  changeRole, countOwners, createOrg as insertOrg, deleteOrg as removeOrg, findMembership, invitePolicy,
  leaveOrg as leaveMembership, listMembers, orgAllowance, removeMember as removeMembership,
  renameOrg as updateOrgName, setAppAccess, setInviteVerifiedDomainsOnly, type MembershipRow,
} from '../db/orgs.ts'
import { field } from '../http/request.ts'
import { htmlResponse, redirect } from '../http/response.ts'
import { safeReturnTo } from '../http/return-to.ts'
import { log } from '../log.ts'
import { loadShell, type ShellData } from '../navigation.ts'
import { orgRequestMail } from '../mail/templates.ts'
import { sendOrgRequest } from '../mail/transport.ts'
import { MAIL_FAILED } from '../pages/auth.tsx'
import { newOrgPage, orgSettingsPage, rolesPage, usersPage, type NewOrgState, type OrgLimitView, type SettingsTab } from '../pages/settings.tsx'
import { actorChangedPage, afterPost, home, notAllowedPage, notFoundPage } from '../pages/status.tsx'
import { allowAuth } from '../ratelimit.ts'
import {
  canChangeRole, canDeleteOrg, canManageMembers, canRemoveMember, canRenameOrg, canSeeMembers, canSetInvitePolicy,
} from '../roles.ts'
import { requireSession } from '../auth/guard.ts'
import { activeOrg, switchActiveOrg, type Session } from '../auth/session.ts'
import { checkOrgName, checkOrgRequestReason, truncate } from '../validate.ts'
import { parseAccessForm } from './access-forms.ts'

const NOTICES: Record<string, string> = {
  created: 'Your organization is ready. Invite people below, or open an app.',
  renamed: 'The organization was renamed.',
  'invite-domains-on': 'Only people with an address in your verified domains can be invited now.',
  'invite-domains-off': 'People with any address can be invited again.',
  'role-changed': 'The access was changed.',
  'member-removed': 'The member was removed.',
  invited: 'Invitation sent.',
  'invitation-saved': 'Invitation saved, but we couldn\'t email it right now: that address has received several emails recently. Use Resend later.',
  'invitation-revoked': 'Invitation revoked.',
  'invitation-resent': 'Invitation sent again.',
  joined: 'You joined the organization.',
  'role-created': 'The custom role was created.',
  'role-updated': 'The custom role was saved.',
  'role-deleted': 'The custom role was deleted.',
}

export interface Problem {
  error: string
  status: number
}

/** The signed-in user's membership in `orgId`; anyone else gets a 404, so organization ids reveal nothing. */
export async function memberOf(ctx: Context, orgId: string): Promise<{ session: Session; membership: MembershipRow } | Response> {
  const session = await requireSession(ctx)
  if (session instanceof Response) return session
  const membership = await findMembership(ctx.config.db, orgId, session.user.id)
  if (!membership) return notFoundPage(ctx)
  return { session, membership }
}

export function notAllowed(ctx: Context, session: Session): Response {
  return notAllowedPage(ctx, session)
}

/**
 * After a guarded mutation changed nothing: if the actor's own membership changed since the request read it (they were
 * removed or given another role meanwhile), say so; otherwise null, and the caller explains its own condition.
 */
export async function actorChanged(ctx: Context, session: Session, membership: MembershipRow): Promise<Response | null> {
  const current = await findMembership(ctx.config.db, membership.org_id, session.user.id)
  if (!current) return notFoundPage(ctx)
  if (current.role === membership.role) return null
  return actorChangedPage(ctx, session, membership.org_id)
}

const TAB_PATHS: Record<SettingsTab, string> = {
  users: '/settings/users',
  roles: '/settings/roles',
  organization: '/settings/organization',
  sso: '/settings/sso',
}

export function settingsUrl(ctx: Context, tab: SettingsTab, orgId: string, notice?: string): string {
  return apexUrl(ctx, `${TAB_PATHS[tab]}?org=${orgId}${notice ? `&notice=${notice}` : ''}`)
}

export function backTo(ctx: Context, tab: SettingsTab, orgId: string, notice: string): Response {
  return redirect(settingsUrl(ctx, tab, orgId, notice), 303)
}

/** The organization a settings page shows: `?org=` when the user is a member of it, else the active one. */
export async function settingsOrg(ctx: Context): Promise<{ session: Session; membership: MembershipRow } | Response> {
  const session = await requireSession(ctx)
  if (session instanceof Response) return session
  const wanted = ctx.url.searchParams.get('org')
  if (wanted) {
    const membership = await findMembership(ctx.config.db, wanted, session.user.id)
    return membership ? { session, membership } : notFoundPage(ctx)
  }
  const active = await activeOrg(ctx, session)
  if (!active) return redirect(apexUrl(ctx, '/orgs/new'), 302)
  const membership = await findMembership(ctx.config.db, active.id, session.user.id)
  return membership ? { session, membership } : notFoundPage(ctx)
}

function notice(ctx: Context, problem: Problem | null): string | null {
  return problem ? null : NOTICES[ctx.url.searchParams.get('notice') ?? ''] ?? null
}

/** Whether the page's organization is the active one, and the navigation's data, in that organization. */
export async function frame(ctx: Context, session: Session, membership: MembershipRow): Promise<{ active: boolean; shell: ShellData }> {
  const [active, shell] = await Promise.all([
    activeOrg(ctx, session),
    loadShell(ctx, session, { org: { id: membership.org_id, name: membership.org_name, role: membership.role } }),
  ])
  return { active: active?.id === membership.org_id, shell }
}

/** /settings/users: the people, as the member's role allows; also used to show a problem with a submitted form. */
export async function renderUsers(ctx: Context, session: Session, membership: MembershipRow, problem: Problem | null = null): Promise<Response> {
  const db = ctx.config.db
  const role = membership.role
  const orgId = membership.org_id
  const manage = canManageMembers(role)
  const [members, grants, invitations, customRoles, ownerCount, myGrants, chrome] = await Promise.all([
    canSeeMembers(role) ? listMembers(db, orgId) : Promise.resolve(null),
    canSeeMembers(role) ? listOrgGrants(db, orgId) : Promise.resolve([]),
    manage ? listOrgInvitations(db, orgId) : Promise.resolve(null),
    listCustomRoles(db, orgId),
    countOwners(db, orgId),
    role === 'APPS' ? listUserGrants(db, orgId, session.user.id) : Promise.resolve([]),
    frame(ctx, session, membership),
  ])
  const invitationGrants = invitations ? await listInvitationGrants(db, invitations.map((invitation) => invitation.id)) : new Map()
  return htmlResponse(usersPage(ctx, session, {
    orgId,
    orgName: membership.org_name,
    role,
    active: chrome.active,
    members,
    grants,
    invitations,
    invitationGrants,
    customRoles,
    ownerCount,
    myGrants,
    notice: notice(ctx, problem),
    error: problem?.error ?? null,
  }, chrome.shell), { status: problem?.status ?? 200 })
}

/** /settings/roles: the built-in roles, each app's permissions and the custom roles. */
export async function renderRoles(ctx: Context, session: Session, membership: MembershipRow, problem: Problem | null = null): Promise<Response> {
  const db = ctx.config.db
  const [customRoles, uses, chrome] = await Promise.all([
    listCustomRoles(db, membership.org_id),
    customRoleUse(db, membership.org_id, ctx.now),
    frame(ctx, session, membership),
  ])
  return htmlResponse(rolesPage(ctx, session, {
    orgId: membership.org_id,
    orgName: membership.org_name,
    role: membership.role,
    active: chrome.active,
    customRoles,
    uses,
    notice: notice(ctx, problem),
    error: problem?.error ?? null,
  }, chrome.shell), { status: problem?.status ?? 200 })
}

/** /settings/organization: its name, who can be invited (owners), leaving it, deleting it. */
export async function renderOrganization(ctx: Context, session: Session, membership: MembershipRow, problem: Problem | null = null): Promise<Response> {
  const db = ctx.config.db
  const [ownerCount, policy, chrome] = await Promise.all([
    countOwners(db, membership.org_id), invitePolicy(db, membership.org_id), frame(ctx, session, membership),
  ])
  return htmlResponse(orgSettingsPage(ctx, session, {
    orgId: membership.org_id,
    orgName: membership.org_name,
    role: membership.role,
    active: chrome.active,
    ownerCount,
    invitePolicy: policy,
    notice: notice(ctx, problem),
    error: problem?.error ?? null,
  }, chrome.shell), { status: problem?.status ?? 200 })
}

export async function usersSettings(ctx: Context): Promise<Response> {
  const found = await settingsOrg(ctx)
  if (found instanceof Response) return found
  return renderUsers(ctx, found.session, found.membership)
}

export async function rolesSettings(ctx: Context): Promise<Response> {
  const found = await settingsOrg(ctx)
  if (found instanceof Response) return found
  if (!canSeeMembers(found.membership.role)) return renderUsers(ctx, found.session, found.membership)
  return renderRoles(ctx, found.session, found.membership)
}

export async function organizationSettings(ctx: Context): Promise<Response> {
  const found = await settingsOrg(ctx)
  if (found instanceof Response) return found
  return renderOrganization(ctx, found.session, found.membership)
}

const NEW_ORG_NOTICES: Record<string, string> = {
  'request-sent': 'We\'ve sent your request to Insulin Apps support. They\'ll reply by email.',
}

/** The signed-in user's owner domain when it has all the organizations it may have (DESIGN.md §3.1), else null. */
async function orgLimit(ctx: Context, session: Session): Promise<OrgLimitView | null> {
  const { ownerDomain, count, max } = await orgAllowance(ctx.config.db, session.user.email)
  if (count < max) return null
  return { ownerDomain, personal: ownerDomain.includes('@'), count, max, canRequest: ctx.config.orgRequestEmail !== null }
}

/** /orgs/new: the form, or at the owner domain's limit the request for more; with the invitations waiting. */
async function renderNewOrg(ctx: Context, session: Session, state: NewOrgState, status = 200): Promise<Response> {
  const db = ctx.config.db
  const [invitations, limit, shell] = await Promise.all([
    listInvitationsFor(db, session.user.email, ctx.now), state.limit === undefined ? orgLimit(ctx, session) : state.limit, loadShell(ctx, session),
  ])
  const grants = await listInvitationGrants(db, invitations.map((invitation) => invitation.id))
  return htmlResponse(newOrgPage(ctx, session, invitations, grants, shell, { ...state, limit }), { status })
}

export async function newOrgForm(ctx: Context): Promise<Response> {
  const session = await requireSession(ctx)
  if (session instanceof Response) return session
  return renderNewOrg(ctx, session, {
    returnTo: safeReturnTo(ctx, ctx.url.searchParams.get('return_to')),
    notice: NEW_ORG_NOTICES[ctx.url.searchParams.get('notice') ?? ''] ?? null,
  })
}

export async function createOrg(ctx: Context): Promise<Response> {
  const session = await requireSession(ctx)
  if (session instanceof Response) return session
  const returnTo = safeReturnTo(ctx, field(ctx.form, 'return_to'))
  const checked = checkOrgName(field(ctx.form, 'name'))
  if ('problem' in checked) {
    return renderNewOrg(ctx, session, { name: truncate(field(ctx.form, 'name'), 200), error: checked.problem, returnTo }, 400)
  }
  const id = newId()
  // The insert counts the owner domain's organizations itself, so concurrent creations can't go past its limit.
  if (!(await insertOrg(ctx.config.db, { id, name: checked.name, userId: session.user.id, email: session.user.email, now: ctx.now }))) {
    const limit = await orgLimit(ctx, session)
    const error = limit?.personal
      ? 'Your email address has all the organizations it may create.'
      : 'Your email domain has all the organizations it may create.'
    log('org_limit_reached', { user: session.user.id })
    return renderNewOrg(ctx, session, { name: checked.name, error, returnTo, limit }, 409)
  }
  await switchActiveOrg(ctx, session, { id, name: checked.name, role: 'OWNER' })
  log('org_created', { org: id, user: session.user.id })
  return afterPost(ctx, returnTo ?? settingsUrl(ctx, 'users', id, 'created'))
}

/**
 * POST /orgs/request: at the owner domain's limit, asks Insulin Apps support (ORG_REQUEST_EMAIL) for more, with the
 * requester's name, address, owner domain and its count, the name wanted and why, and Reply-To set to them. Each day
 * at most ORG_REQUEST_DAILY_LIMIT per person, ORG_REQUEST_DOMAIN_DAILY_LIMIT per owner domain and
 * ORG_REQUEST_GLOBAL_DAILY_LIMIT in all (db/mail.ts), and RL_AUTH per person and IP.
 */
export async function requestMoreOrgs(ctx: Context): Promise<Response> {
  const session = await requireSession(ctx)
  if (session instanceof Response) return session
  const to = ctx.config.orgRequestEmail
  const limit = await orgLimit(ctx, session)
  // Below the limit there is nothing to ask for, and without the address there is no form: the page says what to do.
  if (!to || !limit) return redirect(apexUrl(ctx, '/orgs/new'), 303)
  const name = checkOrgName(field(ctx.form, 'name'))
  const reason = checkOrgRequestReason(field(ctx.form, 'reason'))
  const again = (error: string, status: number) => renderNewOrg(ctx, session, {
    name: truncate(field(ctx.form, 'name'), 200), reason: truncate(field(ctx.form, 'reason'), 2000), error, limit,
  }, status)
  if ('problem' in name) return again(name.problem, 400)
  if ('problem' in reason) return again(reason.problem, 400)
  if (!(await allowAuth(ctx, 'org_request', session.user.id))) return again('Too many attempts. Please wait a minute, then try again.', 429)
  const requester = { id: session.user.id, email: session.user.email, ownerDomain: limit.ownerDomain }
  const outcome = await sendOrgRequest(ctx, to, requester, orgRequestMail({
    name: session.user.name, email: session.user.email, ownerDomain: limit.ownerDomain, count: limit.count, max: limit.max,
    wanted: name.name, reason: reason.reason, site: ctx.config.domain,
  }))
  if (outcome === 'capped') {
    // The person's own cap, or their owner domain's or everyone's, which the message words alike so it tells them
    // nothing about other people's requests.
    return await countOrgRequests(ctx.config.db, session.user.id, ctx.now) >= ORG_REQUEST_DAILY_LIMIT
      ? again('You\'ve sent the most requests allowed for today. Insulin Apps support will reply to the ones you sent.', 429)
      : again('Insulin Apps support can\'t take more requests for more organizations today. Please try again tomorrow.', 429)
  }
  if (outcome === 'failed') return again(MAIL_FAILED, 503)
  log('org_request_sent', { user: session.user.id })
  return redirect(apexUrl(ctx, '/orgs/new?notice=request-sent'), 303)
}

/** An OWNER turns "invite only people in our verified domains" on or off (DESIGN.md §3). */
export async function setInviteDomains(ctx: Context, [orgId]: string[]): Promise<Response> {
  const found = await memberOf(ctx, orgId!)
  if (found instanceof Response) return found
  const { session, membership } = found
  if (!canSetInvitePolicy(membership.role)) return notAllowed(ctx, session)
  const on = field(ctx.form, 'only') === 'on'
  if (!(await setInviteVerifiedDomainsOnly(ctx.config.db, membership.org_id, session.user.id, on, ctx.now))) {
    return (await actorChanged(ctx, session, membership))
      ?? renderOrganization(ctx, session, membership, { error: 'Verify a domain under Single sign-on first.', status: 409 })
  }
  log('org_invite_domains_changed', { org: membership.org_id, user: session.user.id, on })
  return backTo(ctx, 'organization', membership.org_id, on ? 'invite-domains-on' : 'invite-domains-off')
}

export async function switchOrg(ctx: Context): Promise<Response> {
  const session = await requireSession(ctx)
  if (session instanceof Response) return session
  const orgId = field(ctx.form, 'org_id')
  const membership = await findMembership(ctx.config.db, orgId, session.user.id)
  if (!membership) return notFoundPage(ctx)
  await switchActiveOrg(ctx, session, { id: membership.org_id, name: membership.org_name, role: membership.role })
  return afterPost(ctx, safeReturnTo(ctx, field(ctx.form, 'return_to')) ?? home(ctx))
}

/** The old organization page's address: its people now live under /settings/users. */
export async function orgOverview(ctx: Context, [orgId]: string[]): Promise<Response> {
  const found = await memberOf(ctx, orgId!)
  if (found instanceof Response) return found
  return redirect(settingsUrl(ctx, 'users', found.membership.org_id), 302)
}

export async function renameOrg(ctx: Context, [orgId]: string[]): Promise<Response> {
  const found = await memberOf(ctx, orgId!)
  if (found instanceof Response) return found
  const { session, membership } = found
  if (!canRenameOrg(membership.role)) return notAllowed(ctx, session)
  const checked = checkOrgName(field(ctx.form, 'name'))
  if ('problem' in checked) return renderOrganization(ctx, session, membership, { error: checked.problem, status: 400 })
  if (!(await updateOrgName(ctx.config.db, membership.org_id, session.user.id, checked.name, ctx.now))) {
    return (await actorChanged(ctx, session, membership)) ?? notFoundPage(ctx)
  }
  log('org_renamed', { org: membership.org_id, user: session.user.id })
  return backTo(ctx, 'organization', membership.org_id, 'renamed')
}

export async function deleteOrg(ctx: Context, [orgId]: string[]): Promise<Response> {
  const found = await memberOf(ctx, orgId!)
  if (found instanceof Response) return found
  const { session, membership } = found
  if (!canDeleteOrg(membership.role)) return notAllowed(ctx, session)
  if (field(ctx.form, 'confirm').trim() !== membership.org_name) {
    return renderOrganization(ctx, session, membership, { error: 'Type the organization\'s name exactly as shown to confirm.', status: 400 })
  }
  if (!(await removeOrg(ctx.config.db, membership.org_id, session.user.id))) {
    return (await actorChanged(ctx, session, membership)) ?? notFoundPage(ctx)
  }
  log('org_deleted', { org: membership.org_id, user: session.user.id })
  return redirect(apexUrl(ctx, '/?notice=org-deleted'), 303)
}

export async function leaveOrg(ctx: Context, [orgId]: string[]): Promise<Response> {
  const found = await memberOf(ctx, orgId!)
  if (found instanceof Response) return found
  const { session, membership } = found
  if (!(await leaveMembership(ctx.config.db, membership.org_id, session.user.id, membership.role))) {
    return (await actorChanged(ctx, session, membership))
      ?? renderOrganization(ctx, session, membership, { error: 'You\'re the only owner, so you can\'t leave. Make another member an owner first.', status: 409 })
  }
  log('org_left', { org: membership.org_id, user: session.user.id })
  return redirect(apexUrl(ctx, '/?notice=org-left'), 303)
}

/** A member's access: an organization role, or specific apps with a role in each (DESIGN.md §2). */
export async function changeMemberRole(ctx: Context, [orgId, userId]: string[]): Promise<Response> {
  const found = await memberOf(ctx, orgId!)
  if (found instanceof Response) return found
  const { session, membership } = found
  const db = ctx.config.db
  const target = await findMembership(db, membership.org_id, userId!)
  if (!target) return notFoundPage(ctx)
  if (!canManageMembers(membership.role)) return notAllowed(ctx, session)
  const parsed = parseAccessForm(ctx.config, ctx.form, membership.role, await listCustomRoles(db, membership.org_id))
  if ('problem' in parsed) return renderUsers(ctx, session, membership, { error: parsed.problem, status: parsed.status })
  if (!canChangeRole(membership.role, target.role, parsed.role)) return notAllowed(ctx, session)
  const lastOwner = 'An organization needs at least one owner, so the last owner can\'t be given another role.'
  if (parsed.role === 'APPS') {
    if (!(await setAppAccess(db, { orgId: membership.org_id, userId: userId!, current: target.role, grants: parsed.grants, actorId: session.user.id, now: ctx.now }))) {
      return (await actorChanged(ctx, session, membership)) ?? renderUsers(ctx, session, membership, { error: lastOwner, status: 409 })
    }
  } else if (parsed.role !== target.role && !(await changeRole(db, { orgId: membership.org_id, userId: userId!, current: target.role, next: parsed.role, actorId: session.user.id, now: ctx.now }))) {
    return (await actorChanged(ctx, session, membership)) ?? renderUsers(ctx, session, membership, { error: lastOwner, status: 409 })
  }
  log('member_role_changed', { org: membership.org_id, user: userId, by: session.user.id, role: parsed.role, apps: parsed.grants.length })
  return backTo(ctx, 'users', membership.org_id, 'role-changed')
}

export async function removeMember(ctx: Context, [orgId, userId]: string[]): Promise<Response> {
  const found = await memberOf(ctx, orgId!)
  if (found instanceof Response) return found
  const { session, membership } = found
  if (userId === session.user.id) return leaveOrg(ctx, [orgId!])
  const target = await findMembership(ctx.config.db, membership.org_id, userId!)
  if (!target) return notFoundPage(ctx)
  if (!canRemoveMember(membership.role, target.role)) return notAllowed(ctx, session)
  if (!(await removeMembership(ctx.config.db, membership.org_id, userId!, target.role, session.user.id))) {
    return (await actorChanged(ctx, session, membership))
      ?? renderUsers(ctx, session, membership, { error: 'An organization needs at least one owner, so the last owner can\'t be removed.', status: 409 })
  }
  log('member_removed', { org: membership.org_id, user: userId, by: session.user.id })
  return backTo(ctx, 'users', membership.org_id, 'member-removed')
}
