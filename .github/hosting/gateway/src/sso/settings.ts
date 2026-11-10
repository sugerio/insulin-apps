// insulinapps.com/settings/sso (DESIGN.md §7): an organization's OWNERs claim and verify e-mail domains, set up the
// SAML or OIDC connection, and create SCIM tokens. Every write re-checks the OWNER role in its own statement.
import type { Context } from '../context.ts'
import { newId, randomToken, seal, sha256Hex } from '../crypto.ts'
import {
  claimDomain, deleteConnection, findConnection, insertScimToken, listDomains, listScimTokens, markDomainVerified,
  removeDomain, revokeScimToken as deleteScimToken, saveConnection, verifiedElsewhere, type ConnectionInput,
} from '../db/sso.ts'
import type { MembershipRow } from '../db/orgs.ts'
import { listMemberships } from '../db/orgs.ts'
import { field } from '../http/request.ts'
import { htmlResponse } from '../http/response.ts'
import { log } from '../log.ts'
import { ssoSettingsPage } from '../pages/sso.tsx'
import { notFoundPage } from '../pages/status.tsx'
import { canManageSso } from '../roles.ts'
import { activeOrg, type Session } from '../auth/session.ts'
import { cleanText, truncate } from '../validate.ts'
import { actorChanged, backTo, memberOf, notAllowed, settingsOrg, type Problem } from '../orgs/orgs.ts'
import { providerDetails } from './flow.ts'
import { normalizeIssuer } from './oidc.ts'
import { parseCertificates } from './saml.ts'

export const DOMAIN_LIMIT = 20
export const SCIM_TOKEN_LIMIT = 10
const DNS_TIMEOUT_MS = 5000
const DOH_URL = 'https://cloudflare-dns.com/dns-query'

/** Consumer mail providers: anyone can have an address there, so no organization may claim one. */
const SHARED_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'yahoo.com', 'ymail.com', 'icloud.com',
  'me.com', 'mac.com', 'aol.com', 'proton.me', 'protonmail.com', 'pm.me', 'gmx.com', 'gmx.de', 'gmx.net', 'mail.com',
  'yandex.com', 'yandex.ru', 'qq.com', '163.com', '126.com', 'zoho.com', 'fastmail.com', 'hey.com', 'tutanota.com',
])

const NOTICES: Record<string, string> = {
  'domain-claimed': 'Domain added. Publish the DNS record below, then verify it.',
  'domain-verified': 'Domain verified.',
  'domain-removed': 'Domain removed.',
  'connection-saved': 'Single sign-on settings saved.',
  'connection-deleted': 'The connection was deleted.',
  'token-revoked': 'SCIM token revoked.',
}

const HOSTNAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/

