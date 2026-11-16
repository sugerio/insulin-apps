// An app's API access page, on the apex at /apps/<app>/settings/api (DESIGN.md §5.3; <app>.<domain>/settings/api
// redirects there): the OAuth clients (client credentials) that programs use to call the app's API, stored as service
// accounts. Everyone who can use the app sees them, never a secret; only the organization's owners and admins create,
// rename, change the role of, rotate and delete them, each write re-checking OWNER or ADMIN in SQL. Rotating keeps the
// previous secret valid for 24 hours, so a running program can switch over. An app that keeps settings per OAuth client
// (`insulin.clientSettings`, client-settings.ts) shows a section of its own under each client, for owners and admins.
import type { HostedApp } from '../config.ts'
import type { Context } from '../context.ts'
import { appSettingsPath } from '../context.ts'
import { newId } from '../crypto.ts'
import { listCustomRoles } from '../db/grants.ts'
import {
  deleteServiceAccount, findServiceAccount, insertServiceAccount, listServiceAccounts, revokePreviousSecret, rotateServiceAccount,
  updateServiceAccount,
} from '../db/oauth.ts'
import { findMembership, listMembers, listMemberships } from '../db/orgs.ts'
import { forgetClientSettings, formValues, hasClientSettings, loadClientSettings, saveClientSettings, type ClientSettingsLoad } from './client-settings.ts'
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

/** After saving an app's section for a client: the app's notice, or what it refused. */
export interface ClientSettingsOutcome {
  accountId: string
  notice: string | null
  errors: Record<string, string>
  message: string | null
}

export async function renderApiAccess(ctx: Context, app: HostedApp, member: AppMember, extra: { problem?: Problem | null; secret?: NewSecret | null; settings?: ClientSettingsOutcome | null } = {}): Promise<Response> {
  const db = ctx.config.db
  const orgId = member.membership.org_id
  const manage = canManageAppClients(member.membership.role)
  const [clients, customRoles, memberships, members] = await Promise.all([
    listServiceAccounts(db, orgId, app.name),
    listCustomRoles(db, orgId),
    listMemberships(db, member.session.user.id),
    manage && hasClientSettings(app) ? listMembers(db, orgId) : Promise.resolve([]),
  ])
  // The app's section of each live client, read at once, for the owners and admins who change it.
  const clientSettings: Record<string, ClientSettingsLoad> = {}
  if (manage && hasClientSettings(app)) {
    const live = clients.filter((client) => client.revoked_at === null)
    const loads = await Promise.all(live.map((client) => loadClientSettings(app, member, { id: client.id, name: client.name })))
    live.forEach((client, i) => { clientSettings[client.id] = loads[i]! })
  }
  return htmlResponse(apiAccessPage(ctx, member.session, app, {
    orgId,
    orgName: member.membership.org_name,
    orgRole: member.membership.role,
    access: member.access,
    manage,
    clients,
    clientSettings,
    members: members.map((m) => ({ email: m.email, name: m.name })),
    settings: extra.settings ?? null,
    customRoles: customRoles.filter((role) => role.app === app.name),
    secret: extra.secret ?? null,
    notice: extra.problem || extra.secret ? null : extra.settings?.notice ?? NOTICES[ctx.url.searchParams.get('notice') ?? ''] ?? null,
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
  // The app forgets its settings for the client; the deletion stands whatever it answers.
  await forgetClientSettings(app, found, id!)
  return back(app, 'client-deleted')
}

/**
 * Saves the app's section for one client (client-settings.ts): read again from the app, so that only its fields, of
 * their types, are sent (a members field: the organization's members only), then saved by the app, which may refuse
 * with what to fix. Owners and admins of the organization.
 */
export async function saveApiClientSettings(ctx: Context, [id]: string[]): Promise<Response> {
  const app = ctx.app!
  const found = await orgAdminOf(ctx, app)
  if (found instanceof Response) return found
  const orgId = found.membership.org_id
  const account = await findServiceAccount(ctx.config.db, orgId, app.name, id!)
  if (!account || account.revoked_at !== null || !hasClientSettings(app)) return notFoundPage(ctx)
  const unreachable = { problem: { error: `${app.title} couldn't be reached to save its settings for ${account.name}. Try again.`, status: 502 } }
  const load = await loadClientSettings(app, found, { id: account.id, name: account.name })
  if (!('section' in load)) return renderApiAccess(ctx, app, found, unreachable)
  const members = (await listMembers(ctx.config.db, orgId)).map((m) => m.email)
  const saved = await saveClientSettings(app, found, account.id, formValues(load.section, ctx.form, members))
  if (!saved.ok && !Object.keys(saved.errors).length && !saved.message) return renderApiAccess(ctx, app, found, unreachable)
  log('service_account_app_settings_saved', { org: orgId, app: app.name, account: account.id, by: found.session.user.id, ok: saved.ok })
  return renderApiAccess(ctx, app, found, {
    settings: saved.ok
      ? { accountId: account.id, notice: saved.notice ?? `${app.title}'s settings for ${account.name} were saved.`, errors: {}, message: null }
      : { accountId: account.id, notice: null, errors: saved.errors, message: saved.message },
  })
}
