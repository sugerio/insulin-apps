// Signing in with an organization's identity provider (DESIGN.md §7): "Sign in with SSO" finds the connection by the
// work address's verified domain, sends the browser there (SAML or OIDC), and turns the answer into a session in that
// organization, creating the account and the membership when needed.
import type { Context } from '../context.ts'
import { apexUrl } from '../context.ts'
import { base64url, newId, randomToken, sha256, sha256Hex, unseal } from '../crypto.ts'
import {
  confirmByIdentityProvider, connectionForDomain, consumePendingSignIn, domainOf, findConnectionById, insertPendingSignIn,
  isVerifiedDomain, joinOrg, ssoRequiredForDomain, type SsoConnectionRow,
} from '../db/sso.ts'
import { findUserByEmail, findUserById, insertUser, type UserRow } from '../db/users.ts'
import { cookieValues, serializeCookie } from '../http/cookies.ts'
import { field } from '../http/request.ts'
import { htmlResponse } from '../http/response.ts'
import { safeReturnTo } from '../http/return-to.ts'
import { log } from '../log.ts'
import { MEMBER_LIMIT } from '../orgs/invitations.ts'
import { ssoContinuePage, ssoFailedPage, ssoRequiredPage, ssoStartPage } from '../pages/sso.tsx'
import { home, notFoundPage } from '../pages/status.tsx'
import { allowAuth } from '../ratelimit.ts'
import { finishSignIn } from '../auth/sign-in.ts'
import { NAME_MAX, cleanText, normalizeEmail, truncate } from '../validate.ts'
import { checkIdToken, discover, exchangeCode } from './oidc.ts'
import { SamlError, authnRequest, newRequestId, redirectUrl, spMetadata, validateResponse, type ServiceProvider } from './saml.ts'

const FLOW_TTL_SECONDS = 600

/** `__Host-` in production. SameSite=None there, because the identity provider posts the SAML response cross-site. */
function flowCookieName(ctx: Context): string {
  return ctx.relaxed ? 'insulin_sso' : '__Host-insulin_sso'
}

function flowCookie(ctx: Context, value: string, maxAge: number): string {
  return serializeCookie(flowCookieName(ctx), value, {
    path: '/', maxAge, secure: !ctx.relaxed, httpOnly: true, sameSite: ctx.relaxed ? 'Lax' : 'None',
  })
}

function flowBinding(ctx: Context): string | null {
  return cookieValues(ctx.request.headers.get('Cookie'), flowCookieName(ctx)).find((value) => /^[A-Za-z0-9_-]{43}$/.test(value)) ?? null
}

/** Our SAML service provider for a connection: the entity id and the ACS, on the apex. */
export function serviceProvider(ctx: Context, connectionId: string): ServiceProvider {
  return { entityId: apexUrl(ctx, `/sso/saml/${connectionId}`), acsUrl: apexUrl(ctx, `/sso/saml/${connectionId}/acs`) }
}

export function oidcRedirectUri(ctx: Context, connectionId: string): string {
  return apexUrl(ctx, `/sso/oidc/${connectionId}/callback`)
}

function certificatesOf(connection: SsoConnectionRow): string[] {
  try {
    const value: unknown = JSON.parse(connection.saml_certificates ?? '[]')
    return Array.isArray(value) ? value.filter((pem): pem is string => typeof pem === 'string') : []
  } catch {
    return []
  }
}

/** Whether the connection has everything its protocol needs to sign someone in. */
export function connectionReady(connection: SsoConnectionRow): boolean {
  if (connection.protocol === 'saml') return Boolean(connection.saml_entity_id && connection.saml_sso_url && certificatesOf(connection).length)
  return Boolean(connection.oidc_issuer && connection.oidc_client_id && connection.oidc_client_secret)
}

/**
 * Whether an organization requires its single sign-on for this address: password, Google, reset and confirmation
 * sign-ins are then refused. It depends on the domain alone, so it says nothing about whether an account exists.
 */
export function ssoRequired(ctx: Context, email: string): Promise<boolean> {
  return ssoRequiredForDomain(ctx.config.db, domainOf(email))
}

/** The page that sends someone with a required single sign-on there instead. */
export function ssoRequiredResponse(ctx: Context, email: string, returnTo: string | null): Response {
  log('sso_required_refused')
  return htmlResponse(ssoRequiredPage(ctx, email, returnTo), { status: 403 })
}

function failed(ctx: Context, status: number, text: string): Response {
  return htmlResponse(ssoFailedPage(ctx, text), { status })
}

export async function ssoForm(ctx: Context): Promise<Response> {
  return htmlResponse(ssoStartPage(ctx, {
    email: normalizeEmail(ctx.url.searchParams.get('email')) ?? undefined,
    returnTo: safeReturnTo(ctx, ctx.url.searchParams.get('return_to')),
  }))
}

