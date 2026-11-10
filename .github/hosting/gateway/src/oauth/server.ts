// The OAuth authorization server on the apex (DESIGN.md §5.2, §5.3): metadata, dynamic registration of MCP clients,
// authorization with the person's consent, the token endpoint (codes with PKCE, rotating refresh tokens, and service
// accounts' client credentials) and revocation. Each app's MCP server is its own resource, so a client is authorized
// for one app (and one organization) at a time.
import { appAccess } from '../access.ts'
import type { HostedApp } from '../config.ts'
import type { Context } from '../context.ts'
import { constantTimeEqual, newId } from '../crypto.ts'
import {
  deleteGrant, deleteToken, findClient, findGrant, findServiceAccountByClientId, findTokenOwner, insertClient,
  insertGrantWithCode, insertRequest, issueTokens, redeemCode, redeemRefresh, takeRequest, usedCodeGrant, usedRefreshGrant,
  type ServiceAccountRow,
} from '../db/oauth.ts'
import { listMemberships } from '../db/orgs.ts'
import { field } from '../http/request.ts'
import { htmlResponse, redirect } from '../http/response.ts'
import { log } from '../log.ts'
import { consentPage, oauthContinuePage, oauthProblemPage } from '../pages/oauth.tsx'
import { allowOAuth } from '../ratelimit.ts'
import { requireSession } from '../auth/guard.ts'
import { activeOrg } from '../auth/session.ts'
import { cleanText, truncate } from '../validate.ts'
import { corsJson, oauthError, readJson, readParams, withParams } from './http.ts'
import { isAllowedRedirect, isLoopback } from './redirects.ts'
import {
  ACCESS_TTL_MS, CODE_TTL_MS, GRANT_TTL_MS, PREFIX, REQUEST_TTL_MS, apiResource, hashSecret, isChallenge, isSecret, issuer,
  mcpResource, newIdentifier, newSecret, pkceMatches,
} from './tokens.ts'

const CLIENT_NAME_MAX = 100
const REDIRECT_URIS_MAX = 10
const STATE_MAX = 1024

/** RFC 8414 metadata, the same on the apex and on every app host. */
export function authorizationServerMetadata(ctx: Context): Response {
  const base = issuer(ctx)
  return corsJson({
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    revocation_endpoint: `${base}/oauth/revoke`,
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token', 'client_credentials'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_basic', 'client_secret_post'],
    revocation_endpoint_auth_methods_supported: ['none', 'client_secret_basic', 'client_secret_post'],
    scopes_supported: ['mcp'],
    authorization_response_iss_parameter_supported: true,
    service_documentation: `${base}/`,
  }, 200, { 'Cache-Control': 'public, max-age=300' })
}

/** RFC 7591 registration: public clients only, redirecting to the same computer or a known hosted connector. */
export async function register(ctx: Context): Promise<Response> {
  if (!(await allowOAuth(ctx, `register:ip:${ctx.clientIp ?? 'unknown'}`))) return oauthError('slow_down', 'Too many registrations. Try again in a minute.', 429, { 'Retry-After': '60' })
  const body = await readJson(ctx, 16 * 1024)
  if (body instanceof Response) return body
  if (!body || typeof body !== 'object' || Array.isArray(body)) return oauthError('invalid_client_metadata', 'Send the client metadata as a JSON object.')
  const metadata = body as Record<string, unknown>
  const uris = metadata.redirect_uris
  if (!Array.isArray(uris) || !uris.length || uris.length > REDIRECT_URIS_MAX || !uris.every((uri) => typeof uri === 'string' && isAllowedRedirect(uri))) {
    return oauthError('invalid_redirect_uri', 'Redirect URIs must be http://localhost, http://127.0.0.1 or http://[::1] (any port), or a known hosted connector.')
  }
  const method = metadata.token_endpoint_auth_method ?? 'none'
  if (method !== 'none') return oauthError('invalid_client_metadata', 'Only public clients (token_endpoint_auth_method "none") can register; they use PKCE.')
  const grantTypes = metadata.grant_types ?? ['authorization_code', 'refresh_token']
  if (!Array.isArray(grantTypes) || !grantTypes.every((type) => type === 'authorization_code' || type === 'refresh_token')) {
    return oauthError('invalid_client_metadata', 'Clients may use authorization_code and refresh_token only.')
  }
  const responseTypes = metadata.response_types ?? ['code']
  if (!Array.isArray(responseTypes) || !responseTypes.every((type) => type === 'code')) return oauthError('invalid_client_metadata', 'Only the "code" response type is supported.')
  const name = truncate(cleanText(metadata.client_name), CLIENT_NAME_MAX) || 'MCP client'
  const id = newIdentifier(PREFIX.client)
  const redirectUris = [...new Set(uris as string[])]
  await insertClient(ctx.config.db, { id, name, redirectUris, now: ctx.now })
  log('oauth_client_registered', { client: id, uris: redirectUris.length })
  return corsJson({
    client_id: id,
    client_id_issued_at: Math.floor(ctx.now / 1000),
    client_name: name,
    redirect_uris: redirectUris,
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  }, 201)
}

