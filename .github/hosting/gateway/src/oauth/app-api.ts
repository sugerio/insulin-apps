// Requests to an app on behalf of a bearer token (DESIGN.md §4, §5.2, §5.3): an MCP tool call or a service account's
// API call. Only the app's own API is reachable (`/api/*`, never the platform's `/api/__suger/*`). The app gets the
// identity headers, no cookie and no Authorization; the request counts as same-origin (a token isn't an ambient
// credential, so the app's CSRF check has nothing to guard), and the User-Agent names the client for the app's audit.
import type { HostedApp } from '../config.ts'
import type { Context } from '../context.ts'
import { originOf } from '../context.ts'
import { identityHeaders, type AccessVia } from '../http/forward.ts'
import { jsonResponse } from '../http/response.ts'
import { markFromApp } from '../http/secure.ts'
import { logError } from '../log.ts'
import { allowApp } from '../ratelimit.ts'
import { CORS } from './http.ts'
import { bearerToken, resolveBearer, type BearerIdentity } from './tokens.ts'

/** Whether a path is in the app's own API. Checked on the parsed URL, after dot segments are resolved. */
export function isAppApiPath(pathname: string): boolean {
  return pathname.startsWith('/api/') && !pathname.toLowerCase().startsWith('/api/__suger/')
}

const BROWSER_HEADERS = /^(?:cookie|authorization|origin|referer|sec-fetch-.*|x-suger-.*|user-agent)$/i

/** The headers every bearer request carries to the app, besides its own content headers. */
export function bearerHeaders(ctx: Context, app: HostedApp, identity: BearerIdentity, via: AccessVia): Record<string, string> {
  const client = identity.kind === 'person' ? `Insulin Apps MCP: ${identity.clientName}` : `Insulin Apps API: ${identity.actor.name}`
  return {
    ...identityHeaders(identity.actor, identity.orgId, app, identity.access, via),
    Origin: originOf(ctx, app.host),
    'Sec-Fetch-Site': 'same-origin',
    // Header values must be Latin-1 and on one line: anything else in a client's self-given name becomes "?".
    'User-Agent': client.replace(/[^\x20-\x7e]/g, '?').slice(0, 200),
  }
}

/** The 401 that points a client at the resource's metadata (RFC 9728 §5.1). */
export function unauthorized(ctx: Context, app: HostedApp, metadataPath: string, error: 'invalid_token' | null): Response {
  const metadata = `${originOf(ctx, app.host)}${metadataPath}`
  const challenge = `Bearer resource_metadata="${metadata}"${error ? `, error="${error}"` : ''}`
  return jsonResponse({ error: error ?? 'unauthorized' }, 401, { ...CORS, 'WWW-Authenticate': challenge })
}

/**
 * A service account's call to the app's API: `Authorization: Bearer` on an app host. The token must be a service
 * account's for this app; cookies are never looked at. The request (body streamed) goes on with the identity headers.
 */
export async function apiCall(ctx: Context, app: HostedApp): Promise<Response> {
  if (!app.service) return jsonResponse({ error: 'unavailable' }, 503)
  const path = ctx.url.pathname
  if (!isAppApiPath(path)) return jsonResponse({ error: 'invalid_request', error_description: 'Tokens reach only the app\'s API, under /api/.' }, 401)
  const identity = await resolveBearer(ctx, app, bearerToken(ctx.request))
  if ('refused' in identity) {
    return identity.refused === 'no_access' ? jsonResponse({ error: 'no_app_access' }, 403) : unauthorized(ctx, app, '/.well-known/oauth-protected-resource', 'invalid_token')
  }
  if (identity.kind !== 'service') {
    // A person's MCP token is for the MCP server only.
    return unauthorized(ctx, app, '/.well-known/oauth-protected-resource', 'invalid_token')
  }
  if (!(await allowApp(ctx, identity.serviceAccountId))) return jsonResponse({ error: 'rate_limited' }, 429, { 'Retry-After': '60' })
  const headers = new Headers()
  for (const [name, value] of ctx.request.headers) if (!BROWSER_HEADERS.test(name)) headers.set(name, value)
  for (const [name, value] of Object.entries(bearerHeaders(ctx, app, identity, 'api'))) headers.set(name, value)
  let upstream: Response
  try {
    upstream = await app.service.fetch(new Request(ctx.request, { headers, redirect: 'manual' }))
  } catch (error) {
    logError('app_unreachable', error, { app: app.name })
    return jsonResponse({ error: 'bad_gateway' }, 502)
  }
  // No cookie for a machine: an app's Set-Cookie would be scoped to a browser that isn't there.
  const response = new Response(upstream.body, upstream)
  response.headers.delete('Set-Cookie')
  return markFromApp(response)
}
