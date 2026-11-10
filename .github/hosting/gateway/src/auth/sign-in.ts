// Where a verified identity becomes a session. Every way of signing in (password, Google, a reset link, a confirmation
// link, enterprise SSO) ends here, so what applies to all of them (the second factor, DESIGN.md §5.1) is in one place.
import type { Context } from '../context.ts'
import { findUserById } from '../db/users.ts'
import { redirect } from '../http/response.ts'
import { afterPost } from '../pages/status.tsx'
import { ssoRequired, ssoRequiredResponse } from '../sso/required.ts'
import { mfaEnabled, startChallenge } from './mfa.ts'
import { startSession } from './session.ts'

export type SignInMethod = 'password' | 'google' | 'reset' | 'verify' | 'sso'

/**
 * Signs `user` in under the credential version the request verified and continues to `next` (a redirect after a GET,
 * afterPost after a POST). `changed` answers when the credentials changed meanwhile and no session was created.
 *
 * An address whose organization requires its single sign-on signs in no other way: checked here against the account's
 * stored address, whatever matched the account (a Google account is found by its subject, not its address).
 *
 * With two-step sign-in on, there is no session yet: the browser gets a challenge to answer with a code (auth/mfa.ts).
 * That holds for every method, single sign-on included: the organization that verified a domain controls its
 * mailboxes, and so could already reset a password; with the code asked for here too, its identity provider is no
 * weaker a way in than a reset. A confirmation link only signs in an account that has just been created, which can't
 * have it on yet, but an older link must not get around it either. `activeOrgId` makes that organization the session's
 * active one (single sign-on signs in to its organization).
 */
export async function finishSignIn(ctx: Context, user: { id: string; credential_version: number }, method: SignInMethod, next: string, changed: () => Response, activeOrgId: string | null = null): Promise<Response> {
  if (method !== 'sso') {
    const account = await findUserById(ctx.config.db, user.id)
    if (account && await ssoRequired(ctx, account.email)) return ssoRequiredResponse(ctx, account.email, null)
  }
  if (await mfaEnabled(ctx.config.db, user.id)) return startChallenge(ctx, user, method, next, activeOrgId)
  if (!(await startSession(ctx, user, activeOrgId))) return changed()
  return ctx.request.method === 'GET' ? redirect(next, 302) : afterPost(ctx, next)
}