/**
 * The app a resource names (RFC 8707): its MCP server, or its origin (what the root protected-resource metadata
 * describes, which some clients read instead), allowing one trailing slash.
 */
function appForResource(ctx: Context, resource: string): HostedApp | null {
  const wanted = resource.replace(/\/$/, '')
  return ctx.config.apps.find((app) => mcpResource(ctx, app) === wanted || apiResource(ctx, app) === wanted) ?? null
}

/**
 * GET /oauth/authorize. A bad client or redirect URI is shown here (never redirected to); other problems go back to
 * the client as RFC 6749 errors. A valid request needs a signed-in person, is kept for 10 minutes for this browser
 * session, and shows the consent page.
 */
export async function authorize(ctx: Context): Promise<Response> {
  const params = ctx.url.searchParams
  const client = await findClient(ctx.config.db, params.get('client_id') ?? '')
  if (!client) return oauthProblemPage(ctx, 400, 'This app isn\'t registered', 'Go back to the app you came from and connect it again.')
  const redirectUri = params.get('redirect_uri') ?? ''
  const registered: string[] = JSON.parse(client.redirect_uris)
  if (!registered.includes(redirectUri)) return oauthProblemPage(ctx, 400, 'This app gave an unknown return address', 'Go back to the app you came from and connect it again.')
  const state = params.get('state')
  const back = (error: string, description: string) => redirect(withParams(redirectUri, { error, error_description: description, state, iss: issuer(ctx) }), 302)
  if (params.get('response_type') !== 'code') return back('unsupported_response_type', 'Only the "code" response type is supported.')
  const challenge = params.get('code_challenge') ?? ''
  if (params.get('code_challenge_method') !== 'S256' || !isChallenge(challenge)) return back('invalid_request', 'PKCE with S256 is required.')
  if (state !== null && state.length > STATE_MAX) return back('invalid_request', 'The state is too long.')
  const app = appForResource(ctx, params.get('resource') ?? '')
  if (!app) return back('invalid_target', 'Name the app\'s MCP server as the resource, for example https://<app>.<domain>/mcp.')

  const session = await requireSession(ctx)
  if (session instanceof Response) return session
  const orgs = await eligibleOrgs(ctx, session.user.id, app)
  const memberships = await listMemberships(ctx.config.db, session.user.id)
  if (!orgs.length) {
    return oauthProblemPage(ctx, 403, `You don't have access to ${app.title}`, `None of your organizations gives you access to ${app.title}, so there is nothing to connect. Ask an owner or admin for access, then try again.`, session)
  }
  const requestToken = newSecret(PREFIX.request)
  await insertRequest(ctx.config.db, {
    id_hash: await hashSecret(requestToken), session_hash: session.idHash, client_id: client.id, app: app.name, redirect_uri: redirectUri,
    code_challenge: challenge, state, now: ctx.now, expiresAt: ctx.now + REQUEST_TTL_MS,
  })
  const active = await activeOrg(ctx, session)
  const selected = orgs.find((org) => org.id === active?.id)?.id ?? orgs[0]!.id
  return htmlResponse(consentPage(ctx, session, {
    requestToken, clientName: client.name, app, redirectUri, loopback: isLoopback(redirectUri), orgs, selected,
  }, memberships))
}

