// Account → AI agents (DESIGN.md §5.2): the MCP clients a person allowed, for which app and organization, and
// disconnecting one (its grant ends, and every token of it stops at once); links to each app's Connect AI page.
import { appAccess } from '../access.ts'
import type { HostedApp } from '../config.ts'
import type { Context } from '../context.ts'
import { deleteUserGrant, listUserGrants } from '../db/oauth.ts'
import { listMemberships } from '../db/orgs.ts'
import { htmlResponse, redirect } from '../http/response.ts'
import { log } from '../log.ts'
import { agentsPage } from '../pages/agents.tsx'
import { notFoundPage } from '../pages/status.tsx'
import { requireSession } from './guard.ts'
import { activeOrg } from './session.ts'

const NOTICES: Record<string, string> = {
  disconnected: 'The agent is disconnected. It can no longer use the app as you.',
}

export async function agentsView(ctx: Context): Promise<Response> {
  const session = await requireSession(ctx)
  if (session instanceof Response) return session
  const [grants, memberships, active] = await Promise.all([
    listUserGrants(ctx.config.db, session.user.id, ctx.now),
    listMemberships(ctx.config.db, session.user.id),
    activeOrg(ctx, session),
  ])
  // The deployed apps the person can use in the active organization: each has a Connect AI page with its setup.
  const apps: HostedApp[] = []
  if (active) {
    for (const app of ctx.config.apps) {
      if (app.service && (await appAccess(ctx.config.db, app, active.id, session.user.id, active.role))) apps.push(app)
    }
  }
  return htmlResponse(agentsPage(ctx, session, grants, NOTICES[ctx.url.searchParams.get('notice') ?? ''] ?? null, { apps, orgName: active?.name ?? null }, memberships))
}

export async function disconnectAgent(ctx: Context, [grantId]: string[]): Promise<Response> {
  const session = await requireSession(ctx)
  if (session instanceof Response) return session
  if (!(await deleteUserGrant(ctx.config.db, grantId!, session.user.id))) return notFoundPage(ctx)
  log('oauth_grant_disconnected', { grant: grantId, user: session.user.id })
  return redirect('/account/agents?notice=disconnected', 303)
}
