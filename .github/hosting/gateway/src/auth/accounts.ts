// E-mail and password accounts: sign-up, sign-in, sign-out, e-mail confirmation, resend, forgotten and reset passwords.
// Nothing here reveals whether an address has an account, except to someone who knows its password.
import type { Context } from '../context.ts'
import { authUrl } from '../context.ts'
import { burnPasswordCheck, hashPassword, isToken, newId, randomToken, sha256Hex, verifyPassword } from '../crypto.ts'
import { commitToken, consumeToken, dropToken, findUsableToken, stageToken, type TokenPurpose } from '../db/tokens.ts'
import {
  deleteUnverifiedUser, findUserByEmail, findUserById, insertUser, markVerifiedStatement, resetPassword, type UserRow,
} from '../db/users.ts'
import { field } from '../http/request.ts'
import { htmlResponse, redirect } from '../http/response.ts'
import { safeReturnTo } from '../http/return-to.ts'
import { log, logError } from '../log.ts'
import { resetPasswordMail, signupExistsMail, verifyEmailMail, type MailContent } from '../mail/templates.ts'
import { sendMail, type SendOutcome } from '../mail/transport.ts'
import {
  MAIL_FAILED, RATE_LIMITED, TURNSTILE_FAILED, checkInboxPage, confirmFirstPage, forgotPage, linkInvalidPage, loginPage,
  resendPage, resetPage, signupPage, verifyEmailPage,
} from '../pages/auth.tsx'
import { afterPost, credentialsChangedPage, home, rateLimitedPage } from '../pages/status.tsx'
import { allowAuth } from '../ratelimit.ts'
import { TURNSTILE_FIELD, verifyTurnstile } from '../turnstile.ts'
import { checkName, normalizeEmail, passwordProblem } from '../validate.ts'
import { endSession, loadSession, startSession } from './session.ts'

const VERIFY_TTL_MS = 24 * 60 * 60 * 1000
const RESET_TTL_MS = 60 * 60 * 1000

/**
 * E-mails a new single-use link (only the token's SHA-256 is stored). The token is staged first, the e-mail takes a
 * slot under the caps and goes out, and only then do older links of the same purpose stop working. A capped or failed
 * send drops the staged token instead, so flooding requests can never invalidate the links someone already received.
 */
async function sendTokenMail(ctx: Context, user: UserRow, purpose: TokenPurpose, returnTo: string | null, build: (link: string) => MailContent): Promise<SendOutcome> {
  const db = ctx.config.db
  const token = randomToken()
  const tokenHash = await sha256Hex(token)
  await stageToken(db, {
    tokenHash,
    userId: user.id,
    purpose,
    email: user.email,
    returnTo,
    now: ctx.now,
    expiresAt: ctx.now + (purpose === 'verify_email' ? VERIFY_TTL_MS : RESET_TTL_MS),
  })
  const link = authUrl(ctx, `/${purpose === 'verify_email' ? 'verify-email' : 'reset-password'}?token=${token}`)
  const outcome = await sendMail(ctx, purpose, user.email, build(link))
  if (outcome === 'sent') await commitToken(db, tokenHash, user.id, purpose)
  else await dropToken(db, tokenHash)
  return outcome
}

function prefilledEmail(ctx: Context): string | undefined {
  return normalizeEmail(ctx.url.searchParams.get('email')) ?? undefined
}

async function signedInRedirect(ctx: Context): Promise<Response | null> {
  const session = await loadSession(ctx)
  if (!session?.user.verified) return null
  return redirect(safeReturnTo(ctx, ctx.url.searchParams.get('return_to')) ?? home(ctx))
}

export async function signupForm(ctx: Context): Promise<Response> {
  const already = await signedInRedirect(ctx)
  if (already) return already
  return htmlResponse(signupPage(ctx, { values: { email: prefilledEmail(ctx) }, returnTo: safeReturnTo(ctx, ctx.url.searchParams.get('return_to')) }))
}

