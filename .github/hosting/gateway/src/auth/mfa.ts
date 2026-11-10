// The second step of signing in (DESIGN.md §5.1): after the first factor, someone with two-step sign-in on gets a
// challenge, tied to their browser by a host-only cookie, and answers it at /login/mfa with a code from their
// authenticator app or a recovery code. Only then does a session exist.
import type { Context } from '../context.ts'
import { apexUrl } from '../context.ts'
import { isToken, randomToken, sha256Hex, unseal } from '../crypto.ts'
import { consumeRecoveryCode, consumeStep, countAttempt, findChallenge, findMfa, insertChallenge, takeChallenge, type ChallengeRow } from '../db/mfa.ts'
import { cookieValues, serializeCookie } from '../http/cookies.ts'
import { field } from '../http/request.ts'
import { htmlResponse, redirect } from '../http/response.ts'
import { safeReturnTo } from '../http/return-to.ts'
import { log } from '../log.ts'
import { mfaChallengePage, mfaExpiredPage, mfaUnavailablePage } from '../pages/mfa.tsx'
import { afterPost, credentialsChangedPage, home } from '../pages/status.tsx'
import { allowAuth } from '../ratelimit.ts'
import { startSession } from './session.ts'
import { codeDigits, matchTotp, normalizeRecoveryCode } from './totp.ts'

export const CHALLENGE_TTL_MS = 10 * 60 * 1000
export const CHALLENGE_ATTEMPTS = 5
/** The purpose TOTP secrets are sealed for (crypto.ts `seal`). */
export const TOTP_PURPOSE = 'totp'

/** `__Host-` in production (host-only, Secure, Path=/); the prefix needs Secure, so it is dropped on http://*.localhost. */
export function mfaCookieName(ctx: Context): string {
  return ctx.relaxed ? 'insulin_mfa' : '__Host-insulin_mfa'
}

function mfaCookie(ctx: Context, value: string, maxAgeSeconds: number): string {
  return serializeCookie(mfaCookieName(ctx), value, { path: '/', maxAge: maxAgeSeconds, secure: !ctx.relaxed, httpOnly: true, sameSite: 'Lax' })
}

/** Whether the user has two-step sign-in on. */
export async function mfaEnabled(db: D1Database, userId: string): Promise<boolean> {
  return Boolean((await findMfa(db, userId))?.totp_secret)
}

/**
 * Instead of a session: a challenge for the credential version the first factor verified, the cookie that ties it to
 * this browser, and the way to the code form.
 */
export async function startChallenge(ctx: Context, user: { id: string; credential_version: number }, method: string, next: string): Promise<Response> {
  const token = randomToken()
  await insertChallenge(ctx.config.db, {
    idHash: await sha256Hex(token),
    userId: user.id,
    credentialVersion: user.credential_version,
    method,
    next,
    now: ctx.now,
    expiresAt: ctx.now + CHALLENGE_TTL_MS,
  })
  ctx.setCookies.push(mfaCookie(ctx, token, CHALLENGE_TTL_MS / 1000))
  log('mfa_challenge', { user: user.id, method })
  const form = apexUrl(ctx, '/login/mfa')
  return ctx.request.method === 'GET' ? redirect(form, 302) : afterPost(ctx, form)
}

/** The challenge this browser holds, if it is still open. */
async function presentedChallenge(ctx: Context): Promise<ChallengeRow | null> {
  for (const token of cookieValues(ctx.request.headers.get('Cookie'), mfaCookieName(ctx)).filter(isToken).slice(0, 3)) {
    const challenge = await findChallenge(ctx.config.db, await sha256Hex(token), ctx.now)
    if (challenge) return challenge
  }
  return null
}

function closeChallenge(ctx: Context): void {
  ctx.setCookies.push(mfaCookie(ctx, '', 0))
}

export async function mfaForm(ctx: Context): Promise<Response> {
  const challenge = await presentedChallenge(ctx)
  if (!challenge) return htmlResponse(mfaExpiredPage(ctx), { status: 410 })
  return htmlResponse(mfaChallengePage(ctx, {}))
}

/**
 * A code (or a recovery code) for the challenge. Wrong answers count, five per challenge and the RL_AUTH limit per
 * user; a right one is used up atomically, the challenge is taken once, and the session starts under the credential
 * version the first factor verified (none if it has changed since).
 */
export async function mfaVerify(ctx: Context): Promise<Response> {
  const db = ctx.config.db
  const challenge = await presentedChallenge(ctx)
  if (!challenge) {
    closeChallenge(ctx)
    return htmlResponse(mfaExpiredPage(ctx), { status: 410 })
  }
  if (!(await allowAuth(ctx, 'mfa', challenge.user_id))) {
    return htmlResponse(mfaChallengePage(ctx, { error: 'Too many attempts. Please wait a minute, then try again.' }), { status: 429, headers: { 'Retry-After': '60' } })
  }
  const attempts = await countAttempt(db, challenge.id_hash, ctx.now, CHALLENGE_ATTEMPTS)
  if (attempts === null) {
    await takeChallenge(db, challenge.id_hash)
    closeChallenge(ctx)
    log('mfa_attempts_exhausted', { user: challenge.user_id })
    return htmlResponse(mfaExpiredPage(ctx, 'That was too many wrong codes. Sign in again to get another try.'), { status: 429 })
  }
  const mfa = await findMfa(db, challenge.user_id)
  if (!mfa || mfa.credential_version !== challenge.credential_version || !mfa.totp_secret) {
    await takeChallenge(db, challenge.id_hash)
    closeChallenge(ctx)
    return credentialsChangedPage(ctx)
  }
  const input = field(ctx.form, 'code')
  const left = CHALLENGE_ATTEMPTS - attempts
  const wrong = () => htmlResponse(mfaChallengePage(ctx, {
    error: left > 0 ? `That code didn't work. ${left === 1 ? 'One more try' : `${left} more tries`}, then you'll need to sign in again.` : 'That code didn\'t work.',
  }), { status: 400 })

  const digits = codeDigits(input)
  let accepted = false
  if (digits) {
    // Fail closed: without the key nobody can check an app code, so nobody gets in with one (recovery codes still work).
    const secret = ctx.config.secretKey ? await unseal(ctx.config.secretKey, TOTP_PURPOSE, mfa.totp_secret) : null
    if (secret === null) {
      log('mfa_secret_unavailable', { user: challenge.user_id })
      return htmlResponse(mfaUnavailablePage(ctx), { status: 503 })
    }
    const step = await matchTotp(secret, digits, ctx.now)
    accepted = step !== null && step > mfa.totp_last_step && await consumeStep(db, challenge.user_id, mfa.totp_secret, step)
  } else {
    const code = normalizeRecoveryCode(input)
    accepted = code !== null && await consumeRecoveryCode(db, challenge.user_id, await sha256Hex(code), ctx.now)
    if (accepted) log('mfa_recovery_code_used', { user: challenge.user_id })
  }
  if (!accepted) {
    log('mfa_failed', { user: challenge.user_id })
    return wrong()
  }
  // Exactly one request takes the challenge; a second right answer at the same moment gets no session.
  if (!(await takeChallenge(db, challenge.id_hash))) return htmlResponse(mfaExpiredPage(ctx), { status: 410 })
  closeChallenge(ctx)
  if (!(await startSession(ctx, { id: challenge.user_id, credential_version: challenge.credential_version }))) return credentialsChangedPage(ctx)
  log('login', { user: challenge.user_id, method: challenge.method, mfa: true })
  return afterPost(ctx, safeReturnTo(ctx, challenge.next) ?? home(ctx))
}
