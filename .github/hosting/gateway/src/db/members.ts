// What apps learn about their organizations' people (DESIGN.md §12.3): where each app is used (`app_orgs`), the member
// events the triggers of migration 0012 write with every change, someone's current access for member status, and the
// people and API clients a member lookup may return. Every read is for one app, and only in organizations where it is
// used.
import type { GrantRole } from './grants.ts'
import type { Role } from '../roles.ts'

/** Events are kept this long; a cursor from before the cleanup's last deletion gets 410. */
export const MEMBER_EVENT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000

/** Notes the first request to `app` for an organization; later ones change nothing. */
export async function recordAppUse(db: D1Database, app: string, orgId: string, now: number): Promise<void> {
  await db.prepare(
    `INSERT INTO app_orgs (app, org_id, first_at) SELECT ?1, ?2, ?3 WHERE EXISTS (SELECT 1 FROM orgs WHERE id = ?2)
     ON CONFLICT (app, org_id) DO NOTHING`,
  ).bind(app, orgId, now).run()
}

/** Whether `app` has been used in the organization. */
export async function appUsedIn(db: D1Database, app: string, orgId: string): Promise<boolean> {
  return (await db.prepare('SELECT 1 AS found FROM app_orgs WHERE app = ?1 AND org_id = ?2').bind(app, orgId).first()) !== null
}

/** A stored event, before it is put in one app's terms (members/events.ts). */
export interface MemberEventRow {
  id: number
  app: string
  org_id: string
  type: 'left' | 'returned' | 'role_changed' | 'owners' | 'client_revoked' | 'org_deleted'
  subject: string | null
  payload: string
  at: number
}

export interface MemberEventPage {
  rows: MemberEventRow[]
  /** The newest event id of all apps when the page was read: where a caller that has seen everything continues. */
  latest: number
  /** The highest id the cleanup has deleted. */
  prunedThrough: number
}

/**
 * Up to `limit` + 1 of `app`'s events after `since`, oldest first: those for every app ('*') or this one, in
 * organizations where it is used (an organization's deletion is written only for the apps it used, which then forget
 * it). One batch, so the newest id and the cleanup's mark are read in the same snapshot as the page.
 */
export async function memberEventsAfter(db: D1Database, app: string, since: number, limit: number): Promise<MemberEventPage> {
  const [page, marks] = await db.batch([
    db.prepare(
      `SELECT e.id, e.app, e.org_id, e.type, e.subject, e.payload, e.at FROM member_events e
       WHERE e.id > ?2 AND (e.app = ?1 OR e.app = '*')
         AND (e.type = 'org_deleted' OR EXISTS (SELECT 1 FROM app_orgs a WHERE a.app = ?1 AND a.org_id = e.org_id))
       ORDER BY e.id LIMIT ?3`,
    ).bind(app, since, limit + 1),
    db.prepare(
      `SELECT COALESCE((SELECT MAX(id) FROM member_events), 0) AS latest,
         (SELECT through FROM member_events_pruned WHERE id = 1) AS pruned_through`,
    ),
  ])
  const mark = (marks?.results[0] ?? {}) as { latest?: number; pruned_through?: number }
  const prunedThrough = mark.pruned_through ?? 0
  return { rows: (page?.results ?? []) as MemberEventRow[], latest: Math.max(mark.latest ?? 0, prunedThrough), prunedThrough }
}

/** The cleanup (housekeeping.ts): events past 90 days, oldest first, noting the highest id it deletes. */
export function pruneMemberEventsStatements(db: D1Database, now: number, limit: number): D1PreparedStatement[] {
  const cut = now - MEMBER_EVENT_RETENTION_MS
  return [
    db.prepare(
      `UPDATE member_events_pruned SET through = MAX(through, COALESCE((SELECT MAX(id) FROM (SELECT id FROM member_events WHERE at < ?1 ORDER BY id LIMIT ?2)), 0))
       WHERE id = 1`,
    ).bind(cut, limit),
    db.prepare('DELETE FROM member_events WHERE id IN (SELECT id FROM member_events WHERE at < ?1 ORDER BY id LIMIT ?2)').bind(cut, limit),
  ]
}

/** The organization's owners and since when they have been (their membership's last change of role), longest first. */
export async function orgOwners(db: D1Database, orgId: string): Promise<{ user_id: string; since: number }[]> {
  const { results } = await db.prepare(
    "SELECT user_id, updated_at AS since FROM memberships WHERE org_id = ?1 AND role = 'OWNER' ORDER BY updated_at, user_id",
  ).bind(orgId).all<{ user_id: string; since: number }>()
  return results
}

