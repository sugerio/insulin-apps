// What the gateway forwards to an app: the identity headers of the Insulin console, and the browser's request without
// anything that could impersonate them. No I/O, so the unit tests import it directly.
import type { AppAccess } from '../access.ts'
import type { HostedApp } from '../config.ts'
import { withoutCookies } from './cookies.ts'
import { SESSION_COOKIE } from '../auth/session.ts'

// Lower-case names of the gateway's own cookies: never forwarded to an app, never set by one.
export const GATEWAY_COOKIES: ReadonlySet<string> = new Set([SESSION_COOKIE, 'insulin_oauth', '__host-insulin_oauth', 'insulin_sso', '__host-insulin_sso'])

/** How a request reached the app (x-suger-access-via): apps keep people, billing and integrations to `browser`. */
export type AccessVia = 'browser' | 'mcp' | 'api'

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
