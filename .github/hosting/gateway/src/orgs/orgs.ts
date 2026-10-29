// Organizations: create, switch, overview, rename, delete, leave, and members' roles.
import type { Context } from '../context.ts'
import { authUrl } from '../context.ts'
import { newId } from '../crypto.ts'
import { listInvitationsFor, listOrgInvitations } from '../db/invitations.ts'
import {
  changeRole, countOwners, createOrg as insertOrg, deleteOrg as removeOrg, findMembership, leaveOrg as leaveMembership,
  listMembers, listMemberships, removeMember as removeMembership, renameOrg as updateOrgName, type MembershipRow,
} from '../db/orgs.ts'
import { releaseOrgCreation, reserveOrgCreation } from '../db/users.ts'
import { field } from '../http/request.ts'
import { htmlResponse, redirect } from '../http/response.ts'
import { safeReturnTo } from '../http/return-to.ts'
import { log } from '../log.ts'
import { newOrgPage, orgPage } from '../pages/orgs.tsx'
import { actorChangedPage, afterPost, home, notAllowedPage, notFoundPage } from '../pages/status.tsx'
import {
  canChangeRole, canDeleteOrg, canManageMembers, canRemoveMember, canRenameOrg, canSeeMembers, isRole,
} from '../roles.ts'
import { requireSession } from '../auth/guard.ts'
import { activeOrg, switchActiveOrg, type Session } from '../auth/session.ts'
import { checkOrgName } from '../validate.ts'

export const ORG_LIMIT_PER_USER = 10

