// Host and path dispatch. Every POST to the auth host passes the Origin and content-type checks here before its
// handler runs; /__insulin/* checks its own (reserved.ts). index.ts wraps all of it in the outer security layer.
import { staticAsset } from './assets.ts'
import { loadConfig } from './config.ts'
import { createContext, type Context } from './context.ts'
import { UUID_PATTERN } from './crypto.ts'
import type { Env } from './env.ts'
import { housekeeping } from './housekeeping.ts'
import { reservedRoutes } from './reserved.ts'
import { BodyTooLarge, FORM_LIMIT_BYTES, isFormBody, isSameOrigin, readText } from './http/request.ts'
import { redirect } from './http/response.ts'
import { httpsUpgrade, isFromApp, markFromApp } from './http/secure.ts'
import { log, logError } from './log.ts'
import { badRequestPage, forbiddenPage, methodNotAllowed, notConfiguredResponse, notFoundPage } from './pages/status.ts'
import { proxyToApp } from './proxy.ts'
import { authHome, landing, privacy, terms } from './site.ts'
import { accountView, deleteAccount, updateName, updatePassword } from './auth/account.ts'
import {
  forgot, forgotForm, login, loginForm, logout, resend, resendForm, reset, resetForm, signup, signupForm, verifyEmail,
  verifyEmailForm,
} from './auth/accounts.ts'
import { googleCallback, googleStart } from './auth/google.ts'
import { acceptInvitation, declineInvitation, invitationView, invite, resendInvitation, revokeInvitation } from './orgs/invitations.ts'
import {
  changeMemberRole, createOrg, deleteOrg, leaveOrg, newOrgForm, orgOverview, removeMember, renameOrg, switchOrg,
} from './orgs/orgs.ts'

type Handler = (ctx: Context, params: string[]) => Promise<Response> | Response

interface Route {
  method: 'GET' | 'POST'
  pattern: RegExp
  handler: Handler
}

// Organization, user and invitation ids are UUIDs; anything else in their place is a 404 without a database lookup.
const ORG = UUID_PATTERN
const USER = UUID_PATTERN
const INVITATION = UUID_PATTERN

function route(method: 'GET' | 'POST', path: string, handler: Handler): Route {
  return { method, pattern: new RegExp(`^${path}$`), handler }
}

const APEX_ROUTES: Route[] = [
  route('GET', '/', landing),
  route('GET', '/privacy', privacy),
  route('GET', '/terms', terms),
]

const AUTH_ROUTES: Route[] = [
  route('GET', '/', authHome),
  route('GET', '/signup', signupForm),
  route('POST', '/signup', signup),
  route('GET', '/login', loginForm),
  route('POST', '/login', login),
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
  route('POST', '/orgs/switch', switchOrg),
  route('GET', `/orgs/(${ORG})`, orgOverview),
  route('POST', `/orgs/(${ORG})/rename`, renameOrg),
  route('POST', `/orgs/(${ORG})/delete`, deleteOrg),
  route('POST', `/orgs/(${ORG})/leave`, leaveOrg),
  route('POST', `/orgs/(${ORG})/members/(${USER})/role`, changeMemberRole),
  route('POST', `/orgs/(${ORG})/members/(${USER})/remove`, removeMember),
  route('POST', `/orgs/(${ORG})/invitations`, invite),
  route('POST', `/orgs/(${ORG})/invitations/(${INVITATION})/revoke`, revokeInvitation),
  route('POST', `/orgs/(${ORG})/invitations/(${INVITATION})/resend`, resendInvitation),
  route('GET', `/invitations/(${INVITATION})`, invitationView),
  route('POST', `/invitations/(${INVITATION})/accept`, acceptInvitation),
  route('POST', `/invitations/(${INVITATION})/decline`, declineInvitation),
  route('GET', '/account', accountView),
  route('POST', '/account/name', updateName),
  route('POST', '/account/password', updatePassword),
  route('POST', '/account/delete', deleteAccount),
]

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
  if (path === '/__insulin' || path.startsWith('/__insulin/')) return reservedRoutes(ctx)
  if (ctx.site === 'app') return proxyToApp(ctx, ctx.app!)
  return runRoutes(ctx, ctx.site === 'auth' ? AUTH_ROUTES : APEX_ROUTES)
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
      const rejected = await readPostForm(ctx)
      if (rejected) return rejected
    }
    return candidate.handler(ctx, match.slice(1))
  }
  if (allowed.size) return methodNotAllowed(ctx, allowed.has('GET') ? [...allowed, 'HEAD'] : [...allowed])
  return notFoundPage(ctx)
}

/** POSTs to the auth host: from the auth host's own pages, as a small urlencoded form. Otherwise 403, 415 or 413. */
async function readPostForm(ctx: Context): Promise<Response | null> {
  if (!isSameOrigin(ctx)) {
    log('origin_rejected', { site: ctx.site, path: ctx.url.pathname })
    return forbiddenPage(ctx)
  }
  if (!isFormBody(ctx.request)) return badRequestPage(ctx, 415, 'Please submit the form on this site.')
  try {
    ctx.form = new URLSearchParams(await readText(ctx.request, FORM_LIMIT_BYTES))
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
