// What an app may learn about its organizations' people (DESIGN.md §8.9), with its SUGER_APP_TOKEN over
// SUGER_GATEWAY, and only in organizations where it is used:
//   GET  /__insulin/members?q=        a sharing dialog's search, for the person of the browser request it serves
//   POST /__insulin/members/status    whether the people and API clients it holds can still use it, and the owners
//   GET  /__insulin/member-events     who left, came back or changed since its cursor
// Names and addresses come only from the lookup, for the person the gateway signed the request for.
import { accessFromRow, grantAccess } from '../access.ts'
import type { HostedApp } from '../config.ts'
import type { Context } from '../context.ts'
import { isId } from '../crypto.ts'
import { findAccessRow } from '../db/grants.ts'
import { appUsedIn, lookupMembers, memberEventsAfter, memberStatusRows, orgOwners, type MemberStatusRow } from '../db/members.ts'
import { appCaller, problem, readCursor } from '../http/app-caller.ts'
import { BodyTooLarge, isJsonBody, readText } from '../http/request.ts'
import { jsonResponse } from '../http/response.ts'
import { log } from '../log.ts'
import { allowApp } from '../ratelimit.ts'
import type { AppRole, Role } from '../roles.ts'
import { memberEventFor, type MemberEvent } from './events.ts'
import { MEMBER_LOOKUP_HEADER, verifyMemberLookup } from './lookup-token.ts'

/** At most this many people and API clients in one lookup. */
export const LOOKUP_LIMIT = 20
const QUERY_MAX = 100
/** At most this many ids in one member status request. */
export const STATUS_LIMIT = 100
const STATUS_BODY_LIMIT_BYTES = 16 * 1024
/** Member events in one page. */
export const EVENTS_PER_PAGE = 1000

/**
 * GET /__insulin/members?q=<text>, with the x-suger-member-lookup header of the browser request the app is serving.
 * The organization and the person come from that header, signed for this app; the person must still be able to use
 * the app there. Up to 20 people who can use it (id, name, address, app role) and its live API clients (id, name), whose
 * name (or address) contains the text. Limited per person.
 */
export async function memberLookup(ctx: Context): Promise<Response> {
  // Limited per person below: a sharing dialog searches as people type, and an app has many people.
  const app = await appCaller(ctx, 'GET', 'members', { perApp: false })
  if (app instanceof Response) return app
  const signed = await verifyMemberLookup(ctx.config.secretKey!, app.name, ctx.request.headers.get(MEMBER_LOOKUP_HEADER), ctx.now)
  if ('problem' in signed) {
    log('member_lookup_refused', { app: app.name, reason: signed.problem })
    return problem('invalid_member_lookup', 403)
  }
  const query = (ctx.url.searchParams.get('q') ?? '').trim()
  if (!query || [...query].length > QUERY_MAX) return problem('invalid_request', 400)
  if (!(await allowApp(ctx, `member-lookup:${signed.user}`))) return problem('rate_limited', 429, { 'Retry-After': '60' })
  // The person may have lost access, or the organization been suspended, since the request was signed.
  const row = await findAccessRow(ctx.config.db, signed.org, signed.user, app.name)
  if (!accessFromRow(app, row) || !(await appUsedIn(ctx.config.db, app.name, signed.org))) return problem('no_app_access', 403)
  const found = await lookupMembers(ctx.config.db, app.name, signed.org, query, LOOKUP_LIMIT)
  const people = found.people.flatMap((person) => {
    const access = accessFromRow(app, person)
    return access ? [{ type: 'person' as const, id: person.id, name: person.name, email: person.email, appRole: access.role }] : []
  })
  const clients = found.clients.map((client) => ({ type: 'client' as const, id: client.id, name: client.name }))
  return jsonResponse({ members: [...people, ...clients].slice(0, LOOKUP_LIMIT) }, 200, { 'Cache-Control': 'no-store' })
}

/** An account's or organization's standing (DESIGN.md §11.3). */
type Standing = 'active' | 'suspended' | 'disabled'
const standingOf = (value: string | null): Standing => (value === 'suspended' || value === 'disabled' ? value : 'active')

type Status =
  | { id: string; type: 'person'; status: 'member'; orgRole: Role; appRole: AppRole; permissions?: string[]; standing: Standing }
  | { id: string; type: 'person'; status: 'left' }
  | { id: string; type: 'client'; status: 'member'; appRole: AppRole; permissions?: string[] }
  | { id: string; type: 'client'; status: 'revoked' }
  | { id: string; type: null; status: 'gone' }

