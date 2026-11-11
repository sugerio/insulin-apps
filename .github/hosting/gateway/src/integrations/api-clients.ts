// An app's API access page, on the apex at /apps/<app>/settings/api (DESIGN.md §5.3; <app>.<domain>/settings/api
// redirects there): the OAuth clients (client credentials) that programs use to call the app's API, stored as service
// accounts. Everyone who can use the app sees them, never a secret; only the organization's owners and admins create,
// rename, change the role of, rotate and delete them, each write re-checking OWNER or ADMIN in SQL. Rotating keeps the
// previous secret valid for 24 hours, so a running program can switch over.
import type { HostedApp } from '../config.ts'
import type { Context } from '../context.ts'
import { appSettingsPath } from '../context.ts'
import { newId } from '../crypto.ts'
import { listCustomRoles } from '../db/grants.ts'
import {
  deleteServiceAccount, findServiceAccount, insertServiceAccount, listServiceAccounts, revokePreviousSecret, rotateServiceAccount,
  updateServiceAccount,
} from '../db/oauth.ts'
import { findMembership, listMemberships } from '../db/orgs.ts'
import { field } from '../http/request.ts'
import { htmlResponse, redirect } from '../http/response.ts'
import { log } from '../log.ts'
import { parseGrant } from '../orgs/access-forms.ts'
import { appMember, type AppMember } from '../orgs/app-users.ts'
import type { Problem } from '../orgs/orgs.ts'
import { apiAccessPage, type NewSecret } from '../pages/api-access.tsx'
import { notAllowedPage, notFoundPage } from '../pages/status.tsx'
import { PREFIX, PREVIOUS_SECRET_TTL_MS, hashSecret, newIdentifier, newSecret } from '../oauth/tokens.ts'
import { canManageAppClients } from '../roles.ts'
import { cleanText, length } from '../validate.ts'

const NOTICES: Record<string, string> = {
  'client-saved': 'The OAuth client was saved.',
  'client-deleted': 'The OAuth client was deleted. Its secrets and tokens no longer work.',
  'previous-revoked': 'The previous secret was revoked. It, and the tokens it issued, no longer work.',
  'no-previous': 'There was no previous secret to revoke.',
}

const NAME_MAX = 80

export async function renderApiAccess(ctx: Context, app: HostedApp, member: AppMember, extra: { problem?: Problem | null; secret?: NewSecret | null } = {}): Promise<Response> {
  const db = ctx.config.db
  const orgId = member.membership.org_id
  const [clients, customRoles, memberships] = await Promise.all([
    listServiceAccounts(db, orgId, app.name),
    listCustomRoles(db, orgId),
    listMemberships(db, member.session.user.id),
  ])
  return htmlResponse(apiAccessPage(ctx, member.session, app, {
    orgId,
    orgName: member.membership.org_name,
    orgRole: member.membership.role,
    access: member.access,
    manage: canManageAppClients(member.membership.role),
    clients,
    customRoles: customRoles.filter((role) => role.app === app.name),
    secret: extra.secret ?? null,
    notice: extra.problem || extra.secret ? null : NOTICES[ctx.url.searchParams.get('notice') ?? ''] ?? null,
    error: extra.problem?.error ?? null,
  }, memberships), { status: extra.problem?.status ?? 200 })
}

function back(app: HostedApp, notice: string): Response {
  return redirect(`${appSettingsPath(app, 'api')}?notice=${notice}`, 303)
}

export async function apiAccess(ctx: Context): Promise<Response> {
  const app = ctx.app!
  const found = await appMember(ctx, app, null)
  if (found instanceof Response) return found
  return renderApiAccess(ctx, app, found)
}

/** An OWNER or ADMIN of the organization, for a POST: the organization comes from the form. App admins by grant aren't. */
async function orgAdminOf(ctx: Context, app: HostedApp): Promise<AppMember | Response> {
  const found = await appMember(ctx, app, field(ctx.form, 'org_id') || null)
  if (found instanceof Response) return found
  return canManageAppClients(found.membership.role) ? found : notAllowedPage(ctx, found.session)
}

/** After a guarded write changed nothing: the actor's own role changed meanwhile (403), or null. */
async function stillOrgAdmin(ctx: Context, member: AppMember): Promise<Response | null> {
  const fresh = await findMembership(ctx.config.db, member.membership.org_id, member.session.user.id)
  return fresh && canManageAppClients(fresh.role) ? null : notAllowedPage(ctx, member.session)
}

function checkName(input: string): { name: string } | { problem: string } {
  const name = cleanText(input)
  if (!name) return { problem: 'Enter a name for the OAuth client.' }
  if (length(name) > NAME_MAX) return { problem: `Use at most ${NAME_MAX} characters for the name.` }
  return { name }
}

/** A new client secret, shown once, and its hash to store. */
async function freshSecret(): Promise<{ secret: string; hash: string }> {
  const secret = newSecret(PREFIX.secret)
  return { secret, hash: await hashSecret(secret) }
}

