// An app's Connect AI page, on the apex at /apps/<app>/settings/connect-ai (DESIGN.md §5.2; <app>.<domain>/settings/
// connect-ai redirects there): the app's MCP server and how to add it to each AI client, the person's own agents for
// this app in the organization, and, for the organization's owners and admins, everyone's, re-checked in SQL. Everyone
// who can use the app opens it. Disconnecting ends the agent's grant, and so every token of it, at once.
import type { Context } from '../context.ts'
import { appSettingsPath } from '../context.ts'
import { deleteAppGrant, listAppGrantsAsAdmin, listOwnAppGrants } from '../db/oauth.ts'
import { listMemberships } from '../db/orgs.ts'
import { field } from '../http/request.ts'
import { htmlResponse, redirect } from '../http/response.ts'
import { log } from '../log.ts'
import { appMember } from '../orgs/app-users.ts'
import { connectAiPage } from '../pages/connect-ai.tsx'
import { notFoundPage } from '../pages/status.tsx'
import { canManageAppClients } from '../roles.ts'

const NOTICES: Record<string, string> = {
  disconnected: 'The agent is disconnected. It can no longer use the app.',
}

export async function connectAi(ctx: Context): Promise<Response> {
  const app = ctx.app!
  const found = await appMember(ctx, app, null)
  if (found instanceof Response) return found
  const db = ctx.config.db
  const { session, membership } = found
  const orgId = membership.org_id
  const everyone = canManageAppClients(membership.role)
  const [own, all, memberships] = await Promise.all([
    listOwnAppGrants(db, { userId: session.user.id, orgId, app: app.name, now: ctx.now }),
    everyone ? listAppGrantsAsAdmin(db, { orgId, app: app.name, actorId: session.user.id, now: ctx.now }) : Promise.resolve(null),
    listMemberships(db, session.user.id),
  ])
  return htmlResponse(connectAiPage(ctx, session, app, {
    orgId,
    orgName: membership.org_name,
    orgRole: membership.role,
    access: found.access,
    own,
    everyone: all,
    notice: NOTICES[ctx.url.searchParams.get('notice') ?? ''] ?? null,
  }, memberships))
}

/**
 * Disconnect from Connect AI: the person's own agent, or, for an OWNER or ADMIN of the organization, anyone's for this
 * app there (the statement checks both). The organization comes from the form.
 */
export async function disconnectAppAgent(ctx: Context, [grantId]: string[]): Promise<Response> {
  const app = ctx.app!
  const found = await appMember(ctx, app, field(ctx.form, 'org_id') || null)
  if (found instanceof Response) return found
  const orgId = found.membership.org_id
  if (!(await deleteAppGrant(ctx.config.db, { id: grantId!, orgId, app: app.name, actorId: found.session.user.id }))) return notFoundPage(ctx)
  log('oauth_grant_disconnected', { grant: grantId, app: app.name, org: orgId, by: found.session.user.id })
  return redirect(`${appSettingsPath(app, 'connect-ai')}?notice=disconnected`, 303)
}
