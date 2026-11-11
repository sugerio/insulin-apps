// Host and path dispatch. Every form POST to the apex passes the Origin and content-type checks here before its handler
// runs; /__insulin/* checks its own (reserved.ts). index.ts wraps all of it in the outer security layer. The old auth
// host only redirects to the apex.
import { siteIcon, staticAsset } from './assets.ts'
import { isGatewayAppPath, loadConfig } from './config.ts'
import { apexUrl, createContext, type Context } from './context.ts'
import { UUID_PATTERN } from './crypto.ts'
import type { Env } from './env.ts'
import { housekeeping } from './housekeeping.ts'
import { reservedRoutes } from './reserved.ts'
import { BodyTooLarge, FORM_LIMIT_BYTES, isFormBody, isSameOrigin, readText } from './http/request.ts'
import { redirect } from './http/response.ts'
import { httpsUpgrade, isFromApp, markFromApp } from './http/secure.ts'
import { log, logError } from './log.ts'
import { badRequestPage, forbiddenPage, methodNotAllowed, notConfiguredResponse, notFoundPage } from './pages/status.tsx'
import { proxyToApp } from './proxy.ts'
import { landing, privacy, terms } from './site.ts'
import { docs } from './docs.ts'
import { accountView, deleteAccount, updateName, updatePassword } from './auth/account.ts'
import {
  forgot, forgotForm, login, loginForm, logout, resend, resendForm, reset, resetForm, signup, signupForm, verifyEmail,
  verifyEmailForm,
} from './auth/accounts.ts'
import { agentsView, disconnectAgent } from './auth/agents.ts'
import { googleCallback, googleStart } from './auth/google.ts'
import { mfaForm, mfaVerify } from './auth/mfa.ts'
import { cancelSetup, disable as disableMfa, enable as enableMfa, regenerateCodes, securityView, startSetup } from './auth/security.ts'
import {
  apiAccess, createApiClient, deleteApiClient, revokePreviousApiClientSecret, rotateApiClientSecret, updateApiClient,
} from './integrations/api-clients.ts'
import { createCredential, deleteCredential, integrations, updateCredential } from './integrations/settings.ts'
import { connectAi, disconnectAppAgent } from './mcp/connect-ai.ts'
import { mcpEndpoint, protectedResourceMetadata } from './mcp/server.ts'
import { preflight } from './oauth/http.ts'
import { authorizationServerMetadata, authorize, decide, register, revoke, token } from './oauth/server.ts'
import { acceptInvitation, declineInvitation, invitationView, invite, resendInvitation, revokeInvitation } from './orgs/invitations.ts'
import {
  changeAppRole, inviteToApp, removeFromApp, resendAppInvitation, revokeAppInvitation, appUsers,
} from './orgs/app-users.ts'
import { createCustomRole, deleteCustomRole, updateCustomRole } from './orgs/custom-roles.ts'
import {
  changeMemberRole, createOrg, deleteOrg, leaveOrg, newOrgForm, orgOverview, organizationSettings, removeMember,
  renameOrg, requestMoreOrgs, rolesSettings, setInviteDomains, switchOrg, usersSettings,
} from './orgs/orgs.ts'
import { oidcCallback, samlAcs, samlMetadata, ssoForm, ssoStart } from './sso/flow.ts'
import { MAX_RESPONSE_BYTES } from './sso/saml.ts'
import { SCIM_BASE, scimRoutes } from './sso/scim.ts'
import {
  claimSsoDomain, createScimToken, deleteSsoConnection, removeSsoDomain, revokeScimToken, saveSsoConnection, ssoSettings,
  verifySsoDomain,
} from './sso/settings.ts'

type Handler = (ctx: Context, params: string[]) => Promise<Response> | Response

interface Route {
  method: 'GET' | 'POST'
  pattern: RegExp
  handler: Handler
  /**
   * A form another site posts here (a SAML response from an identity provider): no Origin check, a larger body. The
   * handler stands on its own proof instead (a signed response tied to a pending sign-in and this browser).
   */
  crossSite?: boolean
}

