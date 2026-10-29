// What the gateway forwards to an app: the identity headers of the Insulin console, and the browser's request without
// anything that could impersonate them. No I/O, so the unit tests import it directly.
import type { HostedApp } from '../config.ts'
import { withoutCookies } from './cookies.ts'
import { SESSION_COOKIE, type ActiveOrg, type Session } from '../auth/session.ts'

// Lower-case names of the gateway's own cookies: never forwarded to an app, never set by one.
export const GATEWAY_COOKIES: ReadonlySet<string> = new Set([SESSION_COOKIE, 'insulin_oauth', '__host-insulin_oauth'])

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
