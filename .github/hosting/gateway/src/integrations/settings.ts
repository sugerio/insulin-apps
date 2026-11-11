// An app's integrations page, on the apex at /apps/<app>/settings/integrations (DESIGN.md §6; <app>.<domain>/settings/
// integrations redirects there): the app's stored credentials for outside services. Everyone who can use the app sees
// them (never a secret); the app's admins create, change and delete them, each write re-checking the admin in SQL.
// Bearer tokens never reach this page (DESIGN.md §4), and neither can code the app serves: it's another origin. The
// app's OAuth clients for API access are on its API access page (api-clients.ts).
import type { HostedApp } from '../config.ts'
import type { Context } from '../context.ts'
import { appSettingsPath } from '../context.ts'
import { newId, seal } from '../crypto.ts'
import {
  deleteIntegration, findIntegration, insertIntegration, listIntegrations, updateIntegration, type AuthScheme, type IntegrationInput,
  type IntegrationRow,
} from '../db/integrations.ts'
import { listMemberships } from '../db/orgs.ts'
import { field } from '../http/request.ts'
import { htmlResponse, redirect } from '../http/response.ts'
import { log } from '../log.ts'
import { appAdminOf, appMember, stillAdmin, type AppMember } from '../orgs/app-users.ts'
import type { Problem } from '../orgs/orgs.ts'
import { integrationsPage } from '../pages/integrations.tsx'
import { notFoundPage } from '../pages/status.tsx'
import { cleanText, length, truncate } from '../validate.ts'

const NOTICES: Record<string, string> = {
  'credential-created': 'The credential was saved.',
  'credential-saved': 'The credential was saved.',
  'credential-deleted': 'The credential was deleted.',
}

export const KEY_PATTERN = /^[a-z][a-z0-9_-]{0,39}$/
const NAME_MAX = 80
const SECRET_MAX = 4096
const HOSTS_MAX = 10
const HOSTNAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/

/**
 * An outside service's host name: dotted labels whose last one has a letter, so never an IPv4 address (an IPv6 literal
 * never passes HOSTNAME), a single-label name, or this site itself (the proxy must not loop).
 */
function isOutsideHost(ctx: Context, host: string): boolean {
  return HOSTNAME.test(host) && /[a-z]/.test(host.slice(host.lastIndexOf('.') + 1)) && !isSiteHost(ctx, host)
}
// Headers the credential may not be sent as: they belong to the connection, the browser, or the gateway.
const RESERVED_HEADERS = /^(?:host|cookie|set-cookie|content-length|content-type|transfer-encoding|connection|upgrade|te|trailer|keep-alive|proxy-.*|x-suger-.*|cf-.*|x-forwarded-.*)$/i

export function secretPurpose(integrationId: string): string {
  return `integration:${integrationId}`
}

export async function renderIntegrations(ctx: Context, app: HostedApp, member: AppMember, extra: { problem?: Problem | null } = {}): Promise<Response> {
  const db = ctx.config.db
  const orgId = member.membership.org_id
  const [credentials, memberships] = await Promise.all([
    listIntegrations(db, orgId, app.name),
    listMemberships(db, member.session.user.id),
  ])
  return htmlResponse(integrationsPage(ctx, member.session, app, {
    orgId,
    orgName: member.membership.org_name,
    orgRole: member.membership.role,
    access: member.access,
    credentials,
    sealing: ctx.config.secretKey !== null,
    notice: extra.problem ? null : NOTICES[ctx.url.searchParams.get('notice') ?? ''] ?? null,
    error: extra.problem?.error ?? null,
  }, memberships), { status: extra.problem?.status ?? 200 })
}

function back(app: HostedApp, notice: string): Response {
  return redirect(`${appSettingsPath(app, 'integrations')}?notice=${notice}`, 303)
}

export async function integrations(ctx: Context): Promise<Response> {
  const app = ctx.app!
  const found = await appMember(ctx, app, null)
  if (found instanceof Response) return found
  return renderIntegrations(ctx, app, found)
}

function checkName(input: string): { name: string } | { problem: string } {
  const name = cleanText(input)
  if (!name) return { problem: 'Enter a name for the credential.' }
  if (length(name) > NAME_MAX) return { problem: `Use at most ${NAME_MAX} characters for the name.` }
  return { name }
}

/** The base URL: https, no credentials, query or fragment, and not this site itself (the proxy must not loop). */
function checkBaseUrl(ctx: Context, input: string): { url: string; host: string } | { problem: string } {
  let url: URL
  try {
    url = new URL(input.trim())
  } catch {
    return { problem: 'Enter the base URL, starting with https://.' }
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.port || input.length > 500) {
    return { problem: 'The base URL must be https, without a port, user name, query or fragment.' }
  }
  if (!isOutsideHost(ctx, url.hostname)) return { problem: 'The base URL must be an outside service\'s address, by name.' }
  return { url: `${url.origin}${url.pathname.replace(/\/+$/, '')}`, host: url.hostname }
}

function isSiteHost(ctx: Context, host: string): boolean {
  return host === ctx.config.domain || host.endsWith(`.${ctx.config.domain}`)
}