// Organization, user and invitation ids are UUIDs; anything else in their place is a 404 without a database lookup.
const ORG = UUID_PATTERN
const USER = UUID_PATTERN
const INVITATION = UUID_PATTERN
const ROLE = UUID_PATTERN
const GRANT = UUID_PATTERN
const ACCOUNT = UUID_PATTERN
const CREDENTIAL = UUID_PATTERN
const CONNECTION = UUID_PATTERN
// App names, as config.ts isAppName allows them; an unknown one is a 404 in forApp.
const APP = '[a-z](?:[a-z0-9-]{0,30}[a-z0-9])?'
const SCIM_TOKEN = UUID_PATTERN

function route(method: 'GET' | 'POST', path: string, handler: Handler, options: { crossSite?: boolean } = {}): Route {
  return { method, pattern: new RegExp(`^${path}$`), handler, ...options }
}

// The favicon at the root of the gateway's own hosts (app hosts answer for their own).
const ICON_ROUTES: Route[] = [
  route('GET', '/favicon\\.ico', siteIcon),
  route('GET', '/apple-touch-icon\\.png', siteIcon),
]

const APEX_ROUTES: Route[] = [
  ...ICON_ROUTES,
  route('GET', '/', landing),
  route('GET', '/privacy', privacy),
  route('GET', '/terms', terms),
  // The public documentation, its llms.txt and its images (docs.ts).
  route('GET', '/docs(?:/.*)?', docs),
  route('GET', '/signup', signupForm),
  route('POST', '/signup', signup),
  route('GET', '/login', loginForm),
  route('POST', '/login', login),
  route('GET', '/login/mfa', mfaForm),
  route('POST', '/login/mfa', mfaVerify),
  route('POST', '/logout', logout),
  route('GET', '/verify-email', verifyEmailForm),
  route('POST', '/verify-email', verifyEmail),
  route('GET', '/resend-verification', resendForm),
  route('POST', '/resend-verification', resend),
  route('GET', '/forgot-password', forgotForm),
  route('POST', '/forgot-password', forgot),
  route('GET', '/reset-password', resetForm),
  route('POST', '/reset-password', reset),
  route('GET', '/auth/google/start', googleStart),
  route('GET', '/auth/google/callback', googleCallback),
  route('GET', '/orgs/new', newOrgForm),
  route('POST', '/orgs/new', createOrg),
  route('POST', '/orgs/request', requestMoreOrgs),
  route('POST', '/orgs/switch', switchOrg),
  route('GET', `/orgs/(${ORG})`, orgOverview),
  route('POST', `/orgs/(${ORG})/rename`, renameOrg),
  route('POST', `/orgs/(${ORG})/delete`, deleteOrg),
  route('POST', `/orgs/(${ORG})/leave`, leaveOrg),
  route('POST', `/orgs/(${ORG})/invite-domains`, setInviteDomains),
  route('POST', `/orgs/(${ORG})/members/(${USER})/role`, changeMemberRole),
  route('POST', `/orgs/(${ORG})/members/(${USER})/remove`, removeMember),
  route('POST', `/orgs/(${ORG})/invitations`, invite),
  route('POST', `/orgs/(${ORG})/invitations/(${INVITATION})/revoke`, revokeInvitation),
  route('POST', `/orgs/(${ORG})/invitations/(${INVITATION})/resend`, resendInvitation),
  route('POST', `/orgs/(${ORG})/roles`, createCustomRole),
  route('POST', `/orgs/(${ORG})/roles/(${ROLE})`, updateCustomRole),
  route('POST', `/orgs/(${ORG})/roles/(${ROLE})/delete`, deleteCustomRole),
  route('GET', '/settings/users', usersSettings),
  route('GET', '/settings/roles', rolesSettings),
  route('GET', '/settings/organization', organizationSettings),
  route('GET', '/settings/sso', ssoSettings),
  route('POST', `/orgs/(${ORG})/sso/domains`, claimSsoDomain),
  route('POST', `/orgs/(${ORG})/sso/domains/verify`, verifySsoDomain),
  route('POST', `/orgs/(${ORG})/sso/domains/remove`, removeSsoDomain),
  route('POST', `/orgs/(${ORG})/sso/connection`, saveSsoConnection),
  route('POST', `/orgs/(${ORG})/sso/connection/delete`, deleteSsoConnection),
  route('POST', `/orgs/(${ORG})/sso/scim-tokens`, createScimToken),
  route('POST', `/orgs/(${ORG})/sso/scim-tokens/(${SCIM_TOKEN})/revoke`, revokeScimToken),
  route('GET', '/sso', ssoForm),
  route('POST', '/sso', ssoStart),
  route('GET', `/sso/saml/(${CONNECTION})/metadata`, samlMetadata),
  route('POST', `/sso/saml/(${CONNECTION})/acs`, samlAcs, { crossSite: true }),
  route('GET', `/sso/oidc/(${CONNECTION})/callback`, oidcCallback),
  route('GET', `/invitations/(${INVITATION})`, invitationView),
  route('POST', `/invitations/(${INVITATION})/accept`, acceptInvitation),
  route('POST', `/invitations/(${INVITATION})/decline`, declineInvitation),
  route('GET', '/account', accountView),
  route('POST', '/account/name', updateName),
  route('POST', '/account/password', updatePassword),
  route('POST', '/account/delete', deleteAccount),
  route('GET', '/account/security', securityView),
  route('POST', '/account/security/setup', startSetup),
  route('POST', '/account/security/cancel', cancelSetup),
  route('POST', '/account/security/enable', enableMfa),
  route('POST', '/account/security/recovery-codes', regenerateCodes),
  route('POST', '/account/security/disable', disableMfa),
  route('GET', '/account/agents', agentsView),
  route('POST', `/account/agents/(${GRANT})/disconnect`, disconnectAgent),
  route('GET', '/oauth/authorize', authorize),
  route('POST', '/oauth/authorize/decision', decide),
]