/** The person's organizations where they can use `app`, with their role there. */
async function eligibleOrgs(ctx: Context, userId: string, app: HostedApp): Promise<{ id: string; name: string; label: string }[]> {
  const memberships = await listMemberships(ctx.config.db, userId)
  const orgs: { id: string; name: string; label: string }[] = []
  for (const membership of memberships) {
    const access = await appAccess(ctx.config.db, app, membership.org_id, userId, membership.role)
    if (access) orgs.push({ id: membership.org_id, name: membership.org_name, label: access.label })
  }
  return orgs
}

/** POST /oauth/authorize/decision: Allow records a grant and sends the client a code; Deny sends access_denied. */
export async function decide(ctx: Context): Promise<Response> {
  const session = await requireSession(ctx)
  if (session instanceof Response) return session
  const token = field(ctx.form, 'request')
  const request = isSecret(token, PREFIX.request) ? await takeRequest(ctx.config.db, await hashSecret(token), session.idHash, ctx.now) : null
  const expired = 'This request has expired or was already answered. Go back to the app you came from and connect it again.'
  if (!request) return oauthProblemPage(ctx, 400, 'This request is no longer open', expired, session)
  const client = await findClient(ctx.config.db, request.client_id)
  const app = ctx.config.apps.find((candidate) => candidate.name === request.app)
  if (!client || !app) return oauthProblemPage(ctx, 400, 'This request is no longer open', expired, session)
  const back = (params: Record<string, string>) => oauthContinuePage(ctx, withParams(request.redirect_uri, { ...params, state: request.state, iss: issuer(ctx) }), client.name)
  if (field(ctx.form, 'decision') !== 'allow') {
    log('oauth_denied', { client: client.id, app: app.name, user: session.user.id })
    return back({ error: 'access_denied', error_description: 'The person declined.' })
  }
  const orgId = field(ctx.form, 'org_id')
  if (!(await eligibleOrgs(ctx, session.user.id, app)).some((org) => org.id === orgId)) {
    return oauthProblemPage(ctx, 403, `You don't have access to ${app.title} there`, 'Go back to the app you came from and connect it again, choosing an organization where you use the app.', session)
  }
  const code = newSecret(PREFIX.code)
  const grantId = newId()
  const created = await insertGrantWithCode(ctx.config.db, {
    id: grantId, clientId: client.id, userId: session.user.id, orgId, app: app.name, now: ctx.now, expiresAt: ctx.now + GRANT_TTL_MS,
    codeHash: await hashSecret(code), redirectUri: request.redirect_uri, codeChallenge: request.code_challenge, codeExpiresAt: ctx.now + CODE_TTL_MS,
  })
  if (!created) return oauthProblemPage(ctx, 409, 'Nothing was connected', 'Your membership changed while you were deciding. Go back to the app you came from and try again.', session)
  log('oauth_grant_created', { grant: grantId, client: client.id, app: app.name, org: orgId, user: session.user.id })
  return back({ code })
}

/** POST /oauth/token. */
export async function token(ctx: Context): Promise<Response> {
  const params = await readParams(ctx)
  if (params instanceof Response) return params
  switch (params.grant_type) {
    case 'authorization_code':
      return exchangeCode(ctx, params)
    case 'refresh_token':
      return refresh(ctx, params)
    case 'client_credentials':
      return clientCredentials(ctx, params)
    default:
      return oauthError('unsupported_grant_type', 'Use authorization_code, refresh_token or client_credentials.')
  }
}

const SLOW_DOWN = { error: 'slow_down', description: 'Too many token requests. Try again in a minute.' } as const

/** Every token request, before anything is checked: per IP, so nobody can use up a client's allowance by naming it. */
async function tokenLimit(ctx: Context): Promise<Response | null> {
  return (await allowOAuth(ctx, `token:ip:${ctx.clientIp ?? 'unknown'}`)) ? null : oauthError(SLOW_DOWN.error, SLOW_DOWN.description, 429, { 'Retry-After': '60' })
}

/**
 * A failed authentication, counted per client as well: guessing is slowed per client, but only failures count, so
 * someone else's junk requests never stop the client's own valid ones.
 */
async function failed(ctx: Context, clientId: string, error: Response): Promise<Response> {
  if (clientId && !(await allowOAuth(ctx, `token:failed:${clientId}`))) return oauthError(SLOW_DOWN.error, SLOW_DOWN.description, 429, { 'Retry-After': '60' })
  return error
}

