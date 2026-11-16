import type { EngineFetcher } from '../env.ts'

/**
 * The engine this request uses. The deploy binds the engine Worker to the app as SUGER_ENGINE, and Nitro on Workers
 * puts the invocation's env on the request (request.runtime.cloudflare.env), as it does for SUGER_GATEWAY
 * (gateway-fetch.ts), so no cloudflare: import is needed.
 *
 * Without the binding: a development build (`npm run dev`, the AppBuilder's preview) uses the in-memory engine from
 * knowledge/engine/src/stub/, imported dynamically inside `import.meta.env.DEV` so that production builds don't contain
 * it (scripts/check-no-stub.mjs checks); a production build has no engine, and routes that need one answer
 * 503 engine_unavailable.
 */
export async function engineOf(request: Request): Promise<EngineFetcher | undefined> {
  const env = (request as Request & { runtime?: { cloudflare?: { env?: Record<string, unknown> } } }).runtime?.cloudflare?.env
  const binding = env?.SUGER_ENGINE as { fetch?: unknown } | undefined
  if (binding && typeof binding.fetch === 'function') {
    const call = binding.fetch as (request: Request) => Promise<Response>
    return { fetch: (engineRequest) => call.call(binding, engineRequest) }
  }
  if (import.meta.env.DEV) {
    const { devEngine } = await import('../../../../engine/src/stub/index.ts')
    return devEngine()
  }
  return undefined
}
