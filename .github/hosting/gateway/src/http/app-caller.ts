// The app endpoints of DESIGN.md §12.2 and §12.3 (limits, members, member status, member events): on the apex only,
// called by an app Worker over SUGER_GATEWAY with its own SUGER_APP_TOKEN, and nothing else. A session, an AI agent's
// token or an API client's is no app's token, so it gets 401; the app is the token's, never one the request names.
import type { HostedApp } from '../config.ts'
import type { Context } from '../context.ts'
import { appForToken } from '../integrations/proxy.ts'
import { log } from '../log.ts'
import { bearerToken } from '../oauth/tokens.ts'
import { allowApp } from '../ratelimit.ts'
import { jsonResponse } from './response.ts'

export function problem(error: string, status: number, headers: Record<string, string> = {}): Response {
  return jsonResponse({ error }, status, headers)
}

/**
 * The app calling, or the answer to give instead: 404 off the apex, 405 for another method, 503 `not_configured`
 * without GATEWAY_SECRET_KEY (there are no app tokens then), 401 without the app's token, and 429 past RL_APP for this
 * endpoint and app, unless `perApp` is false (an endpoint limited per person instead).
 */
export async function appCaller(ctx: Context, method: 'GET' | 'POST', endpoint: string, { perApp = true } = {}): Promise<HostedApp | Response> {
  if (ctx.site !== 'apex') return problem('not_found', 404)
  const asked = ctx.request.method === 'HEAD' ? 'GET' : ctx.request.method
  if (asked !== method) return problem('method_not_allowed', 405, { Allow: method === 'GET' ? 'GET, HEAD' : method })
  const master = ctx.config.secretKey
  if (!master) return problem('not_configured', 503)
  const app = await appForToken(ctx, master, bearerToken(ctx.request))
  if (!app) {
    log('app_endpoint_unauthorized', { endpoint })
    return problem('unauthorized', 401)
  }
  if (perApp && !(await allowApp(ctx, `${endpoint}:${app.name}`))) return problem('rate_limited', 429, { 'Retry-After': '60' })
  return app
}

/** A cursor as apps send it back: the decimal digits of a non-negative integer, or null when it isn't one. */
export function readCursor(value: string | null): number | null {
  if (value === null || !/^\d{1,15}$/.test(value)) return null
  return Number(value)
}
