// The apex pages (landing, privacy notice, terms of use: public and indexable) and the auth host's home page.
import type { Context } from './context.ts'
import { listInvitationsFor } from './db/invitations.ts'
import { listMemberships } from './db/orgs.ts'
import { htmlResponse } from './http/response.ts'
import { homePage, landingPage } from './pages/home.ts'
import { privacyPage, termsPage } from './pages/legal.ts'
import { requireSession } from './auth/guard.ts'
import { activeOrg, loadSession } from './auth/session.ts'

export async function landing(ctx: Context): Promise<Response> {
  const session = await loadSession(ctx)
  const signedIn = session?.user.verified ? session : null
  const active = signedIn ? await activeOrg(ctx, signedIn) : null
  return htmlResponse(landingPage(ctx, signedIn, active), { index: true })
}

export function privacy(ctx: Context): Response {
  return htmlResponse(privacyPage(ctx), { index: true })
}

export function terms(ctx: Context): Response {
  return htmlResponse(termsPage(ctx), { index: true })
}

export async function authHome(ctx: Context): Promise<Response> {
  const session = await requireSession(ctx)
  if (session instanceof Response) return session
  const [memberships, invitations, active] = await Promise.all([
    listMemberships(ctx.config.db, session.user.id),
    listInvitationsFor(ctx.config.db, session.user.email, ctx.now),
    activeOrg(ctx, session),
  ])
  return htmlResponse(homePage(ctx, session, memberships, invitations, active))
}