/** One id asked about in a member status request, as the database has it now. */
export interface MemberStatusRow {
  id: string
  /** Set when the id is an account. */
  user_id: string | null
  member_role: Role | null
  grant_role: GrantRole | null
  custom_role_id: string | null
  custom_role_name: string | null
  custom_permissions: string | null
  /** Set when the id is one of this app's API clients in the organization. */
  client_id: string | null
  client_role: GrantRole | null
  client_custom_role_id: string | null
  client_custom_role_name: string | null
  client_custom_permissions: string | null
  client_revoked_at: number | null
}

/**
 * Each id's account and its access to `app` in the organization, or the app's API client of the organization with that
 * id. Standing isn't looked at: a suspended account or organization still counts (suspension is the gateway's to
 * enforce, not a departure).
 */
export async function memberStatusRows(db: D1Database, app: string, orgId: string, ids: string[]): Promise<MemberStatusRow[]> {
  const { results } = await db.prepare(
    `SELECT j.value AS id, u.id AS user_id, m.role AS member_role, g.role AS grant_role, g.custom_role_id, c.name AS custom_role_name,
       c.permissions AS custom_permissions, s.id AS client_id, s.role AS client_role, s.custom_role_id AS client_custom_role_id,
       sc.name AS client_custom_role_name, sc.permissions AS client_custom_permissions, s.revoked_at AS client_revoked_at
     FROM json_each(?3) j
     LEFT JOIN users u ON u.id = j.value
     LEFT JOIN memberships m ON m.org_id = ?2 AND m.user_id = u.id
     LEFT JOIN app_grants g ON g.org_id = ?2 AND g.user_id = u.id AND g.app = ?1
     LEFT JOIN custom_roles c ON c.id = g.custom_role_id
     LEFT JOIN service_accounts s ON s.id = j.value AND s.org_id = ?2 AND s.app = ?1
     LEFT JOIN custom_roles sc ON sc.id = s.custom_role_id`,
  ).bind(app, orgId, JSON.stringify(ids)).all<MemberStatusRow>()
  return results
}

/** A person a member lookup found: someone who can use the app in the organization now. */
export interface LookupPersonRow {
  id: string
  name: string
  email: string
  member_role: Role
  grant_role: GrantRole | null
  custom_role_id: string | null
  custom_role_name: string | null
  custom_permissions: string | null
}

/** A search box's text as a LIKE pattern (its wildcards escaped). */
function likePattern(query: string): string {
  return `%${query.toLowerCase().replace(/[\\%_]/g, (character) => `\\${character}`)}%`
}

/**
 * Up to `limit` people who can use `app` in the organization now (an organization role, or a grant for this app; an
 * active account) and up to `limit` of the app's live API clients, whose name or address contains `query`.
 */
export async function lookupMembers(db: D1Database, app: string, orgId: string, query: string, limit: number): Promise<{ people: LookupPersonRow[]; clients: { id: string; name: string }[] }> {
  const pattern = likePattern(query)
  const [people, clients] = await db.batch([
    db.prepare(
      `SELECT u.id, u.name, u.email, m.role AS member_role, g.role AS grant_role, g.custom_role_id, c.name AS custom_role_name,
         c.permissions AS custom_permissions
       FROM memberships m
       JOIN users u ON u.id = m.user_id AND u.status = 'active'
       LEFT JOIN app_grants g ON g.org_id = m.org_id AND g.user_id = m.user_id AND g.app = ?1
       LEFT JOIN custom_roles c ON c.id = g.custom_role_id
       WHERE m.org_id = ?2 AND (m.role <> 'APPS' OR g.role IS NOT NULL)
         AND (lower(u.name) LIKE ?3 ESCAPE '\\' OR u.email LIKE ?3 ESCAPE '\\')
       ORDER BY u.name COLLATE NOCASE, u.email LIMIT ?4`,
    ).bind(app, orgId, pattern, limit),
    db.prepare(
      `SELECT s.id, s.name FROM service_accounts s
       WHERE s.org_id = ?2 AND s.app = ?1 AND s.revoked_at IS NULL AND lower(s.name) LIKE ?3 ESCAPE '\\'
       ORDER BY s.name COLLATE NOCASE, s.id LIMIT ?4`,
    ).bind(app, orgId, pattern, limit),
  ])
  return { people: (people?.results ?? []) as LookupPersonRow[], clients: (clients?.results ?? []) as { id: string; name: string }[] }
}