/** Access and refresh tokens for a person's grant, the refresh token lasting as long as the grant. */
async function grantTokens(ctx: Context, grant: { id: string; expires_at: number; app: string }): Promise<Response> {
  const access = newSecret(PREFIX.access)
  const refreshToken = newSecret(PREFIX.refresh)
  const accessExpires = Math.min(ctx.now + ACCESS_TTL_MS, grant.expires_at)
  await issueTokens(ctx.config.db, [
    { hash: await hashSecret(access), kind: 'access', grantId: grant.id, serviceAccountId: null, expiresAt: accessExpires },
    { hash: await hashSecret(refreshToken), kind: 'refresh', grantId: grant.id, serviceAccountId: null, expiresAt: grant.expires_at },
  ], ctx.now)
  return corsJson({ access_token: access, token_type: 'Bearer', expires_in: Math.floor((accessExpires - ctx.now) / 1000), refresh_token: refreshToken, scope: 'mcp' })
}

async function exchangeCode(ctx: Context, params: Record<string, string>): Promise<Response> {
  const clientId = params.client_id ?? ''
  const limited = await tokenLimit(ctx)
  if (limited) return limited
  const code = params.code ?? ''
  if (!isSecret(code, PREFIX.code)) return failed(ctx, clientId, oauthError('invalid_grant', 'The code is not valid.'))
  const codeHash = await hashSecret(code)
  const redeemed = await redeemCode(ctx.config.db, codeHash, clientId, ctx.now)
  if (!redeemed) {
    // A code presented twice: whoever has the first set of tokens may not be the client, so the grant ends.
    const replayed = await usedCodeGrant(ctx.config.db, codeHash)
    if (replayed) {
      await deleteGrant(ctx.config.db, replayed)
      log('oauth_code_replayed', { grant: replayed })
    }
    return failed(ctx, clientId, oauthError('invalid_grant', 'The code is not valid, has expired, or was already used.'))
  }
  const grant = await findGrant(ctx.config.db, redeemed.grant_id, ctx.now)
  if (!grant || grant.client_id !== clientId) return oauthError('invalid_grant', 'The code was issued to another client.')
  if (params.redirect_uri !== redeemed.redirect_uri) return oauthError('invalid_grant', 'The redirect URI doesn\'t match the authorization request.')
  if (!(await pkceMatches(params.code_verifier ?? '', redeemed.code_challenge))) return oauthError('invalid_grant', 'The code verifier doesn\'t match the challenge.')
  const app = ctx.config.apps.find((candidate) => candidate.name === grant.app)
  if (!app) return oauthError('invalid_grant', 'The app is no longer available.')
  if (params.resource && appForResource(ctx, params.resource) !== app) return oauthError('invalid_target', 'The resource doesn\'t match the authorization.')
  log('oauth_code_exchanged', { grant: grant.id, client: clientId })
  return grantTokens(ctx, grant)
}

async function refresh(ctx: Context, params: Record<string, string>): Promise<Response> {
  const clientId = params.client_id ?? ''
  const limited = await tokenLimit(ctx)
  if (limited) return limited
  const presented = params.refresh_token ?? ''
  if (!isSecret(presented, PREFIX.refresh)) return failed(ctx, clientId, oauthError('invalid_grant', 'The refresh token is not valid.'))
  const hash = await hashSecret(presented)
  const grantId = await redeemRefresh(ctx.config.db, hash, clientId, ctx.now)
  if (!grantId) {
    // A refresh token used twice was copied: end the grant, so neither copy works.
    const reused = await usedRefreshGrant(ctx.config.db, hash)
    if (reused) {
      await deleteGrant(ctx.config.db, reused)
      log('oauth_refresh_reused', { grant: reused })
    }
    return failed(ctx, clientId, oauthError('invalid_grant', 'The refresh token is not valid, has expired, or was already used.'))
  }
  const grant = await findGrant(ctx.config.db, grantId, ctx.now)
  if (!grant || grant.client_id !== clientId) return oauthError('invalid_grant', 'The refresh token was issued to another client.')
  return grantTokens(ctx, grant)
}

