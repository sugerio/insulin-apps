// App hosts: forwards to the app Worker over its service binding with the Insulin console identity headers, the way
// the console's entry worker does. Apps trust these headers, so whatever the browser sent under x-suger-* is dropped,
// and the session cookie never reaches an app.
import type { HostedApp } from './config.ts'
import type { Context } from './context.ts'
import { authUrl, withReturnTo } from './context.ts'
import { setCookieName, withoutCookies } from './http/cookies.ts'
import { jsonResponse, redirect } from './http/response.ts'
import { markFromApp } from './http/secure.ts'
import { log, logError } from './log.ts'
import { html } from './pages/html.ts'
import { messagePage, rateLimitedPage } from './pages/status.ts'
import { allowApp } from './ratelimit.ts'
import { verifyNotice } from './auth/guard.ts'
import { SESSION_COOKIE, activeOrg, loadSession, type ActiveOrg, type Session } from './auth/session.ts'

export const BAR_TAG = '<script src="/__insulin/bar.js" defer></script>'

// Lower-case names of the gateway's own cookies: never forwarded to an app, never set by one.
const GATEWAY_COOKIES: ReadonlySet<string> = new Set([SESSION_COOKIE, 'insulin_oauth', '__host-insulin_oauth'])

/** The identity contract of `@fours/app` (`getCurrentUser` with SUGER_ACCESS_MODE=console). */
export function identityHeaders(session: Session, org: ActiveOrg, app: HostedApp): Record<string, string> {
  return {
    'x-suger-user-id': session.user.id,
    'x-suger-organization-id': org.id,
    'x-suger-app-id': app.appId,
    'x-suger-app-role': org.role,
    'x-suger-user-email': encodeURIComponent(session.user.email),
    'x-suger-user-name': encodeURIComponent(session.user.name || session.user.email),
  }
}

/** The original request (same URL and method, body streamed, not buffered) with the identity headers in place. */
export function forwardRequest(request: Request, identity: Record<string, string>): Request {
  const headers = new Headers(request.headers)
  for (const name of [...headers.keys()]) {
    if (name.toLowerCase().startsWith('x-suger-')) headers.delete(name)
  }
  const cookie = withoutCookies(headers.get('Cookie'), GATEWAY_COOKIES)
  if (cookie) headers.set('Cookie', cookie)
  else headers.delete('Cookie')
  for (const [name, value] of Object.entries(identity)) headers.set(name, value)
  // The original request as the input keeps its URL, method and streamed body; only headers and redirect change.
  return new Request(request, { headers, redirect: 'manual' })
}

function isHtml(contentType: string | null): boolean {
  return /^text\/html(\s*;|$)/i.test(contentType ?? '')
}

/**
 * The app's response, unchanged except: its attempts to set gateway cookies are dropped and HTML gets the account bar.
 * It is marked as the app's, so the outer security layer adds HSTS only.
 */
export function appResponse(ctx: Context, app: HostedApp, upstream: Response): Response {
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
  if (!isHtml(response.headers.get('Content-Type')) || !response.body || ctx.request.method === 'HEAD') return response
  return markFromApp(new HTMLRewriter()
    .on('body', { element: (body) => { body.append(BAR_TAG, { html: true }) } })
    .transform(response))
}

/**
 * A browser navigation, which may be sent to sign in: GET or HEAD with `Sec-Fetch-Mode: navigate`, or, from a client
 * that sends no fetch metadata, an `Accept` that asks for HTML. Scripts, assets and API calls get 401 JSON instead.
 */
export function isNavigation(request: Request): boolean {
  if (request.method !== 'GET' && request.method !== 'HEAD') return false
  const mode = request.headers.get('Sec-Fetch-Mode')
  if (mode !== null) return mode === 'navigate'
  return /\btext\/html\b/i.test(request.headers.get('Accept') ?? '')
}

function unavailable(ctx: Context, status: number): Response {
  return messagePage(ctx, status, 'This app is not available right now', html`<p>Please try again in a few minutes.</p>`)
}

export async function proxyToApp(ctx: Context, app: HostedApp): Promise<Response> {
  const path = ctx.url.pathname
  const api = path === '/api' || path.startsWith('/api/')
  const navigation = !api && isNavigation(ctx.request)
  if (!app.service) return navigation ? unavailable(ctx, 503) : jsonResponse({ error: 'unavailable' }, 503)

  const session = await loadSession(ctx)
  if (!session) {
    return navigation ? redirect(authUrl(ctx, withReturnTo('/login', ctx.url.href)), 302) : jsonResponse({ error: 'unauthorized' }, 401)
  }
  if (!session.user.verified) return navigation ? verifyNotice(ctx, session) : jsonResponse({ error: 'unauthorized' }, 401)
  const org = await activeOrg(ctx, session)
  if (!org) {
    return navigation ? redirect(authUrl(ctx, withReturnTo('/orgs/new', ctx.url.href)), 302) : jsonResponse({ error: 'no_organization' }, 403)
  }
  if (!(await allowApp(ctx, session.user.id))) {
    return navigation ? rateLimitedPage(ctx) : jsonResponse({ error: 'rate_limited' }, 429, { 'Retry-After': '60' })
  }

  let upstream: Response
  try {
    upstream = await app.service.fetch(forwardRequest(ctx.request, identityHeaders(session, org, app)))
  } catch (error) {
    logError('app_unreachable', error, { app: app.name })
    return navigation ? unavailable(ctx, 502) : jsonResponse({ error: 'bad_gateway' }, 502)
  }
  return appResponse(ctx, app, upstream)
}