/**
 * A handler for one app's settings page on the apex: the app named in the path, as `ctx.app`, or a 404. These pages
 * live on the apex, not on the app's host: the session cookie reaches app hosts too, so code the app serves could
 * otherwise read them and post their forms as the visitor (DESIGN.md §3).
 */
function forApp(handler: Handler): Handler {
  return (ctx, [name, ...params]) => {
    const app = ctx.config.apps.find((candidate) => candidate.name === name)
    if (!app) return notFoundPage(ctx)
    ctx.app = app
    return handler(ctx, params)
  }
}

/** Each app's people, integrations, API access and Connect AI pages, on the apex (DESIGN.md §3, §5.2, §5.3, §6). */
const APP_SETTINGS_ROUTES: Route[] = [
  route('GET', `/apps/(${APP})/settings/users`, forApp(appUsers)),
  route('POST', `/apps/(${APP})/settings/users/invite`, forApp(inviteToApp)),
  route('POST', `/apps/(${APP})/settings/users/(${USER})/role`, forApp(changeAppRole)),
  route('POST', `/apps/(${APP})/settings/users/(${USER})/remove`, forApp(removeFromApp)),
  route('POST', `/apps/(${APP})/settings/users/invitations/(${INVITATION})/revoke`, forApp(revokeAppInvitation)),
  route('POST', `/apps/(${APP})/settings/users/invitations/(${INVITATION})/resend`, forApp(resendAppInvitation)),
  route('GET', `/apps/(${APP})/settings/integrations`, forApp(integrations)),
  route('POST', `/apps/(${APP})/settings/integrations/credentials`, forApp(createCredential)),
  route('POST', `/apps/(${APP})/settings/integrations/credentials/(${CREDENTIAL})`, forApp(updateCredential)),
  route('POST', `/apps/(${APP})/settings/integrations/credentials/(${CREDENTIAL})/delete`, forApp(deleteCredential)),
  route('GET', `/apps/(${APP})/settings/api`, forApp(apiAccess)),
  route('POST', `/apps/(${APP})/settings/api/clients`, forApp(createApiClient)),
  route('POST', `/apps/(${APP})/settings/api/clients/(${ACCOUNT})`, forApp(updateApiClient)),
  route('POST', `/apps/(${APP})/settings/api/clients/(${ACCOUNT})/rotate`, forApp(rotateApiClientSecret)),
  route('POST', `/apps/(${APP})/settings/api/clients/(${ACCOUNT})/revoke-previous`, forApp(revokePreviousApiClientSecret)),
  route('POST', `/apps/(${APP})/settings/api/clients/(${ACCOUNT})/delete`, forApp(deleteApiClient)),
  route('GET', `/apps/(${APP})/settings/connect-ai`, forApp(connectAi)),
  route('POST', `/apps/(${APP})/settings/connect-ai/agents/(${GRANT})/disconnect`, forApp(disconnectAppAgent)),
]

