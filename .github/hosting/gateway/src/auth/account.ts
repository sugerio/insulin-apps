// The account page: change name, set or change the password, delete the account.
import type { Context } from '../context.ts'
import { hashPassword, verifyPassword } from '../crypto.ts'
import { changePassword, deleteAccount as removeAccount, findUserById, orgsBlockingDeletion, setUserName } from '../db/users.ts'
import { field } from '../http/request.ts'
import { htmlResponse, redirect } from '../http/response.ts'
import { log } from '../log.ts'
import { accountDeletedPage, accountPage } from '../pages/account.ts'
import { RATE_LIMITED } from '../pages/auth.ts'
import { allowAuth } from '../ratelimit.ts'
import { checkName, normalizeEmail, passwordProblem } from '../validate.ts'
import { requireSession } from './guard.ts'
import { clearSessionCookie } from './session.ts'

const ACCOUNT_NOTICES: Record<string, string> = {
  name: 'Your name is saved.',
  password: 'Your password is saved. Your other sessions are signed out.',
}

export async function accountView(ctx: Context): Promise<Response> {
  const session = await requireSession(ctx)
  if (session instanceof Response) return session
  return htmlResponse(accountPage(ctx, session, { notice: ACCOUNT_NOTICES[ctx.url.searchParams.get('notice') ?? ''] ?? null }))
}

export async function updateName(ctx: Context): Promise<Response> {
  const session = await requireSession(ctx)
  if (session instanceof Response) return session
  const checked = checkName(field(ctx.form, 'name'))
  if ('problem' in checked) return htmlResponse(accountPage(ctx, session, { errors: { name: checked.problem } }), { status: 400 })
  await setUserName(ctx.config.db, session.user.id, checked.name, ctx.now)
  return redirect('/account?notice=name', 303)
}

/**
 * Sets a first password (Google-only accounts) or changes it with the current one; other sessions are signed out. The
 * write is conditional on the credential version this request verified (the session's, which matches the user's), so
 * a reset that lands meanwhile wins and this change is refused rather than overwriting it.
 */
export async function updatePassword(ctx: Context): Promise<Response> {
  const session = await requireSession(ctx)
  if (session instanceof Response) return session
  const db = ctx.config.db
  const user = await findUserById(db, session.user.id)
  if (!user || user.credential_version !== session.credentialVersion) return redirect('/login', 303)
  if (user.password_hash) {
    if (!(await allowAuth(ctx, 'password', user.id))) {
      return htmlResponse(accountPage(ctx, session, { errors: { current: RATE_LIMITED } }), { status: 429 })
    }
    if (!(await verifyPassword(field(ctx.form, 'current_password'), user.password_hash))) {
      return htmlResponse(accountPage(ctx, session, { errors: { current: 'Your current password is incorrect.' } }), { status: 400 })
    }
  }
  const password = field(ctx.form, 'password')
  const problem = passwordProblem(password)
  if (problem) return htmlResponse(accountPage(ctx, session, { errors: { password: problem } }), { status: 400 })
  const changed = await changePassword(db, {
    userId: user.id,
    passwordHash: await hashPassword(password),
    verifiedVersion: session.credentialVersion,
    sessionHash: session.idHash,
    now: ctx.now,
  })
  if (!changed) {
    return htmlResponse(accountPage(ctx, session, { errors: { password: 'Your password was changed somewhere else in the meantime. Sign in again to set a new one.' } }), { status: 409 })
  }
  log('password_changed', { user: user.id })
  return redirect('/account?notice=password', 303)
}

export async function deleteAccount(ctx: Context): Promise<Response> {
  const session = await requireSession(ctx)
  if (session instanceof Response) return session
  const db = ctx.config.db
  if (normalizeEmail(field(ctx.form, 'confirm')) !== session.user.email) {
    return htmlResponse(accountPage(ctx, session, { errors: { delete: 'Type your email address exactly to confirm.' } }), { status: 400 })
  }
  const blockingOrgs = await orgsBlockingDeletion(db, session.user.id)
  if (blockingOrgs.length || !(await removeAccount(db, session.user.id))) {
    return htmlResponse(accountPage(ctx, session, { blockingOrgs: blockingOrgs.length ? blockingOrgs : await orgsBlockingDeletion(db, session.user.id) }), { status: 409 })
  }
  clearSessionCookie(ctx)
  log('account_deleted', { user: session.user.id })
  return htmlResponse(accountDeletedPage(ctx))
}
