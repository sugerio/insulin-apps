import { beforeDeadline } from './deadline.ts'
import type { Bindings } from './env.ts'
import { gatewayEndpoint } from './gateway-fetch.ts'

/**
 * The platform's endpoints Knowledge calls (DESIGN.md §8.2, §8.6, §8.8, §8.9), all with the app's token over the
 * gateway's service binding: mail, usage reports, limits, the member lookup, member status and member events. Each URL
 * comes from the deploy (SUGER_*_URL); without it, or without SUGER_APP_TOKEN, nothing is called (the local preview).
 */
export type PlatformUrl = 'SUGER_MAIL_URL' | 'SUGER_METRICS_URL' | 'SUGER_LIMITS_URL' | 'SUGER_MEMBERS_URL' | 'SUGER_MEMBER_STATUS_URL' | 'SUGER_MEMBER_EVENTS_URL'

/**
 * A fetch through the platform's integration proxy (DESIGN.md §6) for one stored credential, as `integrationFetch(key)`
 * of @fours/app would make it, but sent over the gateway's service binding: an app Worker can't reach the gateway
 * through its public address (§8.2). `https://host/path` goes to `<SUGER_INTEGRATIONS_URL>/<key>/proxy/host/path` with
 * the app's token and the organization. Without the proxy's address or the token, every call fails.
 */
export function integrationFetchOverGateway(env: Bindings, key: string, org: string): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const endpoint = gatewayEndpoint(env.SUGER_INTEGRATIONS_URL, env.SUGER_APP_TOKEN)
    if (!endpoint) throw new Error('The integration proxy is not configured')
    const target = new URL(String(input instanceof Request ? input.url : input))
    if (target.protocol !== 'https:') throw new Error('Integrations take https addresses only')
    const headers = new Headers(init?.headers)
    headers.set('authorization', `Bearer ${endpoint.token}`)
    headers.set('x-suger-organization-id', org)
    const send = env.GATEWAY_FETCH ?? fetch
    return send(`${endpoint.url.replace(/\/+$/, '')}/${encodeURIComponent(key)}/proxy/${target.host}${target.pathname}${target.search}`, { ...init, headers, redirect: 'manual' })
  }) as typeof fetch
}

/** The time a call may take before the tick moves on. */
const CALL_TIMEOUT_MS = 8_000

/**
 * Calls one endpoint, or answers null when it isn't configured. `query` is added to the URL; `headers` go with the
 * token. Network failures and timeouts throw. The call, its body included, takes at most 8 seconds, and never runs past
 * the tick's deadline (`env.DEADLINE`): the answer comes back with its body already read.
 */
export async function callPlatform(
  env: Bindings,
  which: PlatformUrl,
  init: { method?: string; query?: Record<string, string>; body?: unknown; headers?: Record<string, string> } = {},
): Promise<Response | null> {
  const endpoint = gatewayEndpoint(env[which], env.SUGER_APP_TOKEN)
  if (!endpoint) return null
  const url = new URL(endpoint.url)
  for (const [name, value] of Object.entries(init.query ?? {})) url.searchParams.set(name, value)
  const headers: Record<string, string> = { authorization: `Bearer ${endpoint.token}`, accept: 'application/json', ...init.headers }
  if (init.body !== undefined) headers['content-type'] = 'application/json'
  const send = env.GATEWAY_FETCH ?? fetch
  const deadline = Math.min(Date.now() + CALL_TIMEOUT_MS, env.DEADLINE ?? Number.POSITIVE_INFINITY)
  const response = await beforeDeadline(send(url.toString(), {
    method: init.method ?? 'GET',
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    redirect: 'manual',
    signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
  }), deadline, 'The platform')
  const text = await beforeDeadline(response.text(), deadline, 'The platform')
  return new Response(NULL_BODY.has(response.status) ? null : text, { status: response.status, headers: { 'content-type': response.headers.get('content-type') ?? 'application/json' } })
}

/** Statuses whose answer has no body. */
const NULL_BODY = new Set([101, 204, 205, 304])
