// An account's standing (DESIGN.md §11.3): the operator console suspends or disables accounts that break the rules.
// Every sign-in asks here before it starts a session or a second step; the session insert, the session lookup and
// every token check repeat it in their statements, so a suspension lands at once wherever it races a sign-in.
import type { Context } from '../context.ts'
import type { AccountStatus } from '../db/users.ts'
import { log } from '../log.ts'
import { accountUnavailablePage } from '../pages/status.tsx'

/** The page for an account the operators suspended or disabled, or null for an active one (or none). */
export function unavailable(ctx: Context, account: { id: string; status: AccountStatus } | null): Response | null {
  if (!account || account.status === 'active') return null
  log('login_refused', { user: account.id, status: account.status })
  return accountUnavailablePage(ctx, account.status)
}
