import type { Bindings } from './env.ts'
import { gatewayEndpoint } from './gateway-fetch.ts'

/**
 * The platform's endpoints Knowledge calls (DESIGN.md §8.2, §8.6, §8.8, §8.9), all with the app's token over the
 * gateway's service binding: mail, usage reports, limits, the member lookup, member status and member events. Each URL
 * comes from the deploy (SUGER_*_URL); without it, or without SUGER_APP_TOKEN, nothing is called (the local preview).
 */
export type PlatformUrl = 'SUGER_MAIL_URL' | 'SUGER_METRICS_URL' | 'SUGER_LIMITS_URL' | 'SUGER_MEMBERS_URL' | 'SUGER_MEMBER_STATUS_URL' | 'SUGER_MEMBER_EVENTS_URL'

/** The time a call may take before the tick moves on. */
const CALL_TIMEOUT_MS = 8_000

/**
 * Calls one endpoint, or answers null when it isn't configured. `query` is added to the URL; `headers` go with the
 * token. Network failures and timeouts throw.
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
  return send(url.toString(), {
    method: init.method ?? 'GET',
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    redirect: 'manual',
    signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
  })
}
