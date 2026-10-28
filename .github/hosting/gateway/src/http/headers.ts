// Response headers for what the gateway serves itself. Proxied app responses keep their own headers (proxy.ts).

export const PAGE_CSP = [
  "default-src 'none'",
  "script-src 'self' https://challenges.cloudflare.com",
  'frame-src https://challenges.cloudflare.com',
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "form-action 'self'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join('; ')

const API_CSP = "default-src 'none'; frame-ancestors 'none'"

export const HSTS = 'max-age=63072000; includeSubDomains'

const COMMON: Record<string, string> = {
  // Verification and reset tokens appear in URLs, so a Referer never carries a path or query: only the origin.
  // Not `no-referrer`: with it, browsers send `Origin: null` on form POSTs, which the Origin check must refuse.
  'Referrer-Policy': 'strict-origin',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
}

/**
 * The floor for every response the gateway produces itself: secure.ts adds any of these a response lacks (redirects,
 * plain-text errors), so nothing leaves without them. Pages, JSON and assets set stricter or specific values first.
 */
export const SECURITY_HEADERS: Record<string, string> = {
  ...COMMON,
  'Content-Security-Policy': API_CSP,
  'Cache-Control': 'no-store',
}

/** Server-rendered pages. Only the apex landing page may be indexed; nothing is cached. */
export function pageHeaders(options: { index?: boolean } = {}): Headers {
  const headers = new Headers(COMMON)
  headers.set('Content-Type', 'text/html; charset=utf-8')
  headers.set('Content-Security-Policy', PAGE_CSP)
  headers.set('Cache-Control', 'no-store')
  if (!options.index) headers.set('X-Robots-Tag', 'noindex')
  return headers
}

export function jsonHeaders(): Headers {
  const headers = new Headers(COMMON)
  headers.set('Content-Type', 'application/json; charset=utf-8')
  headers.set('Content-Security-Policy', API_CSP)
  headers.set('Cache-Control', 'no-store')
  headers.set('X-Robots-Tag', 'noindex')
  return headers
}

/** The stylesheet and the account bar: same-origin static files, briefly cacheable. */
export function assetHeaders(contentType: string): Headers {
  const headers = new Headers(COMMON)
  headers.set('Content-Type', contentType)
  headers.set('Content-Security-Policy', API_CSP)
  headers.set('Cache-Control', 'public, max-age=300')
  headers.set('Cross-Origin-Resource-Policy', 'same-origin')
  return headers
}
