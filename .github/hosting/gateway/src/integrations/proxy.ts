// The integration proxy (DESIGN.md §6): https://<apex>/__insulin/integrations/<key>/proxy/<host|_>/<path>, the address
// `integrationFetch(key)` of @fours/app calls with SUGER_INTEGRATIONS_URL. The app proves itself with its
// SUGER_APP_TOKEN and names the organization it is serving; the gateway adds that organization's stored credential and
// sends the request on, only over https and only to the credential's hosts. The app never holds the secret.
import type { HostedApp } from '../config.ts'
import type { Context } from '../context.ts'
import { base64, constantTimeEqual, derivedSecret, isId, unseal, utf8 } from '../crypto.ts'
import { findIntegrationSecret, touchIntegration, type IntegrationSecretRow } from '../db/integrations.ts'
import { jsonResponse } from '../http/response.ts'
import { log, logError } from '../log.ts'
import { bearerToken } from '../oauth/tokens.ts'
import { allowApp } from '../ratelimit.ts'
import { KEY_PATTERN, secretPurpose } from './settings.ts'

export const APP_TOKEN_PURPOSE = 'app-token'
const TIMEOUT_MS = 15_000
const TOUCH_INTERVAL_MS = 60 * 60 * 1000
const PROXY_PATH = /^\/__insulin\/integrations\/([^/]+)\/proxy\/([^/]+)(\/.*)?$/
// Never sent on: the connection's own headers, the caller's identity and credentials, and Cloudflare's.
const DROPPED = /^(?:host|cookie|authorization|proxy-.*|connection|keep-alive|te|trailer|transfer-encoding|upgrade|content-length|origin|referer|cdn-loop|true-client-ip|x-real-ip|x-forwarded-.*|x-suger-.*|cf-.*)$/i
const DROPPED_BACK = /^(?:set-cookie|connection|keep-alive|proxy-.*|te|trailer|transfer-encoding|upgrade)$/i

/** The app whose SUGER_APP_TOKEN this is, compared in constant time against each app's. */
export async function appForToken(ctx: Context, master: Uint8Array, token: string | null): Promise<HostedApp | null> {
  if (!token) return null
  let found: HostedApp | null = null
  for (const app of ctx.config.apps) {
    if (constantTimeEqual(token, await derivedSecret(master, APP_TOKEN_PURPOSE, app.name)) && !found) found = app
  }
  return found
}

function problem(error: string, status: number): Response {
  return jsonResponse({ error, code: error }, status)
}

function hostsOf(row: IntegrationSecretRow): string[] {
  try {
    const value: unknown = JSON.parse(row.allowed_hosts)
    return Array.isArray(value) ? value.filter((host): host is string => typeof host === 'string') : []
  } catch {
    return []
  }
}

/** The outside address: the base URL for `_`, else an allowed host; null when the host isn't allowed. */
export function targetUrl(row: IntegrationSecretRow, hostSegment: string, rest: string, search: string): URL | null {
  const base = new URL(row.base_url)
  let url: URL
  if (hostSegment === '_') {
    url = new URL(base.origin)
    url.pathname = `${base.pathname.replace(/\/+$/, '')}${rest}` || '/'
  } else {
    const host = hostSegment.toLowerCase()
    if (host !== base.hostname && !hostsOf(row).includes(host)) return null
    url = new URL(`https://${host}`)
    if (url.hostname !== host || url.port) return null
    url.pathname = rest || '/'
  }
  url.search = search
  return url
}

/**
 * A path that could climb out of the base URL at the other end: a `.` or `..` segment, plain or encoded, or a segment
 * hiding a slash or backslash in its encoding, which a server that decodes it might read as more segments.
 */
function climbs(rest: string): boolean {
  return rest.split('/').some((segment) => {
    let decoded = segment
    try {
      decoded = decodeURIComponent(segment)
    } catch {
      return true
    }
    return decoded === '..' || decoded === '.' || /[/\\]/.test(decoded)
  })
}

function credentialHeader(row: IntegrationSecretRow, secret: string): [string, string] {
  if (row.auth_scheme === 'basic') return ['Authorization', `Basic ${base64(utf8(secret))}`]
  if (row.auth_scheme === 'header' && row.header_name) return [row.header_name, secret]
  return ['Authorization', `Bearer ${secret}`]
}

export async function integrationProxy(ctx: Context): Promise<Response> {
  if (ctx.site !== 'apex') return problem('not_found', 404)
  const match = PROXY_PATH.exec(ctx.url.pathname)
  const key = match ? safeDecode(match[1]!) : null
  if (!match || !key || !KEY_PATTERN.test(key)) return problem('not_found', 404)
  const master = ctx.config.secretKey
  if (!master) return problem('not_configured', 503)
  const app = await appForToken(ctx, master, bearerToken(ctx.request))
  if (!app) return problem('unauthorized', 401)
  const orgId = ctx.request.headers.get('x-suger-organization-id')
  if (!isId(orgId)) return problem('organization_required', 400)
  if (!(await allowApp(ctx, `integration:${app.name}:${orgId}`))) return jsonResponse({ error: 'rate_limited', code: 'rate_limited' }, 429, { 'Retry-After': '60' })
  const row = await findIntegrationSecret(ctx.config.db, orgId, app.name, key)
  if (!row) return problem('unknown_integration', 404)
  const rest = match[3] ?? ''
  if (climbs(rest)) return problem('invalid_path', 400)
  const target = targetUrl(row, match[2]!, rest, ctx.url.search)
  if (!target) return problem('host_not_allowed', 403)
  const secret = await unseal(master, secretPurpose(row.id), row.secret_enc)
  if (secret === null) {
    log('integration_unreadable', { app: app.name, org: orgId, integration: row.id })
    return problem('credential_unreadable', 503)
  }

  const headers = new Headers()
  for (const [name, value] of ctx.request.headers) if (!DROPPED.test(name)) headers.set(name, value)
  const [name, value] = credentialHeader(row, secret)
  headers.set(name, value)
  const method = ctx.request.method
  let upstream: Response
  try {
    upstream = await fetch(target.href, {
      method,
      headers,
      body: method === 'GET' || method === 'HEAD' ? undefined : ctx.request.body,
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch (error) {
    const timedOut = error instanceof Error && error.name === 'TimeoutError'
    logError('integration_upstream_failed', error, { app: app.name, org: orgId, integration: row.id })
    return problem(timedOut ? 'upstream_timeout' : 'upstream_unreachable', timedOut ? 504 : 502)
  }
  if (ctx.now - (row.last_used_at ?? 0) >= TOUCH_INTERVAL_MS) {
    ctx.exec.waitUntil(touchIntegration(ctx.config.db, row.id, ctx.now).catch((error) => logError('integration_touch_failed', error)))
  }
  log('integration_proxied', { app: app.name, org: orgId, integration: row.id, status: upstream.status })
  const back = new Headers()
  for (const [header, content] of upstream.headers) if (!DROPPED_BACK.test(header)) back.append(header, content)
  return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: back })
}

function safeDecode(text: string): string | null {
  try {
    return decodeURIComponent(text)
  } catch {
    return null
  }
}
