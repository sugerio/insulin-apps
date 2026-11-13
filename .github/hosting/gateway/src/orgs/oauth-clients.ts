// /settings/oauth-clients (DESIGN.md §5.4): every OAuth client of the organization, for its owners and admins only: each
// app's clients for API access (service accounts) and everyone's AI agents (MCP grants), with who created each, when,
// and when it was last used. They revoke a client (its access ends at once and it stays listed, marked revoked) or delete
// it. No secret is shown or rotated here: a secret is shown once, on the app's API access page, when it is made or rotated.
import type { Context } from '../context.ts'
import {
  deleteOrgGrant, deleteOrgServiceAccount, listOrgGrantsAsAdmin, listOrgServiceAccountsAsAdmin, revokeOrgGrant, revokeOrgServiceAccount,
} from '../db/oauth.ts'
import type { MembershipRow } from '../db/orgs.ts'
import { htmlResponse } from '../http/response.ts'
import { log } from '../log.ts'
import { oauthClientsPage } from '../pages/oauth-clients.tsx'
import { canManageOAuthClients } from '../roles.ts'
import type { Session } from '../auth/session.ts'
import { actorChanged, backTo, frame, memberOf, notAllowed, settingsOrg, type Problem } from './orgs.ts'

const NOTICES: Record<string, string> = {
  'client-revoked': 'The OAuth client was revoked: it gets no token again. Delete it to take it off the list.',
  'client-deleted': 'The OAuth client was deleted.',
  'agent-revoked': 'The AI agent was revoked: it can\'t act until its person allows it again.',
  'agent-deleted': 'The AI agent was deleted.',
}

export async function oauthClientsSettings(ctx: Context): Promise<Response> {
  const found = await settingsOrg(ctx)
  if (found instanceof Response) return found
  if (!canManageOAuthClients(found.membership.role)) return notAllowed(ctx, found.session)
  return render(ctx, found.session, found.membership)
}

async function render(ctx: Context, session: Session, membership: MembershipRow, problem: Problem | null = null): Promise<Response> {
  const db = ctx.config.db
  const list = { orgId: membership.org_id, actorId: session.user.id }
  const [clients, agents, chrome] = await Promise.all([
    listOrgServiceAccountsAsAdmin(db, list),
    listOrgGrantsAsAdmin(db, { ...list, now: ctx.now }),
    frame(ctx, session, membership),
  ])
  return htmlResponse(oauthClientsPage(ctx, session, {
    orgId: membership.org_id,
    orgName: membership.org_name,
    role: membership.role,
    active: chrome.active,
    clients,
    agents,
    notice: problem ? null : NOTICES[ctx.url.searchParams.get('notice') ?? ''] ?? null,
    error: problem?.error ?? null,
  }, chrome.shell), { status: problem?.status ?? 200 })
}

/** The OWNER or ADMIN acting on `orgId`'s OAuth clients, or the response to send instead. */
async function adminOf(ctx: Context, orgId: string): Promise<{ session: Session; membership: MembershipRow } | Response> {
  const found = await memberOf(ctx, orgId)
  if (found instanceof Response) return found
  return canManageOAuthClients(found.membership.role) ? found : notAllowed(ctx, found.session)
}

type Change = (db: D1Database, target: { id: string; orgId: string; actorId: string; now: number }) => Promise<boolean>

/** One revoke or delete; each re-checks OWNER or ADMIN in its own statement (db/oauth.ts). */
async function change(ctx: Context, [orgId, id]: string[], act: Change, notice: string, event: string): Promise<Response> {
  const found = await adminOf(ctx, orgId!)
  if (found instanceof Response) return found
  const { session, membership } = found
  if (await act(ctx.config.db, { id: id!, orgId: membership.org_id, actorId: session.user.id, now: ctx.now })) {
    log(event, { org: membership.org_id, id, by: session.user.id })
    return backTo(ctx, 'oauth-clients', membership.org_id, notice)
  }
  // Nothing changed: the actor lost the role meanwhile, or the client was already revoked or deleted (or isn't this
  // organization's, which reads the same, so ids reveal nothing).
  return (await actorChanged(ctx, session, membership))
    ?? render(ctx, session, membership, { error: 'That client was already revoked or deleted. The list below is current.', status: 409 })
}

export function revokeOrgApiClient(ctx: Context, params: string[]): Promise<Response> {
  return change(ctx, params, revokeOrgServiceAccount, 'client-revoked', 'oauth_client_revoked')
}

export function deleteOrgApiClient(ctx: Context, params: string[]): Promise<Response> {
  return change(ctx, params, deleteOrgServiceAccount, 'client-deleted', 'oauth_client_deleted')
}

export function revokeOrgAgent(ctx: Context, params: string[]): Promise<Response> {
  return change(ctx, params, revokeOrgGrant, 'agent-revoked', 'oauth_agent_revoked')
}

export function deleteOrgAgent(ctx: Context, params: string[]): Promise<Response> {
  return change(ctx, params, deleteOrgGrant, 'agent-deleted', 'oauth_agent_deleted')
}
