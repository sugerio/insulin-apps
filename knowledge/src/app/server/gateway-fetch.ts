// How Esign reaches the platform's gateway (the mail relay, the usage reports). The deploy binds the gateway Worker to
// the app as SUGER_GATEWAY: a Worker can't fetch another Worker of the same zone through its public URL, so a plain
// fetch of https://insulinapps.com/__insulin/mail from esign.insulinapps.com never reaches the gateway. Nitro on Workers
// puts the invocation's env on the request it passes on (request.runtime.cloudflare.env), as it does waitUntil
// (wait-until.ts), so no cloudflare: import is needed. Without the binding (the local preview, tests) the caller uses
// the global fetch.

/** The gateway service binding's fetch, bound to it, when the runtime attached one to the request. */
export function gatewayFetchOf(request: Request): typeof fetch | undefined {
  const env = (request as Request & { runtime?: { cloudflare?: { env?: Record<string, unknown> } } }).runtime?.cloudflare?.env
  const gateway = env?.SUGER_GATEWAY as { fetch?: unknown } | undefined
  if (!gateway || typeof gateway.fetch !== 'function') return undefined
  const call = gateway.fetch as (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
  return ((input: RequestInfo | URL, init?: RequestInit) => call.call(gateway, input, init)) as typeof fetch
}

/**
 * A gateway endpoint's address (SUGER_MAIL_URL, SUGER_METRICS_URL) and the app's token (SUGER_APP_TOKEN), when both
 * are set and the address is https (http only on a loopback host); otherwise null, and nothing is sent there.
 */
export function gatewayEndpoint(address: string | undefined, appToken: string | undefined): { url: string; token: string } | null {
  const url = address?.trim() ?? '', token = appToken?.trim() ?? ''
  if (!url || !token) return null
  try {
    const parsed = new URL(url)
    const loopback = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname.endsWith('.localhost')
    if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) return null
  } catch {
    return null
  }
  return { url, token }
}