/** POST /sso: the work address picks the connection, and the browser goes on to the identity provider. */
export async function ssoStart(ctx: Context): Promise<Response> {
  const input = field(ctx.form, 'email')
  const email = normalizeEmail(input)
  const returnTo = safeReturnTo(ctx, field(ctx.form, 'return_to'))
  const again = (error: string, status: number) => htmlResponse(ssoStartPage(ctx, { email: input.slice(0, 254), returnTo, error }), { status })
  if (!(await allowAuth(ctx, 'sso', email ?? undefined))) return again('Too many attempts. Please wait a minute, then try again.', 429)
  if (!email) return again('Enter your work email address.', 400)
  const connection = await connectionForDomain(ctx.config.db, domainOf(email))
  if (!connection || !connectionReady(connection)) {
    return again('There\'s no single sign-on for that address. Sign in with your password or Google instead.', 404)
  }
  const target = await beginSignIn(ctx, connection, returnTo)
  if (!target) return failed(ctx, 502, 'We couldn\'t reach your organization\'s identity provider. Please try again later.')
  return htmlResponse(ssoContinuePage(ctx, target))
}

/** Records the pending sign-in, sets the flow cookie, and returns the identity provider's address for the browser. */
async function beginSignIn(ctx: Context, connection: SsoConnectionRow, returnTo: string | null): Promise<string | null> {
  const db = ctx.config.db
  const binding = randomToken()
  const pending = { connectionId: connection.id, bindingHash: await sha256Hex(binding), returnTo, now: ctx.now, expiresAt: ctx.now + FLOW_TTL_SECONDS * 1000 }
  let target: string
  if (connection.protocol === 'saml') {
    const id = newRequestId()
    await insertPendingSignIn(db, { ...pending, idHash: await sha256Hex(id), nonce: null, verifier: null })
    target = await redirectUrl(connection.saml_sso_url!, authnRequest(serviceProvider(ctx, connection.id), id, connection.saml_sso_url!, ctx.now))
  } else {
    const discovery = await discover(connection.oidc_issuer!)
    if (!discovery) {
      log('sso_oidc_discovery_failed', { connection: connection.id })
      return null
    }
    const state = randomToken()
    const nonce = randomToken()
    const verifier = randomToken()
    await insertPendingSignIn(db, { ...pending, idHash: await sha256Hex(state), nonce, verifier })
    const url = new URL(discovery.authorizationEndpoint)
    for (const [name, value] of Object.entries({
      response_type: 'code',
      client_id: connection.oidc_client_id!,
      redirect_uri: oidcRedirectUri(ctx, connection.id),
      scope: 'openid email profile',
      state,
      nonce,
      code_challenge: base64url(await sha256(verifier)),
      code_challenge_method: 'S256',
    })) url.searchParams.set(name, value)
    target = url.href
  }
  ctx.setCookies.push(flowCookie(ctx, binding, FLOW_TTL_SECONDS))
  log('sso_started', { connection: connection.id, protocol: connection.protocol })
  return target
}

