// App hosts: forwards to the app Worker over its service binding with the Insulin console identity headers, the way
// the console's entry worker does. Apps trust these headers, so whatever the browser sent under x-suger-* is dropped,
// and the session cookie never reaches an app.
import type { HostedApp } from './config.ts'
import type { Context } from './context.ts'
import { authUrl, withReturnTo } from './context.ts'
import { setCookieName } from './http/cookies.ts'
import { GATEWAY_COOKIES, forwardRequest, identityHeaders, isNavigation } from './http/forward.ts'
import { jsonResponse, redirect } from './http/response.ts'
import { markFromApp } from './http/secure.ts'
import { log, logError } from './log.ts'
import { appUnavailablePage, rateLimitedPage } from './pages/status.tsx'
import { allowApp } from './ratelimit.ts'
import { verifyNotice } from './auth/guard.ts'
import { activeOrg, loadSession } from './auth/session.ts'

export const BAR_TAG = '<script src="/__insulin/bar.js" defer></script>'

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

export async function proxyToApp(ctx: Context, app: HostedApp): Promise<Response> {
  const path = ctx.url.pathname
  const api = path === '/api' || path.startsWith('/api/')
  const navigation = !api && isNavigation(ctx.request)
  if (!app.service) return navigation ? appUnavailablePage(ctx, 503) : jsonResponse({ error: 'unavailable' }, 503)

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
    return navigation ? appUnavailablePage(ctx, 502) : jsonResponse({ error: 'bad_gateway' }, 502)
  }
  return appResponse(ctx, app, upstream)
}