/**
 * `<app>.<domain>/settings/users`, `/settings/integrations`, `/settings/api` and `/settings/connect-ai` (and below): a
 * GET goes to the same page on the apex, anything else is refused, so nothing on the app's host can change settings.
 */
function appSettingsRedirect(ctx: Context): Response {
  const method = ctx.request.method
  if (method !== 'GET' && method !== 'HEAD') return methodNotAllowed(ctx, ['GET', 'HEAD'])
  return redirect(apexUrl(ctx, `/apps/${ctx.app!.name}${ctx.url.pathname}${ctx.url.search}`), 302)
}

type MachineHandler = (ctx: Context) => Promise<Response> | Response

/**
 * Endpoints machines call, with JSON or form bodies and no cookies: they skip the form POST checks and answer CORS
 * preflights (oauth/http.ts). On the apex, the authorization server; on every app host, its MCP server and metadata.
 */
const APEX_MACHINE: Record<string, { methods: string; handlers: Partial<Record<string, MachineHandler>> }> = {
  '/.well-known/oauth-authorization-server': { methods: 'GET, OPTIONS', handlers: { GET: authorizationServerMetadata } },
  '/oauth/register': { methods: 'POST, OPTIONS', handlers: { POST: register } },
  '/oauth/token': { methods: 'POST, OPTIONS', handlers: { POST: token } },
  '/oauth/revoke': { methods: 'POST, OPTIONS', handlers: { POST: revoke } },
}

function appMachine(ctx: Context, path: string): Promise<Response> | Response | null {
  const app = ctx.app!
  switch (path) {
    case '/mcp':
      return mcpEndpoint(ctx, app)
    case '/.well-known/oauth-protected-resource':
    case '/.well-known/oauth-protected-resource/mcp':
    case '/.well-known/oauth-authorization-server': {
      const method = ctx.request.method
      if (method === 'OPTIONS') return preflight('GET, OPTIONS')
      if (method !== 'GET' && method !== 'HEAD') return new Response(null, { status: 405, headers: { Allow: 'GET, HEAD, OPTIONS' } })
      if (path === '/.well-known/oauth-authorization-server') return authorizationServerMetadata(ctx)
      return protectedResourceMetadata(ctx, app, path.endsWith('/mcp'))
    }
    default:
      return null
  }
}

function apexMachine(ctx: Context, path: string): Promise<Response> | Response | null {
  const endpoint = APEX_MACHINE[path]
  if (!endpoint) return null
  const method = ctx.request.method === 'HEAD' ? 'GET' : ctx.request.method
  if (method === 'OPTIONS') return preflight(endpoint.methods)
  const handler = endpoint.handlers[method]
  if (!handler) return new Response(null, { status: 405, headers: { Allow: endpoint.methods } })
  return handler(ctx)
}

export async function handleRequest(request: Request, env: Env, exec: ExecutionContext): Promise<Response> {
  const url = new URL(request.url)
  const loaded = loadConfig(env)
  if (loaded.ok && url.hostname === `www.${loaded.config.domain}`) return wwwRedirect(url, loaded.config.testMode)
  // Before anything else is served (assets and configuration errors included): production hosts are https only.
  const upgrade = httpsUpgrade(request)
  if (upgrade) return upgrade
  const asset = staticAsset(request, url)
  if (asset) return asset
  if (!loaded.ok) return notConfiguredResponse()
  const ctx = createContext(request, env, exec, loaded.config)
  if (url.protocol === 'http:' && !ctx.relaxed) return toHttps(ctx)
  const response = await dispatch(ctx)
  if (request.method === 'POST') {
    // Retention cleanup, a bounded batch after each state-changing request (housekeeping.ts).
    exec.waitUntil(housekeeping(ctx.config.db, ctx.now).catch((error) => logError('housekeeping_failed', error)))
  }
  return finalize(ctx, response)
}