export async function signup(ctx: Context): Promise<Response> {
  const db = ctx.config.db
  const nameInput = field(ctx.form, 'name')
  const emailInput = field(ctx.form, 'email')
  const password = field(ctx.form, 'password')
  const returnTo = safeReturnTo(ctx, field(ctx.form, 'return_to'))
  const values = { name: nameInput.slice(0, 200), email: emailInput.slice(0, 254) }
  const checked = checkName(nameInput)
  const email = normalizeEmail(emailInput)

  if (!(await allowAuth(ctx, 'signup', email ?? undefined))) {
    return htmlResponse(signupPage(ctx, { values, returnTo, errors: { form: RATE_LIMITED } }), { status: 429 })
  }
  const errors = {
    name: 'problem' in checked ? checked.problem : null,
    email: email ? null : 'Enter a valid email address.',
    password: passwordProblem(password),
  }
  if (errors.name || errors.email || errors.password || !email || 'problem' in checked) {
    return htmlResponse(signupPage(ctx, { values, returnTo, errors }), { status: 400 })
  }
  if (!(await verifyTurnstile(ctx, field(ctx.form, TURNSTILE_FIELD), 'signup'))) {
    return htmlResponse(signupPage(ctx, { values, returnTo, errors: { form: TURNSTILE_FAILED } }), { status: 400 })
  }

  // Both branches hash once and send one e-mail, and both answer "Check your inbox".
  let outcome: SendOutcome
  const existing = await findUserByEmail(db, email)
  const created = existing ? null : { id: newId(), passwordHash: await hashPassword(password) }
  if (created && await insertUser(db, { id: created.id, email, name: checked.name, passwordHash: created.passwordHash, verifiedAt: null, googleSub: null, now: ctx.now })) {
    const user = (await findUserById(db, created.id))!
    outcome = await sendTokenMail(ctx, user, 'verify_email', returnTo, (link) => verifyEmailMail(user.name, link))
    if (outcome === 'failed') await deleteUnverifiedUser(db, user.id)
  } else {
    if (!created) await burnPasswordCheck(password)
    outcome = await sendMail(ctx, 'signup_exists', email, signupExistsMail(authUrl(ctx, '/login'), authUrl(ctx, '/forgot-password')))
  }
  if (outcome === 'failed') return htmlResponse(signupPage(ctx, { values, returnTo, errors: { form: MAIL_FAILED } }), { status: 503 })
  return htmlResponse(checkInboxPage(ctx, email))
}

export async function loginForm(ctx: Context): Promise<Response> {
  const already = await signedInRedirect(ctx)
  if (already) return already
  return htmlResponse(loginPage(ctx, {
    values: { email: prefilledEmail(ctx) },
    returnTo: safeReturnTo(ctx, ctx.url.searchParams.get('return_to')),
    notice: ctx.url.searchParams.get('signed_out') === '1' ? 'You\'re signed out.' : null,
  }))
}

export async function login(ctx: Context): Promise<Response> {
  const db = ctx.config.db
  const emailInput = field(ctx.form, 'email')
  const password = field(ctx.form, 'password')
  const returnTo = safeReturnTo(ctx, field(ctx.form, 'return_to'))
  const values = { email: emailInput.slice(0, 254) }
  const email = normalizeEmail(emailInput)

  if (!(await allowAuth(ctx, 'login', email ?? undefined))) {
    return htmlResponse(loginPage(ctx, { values, returnTo, errors: { form: RATE_LIMITED } }), { status: 429 })
  }
  if (!email || !password) {
    return htmlResponse(loginPage(ctx, { values, returnTo, errors: { form: 'Enter your email address and password.' } }), { status: 400 })
  }
  if (!(await verifyTurnstile(ctx, field(ctx.form, TURNSTILE_FIELD), 'login'))) {
    return htmlResponse(loginPage(ctx, { values, returnTo, errors: { form: TURNSTILE_FAILED } }), { status: 400 })
  }
  const user = await findUserByEmail(db, email)
  let valid = false
  if (user?.password_hash) valid = await verifyPassword(password, user.password_hash)
  else await burnPasswordCheck(password)
  if (!user || !valid) {
    log('login_failed')
    return htmlResponse(loginPage(ctx, { values, returnTo, errors: { form: 'Email or password is incorrect.' } }), { status: 401 })
  }
  if (user.email_verified_at === null) return htmlResponse(confirmFirstPage(ctx, user.email, { returnTo }), { status: 403 })
  // The session is created only under the credential version whose password was just verified.
  if (!(await startSession(ctx, user))) return credentialsChangedPage(ctx)
  log('login', { user: user.id })
  return afterPost(ctx, returnTo ?? home(ctx))
}

export async function logout(ctx: Context): Promise<Response> {
  await endSession(ctx)
  return redirect('/login?signed_out=1', 303)
}

export async function verifyEmailForm(ctx: Context): Promise<Response> {
  const token = ctx.url.searchParams.get('token')
  const row = isToken(token) ? await findUsableToken(ctx.config.db, await sha256Hex(token), 'verify_email', ctx.now) : null
  if (!row || !isToken(token)) return htmlResponse(linkInvalidPage(ctx, 'verify'), { status: 400 })
  return htmlResponse(verifyEmailPage(ctx, token, row.email))
}

export async function verifyEmail(ctx: Context): Promise<Response> {
  const db = ctx.config.db
  if (!(await allowAuth(ctx, 'verify'))) return rateLimitedPage(ctx)
  const token = field(ctx.form, 'token')
  const row = isToken(token) ? await consumeToken(db, await sha256Hex(token), 'verify_email', ctx.now) : null
  const user = row ? await findUserById(db, row.user_id) : null
  if (!row || !user || user.email !== row.email) return htmlResponse(linkInvalidPage(ctx, 'verify'), { status: 400 })
  await markVerifiedStatement(db, user.id, ctx.now).run()
  if (!(await startSession(ctx, user))) return credentialsChangedPage(ctx)
  log('email_verified', { user: user.id })
  return afterPost(ctx, safeReturnTo(ctx, row.return_to) ?? authUrl(ctx, '/?notice=verified'))
}