/** One id's standing in the app: an account's access now, or one of the app's API clients; `gone` for neither. */
function statusOf(app: HostedApp, row: MemberStatusRow): Status {
  const catalog = app.permissions.length > 0
  if (row.user_id) {
    const access = row.member_role ? accessFromRow(app, { ...row, member_role: row.member_role }) : null
    if (!access || !row.member_role) return { id: row.id, type: 'person', status: 'left' }
    return {
      id: row.id, type: 'person', status: 'member', orgRole: row.member_role, appRole: access.role, ...(catalog ? { permissions: access.permissions } : {}),
      standing: standingOf(row.user_status),
    }
  }
  if (row.client_id && row.client_role) {
    if (row.client_revoked_at !== null) return { id: row.id, type: 'client', status: 'revoked' }
    const access = grantAccess(app, {
      role: row.client_role, customRoleId: row.client_custom_role_id, customRoleName: row.client_custom_role_name, customPermissions: row.client_custom_permissions,
    })
    if (access) return { id: row.id, type: 'client', status: 'member', appRole: access.role, ...(catalog ? { permissions: access.permissions } : {}) }
  }
  return { id: row.id, type: null, status: 'gone' }
}

/**
 * POST /__insulin/members/status `{ "org", "ids" }`: for at most 100 people or API clients the app holds, whether each
 * can still use the app (a suspended account or organization still counts), with its roles and, for a person, the
 * account's standing, or `gone`; the organization's standing; and its owners with since when. 404 `org_deleted` for an
 * organization that no longer exists. No names or addresses: apps resync with it, never search.
 */
export async function memberStatus(ctx: Context): Promise<Response> {
  const app = await appCaller(ctx, 'POST', 'member-status')
  if (app instanceof Response) return app
  if (!isJsonBody(ctx.request)) return problem('invalid_request', 400)
  let body: unknown
  try {
    body = JSON.parse(await readText(ctx.request, STATUS_BODY_LIMIT_BYTES))
  } catch (error) {
    if (error instanceof BodyTooLarge || error instanceof SyntaxError) return problem('invalid_request', 400)
    throw error
  }
  const { org, ids } = (typeof body === 'object' && body !== null && !Array.isArray(body) ? body : {}) as Record<string, unknown>
  if (!isId(org) || !Array.isArray(ids) || ids.length > STATUS_LIMIT || !ids.every(isId)) return problem('invalid_request', 400)
  const exists = await ctx.config.db.prepare('SELECT status FROM orgs WHERE id = ?1').bind(org).first<{ status: string }>()
  if (!exists) return problem('org_deleted', 404)
  if (!(await appUsedIn(ctx.config.db, app.name, org))) return problem('unknown_organization', 404)
  const unique = [...new Set(ids as string[])]
  const [rows, owners] = await Promise.all([
    unique.length ? memberStatusRows(ctx.config.db, app.name, org, unique) : Promise.resolve([]),
    orgOwners(ctx.config.db, org),
  ])
  return jsonResponse({
    org,
    standing: standingOf(exists.status),
    owners: owners.map((owner) => ({ user: owner.user_id, since: new Date(owner.since).toISOString() })),
    members: rows.map((row) => statusOf(app, row)),
  }, 200, { 'Cache-Control': 'no-store' })
}

/**
 * GET /__insulin/member-events?since=<cursor>: up to 1,000 events after the cursor, oldest first, with the cursor to
 * save and whether there are more. Without `since`, the current cursor and no events. A cursor from before the last
 * 90 days' cleanup (or one this gateway never gave) gets 410 `cursor_expired`, and the app resyncs.
 */
export async function memberEvents(ctx: Context): Promise<Response> {
  const app = await appCaller(ctx, 'GET', 'member-events')
  if (app instanceof Response) return app
  const sinceText = ctx.url.searchParams.get('since')
  const headers = { 'Cache-Control': 'no-store' }
  if (sinceText === null) {
    const { latest } = await memberEventsAfter(ctx.config.db, app.name, Number.MAX_SAFE_INTEGER, 0)
    return jsonResponse({ events: [], cursor: String(latest), more: false }, 200, headers)
  }
  const since = readCursor(sinceText)
  if (since === null) return problem('invalid_request', 400)
  const page = await memberEventsAfter(ctx.config.db, app.name, since, EVENTS_PER_PAGE)
  if (since < page.prunedThrough || since > page.latest) {
    log('member_events_cursor_expired', { app: app.name })
    return problem('cursor_expired', 410, headers)
  }
  const more = page.rows.length > EVENTS_PER_PAGE
  const rows = page.rows.slice(0, EVENTS_PER_PAGE)
  const events = rows.map((row) => memberEventFor(app, row)).filter((event): event is MemberEvent => event !== null)
  // A full page continues after its last event; otherwise everything up to the newest event has been seen.
  const cursor = more ? rows[rows.length - 1]!.id : Math.max(since, page.latest)
  return jsonResponse({ events, cursor: String(cursor), more }, 200, headers)
}
