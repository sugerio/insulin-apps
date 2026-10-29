// Google's ID token: decoding its payload and checking its claims. No I/O, so the unit tests import it directly.
import { constantTimeEqual, fromBase64url } from '../crypto.ts'
import { NAME_MAX, cleanText, normalizeEmail, truncate } from '../validate.ts'

const ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com'])

/** The payload of a JWT, without verifying its signature (see `checkIdToken`). */
export function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split('.')
  const bytes = parts.length === 3 ? fromBase64url(parts[1]!) : null
  if (!bytes) return null
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes))
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null
  } catch {
    return null
  }
}

export interface GoogleIdentity {
  sub: string
  email: string
  name: string
}

/**
 * Checks the ID token's claims. Its signature is not checked: the token comes straight from Google's token endpoint
 * over TLS in exchange for our client secret and PKCE verifier (OpenID Connect Core 3.1.3.7).
 */
export function checkIdToken(claims: Record<string, unknown>, clientId: string, nonce: string, nowSeconds: number): GoogleIdentity | null {
  if (typeof claims.iss !== 'string' || !ISSUERS.has(claims.iss)) return null
  const aud = claims.aud
  if (!(aud === clientId || (Array.isArray(aud) && aud.includes(clientId) && claims.azp === clientId))) return null
  if (typeof claims.exp !== 'number' || claims.exp <= nowSeconds) return null
  if (typeof claims.nonce !== 'string' || !constantTimeEqual(claims.nonce, nonce)) return null
  if (claims.email_verified !== true) return null
  if (typeof claims.sub !== 'string' || claims.sub === '' || claims.sub.length > 255) return null
  const email = normalizeEmail(claims.email)
  if (!email) return null
  return { sub: claims.sub, email, name: truncate(cleanText(claims.name), NAME_MAX) || email }
}
