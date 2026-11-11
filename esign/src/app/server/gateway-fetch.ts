// How E-sign reaches the platform's gateway (the mail relay). The deploy binds the gateway Worker to the app as
// SUGER_GATEWAY: a Worker can't fetch another Worker of the same zone through its public URL, so a plain fetch of
// https://insulinapps.com/__insulin/mail from esign.insulinapps.com never reaches the gateway. Nitro on Workers puts the
// invocation's env on the request it passes on (request.runtime.cloudflare.env), as it does waitUntil (wait-until.ts),
// so no cloudflare: import is needed. Without the binding (the local preview, tests) the caller uses the global fetch.

/** The gateway service binding's fetch, bound to it, when the runtime attached one to the request. */
export function gatewayFetchOf(request: Request): typeof fetch | undefined {
  const env = (request as Request & { runtime?: { cloudflare?: { env?: Record<string, unknown> } } }).runtime?.cloudflare?.env
  const gateway = env?.SUGER_GATEWAY as { fetch?: unknown } | undefined
  if (!gateway || typeof gateway.fetch !== 'function') return undefined
  const call = gateway.fetch as (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
  return ((input: RequestInfo | URL, init?: RequestInit) => call.call(gateway, input, init)) as typeof fetch
}
