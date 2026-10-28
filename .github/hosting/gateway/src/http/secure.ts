// The outermost layer, applied to every response (pages, assets, redirects, configuration errors, uncaught 500s):
// HSTS over https, and the common security headers on everything the gateway produced itself. Responses that came
// from an app Worker keep their own headers and only gain HSTS (brief: app responses pass through unchanged).
import { HSTS, SECURITY_HEADERS } from './headers.ts'

const fromApp = new WeakSet<Response>()

/** Marks a response as the app's own, so `secure` adds nothing but HSTS to it. */
export function markFromApp(response: Response): Response {
  fromApp.add(response)
  return response
}

export function isFromApp(response: Response): boolean {
  return fromApp.has(response)
}

export function isLocalHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname.endsWith('.localhost')
}

/**
 * Plain http on a production host (anything but *.localhost) is redirected to https before anything else runs: GET
 * and HEAD with a 301, other methods refused, since their bodies already crossed the network in clear.
 */
export function httpsUpgrade(request: Request): Response | null {
  const url = new URL(request.url)
  if (url.protocol !== 'http:' || isLocalHost(url.hostname)) return null
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('This site only accepts https requests.\n', { status: 400, headers: { 'Content-Type': 'text/plain; charset=utf-8' } })
  }
  url.protocol = 'https:'
  url.port = ''
  return new Response(null, { status: 301, headers: { Location: url.href } })
}

export function secure(request: Request, response: Response): Response {
  if (response.status === 101 || response.webSocket) return response
  const https = new URL(request.url).protocol === 'https:'
  const own = !fromApp.has(response)
  const needsHsts = https && !response.headers.has('Strict-Transport-Security')
  const missing = own ? Object.keys(SECURITY_HEADERS).filter((name) => !response.headers.has(name)) : []
  if (!needsHsts && !missing.length) return response
  const out = new Response(response.body, response)
  if (needsHsts) out.headers.set('Strict-Transport-Security', HSTS)
  for (const name of missing) out.headers.set(name, SECURITY_HEADERS[name]!)
  return out
}
