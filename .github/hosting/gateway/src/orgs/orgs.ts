// Organizations: create, switch, the settings pages (people, roles, the organization itself), rename, delete, leave,
// and members' access: an organization role, or specific apps with a role in each.
import type { Context } from '../context.ts'
import { apexUrl } from '../context.ts'
import { newId } from '../crypto.ts'
import { customRoleUse, listCustomRoles, listOrgGrants, listUserGrants } from '../db/grants.ts'
import { listInvitationGrants, listInvitationsFor, listOrgInvitations } from '../db/invitations.ts'
import {
  changeRole, countOwners, createOrg as insertOrg, deleteOrg as removeOrg, findMembership, leaveOrg as leaveMembership,
  listMembers, listMemberships, removeMember as removeMembership, renameOrg as updateOrgName, setAppAccess,
  type MembershipRow,
} from '../db/orgs.ts'
import { releaseOrgCreation, reserveOrgCreation } from '../db/users.ts'
import { field } from '../http/request.ts'
import { htmlResponse, redirect } from '../http/response.ts'
import { safeReturnTo } from '../http/return-to.ts'
import { log } from '../log.ts'
import { newOrgPage, orgSettingsPage, rolesPage, usersPage, type SettingsTab } from '../pages/settings.tsx'
import { actorChangedPage, afterPost, home, notAllowedPage, notFoundPage } from '../pages/status.tsx'
import { canChangeRole, canDeleteOrg, canManageMembers, canRemoveMember, canRenameOrg, canSeeMembers } from '../roles.ts'
import { requireSession } from '../auth/guard.ts'
import { activeOrg, switchActiveOrg, type Session } from '../auth/session.ts'
import { checkOrgName } from '../validate.ts'
import { parseAccessForm } from './access-forms.ts'

export const ORG_LIMIT_PER_USER = 10

const NOTICES: Record<string, string> = {
  created: 'Your organization is ready. Invite people below, or open an app.',
  renamed: 'The organization was renamed.',
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
}

export function settingsUrl(ctx: Context, tab: SettingsTab, orgId: string, notice?: string): string {
  return apexUrl(ctx, `${TAB_PATHS[tab]}?org=${orgId}${notice ? `&notice=${notice}` : ''}`)
}

export function backTo(ctx: Context, tab: SettingsTab, orgId: string, notice: string): Response {
  return redirect(settingsUrl(ctx, tab, orgId, notice), 303)
}

/** The organization a settings page shows: `?org=` when the user is a member of it, else the active one. */
async function settingsOrg(ctx: Context): Promise<{ session: Session; membership: MembershipRow } | Response> {
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

async function frame(ctx: Context, session: Session, membership: MembershipRow) {
  const [active, memberships] = await Promise.all([activeOrg(ctx, session), listMemberships(ctx.config.db, session.user.id)])
  return { active: active?.id === membership.org_id, memberships }
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
  }, chrome.memberships), { status: problem?.status ?? 200 })
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
  }, chrome.memberships), { status: problem?.status ?? 200 })
}

/** /settings/organization: its name, leaving it, deleting it. */
export async function renderOrganization(ctx: Context, session: Session, membership: MembershipRow, problem: Problem | null = null): Promise<Response> {
  const [ownerCount, chrome] = await Promise.all([countOwners(ctx.config.db, membership.org_id), frame(ctx, session, membership)])
  return htmlResponse(orgSettingsPage(ctx, session, {
    orgId: membership.org_id,
    orgName: membership.org_name,
    role: membership.role,
    active: chrome.active,
    ownerCount,
    notice: notice(ctx, problem),
    error: problem?.error ?? null,
  }, chrome.memberships), { status: problem?.status ?? 200 })
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

export async function newOrgForm(ctx: Context): Promise<Response> {
  const session = await requireSession(ctx)
  if (session instanceof Response) return session
  const invitations = await listInvitationsFor(ctx.config.db, session.user.email, ctx.now)
  const grants = await listInvitationGrants(ctx.config.db, invitations.map((invitation) => invitation.id))
  return htmlResponse(newOrgPage(ctx, session, invitations, grants, { returnTo: safeReturnTo(ctx, ctx.url.searchParams.get('return_to')) }))
}

export async function createOrg(ctx: Context): Promise<Response> {
  const session = await requireSession(ctx)
  if (session instanceof Response) return session
  const db = ctx.config.db
  const returnTo = safeReturnTo(ctx, field(ctx.form, 'return_to'))
  const checked = checkOrgName(field(ctx.form, 'name'))
  const problem = async (error: string, status: number) => {
    const invitations = await listInvitationsFor(db, session.user.email, ctx.now)
    const grants = await listInvitationGrants(db, invitations.map((invitation) => invitation.id))
    return htmlResponse(newOrgPage(ctx, session, invitations, grants, { name: field(ctx.form, 'name').slice(0, 200), error, returnTo }), { status })
  }
  if ('problem' in checked) return problem(checked.problem, 400)
  if (!(await reserveOrgCreation(db, session.user.id, ORG_LIMIT_PER_USER, ctx.now))) {
    return problem(`You've reached the limit of ${ORG_LIMIT_PER_USER} organizations per account.`, 409)
  }
  const id = newId()
  try {
    await insertOrg(db, { id, name: checked.name, userId: session.user.id, now: ctx.now })
  } catch (error) {
    await releaseOrgCreation(db, session.user.id)
    throw error
  }
  await switchActiveOrg(ctx, session, { id, name: checked.name, role: 'OWNER' })
  log('org_created', { org: id, user: session.user.id })
  return afterPost(ctx, returnTo ?? settingsUrl(ctx, 'users', id, 'created'))
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
