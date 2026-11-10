// Where a verified identity becomes a session. Every way of signing in (password, Google, a reset link, a confirmation
// link, enterprise SSO) ends here, so what applies to all of them (the second factor, DESIGN.md §5.1) is in one place.
import type { Context } from '../context.ts'
import { redirect } from '../http/response.ts'
import { afterPost } from '../pages/status.tsx'
import { startSession } from './session.ts'

export type SignInMethod = 'password' | 'google' | 'reset' | 'verify' | 'sso'

/**
 * Signs `user` in under the credential version the request verified and continues to `next` (a redirect after a GET,
 * afterPost after a POST). `changed` answers when the credentials changed meanwhile and no session was created.
 * `activeOrgId` makes that organization the session's active one (single sign-on signs in to its organization).
 */
export async function finishSignIn(ctx: Context, user: { id: string; credential_version: number }, _method: SignInMethod, next: string, changed: () => Response, activeOrgId: string | null = null): Promise<Response> {
  if (!(await startSession(ctx, user, activeOrgId))) return changed()
  return ctx.request.method === 'GET' ? redirect(next, 302) : afterPost(ctx, next)
}