/** The client's id and secret, from HTTP Basic (RFC 6749 §2.3.1, each form-encoded) or the body. */
function clientSecretOf(ctx: Context, params: Record<string, string>): { id: string; secret: string } | null {
  const basic = /^Basic\s+([A-Za-z0-9+/=]+)\s*$/i.exec(ctx.request.headers.get('Authorization') ?? '')
  if (basic) {
    let decoded: string
    try {
      decoded = atob(basic[1]!)
    } catch {
      return null
    }
    const colon = decoded.indexOf(':')
    if (colon < 0) return null
    try {
      return { id: decodeURIComponent(decoded.slice(0, colon).replace(/\+/g, ' ')), secret: decodeURIComponent(decoded.slice(colon + 1).replace(/\+/g, ' ')) }
    } catch {
      return null
    }
  }
  return params.client_id && params.client_secret ? { id: params.client_id, secret: params.client_secret } : null
}

/** The service account these credentials belong to, or null. */
export async function serviceAccountFor(ctx: Context, credentials: { id: string; secret: string } | null): Promise<ServiceAccountRow | null> {
  if (!credentials || !credentials.id.startsWith(PREFIX.serviceAccount) || !isSecret(credentials.secret, PREFIX.secret)) return null
  const account = await findServiceAccountByClientId(ctx.config.db, credentials.id)
  if (!account) return null
  return constantTimeEqual(account.secret_hash, await hashSecret(credentials.secret)) ? account : null
}

async function clientCredentials(ctx: Context, params: Record<string, string>): Promise<Response> {
  const credentials = clientSecretOf(ctx, params)
  const limited = await tokenLimit(ctx)
  if (limited) return limited
  const account = await serviceAccountFor(ctx, credentials)
  if (!account) return failed(ctx, credentials?.id ?? '', oauthError('invalid_client', 'The client id or secret is wrong.', 401, { 'WWW-Authenticate': 'Basic realm="insulin-apps"' }))
  const app = ctx.config.apps.find((candidate) => candidate.name === account.app)
  if (!app) return oauthError('invalid_client', 'The app of this service account is no longer available.', 401)
  if (params.resource && params.resource.replace(/\/$/, '') !== apiResource(ctx, app)) {
    return oauthError('invalid_target', `This service account's tokens are for ${apiResource(ctx, app)}.`)
  }
  const access = newSecret(PREFIX.access)
  await issueTokens(ctx.config.db, [
    { hash: await hashSecret(access), kind: 'access', grantId: null, serviceAccountId: account.id, expiresAt: ctx.now + ACCESS_TTL_MS },
  ], ctx.now)
  log('oauth_service_token', { account: account.id, app: app.name })
  return corsJson({ access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL_MS / 1000 })
}

/**
 * POST /oauth/revoke (RFC 7009): a refresh token ends its whole grant, an access token only itself. The client must be
 * the token's own (by client_id for public clients, by its credentials for a service account). Always 200, so the
 * answer says nothing about a token that isn't the caller's.
 */
export async function revoke(ctx: Context): Promise<Response> {
  const params = await readParams(ctx)
  if (params instanceof Response) return params
  const presented = params.token ?? ''
  if (!presented) return oauthError('invalid_request', 'Send the token to revoke.')
  if (!(await allowOAuth(ctx, `revoke:ip:${ctx.clientIp ?? 'unknown'}`))) return oauthError('slow_down', 'Too many requests. Try again in a minute.', 429, { 'Retry-After': '60' })
  const credentials = clientSecretOf(ctx, params)
  const clientId = credentials?.id ?? params.client_id ?? ''
  if (!isSecret(presented, PREFIX.access) && !isSecret(presented, PREFIX.refresh)) return corsJson({})
  const hash = await hashSecret(presented)
  const owner = await findTokenOwner(ctx.config.db, hash)
  if (!owner) return corsJson({})
  if (owner.grant_id && owner.client_id === clientId) {
    if (owner.kind === 'refresh') await deleteGrant(ctx.config.db, owner.grant_id)
    else await deleteToken(ctx.config.db, hash)
    log('oauth_revoked', { grant: owner.grant_id, kind: owner.kind })
  } else if (owner.service_account_client_id && (await serviceAccountFor(ctx, credentials))?.client_id === owner.service_account_client_id) {
    await deleteToken(ctx.config.db, hash)
    log('oauth_revoked', { kind: 'service' })
  }
  return corsJson({})
}
