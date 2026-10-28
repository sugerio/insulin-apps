// Google sign-in: OpenID Connect authorization code flow with PKCE (S256), state and nonce.
import type { Context } from '../context.ts'
import { authUrl } from '../context.ts'
import {
  base64url, constantTimeEqual, fromBase64url, isToken, newId, randomToken, sha256, utf8,
} from '../crypto.ts'
import { deleteUserSessionsStatement } from '../db/sessions.ts'
import { deleteUnusedTokensStatement } from '../db/tokens.ts'
import { findUserByEmail, findUserByGoogleSub, findUserById, insertUser, linkGoogle, type UserRow } from '../db/users.ts'
import { cookieValues, serializeCookie } from '../http/cookies.ts'
import { redirect } from '../http/response.ts'
import { safeReturnTo } from '../http/return-to.ts'
import { log } from '../log.ts'
import { html } from '../pages/html.ts'
import { home, messagePage, notFoundPage, rateLimitedPage } from '../pages/status.ts'
import { allowAuth } from '../ratelimit.ts'
import { NAME_MAX, cleanText, normalizeEmail, truncate } from '../validate.ts'
import { startSession } from './session.ts'

const AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com'])
const FLOW_TTL_SECONDS = 600

/** `__Host-` in production (host-only, Secure, Path=/); the prefix needs Secure, so it is dropped on http://*.localhost. */
export function flowCookieName(ctx: Context): string {
  return ctx.relaxed ? 'insulin_oauth' : '__Host-insulin_oauth'
}

function flowCookie(ctx: Context, value: string, maxAge: number): string {
  return serializeCookie(flowCookieName(ctx), value, { path: '/', maxAge, secure: !ctx.relaxed, httpOnly: true, sameSite: 'Lax' })
}

export function redirectUri(ctx: Context): string {
  return authUrl(ctx, '/auth/google/callback')
}

export async function googleStart(ctx: Context): Promise<Response> {
  const google = ctx.config.google
  if (!google) return notFoundPage(ctx)
  if (!(await allowAuth(ctx, 'google'))) return rateLimitedPage(ctx)
  const state = randomToken()
  const verifier = randomToken()
  const nonce = randomToken()
  const returnTo = safeReturnTo(ctx, ctx.url.searchParams.get('return_to')) ?? ''
  ctx.setCookies.push(flowCookie(ctx, [state, verifier, nonce, base64url(utf8(returnTo))].join('.'), FLOW_TTL_SECONDS))
  const url = new URL(AUTHORIZE_URL)
  url.search = new URLSearchParams({
    client_id: google.clientId,
    redirect_uri: redirectUri(ctx),
    response_type: 'code',
    scope: 'openid email profile',
    state,
    nonce,
    code_challenge: base64url(await sha256(verifier)),
    code_challenge_method: 'S256',
    prompt: 'select_account',
  }).toString()
  return redirect(url.href, 302)
}

interface Flow {
  state: string
  verifier: string
  nonce: string
  returnTo: string
}

function readFlow(ctx: Context): Flow | null {
  const [value] = cookieValues(ctx.request.headers.get('Cookie'), flowCookieName(ctx))
  const [state, verifier, nonce, encoded, ...rest] = (value ?? '').split('.')
  if (rest.length || !isToken(state) || !isToken(verifier) || !isToken(nonce) || encoded === undefined) return null
  const bytes = fromBase64url(encoded)
  return bytes ? { state, verifier, nonce, returnTo: new TextDecoder().decode(bytes) } : null
}

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

async function exchangeCode(ctx: Context, google: { clientId: string; clientSecret: string }, code: string, verifier: string): Promise<Record<string, unknown> | null> {
  let response: Response
  try {
    response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { Accept: 'application/json' },
      body: new URLSearchParams({
        code,
        client_id: google.clientId,
        client_secret: google.clientSecret,
        redirect_uri: redirectUri(ctx),
        grant_type: 'authorization_code',
        code_verifier: verifier,
      }),
      signal: AbortSignal.timeout(10_000),
    })
  } catch {
    log('google_token_unavailable')
    return null
  }
  if (!response.ok) {
    log('google_token_rejected', { status: response.status })
    return null
  }
  const data = await response.json<{ id_token?: unknown }>().catch(() => null)
  return typeof data?.id_token === 'string' ? decodeJwtPayload(data.id_token) : null
}

