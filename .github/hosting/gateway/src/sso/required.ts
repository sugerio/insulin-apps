// "Require SSO" (DESIGN.md §7): for an address in a verified domain whose organization requires its single sign-on,
// every other way of signing in is refused. The early checks in the sign-in forms say so before any credential work;
// finishSignIn and the code step check again against the account's stored address, the one choke point every sign-in
// passes, so nothing that matched the account another way (a Google account by its subject, say) gets around it.
import type { Context } from '../context.ts'
import { domainOf, ssoRequiredForDomain } from '../db/sso.ts'
import { htmlResponse } from '../http/response.ts'
import { log } from '../log.ts'
import { ssoRequiredPage } from '../pages/sso.tsx'

/**
 * Whether an organization requires its single sign-on for this address. It depends on the domain alone, so it says
 * nothing about whether an account exists.
 */
export function ssoRequired(ctx: Context, email: string): Promise<boolean> {
  return ssoRequiredForDomain(ctx.config.db, domainOf(email))
}

/** The page that sends someone with a required single sign-on there instead. */
export function ssoRequiredResponse(ctx: Context, email: string, returnTo: string | null): Response {
  log('sso_required_refused')
  return htmlResponse(ssoRequiredPage(ctx, email, returnTo), { status: 403 })
}
