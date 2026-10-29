import type { Context } from '../context.ts'
import { authUrl, withReturnTo } from '../context.ts'
import { redirect } from '../http/response.ts'
import { confirmEmailFirstPage } from '../pages/status.tsx'
import { loadSession, type Session } from './session.ts'

/**
 * The verified, signed-in user, or the response to send instead (sign in first, or confirm the email address). After
 * signing in, a GET comes back to its own URL, a POST to `back` when given.
 */
export async function requireSession(ctx: Context, back: string | null = null): Promise<Session | Response> {
  const session = await loadSession(ctx)
  if (session?.user.verified) return session
  if (session) return verifyNotice(ctx, session)
  const get = ctx.request.method === 'GET' || ctx.request.method === 'HEAD'
  return redirect(authUrl(ctx, withReturnTo('/login', get ? ctx.url.href : back)), get ? 302 : 303)
}

/** Sessions are only created for confirmed addresses; this covers an account whose address is somehow unconfirmed. */
export function verifyNotice(ctx: Context, session: Session): Response {
  return confirmEmailFirstPage(ctx, session)
}