/** www.<domain> → the apex, same path and query, in one hop. It never looks at cookies, sessions or apps. */
function wwwRedirect(url: URL, testMode: boolean): Response {
  const local = testMode && url.protocol === 'http:' && url.hostname.endsWith('.localhost')
  const origin = local ? `http://${url.hostname.slice(4)}${url.port ? `:${url.port}` : ''}` : `https://${url.hostname.slice(4)}`
  return redirect(`${origin}${url.pathname}${url.search}`, 301)
}

function toHttps(ctx: Context): Response {
  if (ctx.request.method !== 'GET' && ctx.request.method !== 'HEAD') return badRequestPage(ctx, 400, 'This site only accepts secure (https) requests.')
  return redirect(`https://${ctx.host}${ctx.url.pathname}${ctx.url.search}`, 301)
}

async function dispatch(ctx: Context): Promise<Response> {
  if (ctx.site === 'other') return notFoundPage(ctx)
  const path = ctx.url.pathname
  if (ctx.site === 'auth') return authRedirect(ctx)
  if (path === '/__insulin' || path.startsWith('/__insulin/')) return reservedRoutes(ctx)
  if (ctx.site === 'app') {
    const machine = appMachine(ctx, path)
    if (machine) return machine
    return isGatewayAppPath(path) ? appSettingsRedirect(ctx) : proxyToApp(ctx, ctx.app!)
  }
  // SCIM speaks JSON with a bearer token, not forms: it has its own dispatch and checks (sso/scim.ts).
  if (path === SCIM_BASE || path.startsWith(`${SCIM_BASE}/`)) return scimRoutes(ctx)
  return apexMachine(ctx, path) ?? runRoutes(ctx, path.startsWith('/apps/') ? APP_SETTINGS_ROUTES : APEX_ROUTES)
}

/**
 * Sign-in used to live on auth.<domain>; links in e-mails already sent point there. A 308 keeps the method and body,
 * but a form posted from an old page still fails the apex's Origin check, which is right: it came from another origin.
 */
function authRedirect(ctx: Context): Response {
  return redirect(apexUrl(ctx, `${ctx.url.pathname}${ctx.url.search}`), 308)
}

async function runRoutes(ctx: Context, routes: Route[]): Promise<Response> {
  const method = ctx.request.method === 'HEAD' ? 'GET' : ctx.request.method
  const allowed = new Set<string>()
  for (const candidate of routes) {
    const match = candidate.pattern.exec(ctx.url.pathname)
    if (!match) continue
    if (candidate.method !== method) {
      allowed.add(candidate.method)
      continue
    }
    if (candidate.method === 'POST') {
      const rejected = await readPostForm(ctx, candidate.crossSite === true)
      if (rejected) return rejected
    }
    return candidate.handler(ctx, match.slice(1))
  }
  if (allowed.size) return methodNotAllowed(ctx, allowed.has('GET') ? [...allowed, 'HEAD'] : [...allowed])
  return notFoundPage(ctx)
}

/**
 * Form POSTs to the apex: from the apex's own pages, as a small urlencoded form. Otherwise 403, 415 or 413. A
 * cross-site route skips the Origin check and takes a SAML-sized body.
 */
async function readPostForm(ctx: Context, crossSite: boolean): Promise<Response | null> {
  if (!crossSite && !isSameOrigin(ctx)) {
    log('origin_rejected', { site: ctx.site, path: ctx.url.pathname })
    return forbiddenPage(ctx)
  }
  if (!isFormBody(ctx.request)) return badRequestPage(ctx, 415, 'Please submit the form on this site.')
  try {
    ctx.form = new URLSearchParams(await readText(ctx.request, crossSite ? MAX_RESPONSE_BYTES * 2 : FORM_LIMIT_BYTES))
  } catch (error) {
    if (error instanceof BodyTooLarge) return badRequestPage(ctx, 413, 'That form is too large.')
    throw error
  }
  return null
}

/** Adds the cookies set while handling the request (an app's response stays marked as the app's). */
function finalize(ctx: Context, response: Response): Response {
  if (response.status === 101 || !ctx.setCookies.length) return response
  const out = new Response(response.body, response)
  for (const cookie of ctx.setCookies) out.headers.append('Set-Cookie', cookie)
  return isFromApp(response) ? markFromApp(out) : out
}