export async function createApiClient(ctx: Context): Promise<Response> {
  const app = ctx.app!
  const found = await orgAdminOf(ctx, app)
  if (found instanceof Response) return found
  const problem = (error: string, status = 400) => renderApiAccess(ctx, app, found, { problem: { error, status } })
  const name = checkName(field(ctx.form, 'name'))
  if ('problem' in name) return problem(name.problem)
  const grant = parseGrant(app, field(ctx.form, 'role'), await listCustomRoles(ctx.config.db, found.membership.org_id))
  if (!grant || grant === 'invalid') return problem('Choose a role for the OAuth client.')
  const id = newId()
  const clientId = newIdentifier(PREFIX.serviceAccount)
  const { secret, hash } = await freshSecret()
  if (!(await insertServiceAccount(ctx.config.db, { id, orgId: found.membership.org_id, app: app.name, name: name.name, grant, clientId, secretHash: hash, actorId: found.session.user.id, now: ctx.now }))) {
    return (await stillOrgAdmin(ctx, found)) ?? problem('Nothing was saved. Reload the page and try again.', 409)
  }
  log('service_account_created', { org: found.membership.org_id, app: app.name, account: id, by: found.session.user.id })
  return renderApiAccess(ctx, app, found, { secret: { kind: 'created', name: name.name, clientId, secret, previousExpiresAt: null, replacedPrevious: false } })
}

export async function updateApiClient(ctx: Context, [id]: string[]): Promise<Response> {
  const app = ctx.app!
  const found = await orgAdminOf(ctx, app)
  if (found instanceof Response) return found
  const orgId = found.membership.org_id
  if (!(await findServiceAccount(ctx.config.db, orgId, app.name, id!))) return notFoundPage(ctx)
  const problem = (error: string) => renderApiAccess(ctx, app, found, { problem: { error, status: 400 } })
  const name = checkName(field(ctx.form, 'name'))
  if ('problem' in name) return problem(name.problem)
  const grant = parseGrant(app, field(ctx.form, 'role'), await listCustomRoles(ctx.config.db, orgId))
  if (!grant || grant === 'invalid') return problem('Choose a role for the OAuth client.')
  if (!(await updateServiceAccount(ctx.config.db, { id: id!, orgId, app: app.name, name: name.name, grant, actorId: found.session.user.id, now: ctx.now }))) {
    return (await stillOrgAdmin(ctx, found)) ?? notFoundPage(ctx)
  }
  log('service_account_updated', { org: orgId, app: app.name, account: id, by: found.session.user.id })
  return back(app, 'client-saved')
}

/**
 * Rotate secret: a new secret, shown once; the current one becomes the previous secret and keeps working for 24 hours,
 * replacing any previous secret still there (which ends now, with its tokens).
 */
export async function rotateApiClientSecret(ctx: Context, [id]: string[]): Promise<Response> {
  const app = ctx.app!
  const found = await orgAdminOf(ctx, app)
  if (found instanceof Response) return found
  const orgId = found.membership.org_id
  const account = await findServiceAccount(ctx.config.db, orgId, app.name, id!)
  if (!account) return notFoundPage(ctx)
  const { secret, hash } = await freshSecret()
  const previousExpiresAt = ctx.now + PREVIOUS_SECRET_TTL_MS
  if (!(await rotateServiceAccount(ctx.config.db, { id: account.id, orgId, app: app.name, secretHash: hash, previousExpiresAt, actorId: found.session.user.id, now: ctx.now }))) {
    return (await stillOrgAdmin(ctx, found)) ?? notFoundPage(ctx)
  }
  const replacedPrevious = account.previous_secret_hash !== null && (account.previous_secret_expires_at ?? 0) > ctx.now
  log('service_account_rotated', { org: orgId, app: app.name, account: account.id, by: found.session.user.id, replaced_previous: replacedPrevious })
  return renderApiAccess(ctx, app, found, { secret: { kind: 'rotated', name: account.name, clientId: account.client_id, secret, previousExpiresAt, replacedPrevious } })
}

/** Revoke previous secret now: the previous secret, and the tokens it issued, stop at once. */
export async function revokePreviousApiClientSecret(ctx: Context, [id]: string[]): Promise<Response> {
  const app = ctx.app!
  const found = await orgAdminOf(ctx, app)
  if (found instanceof Response) return found
  const orgId = found.membership.org_id
  const account = await findServiceAccount(ctx.config.db, orgId, app.name, id!)
  if (!account) return notFoundPage(ctx)
  if (!(await revokePreviousSecret(ctx.config.db, { id: account.id, orgId, app: app.name, actorId: found.session.user.id, now: ctx.now }))) {
    return (await stillOrgAdmin(ctx, found)) ?? back(app, 'no-previous')
  }
  log('service_account_previous_revoked', { org: orgId, app: app.name, account: account.id, by: found.session.user.id })
  return back(app, 'previous-revoked')
}

export async function deleteApiClient(ctx: Context, [id]: string[]): Promise<Response> {
  const app = ctx.app!
  const found = await orgAdminOf(ctx, app)
  if (found instanceof Response) return found
  const orgId = found.membership.org_id
  if (!(await deleteServiceAccount(ctx.config.db, { id: id!, orgId, app: app.name, actorId: found.session.user.id }))) {
    return (await stillOrgAdmin(ctx, found)) ?? notFoundPage(ctx)
  }
  log('service_account_deleted', { org: orgId, app: app.name, account: id, by: found.session.user.id })
  return back(app, 'client-deleted')
}
