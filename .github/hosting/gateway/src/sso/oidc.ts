// OpenID Connect for an organization's identity provider (DESIGN.md §7): discovery, the authorization request with
// PKCE (S256), state and nonce, the code exchange, and the checks on the ID token.
import { decodeJwtPayload } from '../auth/id-token.ts'
import { constantTimeEqual } from '../crypto.ts'
import { normalizeEmail } from '../validate.ts'

const TIMEOUT_MS = 5000
// Redirects are never followed (workerd has no redirect: 'error'): a 3xx is not ok, so it counts as a failure.
const CLOCK_SKEW_SECONDS = 120

export interface Discovery {
  issuer: string
  authorizationEndpoint: string
  tokenEndpoint: string
  /** client_secret_post unless the provider supports only client_secret_basic. */
  auth: 'post' | 'basic'
}

/** The issuer as configured: https, no query, fragment or credentials, without a trailing slash. */
export function normalizeIssuer(value: string): string | null {
  try {
    const url = new URL(value.trim())
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return null
    return url.href.replace(/\/$/, '')
  } catch {
    return null
  }
}

function httpsUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null
  } catch {
    return null
  }
}

/** The provider's configuration, fetched for this request only; null when it is unreachable or doesn't match. */
export async function discover(issuer: string): Promise<Discovery | null> {
  let data: Record<string, unknown> | null
  try {
    const response = await fetch(`${issuer}/.well-known/openid-configuration`, {
      headers: { Accept: 'application/json' },
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    data = response.ok ? await response.json<Record<string, unknown>>() : null
  } catch {
    data = null
  }
  if (!data || typeof data.issuer !== 'string' || normalizeIssuer(data.issuer) !== issuer) return null
  const authorizationEndpoint = httpsUrl(data.authorization_endpoint)
  const tokenEndpoint = httpsUrl(data.token_endpoint)
  if (!authorizationEndpoint || !tokenEndpoint) return null
  const methods = Array.isArray(data.token_endpoint_auth_methods_supported) ? data.token_endpoint_auth_methods_supported : null
  const auth = methods && !methods.includes('client_secret_post') && methods.includes('client_secret_basic') ? 'basic' : 'post'
  return { issuer: data.issuer, authorizationEndpoint, tokenEndpoint, auth }
}

/** The claims of the ID token the token endpoint returns for `code`, or null when the exchange fails. */
export async function exchangeCode(discovery: Discovery, client: { id: string; secret: string }, code: string, verifier: string, redirectUri: string): Promise<Record<string, unknown> | null> {
  const body = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: verifier })
  const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }
  if (discovery.auth === 'basic') {
    headers.Authorization = `Basic ${btoa(`${encodeURIComponent(client.id)}:${encodeURIComponent(client.secret)}`)}`
  } else {
    body.set('client_id', client.id)
    body.set('client_secret', client.secret)
  }
  try {
    const response = await fetch(discovery.tokenEndpoint, { method: 'POST', headers, body, redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) })
    if (!response.ok) return null
    const data = await response.json<{ id_token?: unknown }>().catch(() => null)
    return typeof data?.id_token === 'string' ? decodeJwtPayload(data.id_token) : null
  } catch {
    return null
  }
}

export interface OidcIdentity {
  email: string
  name: string | null
}

export type OidcProblem = 'issuer' | 'audience' | 'expired' | 'nonce' | 'email'

/**
 * The person an ID token names, after its claims are checked one by one. The token came straight from the token
 * endpoint over TLS, in exchange for our client secret, so its signature isn't checked (OpenID Connect Core 1.0,
 * 3.1.3.7, item 6): TLS already proves who issued it.
 */
export function checkIdToken(claims: Record<string, unknown>, expected: { issuer: string; clientId: string; nonce: string }, nowSeconds: number): OidcIdentity | OidcProblem {
  if (typeof claims.iss !== 'string' || normalizeIssuer(claims.iss) !== expected.issuer) return 'issuer'
  const audiences = typeof claims.aud === 'string' ? [claims.aud] : Array.isArray(claims.aud) ? claims.aud : []
  if (!audiences.includes(expected.clientId)) return 'audience'
  if (audiences.length > 1 && claims.azp !== expected.clientId) return 'audience'
  if (typeof claims.exp !== 'number' || claims.exp + CLOCK_SKEW_SECONDS <= nowSeconds) return 'expired'
  if (typeof claims.iat !== 'number' || claims.iat - CLOCK_SKEW_SECONDS > nowSeconds) return 'expired'
  if (typeof claims.nonce !== 'string' || !constantTimeEqual(claims.nonce, expected.nonce)) return 'nonce'
  const email = normalizeEmail(claims.email)
  if (!email || (claims.email_verified !== true && claims.email_verified !== 'true')) return 'email'
  const name = typeof claims.name === 'string' && claims.name.trim()
    ? claims.name
    : [claims.given_name, claims.family_name].filter((part): part is string => typeof part === 'string' && Boolean(part.trim())).join(' ') || null
  return { email, name }
}
