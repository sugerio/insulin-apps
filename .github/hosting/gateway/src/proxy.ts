// App hosts: forwards to the app Worker over its service binding with the Insulin console identity headers, the way
// the console's entry worker does. Apps trust these headers, so whatever the browser sent under x-suger-* is dropped,
// and the session cookie never reaches an app.
import { appAccess } from './access.ts'
import { apiCall } from './oauth/app-api.ts'
import { hasBearer } from './oauth/tokens.ts'
import { isPublicPath, type HostedApp } from './config.ts'
import type { Context } from './context.ts'
import { apexUrl, withReturnTo } from './context.ts'
import { setCookieName } from './http/cookies.ts'
import { GATEWAY_COOKIES, forwardRequest, identityHeaders, isNavigation, publicHeaders } from './http/forward.ts'
import { jsonResponse, redirect } from './http/response.ts'
import { markFromApp } from './http/secure.ts'
import { log, logError } from './log.ts'
import { appUnavailablePage, noAppAccessPage, rateLimitedPage } from './pages/status.tsx'
import { allowApp, allowPublic, allowPublicChange } from './ratelimit.ts'
import { verifyNotice } from './auth/guard.ts'
import { activeOrg, loadSession } from './auth/session.ts'

export const BAR_TAG = '<script src="/__insulin/bar.js" defer></script>'

function isHtml(contentType: string | null): boolean {
  return /^text\/html(\s*;|$)/i.test(contentType ?? '')
}

/**
 * The app's response, unchanged except: its attempts to set gateway cookies are dropped and HTML gets the account bar
 * (not on a public path, where nobody is signed in). It is marked as the app's, so the outer security layer adds HSTS
 * only.
 */
export function appResponse(ctx: Context, app: HostedApp, upstream: Response, { bar = true } = {}): Response {
  if (upstream.status === 101 || upstream.webSocket) return upstream
  const response = markFromApp(new Response(upstream.body, upstream))
  const cookies = response.headers.getSetCookie()
  if (cookies.length) {
    response.headers.delete('Set-Cookie')
    for (const cookie of cookies) {
      if (GATEWAY_COOKIES.has(setCookieName(cookie))) log('app_cookie_dropped', { app: app.name })
      else response.headers.append('Set-Cookie', cookie)
    }
  }
  if (!bar || !isHtml(response.headers.get('Content-Type')) || !response.body || ctx.request.method === 'HEAD') return response
  return markFromApp(new HTMLRewriter()
    .on('body', { element: (body) => { body.append(BAR_TAG, { html: true }) } })
    .transform(response))
}

export async function proxyToApp(ctx: Context, app: HostedApp): Promise<Response> {
  const path = ctx.url.pathname
  const api = path === '/api' || path.startsWith('/api/')
  const navigation = !api && isNavigation(ctx.request)
  if (!app.service) return navigation ? appUnavailablePage(ctx, 503) : jsonResponse({ error: 'unavailable' }, 503)

  // A public path is for people without an account (DESIGN.md §8.1): no session, token or identity is looked at or sent.
  if (isPublicPath(app, path)) return proxyPublic(ctx, app, navigation)
  // A bearer token is a machine's way in (DESIGN.md §4): it never falls back to the browser's cookies.
  if (hasBearer(ctx.request)) return apiCall(ctx, app)
  const session = await loadSession(ctx)
  if (!session) {
    return navigation ? redirect(apexUrl(ctx, withReturnTo('/login', ctx.url.href)), 302) : jsonResponse({ error: 'unauthorized' }, 401)
  }
  if (!session.user.verified) return navigation ? verifyNotice(ctx, session) : jsonResponse({ error: 'unauthorized' }, 401)
  const org = await activeOrg(ctx, session)
  if (!org) {
    return navigation ? redirect(apexUrl(ctx, withReturnTo('/orgs/new', ctx.url.href)), 302) : jsonResponse({ error: 'no_organization' }, 403)
  }
  const access = await appAccess(ctx.config.db, app, org.id, session.user.id, org.role)
  if (!access) return navigation ? noAppAccessPage(ctx, session, org, app) : jsonResponse({ error: 'no_app_access' }, 403)
  if (!(await allowApp(ctx, session.user.id))) {
    return navigation ? rateLimitedPage(ctx) : jsonResponse({ error: 'rate_limited' }, 429, { 'Retry-After': '60' })
  }

  let upstream: Response
  try {
    upstream = await app.service.fetch(forwardRequest(ctx.request, identityHeaders(session.user, org.id, app, access, 'browser')))
  } catch (error) {
    logError('app_unreachable', error, { app: app.name })
    return navigation ? appUnavailablePage(ctx, 502) : jsonResponse({ error: 'bad_gateway' }, 502)
  }
  return appResponse(ctx, app, upstream)
}

/**
 * A request on one of the app's public paths: forwarded with only the app's id and `x-suger-access-via: public`, never
 * the session, a token or anyone's identity, and limited per IP (RL_APP); one that isn't GET or HEAD also counts
 * against the stricter RL_PUBLIC, per app and IP. The app's own headers (its CSP and frame-ancestors) stay; HTML gets
 * no account bar.
 */
async function proxyPublic(ctx: Context, app: HostedApp, navigation: boolean): Promise<Response> {
  if (!(await allowPublic(ctx))) return navigation ? rateLimitedPage(ctx) : jsonResponse({ error: 'rate_limited' }, 429, { 'Retry-After': '60' })
  const reading = ctx.request.method === 'GET' || ctx.request.method === 'HEAD'
  if (!reading && !(await allowPublicChange(ctx, app.name))) return jsonResponse({ error: 'rate_limited' }, 429, { 'Retry-After': '60' })
  let upstream: Response
  try {
    upstream = await app.service!.fetch(forwardRequest(ctx.request, publicHeaders(app), { dropAuthorization: true }))
  } catch (error) {
    logError('app_unreachable', error, { app: app.name })
    return navigation ? appUnavailablePage(ctx, 502) : jsonResponse({ error: 'bad_gateway' }, 502)
  }
  return appResponse(ctx, app, upstream, { bar: false })
}