/** An e-mail domain as people type it, normalized (lower case, punycode, no trailing dot), or null. */
export function normalizeDomain(input: string): string | null {
  const text = input.trim().toLowerCase().replace(/^@/, '').replace(/\.$/, '')
  if (!text || /[\s/:@?#]/.test(text)) return null
  let host: string
  try {
    host = new URL(`http://${text}`).hostname
  } catch {
    return null
  }
  return HOSTNAME.test(host) && !/^[\d.]+$/.test(host) ? host : null
}

export function txtRecordName(domain: string): string {
  return `_insulin-apps.${domain}`
}

export function txtRecordValue(token: string): string {
  return `insulin-apps-verification=${token}`
}

/** The TXT strings published at `name`, over DNS-over-HTTPS (character strings of one record are joined). */
async function txtRecords(name: string): Promise<string[] | null> {
  try {
    const url = new URL(DOH_URL)
    url.searchParams.set('name', name)
    url.searchParams.set('type', 'TXT')
    const response = await fetch(url, { headers: { Accept: 'application/dns-json' }, signal: AbortSignal.timeout(DNS_TIMEOUT_MS) })
    if (!response.ok) return null
    const data = await response.json<{ Status?: number; Answer?: { type?: number; data?: string }[] }>()
    if (data.Status !== 0) return data.Status === 3 ? [] : null
    return (data.Answer ?? []).filter((answer) => answer.type === 16 && typeof answer.data === 'string')
      .map((answer) => [...answer.data!.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((part) => part[1]!.replace(/\\(.)/g, '$1')).join('') || answer.data!)
  } catch {
    return null
  }
}

async function render(ctx: Context, session: Session, membership: MembershipRow, problem: Problem | null = null, newToken: string | null = null): Promise<Response> {
  const db = ctx.config.db
  const orgId = membership.org_id
  const [domains, connection, tokens, active, memberships] = await Promise.all([
    listDomains(db, orgId), findConnection(db, orgId), listScimTokens(db, orgId), activeOrg(ctx, session), listMemberships(db, session.user.id),
  ])
  return htmlResponse(ssoSettingsPage(ctx, session, {
    orgId,
    orgName: membership.org_name,
    role: membership.role,
    active: active?.id === orgId,
    domains,
    connection,
    details: providerDetails(ctx, connection),
    tokens,
    newToken,
    secretKeyReady: ctx.config.secretKey !== null,
    notice: problem || newToken ? null : NOTICES[ctx.url.searchParams.get('notice') ?? ''] ?? null,
    error: problem?.error ?? null,
  }, memberships), { status: problem?.status ?? (newToken ? 201 : 200) })
}

export async function ssoSettings(ctx: Context): Promise<Response> {
  const found = await settingsOrg(ctx)
  if (found instanceof Response) return found
  if (!canManageSso(found.membership.role)) return notAllowed(ctx, found.session)
  return render(ctx, found.session, found.membership)
}

/** The OWNER acting on `orgId`'s single sign-on, or the response to send instead. */
async function ownerOf(ctx: Context, orgId: string): Promise<{ session: Session; membership: MembershipRow } | Response> {
  const found = await memberOf(ctx, orgId)
  if (found instanceof Response) return found
  return canManageSso(found.membership.role) ? found : notAllowed(ctx, found.session)
}

export async function claimSsoDomain(ctx: Context, [orgId]: string[]): Promise<Response> {
  const found = await ownerOf(ctx, orgId!)
  if (found instanceof Response) return found
  const { session, membership } = found
  const problem = (error: string, status = 400) => render(ctx, session, membership, { error, status })
  const domain = normalizeDomain(field(ctx.form, 'domain'))
  if (!domain) return problem('Enter a domain, such as example.com.')
  if (SHARED_DOMAINS.has(domain)) return problem('Anyone can have an address at that provider, so it can\'t be claimed. Use your organization\'s own domain.')
  if (domain === ctx.config.domain || domain.endsWith(`.${ctx.config.domain}`)) return problem('That domain belongs to Insulin Apps itself.')
  const db = ctx.config.db
  if (await verifiedElsewhere(db, membership.org_id, domain)) return problem('Another organization has already verified that domain.', 409)
  if (!(await claimDomain(db, { orgId: membership.org_id, domain, token: randomToken(), actorId: session.user.id, now: ctx.now, limit: DOMAIN_LIMIT }))) {
    return (await actorChanged(ctx, session, membership))
      ?? problem(`That domain is already listed, or this organization has the most domains allowed (${DOMAIN_LIMIT}).`, 409)
  }
  log('sso_domain_claimed', { org: membership.org_id, by: session.user.id })
  return backTo(ctx, 'sso', membership.org_id, 'domain-claimed')
}

export async function verifySsoDomain(ctx: Context, [orgId]: string[]): Promise<Response> {
  const found = await ownerOf(ctx, orgId!)
  if (found instanceof Response) return found
  const { session, membership } = found
  const problem = (error: string, status = 400) => render(ctx, session, membership, { error, status })
  const db = ctx.config.db
  const domain = normalizeDomain(field(ctx.form, 'domain'))
  const claim = domain ? (await listDomains(db, membership.org_id)).find((row) => row.domain === domain) : undefined
  if (!claim || claim.verified_at !== null) return notFoundPage(ctx)
  const records = await txtRecords(txtRecordName(claim.domain))
  if (records === null) return problem('We couldn\'t look up the DNS record right now. Please try again in a minute.', 502)
  if (!records.includes(txtRecordValue(claim.token))) {
    return problem(`We didn't find the TXT record at ${txtRecordName(claim.domain)} yet. DNS changes can take a while to show; try again later.`, 409)
  }
  if (!(await markDomainVerified(db, membership.org_id, claim.domain, session.user.id, ctx.now))) {
    return (await actorChanged(ctx, session, membership)) ?? problem('Another organization has already verified that domain.', 409)
  }
  log('sso_domain_verified', { org: membership.org_id, by: session.user.id })
  return backTo(ctx, 'sso', membership.org_id, 'domain-verified')
}

export async function removeSsoDomain(ctx: Context, [orgId]: string[]): Promise<Response> {
  const found = await ownerOf(ctx, orgId!)
  if (found instanceof Response) return found
  const { session, membership } = found
  const domain = normalizeDomain(field(ctx.form, 'domain'))
  if (!domain || !(await removeDomain(ctx.config.db, membership.org_id, domain, session.user.id))) {
    return (await actorChanged(ctx, session, membership)) ?? notFoundPage(ctx)
  }
  log('sso_domain_removed', { org: membership.org_id, by: session.user.id })
  return backTo(ctx, 'sso', membership.org_id, 'domain-removed')
}

function httpsUrl(value: string): string | null {
  try {
    const url = new URL(value.trim())
    return url.protocol === 'https:' && !url.username && !url.password && !url.hash ? url.href : null
  } catch {
    return null
  }
}

/** The connection a form asks for. Turning it on needs everything its protocol uses; off, it may be incomplete. */
async function readConnection(ctx: Context, stored: { secret: boolean; certificates: boolean }): Promise<ConnectionInput | { problem: string }> {
  const form = ctx.form
  const protocol = field(form, 'protocol')
  if (protocol !== 'saml' && protocol !== 'oidc') return { problem: 'Choose SAML or OpenID Connect.' }
  const defaultRole = field(form, 'default_role')
  if (defaultRole !== 'EDITOR' && defaultRole !== 'VIEWER') return { problem: 'Choose the role new members get.' }
  const enabled = field(form, 'enabled') === 'on'
  const requireSso = field(form, 'require_sso') === 'on'
  const text = (name: string, max: number) => truncate(cleanText(field(form, name)), max) || null
  const samlEntityId = text('saml_entity_id', 500)
  const samlSsoInput = text('saml_sso_url', 2000)
  const samlSsoUrl = samlSsoInput ? httpsUrl(samlSsoInput) : null
  if (samlSsoInput && !samlSsoUrl) return { problem: 'The identity provider\'s sign-in URL must be an https address.' }
  const pem = field(form, 'saml_certificate').slice(0, 20000)
  const samlCertificates = pem.trim() ? parseCertificates(pem) : null
  if (pem.trim() && (!samlCertificates || samlCertificates.length > 2)) return { problem: 'Paste one or two certificates in PEM form (BEGIN CERTIFICATE … END CERTIFICATE).' }
  const issuerInput = text('oidc_issuer', 500)
  const oidcIssuer = issuerInput ? normalizeIssuer(issuerInput) : null
  if (issuerInput && !oidcIssuer) return { problem: 'The issuer must be an https address without a query.' }
  const oidcClientId = text('oidc_client_id', 500)
  const secretInput = field(form, 'oidc_client_secret').trim().slice(0, 2000)
  let oidcClientSecret: string | null = null
  if (secretInput) {
    if (!ctx.config.secretKey) return { problem: 'Client secrets can\'t be stored until the operator sets GATEWAY_SECRET_KEY.' }
    oidcClientSecret = await seal(ctx.config.secretKey, 'oidc-client-secret', secretInput)
  }
  if (enabled && protocol === 'saml' && (!samlEntityId || !samlSsoUrl || (!samlCertificates && !stored.certificates))) {
    return { problem: 'To turn SAML on, fill in the identity provider\'s entity ID, sign-in URL and certificate.' }
  }
  if (enabled && protocol === 'oidc' && (!oidcIssuer || !oidcClientId || (!oidcClientSecret && !stored.secret))) {
    return { problem: 'To turn OpenID Connect on, fill in the issuer, client ID and client secret.' }
  }
  return { protocol, enabled, requireSso, defaultRole, samlEntityId, samlSsoUrl, samlCertificates, oidcIssuer, oidcClientId, oidcClientSecret }
}

export async function saveSsoConnection(ctx: Context, [orgId]: string[]): Promise<Response> {
  const found = await ownerOf(ctx, orgId!)
  if (found instanceof Response) return found
  const { session, membership } = found
  const db = ctx.config.db
  const existing = await findConnection(db, membership.org_id)
  const input = await readConnection(ctx, { secret: Boolean(existing?.oidc_client_secret), certificates: Boolean(existing?.saml_certificates) })
  if ('problem' in input) return render(ctx, session, membership, { error: input.problem, status: 400 })
  if (!(await saveConnection(db, { id: existing?.id ?? newId(), orgId: membership.org_id, input, actorId: session.user.id, now: ctx.now }))) {
    return (await actorChanged(ctx, session, membership)) ?? notFoundPage(ctx)
  }
  log('sso_connection_saved', { org: membership.org_id, by: session.user.id, protocol: input.protocol, enabled: input.enabled, required: input.requireSso })
  return backTo(ctx, 'sso', membership.org_id, 'connection-saved')
}

export async function deleteSsoConnection(ctx: Context, [orgId]: string[]): Promise<Response> {
  const found = await ownerOf(ctx, orgId!)
  if (found instanceof Response) return found
  const { session, membership } = found
  if (!(await deleteConnection(ctx.config.db, membership.org_id, session.user.id))) {
    return (await actorChanged(ctx, session, membership)) ?? notFoundPage(ctx)
  }
  log('sso_connection_deleted', { org: membership.org_id, by: session.user.id })
  return backTo(ctx, 'sso', membership.org_id, 'connection-deleted')
}

/** Creates a SCIM token and shows it once, on the page this POST renders. */
export async function createScimToken(ctx: Context, [orgId]: string[]): Promise<Response> {
  const found = await ownerOf(ctx, orgId!)
  if (found instanceof Response) return found
  const { session, membership } = found
  const name = truncate(cleanText(field(ctx.form, 'name')), 60)
  if (!name) return render(ctx, session, membership, { error: 'Name the token after the system that will use it.', status: 400 })
  const token = randomToken()
  if (!(await insertScimToken(ctx.config.db, { id: newId(), orgId: membership.org_id, name, tokenHash: await sha256Hex(token), actorId: session.user.id, now: ctx.now, limit: SCIM_TOKEN_LIMIT }))) {
    return (await actorChanged(ctx, session, membership))
      ?? render(ctx, session, membership, { error: `This organization has the most SCIM tokens allowed (${SCIM_TOKEN_LIMIT}). Revoke one first.`, status: 409 })
  }
  log('scim_token_created', { org: membership.org_id, by: session.user.id })
  return render(ctx, session, membership, null, token)
}

export async function revokeScimToken(ctx: Context, [orgId, tokenId]: string[]): Promise<Response> {
  const found = await ownerOf(ctx, orgId!)
  if (found instanceof Response) return found
  const { session, membership } = found
  if (!(await deleteScimToken(ctx.config.db, membership.org_id, tokenId!, session.user.id))) {
    return (await actorChanged(ctx, session, membership)) ?? notFoundPage(ctx)
  }
  log('scim_token_revoked', { org: membership.org_id, by: session.user.id })
  return backTo(ctx, 'sso', membership.org_id, 'token-revoked')
}
