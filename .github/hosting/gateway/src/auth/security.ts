// Account → Security (DESIGN.md §5.1): turning two-step sign-in on (a sealed secret, confirmed with a code from the
// app, then ten recovery codes shown once) and off, and making new recovery codes. Turning it on or off raises the
// credential version, so every other session ends, and this browser continues with a fresh session.
import type { Context } from '../context.ts'
import { apexUrl } from '../context.ts'
import { seal, sha256Hex, unseal } from '../crypto.ts'
import {
  clearPendingSecret, consumeRecoveryCode, consumeStep, countRecoveryCodes, disableMfa, enableMfa, findMfa,
  replaceRecoveryCodes, setPendingSecret, type MfaRow,
} from '../db/mfa.ts'
import { listMemberships } from '../db/orgs.ts'
import { field } from '../http/request.ts'
import { htmlResponse, redirect } from '../http/response.ts'
import { log } from '../log.ts'
import { mfaChangedMail } from '../mail/templates.ts'
import { sendMail } from '../mail/transport.ts'
import { RATE_LIMITED } from '../pages/auth.tsx'
import { securityPage, type SecurityState } from '../pages/mfa.tsx'
import { credentialsChangedPage } from '../pages/status.tsx'
import { allowAuth } from '../ratelimit.ts'
import { requireSession } from './guard.ts'
import { TOTP_PURPOSE } from './mfa.ts'
import { activeOrg, startSession, type Session } from './session.ts'
import {
  RECOVERY_CODE_COUNT, codeDigits, matchTotp, newRecoveryCode, newTotpSecret, normalizeRecoveryCode, otpauthUri,
} from './totp.ts'

const NOTICES: Record<string, string> = {
  disabled: 'Two-step sign-in is off. Your other sessions are signed out.',
  cancelled: 'Setup cancelled. Two-step sign-in is still off.',
}

const NOT_AVAILABLE = 'Two-step sign-in isn\'t available on this site right now.'
const WRONG_CODE = 'That code didn\'t work. Check that the time on your phone is set automatically, and enter the newest code.'

/** The page as it stands, with whatever the request adds (new codes, a notice, a problem) and its status. */
async function render(ctx: Context, session: Session, extra: Partial<SecurityState> = {}, status = 200): Promise<Response> {
  const db = ctx.config.db
  const key = ctx.config.secretKey
  const [mfa, recoveryLeft, memberships] = await Promise.all([
    findMfa(db, session.user.id),
    countRecoveryCodes(db, session.user.id),
    listMemberships(db, session.user.id),
    activeOrg(ctx, session),
  ])
  const pending = mfa?.totp_pending && key && !mfa.totp_secret ? await unseal(key, TOTP_PURPOSE, mfa.totp_pending) : null
  return htmlResponse(securityPage(ctx, session, {
    available: key !== null,
    enabledAt: mfa?.totp_secret ? mfa.totp_enabled_at ?? ctx.now : null,
    setup: pending ? { secret: pending, uri: otpauthUri(pending, session.user.email) } : null,
    recoveryLeft,
    ...extra,
  }, memberships), { status })
}

function back(notice?: string): Response {
  return redirect(notice ? `/account/security?notice=${notice}` : '/account/security', 303)
}

/** Ten new recovery codes and their stored form (SHA-256 of the normalized code). */
async function recoveryCodes(): Promise<{ codes: string[]; hashes: string[] }> {
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, newRecoveryCode)
  const hashes = await Promise.all(codes.map((code) => sha256Hex(normalizeRecoveryCode(code)!)))
  return { codes, hashes }
}

/** The step of a code from the app for the user's secret, recorded as used; null when it isn't a valid, new code. */
async function acceptAppCode(ctx: Context, userId: string, mfa: MfaRow, input: string): Promise<'ok' | 'wrong' | 'unavailable'> {
  const digits = codeDigits(input)
  if (!digits || !mfa.totp_secret) return 'wrong'
  const secret = ctx.config.secretKey ? await unseal(ctx.config.secretKey, TOTP_PURPOSE, mfa.totp_secret) : null
  if (secret === null) return 'unavailable'
  const step = await matchTotp(secret, digits, ctx.now)
  return step !== null && step > mfa.totp_last_step && await consumeStep(ctx.config.db, userId, mfa.totp_secret, step) ? 'ok' : 'wrong'
}

async function notify(ctx: Context, session: Session, enabled: boolean): Promise<void> {
  await sendMail(ctx, 'mfa_changed', session.user.email, mfaChangedMail(session.user.name, enabled, apexUrl(ctx, '/account/security')))
}

export async function securityView(ctx: Context): Promise<Response> {
  const session = await requireSession(ctx)
  if (session instanceof Response) return session
  return render(ctx, session, { notice: NOTICES[ctx.url.searchParams.get('notice') ?? ''] ?? null })
}

