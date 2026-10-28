import type { Context } from '../context.ts'

/**
 * A `return_to` value the gateway may send a browser to: an absolute URL with the request's scheme (https in
 * production), no credentials, and the apex, the auth host or a known app host (with the local port in development).
 * Anything else returns null, and callers fall back to the auth home page.
 */
export function safeReturnTo(ctx: Context, value: unknown): string | null {
  if (typeof value !== 'string' || value === '' || value.length > 2048) return null
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if (url.protocol !== ctx.scheme || url.username || url.password) return null
  if ((url.port ? `:${url.port}` : '') !== ctx.portSuffix) return null
  const host = url.hostname
  const known = host === ctx.config.domain || host === ctx.config.authHost || ctx.config.appsByHost.has(host)
  return known ? url.href : null
}
