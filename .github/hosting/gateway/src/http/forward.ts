// What the gateway forwards to an app: the identity headers of the Insulin console, and the browser's request without
// anything that could impersonate them. No I/O, so the unit tests import it directly.
import type { AppAccess } from '../access.ts'
import type { HostedApp } from '../config.ts'
import { withoutCookies } from './cookies.ts'
import { SESSION_COOKIE } from '../auth/session.ts'

// Lower-case names of the gateway's own cookies: never forwarded to an app, never set by one.
export const GATEWAY_COOKIES: ReadonlySet<string> = new Set([
  SESSION_COOKIE, 'insulin_oauth', '__host-insulin_oauth', 'insulin_mfa', '__host-insulin_mfa', 'insulin_sso', '__host-insulin_sso',
  // The navigation's collapse state (navigation.ts): host-only on the apex, so an app never sees it, nor sets it.
  'insulin_nav',
])

/**
 * How a request reached the app (x-suger-access-via): apps keep people, billing and integrations to `browser`.
 * `public` is a request on one of the app's public paths, from someone the gateway doesn't know (DESIGN.md §8.1).
 * `schedule` is the gateway's own five-minute tick to the app's `insulin.scheduled` path (DESIGN.md §8.5): it never
 * comes from outside, since every incoming x-suger-* header is removed and app Workers have no public route.
 */
export type AccessVia = 'browser' | 'mcp' | 'api' | 'public' | 'schedule'

/** Who a request acts as: a person, or a service account (DESIGN.md §5.3). */
export interface Actor {
  id: string
  email: string
  name: string
}

/**
 * The identity contract of `@fours/app` (`getCurrentUser` with SUGER_ACCESS_MODE=console), plus the permissions of an
 * app with a catalog and how the request came (DESIGN.md §2.4).
 */
export function identityHeaders(actor: Actor, orgId: string, app: HostedApp, access: AppAccess, via: AccessVia): Record<string, string> {
  const headers: Record<string, string> = {
    'x-suger-user-id': actor.id,
    'x-suger-organization-id': orgId,
    'x-suger-app-id': app.appId,
    'x-suger-app-role': access.role,
    'x-suger-user-email': encodeURIComponent(actor.email),
    'x-suger-user-name': encodeURIComponent(actor.name || actor.email),
    'x-suger-access-via': via,
  }
  if (app.permissions.length) headers['x-suger-app-permissions'] = access.permissions.join(' ')
  return headers
}

/** What a request on a public path carries: the app it is for and that nobody is signed in. Nothing else. */
export function publicHeaders(app: HostedApp): Record<string, string> {
  return { 'x-suger-app-id': app.appId, 'x-suger-access-via': 'public' }
}

/** What the gateway's tick carries: the app it is for and that it is the schedule. No person, organization or role. */
export function scheduleHeaders(app: HostedApp): Record<string, string> {
  return { 'x-suger-app-id': app.appId, 'x-suger-access-via': 'schedule' }
}

/**
 * The original request (same URL and method, body streamed, not buffered) with the identity headers in place.
 * `dropAuthorization` leaves the caller's Authorization header out (a public request never passes a credential on).
 */
export function forwardRequest(request: Request, identity: Record<string, string>, { dropAuthorization = false } = {}): Request {
  const headers = new Headers(request.headers)
  if (dropAuthorization) headers.delete('Authorization')
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