export async function resendForm(ctx: Context): Promise<Response> {
  return htmlResponse(resendPage(ctx, { values: { email: prefilledEmail(ctx) }, returnTo: safeReturnTo(ctx, ctx.url.searchParams.get('return_to')) }))
}

export async function resend(ctx: Context): Promise<Response> {
  const emailInput = field(ctx.form, 'email')
  const returnTo = safeReturnTo(ctx, field(ctx.form, 'return_to'))
  const email = normalizeEmail(emailInput)
  const values = { email: emailInput.slice(0, 254) }
  if (!(await allowAuth(ctx, 'resend', email ?? undefined))) {
    return htmlResponse(resendPage(ctx, { values, returnTo, errors: { form: RATE_LIMITED } }), { status: 429 })
  }
  if (!email) return htmlResponse(resendPage(ctx, { values, returnTo, errors: { email: 'Enter a valid email address.' } }), { status: 400 })
  if (!(await verifyTurnstile(ctx, field(ctx.form, TURNSTILE_FIELD), 'resend'))) {
    return htmlResponse(resendPage(ctx, { values, returnTo, errors: { form: TURNSTILE_FAILED } }), { status: 400 })
  }
  // After the response: the answer and its timing are the same whether or not a message goes out.
  ctx.exec.waitUntil(sendVerification(ctx, email, returnTo).catch((error) => logError('resend_failed', error)))
  return htmlResponse(resendPage(ctx, { done: true }))
}

async function sendVerification(ctx: Context, email: string, returnTo: string | null): Promise<void> {
  const user = await findUserByEmail(ctx.config.db, email)
  if (!user || user.email_verified_at !== null) return
  await sendTokenMail(ctx, user, 'verify_email', returnTo, (link) => verifyEmailMail(user.name, link))
}

export async function forgotForm(ctx: Context): Promise<Response> {
  return htmlResponse(forgotPage(ctx, { values: { email: prefilledEmail(ctx) } }))
}

export async function forgot(ctx: Context): Promise<Response> {
  const emailInput = field(ctx.form, 'email')
  const email = normalizeEmail(emailInput)
  const values = { email: emailInput.slice(0, 254) }
  if (!(await allowAuth(ctx, 'forgot', email ?? undefined))) {
    return htmlResponse(forgotPage(ctx, { values, errors: { form: RATE_LIMITED } }), { status: 429 })
  }
  if (!email) return htmlResponse(forgotPage(ctx, { values, errors: { email: 'Enter a valid email address.' } }), { status: 400 })
  if (!(await verifyTurnstile(ctx, field(ctx.form, TURNSTILE_FIELD), 'forgot'))) {
    return htmlResponse(forgotPage(ctx, { values, errors: { form: TURNSTILE_FAILED } }), { status: 400 })
  }
  ctx.exec.waitUntil(sendReset(ctx, email).catch((error) => logError('forgot_failed', error)))
  return htmlResponse(forgotPage(ctx, { done: true }))
}

async function sendReset(ctx: Context, email: string): Promise<void> {
  const user = await findUserByEmail(ctx.config.db, email)
  if (!user) return
  await sendTokenMail(ctx, user, 'reset_password', null, (link) => resetPasswordMail(user.name, link))
}

export async function resetForm(ctx: Context): Promise<Response> {
  const token = ctx.url.searchParams.get('token')
  const row = isToken(token) ? await findUsableToken(ctx.config.db, await sha256Hex(token), 'reset_password', ctx.now) : null
  if (!row || !isToken(token)) return htmlResponse(linkInvalidPage(ctx, 'reset'), { status: 400 })
  return htmlResponse(resetPage(ctx, token, row.email))
}

export async function reset(ctx: Context): Promise<Response> {
  const db = ctx.config.db
  if (!(await allowAuth(ctx, 'reset'))) return rateLimitedPage(ctx)
  const token = field(ctx.form, 'token')
  const password = field(ctx.form, 'password')
  if (!isToken(token)) return htmlResponse(linkInvalidPage(ctx, 'reset'), { status: 400 })
  const tokenHash = await sha256Hex(token)
  const problem = passwordProblem(password)
  if (problem) {
    // A rejected password must not use up the link.
    const row = await findUsableToken(db, tokenHash, 'reset_password', ctx.now)
    if (!row) return htmlResponse(linkInvalidPage(ctx, 'reset'), { status: 400 })
    return htmlResponse(resetPage(ctx, token, row.email, problem), { status: 400 })
  }
  const row = await consumeToken(db, tokenHash, 'reset_password', ctx.now)
  const user = row ? await findUserById(db, row.user_id) : null
  if (!row || !user || user.email !== row.email) return htmlResponse(linkInvalidPage(ctx, 'reset'), { status: 400 })
  // The inbox is proven, so the address counts as confirmed; the credential version rises and every session ends.
  const version = await resetPassword(db, user.id, await hashPassword(password), ctx.now)
  if (version === null || !(await startSession(ctx, { id: user.id, credential_version: version }))) return credentialsChangedPage(ctx)
  log('password_reset', { user: user.id })
  return redirect(authUrl(ctx, '/?notice=password-set'), 303)
}