/** The form's fields for a stored credential, checked; `requireSecret` on creation. */
function checkCredential(ctx: Context, requireSecret: boolean): (IntegrationInput & { secret: string | null }) | { problem: string } {
  const name = checkName(field(ctx.form, 'name'))
  if ('problem' in name) return name
  const base = checkBaseUrl(ctx, field(ctx.form, 'base_url'))
  if ('problem' in base) return base
  const hosts = [...new Set(field(ctx.form, 'allowed_hosts').toLowerCase().split(/[\s,]+/).filter(Boolean))]
  if (hosts.length > HOSTS_MAX) return { problem: `List at most ${HOSTS_MAX} other hosts.` }
  const badHost = hosts.find((host) => !isOutsideHost(ctx, host))
  if (badHost) return { problem: `"${truncate(badHost, 60)}" isn't an outside host name.` }
  const scheme = field(ctx.form, 'auth_scheme')
  if (scheme !== 'bearer' && scheme !== 'header' && scheme !== 'basic') return { problem: 'Choose how the secret is sent.' }
  let headerName: string | null = null
  if (scheme === 'header') {
    headerName = field(ctx.form, 'header_name').trim()
    if (!/^[A-Za-z0-9-]{1,64}$/.test(headerName) || RESERVED_HEADERS.test(headerName)) return { problem: 'Enter the header the secret is sent in, such as X-Api-Key.' }
  }
  const secret = field(ctx.form, 'secret')
  if (!secret && requireSecret) return { problem: 'Enter the secret.' }
  if (secret && (secret.length > SECRET_MAX || /[\r\n\0]/.test(secret))) return { problem: `The secret must be one line of at most ${SECRET_MAX} characters.` }
  if (secret && scheme === 'basic' && !secret.includes(':')) return { problem: 'For basic authentication, enter the secret as user:password.' }
  return { name: name.name, baseUrl: base.url, allowedHosts: hosts.filter((host) => host !== base.host).sort(), authScheme: scheme as AuthScheme, headerName, secret: secret || null }
}

const NOT_SET_UP = 'Stored credentials aren\'t set up on this site yet: the operator hasn\'t configured the key that encrypts them.'
const SECRET_AGAIN = 'Changing where the secret is sent, or how, needs the secret again: enter it with the change. The stored one is never sent anywhere new.'

function hostsOf(json: string): string[] {
  try {
    const value: unknown = JSON.parse(json)
    return Array.isArray(value) ? value.filter((host): host is string => typeof host === 'string').sort() : []
  } catch {
    return []
  }
}

/** Whether a change sends the secret somewhere else, or differently: then only a new secret may go with it. */
function movesSecret(existing: IntegrationRow, next: IntegrationInput): boolean {
  return next.baseUrl !== existing.base_url || JSON.stringify(next.allowedHosts) !== JSON.stringify(hostsOf(existing.allowed_hosts))
    || next.authScheme !== existing.auth_scheme || next.headerName !== existing.header_name
}

export async function createCredential(ctx: Context): Promise<Response> {
  const app = ctx.app!
  const found = await appAdminOf(ctx, app)
  if (found instanceof Response) return found
  const problem = (error: string, status = 400) => renderIntegrations(ctx, app, found, { problem: { error, status } })
  const key = ctx.config.secretKey
  if (!key) return problem(NOT_SET_UP, 503)
  const integrationKey = field(ctx.form, 'key').trim()
  if (!KEY_PATTERN.test(integrationKey)) return problem('The key is what the app names the credential by: lower-case letters, digits, - and _, starting with a letter.')
  const checked = checkCredential(ctx, true)
  if ('problem' in checked) return problem(checked.problem)
  const id = newId()
  const orgId = found.membership.org_id
  const secretEnc = await seal(key, secretPurpose(id), checked.secret!)
  if (!(await insertIntegration(ctx.config.db, { ...checked, id, orgId, app: app.name, key: integrationKey, secretEnc, actorId: found.session.user.id, now: ctx.now }))) {
    return (await stillAdmin(ctx, app, found)) ?? problem(`There is already a credential with the key "${integrationKey}".`, 409)
  }
  log('integration_created', { org: orgId, app: app.name, integration: id, by: found.session.user.id })
  return back(app, 'credential-created')
}

export async function updateCredential(ctx: Context, [id]: string[]): Promise<Response> {
  const app = ctx.app!
  const found = await appAdminOf(ctx, app)
  if (found instanceof Response) return found
  const orgId = found.membership.org_id
  const existing = await findIntegration(ctx.config.db, orgId, app.name, id!)
  if (!existing) return notFoundPage(ctx)
  const problem = (error: string, status = 400) => renderIntegrations(ctx, app, found, { problem: { error, status } })
  const key = ctx.config.secretKey
  if (!key) return problem(NOT_SET_UP, 503)
  const checked = checkCredential(ctx, false)
  if ('problem' in checked) return problem(checked.problem)
  // An admin who could point the stored secret at another host could read it there: a new destination needs a new secret.
  if (!checked.secret && movesSecret(existing, checked)) return problem(SECRET_AGAIN)
  const secretEnc = checked.secret ? await seal(key, secretPurpose(id!), checked.secret) : null
  if (!(await updateIntegration(ctx.config.db, { ...checked, id: id!, orgId, app: app.name, secretEnc, actorId: found.session.user.id, now: ctx.now }))) {
    return (await stillAdmin(ctx, app, found)) ?? notFoundPage(ctx)
  }
  log('integration_updated', { org: orgId, app: app.name, integration: id, by: found.session.user.id, secret: checked.secret !== null })
  return back(app, 'credential-saved')
}

export async function deleteCredential(ctx: Context, [id]: string[]): Promise<Response> {
  const app = ctx.app!
  const found = await appAdminOf(ctx, app)
  if (found instanceof Response) return found
  const orgId = found.membership.org_id
  if (!(await deleteIntegration(ctx.config.db, { id: id!, orgId, app: app.name, actorId: found.session.user.id }))) {
    return (await stillAdmin(ctx, app, found)) ?? notFoundPage(ctx)
  }
  log('integration_deleted', { org: orgId, app: app.name, integration: id, by: found.session.user.id })
  return back(app, 'credential-deleted')
}