/**
 * The account for a Google identity: the one already linked to it; else the one with its e-mail address, which gets
 * linked (an unconfirmed one is confirmed and loses its password: defeats account pre-hijacking); else a new,
 * confirmed account. Null when the address belongs to an account linked to a different Google account.
 */
async function resolveUser(ctx: Context, identity: GoogleIdentity): Promise<UserRow | null> {
  const db = ctx.config.db
  const linked = await findUserByGoogleSub(db, identity.sub)
  if (linked) return linked
  const existing = await findUserByEmail(db, identity.email)
  if (existing) {
    if (existing.google_sub !== null || !(await linkGoogle(db, existing.id, identity.sub, ctx.now))) {
      log('google_account_conflict', { user: existing.id })
      return null
    }
    if (existing.email_verified_at === null) {
      await db.batch([deleteUserSessionsStatement(db, existing.id), deleteUnusedTokensStatement(db, existing.id)])
      log('google_linked_unconfirmed_account', { user: existing.id })
    } else {
      log('google_linked', { user: existing.id })
    }
    return findUserById(db, existing.id)
  }
  const id = newId()
  if (await insertUser(db, { id, email: identity.email, name: identity.name, passwordHash: null, verifiedAt: ctx.now, googleSub: identity.sub, now: ctx.now })) {
    log('google_signup', { user: id })
    return findUserById(db, id)
  }
  return findUserByGoogleSub(db, identity.sub)
}

function failed(ctx: Context, status: number, text: string): Response {
  return messagePage(ctx, status, 'Google sign-in didn\'t work', html`<p>${text}</p><p><a href="/login">Back to sign in</a></p>`)
}

export async function googleCallback(ctx: Context): Promise<Response> {
  const google = ctx.config.google
  if (!google) return notFoundPage(ctx)
  const params = ctx.url.searchParams
  // The state is checked first, for errors too: a request that doesn't carry this flow's state (say, a cross-site link
  // to ?error=…) changes nothing, and the pending flow stays usable.
  const flow = readFlow(ctx)
  if (!flow || !constantTimeEqual(params.get('state') ?? '', flow.state)) {
    log('google_state_mismatch')
    return failed(ctx, 400, 'The sign-in request expired or didn\'t match. Please try again.')
  }
  // One attempt per flow: from here on the cookie is cleared whatever happens.
  ctx.setCookies.push(flowCookie(ctx, '', 0))
  if (params.get('error')) return failed(ctx, 400, 'Google sign-in was cancelled.')
  const code = params.get('code') ?? ''
  if (!code || code.length > 2048) return failed(ctx, 400, 'Google didn\'t send a sign-in code. Please try again.')
  const claims = await exchangeCode(ctx, google, code, flow.verifier)
  const identity = claims ? checkIdToken(claims, google.clientId, flow.nonce, Math.floor(ctx.now / 1000)) : null
  if (!identity) {
    log('google_identity_rejected')
    return failed(ctx, 400, 'We couldn\'t confirm your Google account. Please try again, and make sure its email address is verified.')
  }
  const user = await resolveUser(ctx, identity)
  if (!user) return failed(ctx, 409, 'This email address belongs to an account that is linked to a different Google account. Sign in with that Google account or with your password.')
  if (!(await startSession(ctx, user))) return failed(ctx, 409, 'The sign-in details of this account changed while you were signing in. Please try again.')
  log('login', { user: user.id, method: 'google' })
  return redirect(safeReturnTo(ctx, flow.returnTo) ?? home(ctx), 302)
}