const ORG_NOTICES: Record<string, string> = {
  created: 'Your organization is ready. Invite people below, or open an app.',
  renamed: 'The organization was renamed.',
  'role-changed': 'The role was changed.',
  'member-removed': 'The member was removed.',
  invited: 'Invitation sent.',
  'invitation-saved': 'Invitation saved, but we couldn\'t email it right now: that address has received several emails recently. Use Resend later.',
  'invitation-revoked': 'Invitation revoked.',
  'invitation-resent': 'Invitation sent again.',
  joined: 'You joined the organization.',
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

/** The organization page, as the member's role allows; also used to show a problem with a submitted form. */
export async function renderOrg(ctx: Context, session: Session, membership: MembershipRow, problem: { error: string; status: number } | null = null): Promise<Response> {
  const db = ctx.config.db
  const role = membership.role
  const [members, invitations, ownerCount, active, memberships] = await Promise.all([
    canSeeMembers(role) ? listMembers(db, membership.org_id) : Promise.resolve(null),
    canManageMembers(role) ? listOrgInvitations(db, membership.org_id) : Promise.resolve(null),
    countOwners(db, membership.org_id),
    activeOrg(ctx, session),
    listMemberships(db, session.user.id),
  ])
  return htmlResponse(orgPage(ctx, session, {
    orgId: membership.org_id,
    orgName: membership.org_name,
    role,
    active: active?.id === membership.org_id,
    members,
    invitations,
    ownerCount,
    notice: problem ? null : ORG_NOTICES[ctx.url.searchParams.get('notice') ?? ''] ?? null,
    error: problem?.error ?? null,
  }, memberships), { status: problem?.status ?? 200 })
}

export function backToOrg(ctx: Context, orgId: string, notice: string): Response {
  return redirect(authUrl(ctx, `/orgs/${orgId}?notice=${notice}`), 303)
}

export async function newOrgForm(ctx: Context): Promise<Response> {
  const session = await requireSession(ctx)
  if (session instanceof Response) return session
  const invitations = await listInvitationsFor(ctx.config.db, session.user.email, ctx.now)
  return htmlResponse(newOrgPage(ctx, session, invitations, { returnTo: safeReturnTo(ctx, ctx.url.searchParams.get('return_to')) }))
}

export async function createOrg(ctx: Context): Promise<Response> {
  const session = await requireSession(ctx)
  if (session instanceof Response) return session
  const db = ctx.config.db
  const returnTo = safeReturnTo(ctx, field(ctx.form, 'return_to'))
  const checked = checkOrgName(field(ctx.form, 'name'))
  const problem = async (error: string, status: number) => htmlResponse(newOrgPage(ctx, session,
    await listInvitationsFor(db, session.user.email, ctx.now), { name: field(ctx.form, 'name').slice(0, 200), error, returnTo }), { status })
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
  return afterPost(ctx, returnTo ?? authUrl(ctx, `/orgs/${id}?notice=created`))
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

export async function orgOverview(ctx: Context, [orgId]: string[]): Promise<Response> {
  const found = await memberOf(ctx, orgId!)
  if (found instanceof Response) return found
  return renderOrg(ctx, found.session, found.membership)
}

export async function renameOrg(ctx: Context, [orgId]: string[]): Promise<Response> {
  const found = await memberOf(ctx, orgId!)
  if (found instanceof Response) return found
  const { session, membership } = found
  if (!canRenameOrg(membership.role)) return notAllowed(ctx, session)
  const checked = checkOrgName(field(ctx.form, 'name'))
  if ('problem' in checked) return renderOrg(ctx, session, membership, { error: checked.problem, status: 400 })
  if (!(await updateOrgName(ctx.config.db, membership.org_id, session.user.id, checked.name, ctx.now))) {
    return (await actorChanged(ctx, session, membership)) ?? notFoundPage(ctx)
  }
  log('org_renamed', { org: membership.org_id, user: session.user.id })
  return backToOrg(ctx, membership.org_id, 'renamed')
}

export async function deleteOrg(ctx: Context, [orgId]: string[]): Promise<Response> {
  const found = await memberOf(ctx, orgId!)
  if (found instanceof Response) return found
  const { session, membership } = found
  if (!canDeleteOrg(membership.role)) return notAllowed(ctx, session)
  if (field(ctx.form, 'confirm').trim() !== membership.org_name) {
    return renderOrg(ctx, session, membership, { error: 'Type the organization\'s name exactly as shown to confirm.', status: 400 })
  }
  if (!(await removeOrg(ctx.config.db, membership.org_id, session.user.id))) {
    return (await actorChanged(ctx, session, membership)) ?? notFoundPage(ctx)
  }
  log('org_deleted', { org: membership.org_id, user: session.user.id })
  return redirect(authUrl(ctx, '/?notice=org-deleted'), 303)
}

export async function leaveOrg(ctx: Context, [orgId]: string[]): Promise<Response> {
  const found = await memberOf(ctx, orgId!)
  if (found instanceof Response) return found
  const { session, membership } = found
  if (!(await leaveMembership(ctx.config.db, membership.org_id, session.user.id, membership.role))) {
    return (await actorChanged(ctx, session, membership))
      ?? renderOrg(ctx, session, membership, { error: 'You\'re the only owner, so you can\'t leave. Make another member an owner first.', status: 409 })
  }
  log('org_left', { org: membership.org_id, user: session.user.id })
  return redirect(authUrl(ctx, '/?notice=org-left'), 303)
}

export async function changeMemberRole(ctx: Context, [orgId, userId]: string[]): Promise<Response> {
  const found = await memberOf(ctx, orgId!)
  if (found instanceof Response) return found
  const { session, membership } = found
  const target = await findMembership(ctx.config.db, membership.org_id, userId!)
  if (!target) return notFoundPage(ctx)
  const next = field(ctx.form, 'role')
  if (!isRole(next)) return renderOrg(ctx, session, membership, { error: 'Choose a role.', status: 400 })
  if (!canChangeRole(membership.role, target.role, next)) return notAllowed(ctx, session)
  if (next !== target.role && !(await changeRole(ctx.config.db, { orgId: membership.org_id, userId: userId!, current: target.role, next, actorId: session.user.id, now: ctx.now }))) {
    return (await actorChanged(ctx, session, membership))
      ?? renderOrg(ctx, session, membership, { error: 'An organization needs at least one owner, so the last owner can\'t be given another role.', status: 409 })
  }
  log('member_role_changed', { org: membership.org_id, user: userId, by: session.user.id, role: next })
  return backToOrg(ctx, membership.org_id, 'role-changed')
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
      ?? renderOrg(ctx, session, membership, { error: 'An organization needs at least one owner, so the last owner can\'t be removed.', status: 409 })
  }
  log('member_removed', { org: membership.org_id, user: userId, by: session.user.id })
  return backToOrg(ctx, membership.org_id, 'member-removed')
}