export async function samlMetadata(ctx: Context, [connectionId]: string[]): Promise<Response> {
  const connection = await findConnectionById(ctx.config.db, connectionId!)
  if (!connection || connection.protocol !== 'saml') return notFoundPage(ctx)
  return new Response(spMetadata(serviceProvider(ctx, connection.id)), {
    headers: { 'Content-Type': 'application/samlmetadata+xml; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
  })
}

/** POST /sso/saml/<connection>/acs: the identity provider's signed answer, posted cross-site by the browser. */
export async function samlAcs(ctx: Context, [connectionId]: string[]): Promise<Response> {
  const db = ctx.config.db
  const connection = await findConnectionById(db, connectionId!)
  if (!connection || connection.protocol !== 'saml' || !connection.enabled || !connectionReady(connection)) return notFoundPage(ctx)
  if (!(await allowAuth(ctx, 'sso'))) return failed(ctx, 429, 'Too many attempts. Please wait a minute, then try again.')
  const binding = flowBinding(ctx)
  ctx.setCookies.push(flowCookie(ctx, '', 0))
  let identity
  try {
    identity = validateResponse({
      samlResponse: field(ctx.form, 'SAMLResponse'),
      idp: { entityId: connection.saml_entity_id!, certificates: certificatesOf(connection) },
      sp: serviceProvider(ctx, connection.id),
      now: ctx.now,
    })
  } catch (error) {
    if (!(error instanceof SamlError)) throw error
    log('sso_saml_refused', { connection: connection.id, code: error.code })
    return failed(ctx, 400, `Your organization's identity provider sent an answer we can't accept: ${error.message}.`)
  }
  const pending = binding ? await consumePendingSignIn(db, await sha256Hex(identity.inResponseTo), connection.id, await sha256Hex(binding), ctx.now) : null
  if (!pending) {
    log('sso_saml_unmatched', { connection: connection.id })
    return failed(ctx, 400, 'This sign-in expired, was already used, or was started in another browser. Please start again.')
  }
  return completeSignIn(ctx, connection, identity, pending.return_to)
}

/** GET /sso/oidc/<connection>/callback: the code (or an error) for the pending sign-in its state names. */
export async function oidcCallback(ctx: Context, [connectionId]: string[]): Promise<Response> {
  const db = ctx.config.db
  const connection = await findConnectionById(db, connectionId!)
  if (!connection || connection.protocol !== 'oidc' || !connection.enabled || !connectionReady(connection)) return notFoundPage(ctx)
  if (!(await allowAuth(ctx, 'sso'))) return failed(ctx, 429, 'Too many attempts. Please wait a minute, then try again.')
  const params = ctx.url.searchParams
  const binding = flowBinding(ctx)
  const state = params.get('state') ?? ''
  // The state is checked first, for errors too: a link that doesn't carry this browser's pending state changes nothing.
  const pending = binding && state.length <= 200 ? await consumePendingSignIn(db, await sha256Hex(state), connection.id, await sha256Hex(binding), ctx.now) : null
  if (!pending?.nonce || !pending.verifier) {
    log('sso_oidc_unmatched', { connection: connection.id })
    return failed(ctx, 400, 'This sign-in expired, was already used, or was started in another browser. Please start again.')
  }
  ctx.setCookies.push(flowCookie(ctx, '', 0))
  if (params.get('error')) return failed(ctx, 400, 'Your organization\'s identity provider didn\'t sign you in.')
  const code = params.get('code') ?? ''
  const key = ctx.config.secretKey
  const secret = key && connection.oidc_client_secret ? await unseal(key, 'oidc-client-secret', connection.oidc_client_secret) : null
  if (!code || code.length > 4096 || !secret) return failed(ctx, 400, 'The identity provider didn\'t send a sign-in code. Please try again.')
  const discovery = await discover(connection.oidc_issuer!)
  const claims = discovery ? await exchangeCode(discovery, { id: connection.oidc_client_id!, secret }, code, pending.verifier, oidcRedirectUri(ctx, connection.id)) : null
  if (!claims) {
    log('sso_oidc_exchange_failed', { connection: connection.id })
    return failed(ctx, 502, 'We couldn\'t complete the sign-in with your organization\'s identity provider. Please try again.')
  }
  const identity = checkIdToken(claims, { issuer: connection.oidc_issuer!, clientId: connection.oidc_client_id!, nonce: pending.nonce }, Math.floor(ctx.now / 1000))
  if (typeof identity === 'string') {
    log('sso_oidc_refused', { connection: connection.id, code: identity })
    return failed(ctx, 400, identity === 'email'
      ? 'Your identity provider didn\'t confirm your e-mail address.'
      : 'Your organization\'s identity provider sent a sign-in we can\'t accept. Please try again.')
  }
  return completeSignIn(ctx, connection, identity, pending.return_to)
}

/**
 * The account for an address the identity provider vouched for: the existing one (confirmed now, losing a password
 * someone else may have set if it wasn't), or a new confirmed one without a password.
 */
async function accountFor(ctx: Context, email: string, name: string | null): Promise<UserRow | null> {
  const db = ctx.config.db
  const existing = await findUserByEmail(db, email)
  if (existing) {
    if (existing.email_verified_at === null) {
      await confirmByIdentityProvider(db, existing.id, ctx.now)
      log('sso_confirmed_account', { user: existing.id })
    }
    return findUserById(db, existing.id)
  }
  const id = newId()
  const display = truncate(cleanText(name), NAME_MAX) || email
  if (await insertUser(db, { id, email, name: display, passwordHash: null, verifiedAt: ctx.now, googleSub: null, now: ctx.now })) {
    log('sso_signup', { user: id })
    return findUserById(db, id)
  }
  return findUserByEmail(db, email)
}

async function completeSignIn(ctx: Context, connection: SsoConnectionRow, identity: { email: string; name: string | null }, returnTo: string | null): Promise<Response> {
  const db = ctx.config.db
  const email = normalizeEmail(identity.email)
  if (!email || !(await isVerifiedDomain(db, connection.org_id, domainOf(email)))) {
    log('sso_domain_refused', { connection: connection.id })
    return failed(ctx, 403, 'Your address isn\'t in one of this organization\'s verified domains, so its single sign-on can\'t sign you in.')
  }
  const user = await accountFor(ctx, email, identity.name)
  if (!user) return failed(ctx, 409, 'We couldn\'t set up your account. Please try again.')
  if (!(await joinOrg(db, connection.org_id, user.id, connection.default_role, ctx.now, MEMBER_LIMIT))) {
    return failed(ctx, 409, `This organization has reached its limit of ${MEMBER_LIMIT} members. Ask its owners to make room.`)
  }
  log('login', { user: user.id, method: 'sso', connection: connection.id })
  return finishSignIn(ctx, user, 'sso', safeReturnTo(ctx, returnTo) ?? home(ctx),
    () => failed(ctx, 409, 'The sign-in details of this account changed while you were signing in. Please try again.'), connection.org_id)
}

/** For the settings page: what an identity provider needs to know about us. */
export function providerDetails(ctx: Context, connection: SsoConnectionRow | null) {
  if (!connection) return null
  const sp = serviceProvider(ctx, connection.id)
  return {
    entityId: sp.entityId,
    acsUrl: sp.acsUrl,
    metadataUrl: apexUrl(ctx, `/sso/saml/${connection.id}/metadata`),
    redirectUri: oidcRedirectUri(ctx, connection.id),
    scimUrl: apexUrl(ctx, '/scim/v2'),
  }
}