export async function startSetup(ctx: Context): Promise<Response> {
  const session = await requireSession(ctx)
  if (session instanceof Response) return session
  const key = ctx.config.secretKey
  if (!key) return render(ctx, session, { errors: { form: NOT_AVAILABLE } }, 503)
  const sealed = await seal(key, TOTP_PURPOSE, newTotpSecret())
  // Refused when it is already on, or the credentials changed since this session was made: the page then shows why.
  await setPendingSecret(ctx.config.db, session.user.id, sealed, session.credentialVersion, ctx.now)
  return back()
}

export async function cancelSetup(ctx: Context): Promise<Response> {
  const session = await requireSession(ctx)
  if (session instanceof Response) return session
  await clearPendingSecret(ctx.config.db, session.user.id, ctx.now)
  return back('cancelled')
}

export async function enable(ctx: Context): Promise<Response> {
  const session = await requireSession(ctx)
  if (session instanceof Response) return session
  const db = ctx.config.db
  const key = ctx.config.secretKey
  if (!key) return render(ctx, session, { errors: { form: NOT_AVAILABLE } }, 503)
  const mfa = await findMfa(db, session.user.id)
  if (!mfa || mfa.totp_secret || !mfa.totp_pending) return back()
  if (!(await allowAuth(ctx, 'mfa', session.user.id))) return render(ctx, session, { errors: { setup: RATE_LIMITED } }, 429)
  const secret = await unseal(key, TOTP_PURPOSE, mfa.totp_pending)
  const digits = codeDigits(field(ctx.form, 'code'))
  const step = secret && digits ? await matchTotp(secret, digits, ctx.now) : null
  if (step === null) return render(ctx, session, { errors: { setup: WRONG_CODE } }, 400)
  const { codes, hashes } = await recoveryCodes()
  const version = await enableMfa(db, { userId: session.user.id, pending: mfa.totp_pending, verifiedVersion: session.credentialVersion, step, codeHashes: hashes, now: ctx.now })
  if (version === null) return credentialsChangedPage(ctx)
  if (!(await startSession(ctx, { id: session.user.id, credential_version: version }))) return credentialsChangedPage(ctx)
  log('mfa_enabled', { user: session.user.id })
  await notify(ctx, session, true)
  return render(ctx, session, { newCodes: codes, notice: 'Two-step sign-in is on. Your other sessions are signed out.' })
}

export async function regenerateCodes(ctx: Context): Promise<Response> {
  const session = await requireSession(ctx)
  if (session instanceof Response) return session
  const db = ctx.config.db
  const mfa = await findMfa(db, session.user.id)
  if (!mfa?.totp_secret) return back()
  if (!(await allowAuth(ctx, 'mfa', session.user.id))) return render(ctx, session, { errors: { regenerate: RATE_LIMITED } }, 429)
  const checked = await acceptAppCode(ctx, session.user.id, mfa, field(ctx.form, 'code'))
  if (checked === 'unavailable') return render(ctx, session, { errors: { regenerate: NOT_AVAILABLE } }, 503)
  if (checked === 'wrong') return render(ctx, session, { errors: { regenerate: WRONG_CODE } }, 400)
  const { codes, hashes } = await recoveryCodes()
  if (!(await replaceRecoveryCodes(db, session.user.id, mfa.totp_secret, hashes, ctx.now))) return back()
  log('mfa_recovery_codes_replaced', { user: session.user.id })
  return render(ctx, session, { newCodes: codes, notice: 'Your new recovery codes are below. The old ones no longer work.' })
}

export async function disable(ctx: Context): Promise<Response> {
  const session = await requireSession(ctx)
  if (session instanceof Response) return session
  const db = ctx.config.db
  const mfa = await findMfa(db, session.user.id)
  if (!mfa?.totp_secret) return back()
  if (!(await allowAuth(ctx, 'mfa', session.user.id))) return render(ctx, session, { errors: { disable: RATE_LIMITED } }, 429)
  const input = field(ctx.form, 'code')
  let checked: 'ok' | 'wrong' | 'unavailable'
  if (codeDigits(input)) {
    checked = await acceptAppCode(ctx, session.user.id, mfa, input)
  } else {
    // Recovery codes are hashed, not sealed: they work even when app codes can't be checked.
    const code = normalizeRecoveryCode(input)
    checked = code !== null && await consumeRecoveryCode(db, session.user.id, await sha256Hex(code), ctx.now) ? 'ok' : 'wrong'
  }
  if (checked === 'unavailable') return render(ctx, session, { errors: { disable: 'App codes can\'t be checked right now. Use a recovery code instead.' } }, 503)
  if (checked === 'wrong') return render(ctx, session, { errors: { disable: WRONG_CODE } }, 400)
  const version = await disableMfa(db, { userId: session.user.id, secret: mfa.totp_secret, verifiedVersion: session.credentialVersion, now: ctx.now })
  if (version === null) return credentialsChangedPage(ctx)
  if (!(await startSession(ctx, { id: session.user.id, credential_version: version }))) return credentialsChangedPage(ctx)
  log('mfa_disabled', { user: session.user.id })
  await notify(ctx, session, false)
  return back('disabled')
}
