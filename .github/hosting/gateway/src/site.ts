// The apex's own pages: `/` (the landing page, public and indexable, or the signed-in home page), the privacy notice
// and the terms of use.
import type { Context } from './context.ts'
import { listUserGrants } from './db/grants.ts'
import { listInvitationGrants, listInvitationsFor } from './db/invitations.ts'
import { listMemberships } from './db/orgs.ts'
import { htmlResponse } from './http/response.ts'
import { homePage, landingPage } from './pages/home.tsx'
import { privacyPage, termsPage } from './pages/legal.tsx'
import { activeOrg, loadSession, type Session } from './auth/session.ts'

/** `/`: the home page for a signed-in, confirmed user; the landing page (indexable) for everyone else. */
export async function landing(ctx: Context): Promise<Response> {
  const session = await loadSession(ctx)
  if (session?.user.verified) return home(ctx, session)
  return htmlResponse(landingPage(ctx), { index: true })
}

export function privacy(ctx: Context): Response {
  return htmlResponse(privacyPage(ctx), { index: true })
}

export function terms(ctx: Context): Response {
  return htmlResponse(termsPage(ctx), { index: true })
}

async function home(ctx: Context, session: Session): Promise<Response> {
  const db = ctx.config.db
  const [memberships, invitations, active] = await Promise.all([
    listMemberships(db, session.user.id),
    listInvitationsFor(db, session.user.email, ctx.now),
    activeOrg(ctx, session),
  ])
  const grants = await listInvitationGrants(db, invitations.map((invitation) => invitation.id))
  // A specific-apps member sees only their apps; an organization role reaches every app.
  const mine = active?.role === 'APPS' ? new Set((await listUserGrants(db, active.id, session.user.id)).map((grant) => grant.app)) : null
  const apps = ctx.config.apps.filter((app) => !mine || mine.has(app.name))
  return htmlResponse(homePage(ctx, session, memberships, invitations, grants, active, apps))
}
