// The people of an organization who can use an app (DESIGN.md §8.7): GET https://<apex>/__insulin/members. An app has
// no directory of its own (the gateway tells it who calls, at each request), so an app Worker that lets someone pick
// people of the organization (Esign: whom to share with, who sees what an API client creates) asks here, with its
// SUGER_APP_TOKEN and the organization (`x-suger-organization-id`), over the SUGER_GATEWAY binding. It gets those who
// can use the app, as its People page counts them: owners, admins, editors and viewers of the organization, and the
// specific-apps members given the app (a built-in or custom role). Their id (the `x-suger-user-id` their requests
// carry), name and email; nothing about their roles. Optional `q` keeps those whose name or email contains it.
import type { Context } from '../context.ts'
import { grantAccess, orgAccess } from '../access.ts'
import { isId } from '../crypto.ts'
import { listAppGrants } from '../db/grants.ts'
import { listMembers } from '../db/orgs.ts'
import { jsonResponse } from '../http/response.ts'
import { appForToken } from './proxy.ts'
import { bearerToken } from '../oauth/tokens.ts'
import { allowApp } from '../ratelimit.ts'

/** The most people one answer holds: a larger organization is narrowed with `q`. */
export const MEMBERS_MAX = 500
const QUERY_MAX = 100

function problem(error: string, status: number, headers: Record<string, string> = {}): Response {
  return jsonResponse({ error }, status, headers)
}

export async function appMembers(ctx: Context): Promise<Response> {
  if (ctx.site !== 'apex') return problem('not_found', 404)
  if (ctx.request.method !== 'GET') return problem('method_not_allowed', 405, { Allow: 'GET' })
  const master = ctx.config.secretKey
  if (!master) return problem('not_configured', 503)
  const app = await appForToken(ctx, master, bearerToken(ctx.request))
  if (!app) return problem('unauthorized', 401)
  const orgId = ctx.request.headers.get('x-suger-organization-id')
  if (!isId(orgId)) return problem('invalid_request', 400)
  const q = (ctx.url.searchParams.get('q') ?? '').trim().toLowerCase()
  const limit = Number(ctx.url.searchParams.get('limit') ?? MEMBERS_MAX)
  if (q.length > QUERY_MAX || !Number.isSafeInteger(limit) || limit < 1 || limit > MEMBERS_MAX) return problem('invalid_request', 400)
  if (!(await allowApp(ctx, `members:${app.name}`))) return problem('rate_limited', 429, { 'Retry-After': '60' })
  const org = await ctx.config.db.prepare('SELECT status FROM orgs WHERE id = ?1').bind(orgId).first<{ status: string }>()
  if (!org) return problem('unknown_organization', 404)
  // Nobody acts in an organization the operators suspended or disabled (DESIGN.md §11.3).
  if (org.status !== 'active') return problem('organization_unavailable', 403)
  const [members, grants] = await Promise.all([listMembers(ctx.config.db, orgId), listAppGrants(ctx.config.db, orgId, app.name)])
  const grantOf = new Map(grants.map((grant) => [grant.user_id, grant]))
  const people = members
    .filter((member) => {
      if (member.role !== 'APPS') return orgAccess(app, member.role) !== null
      const grant = grantOf.get(member.user_id)
      return !!grant && grantAccess(app, { role: grant.role, customRoleId: grant.custom_role_id, customRoleName: grant.custom_role_name, customPermissions: null }) !== null
    })
    .filter((member) => !q || member.email.toLowerCase().includes(q) || (member.name ?? '').toLowerCase().includes(q))
    .slice(0, limit)
    .map((member) => ({ id: member.user_id, name: member.name, email: member.email }))
  return jsonResponse({ members: people }, 200, { 'Cache-Control': 'no-store' })
}
