// What apps learn about their organizations' people (DESIGN.md §8.9): where each app is used (`app_orgs`), the member
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

/**
 * The cleanup (housekeeping.ts): events past 90 days, oldest first, noting the highest id it deletes, and stale moves.
 * It runs after every change, so it finds events through the index on their time, which ends at once when none is old;
 * ordering by id would read the whole table each time.
 */
export function pruneMemberEventsStatements(db: D1Database, now: number, limit: number): D1PreparedStatement[] {
  const cut = now - MEMBER_EVENT_RETENTION_MS
  return [
    db.prepare(
      `UPDATE member_events_pruned SET through = MAX(through, COALESCE((SELECT MAX(id) FROM (SELECT id FROM member_events WHERE at < ?1 ORDER BY at LIMIT ?2)), 0))
       WHERE id = 1`,
    ).bind(cut, limit),
    db.prepare('DELETE FROM member_events WHERE id IN (SELECT id FROM member_events WHERE at < ?1 ORDER BY at LIMIT ?2)').bind(cut, limit),
    // A move to specific apps is closed by the batch that makes it, so any this transaction sees is stale (one the
    // gateway before migration 0012's code left open, during the release that added it).
    db.prepare('DELETE FROM member_event_moves WHERE rowid IN (SELECT rowid FROM member_event_moves LIMIT ?1)').bind(limit),
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
  /** The account's standing (DESIGN.md §11.3): active, suspended or disabled. */
  user_status: string | null
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
 * Each id's account, its standing and its access to `app` in the organization, or the app's API client of the
 * organization with that id. Standing doesn't decide membership: a suspended account or organization still counts
 * (suspension is the gateway's to enforce, not a departure); it is only reported.
 */
export async function memberStatusRows(db: D1Database, app: string, orgId: string, ids: string[]): Promise<MemberStatusRow[]> {
  const { results } = await db.prepare(
    `SELECT j.value AS id, u.id AS user_id, u.status AS user_status, m.role AS member_role, g.role AS grant_role, g.custom_role_id, c.name AS custom_role_name,
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

/**
 * A search box's text, lower case (String.prototype.toLowerCase), as instr() finds it in a name or address folded the
 * same way (folded): as typed, wildcards and all. Not LIKE: D1 refuses a LIKE pattern over 50 bytes, and the text may be
 * 100 characters.
 */
function searchText(query: string): string {
  return query.toLowerCase()
}

/** The most characters beyond ASCII a search folds (two parameters each, within D1's 100 a statement). */
const FOLDED_CHARACTERS_MAX = 40

/**
 * A stored name or address (`column`), folded for comparing with `text` as toLowerCase folds `text`, in SQL, with the
 * values its parameters take from `first` on. SQLite's lower() folds ASCII only, so for each character of `text` beyond
 * ASCII, replace() turns the capitals that lower to it into it first: "Élodie" then holds "élodie", as "ÉLODIE" does.
 * Only the text's own characters matter, since no other character can match one of them; one-to-one case pairs only
 * (a capital whose lower case is two characters, rare in names, compares as SQLite has it).
 */
function folded(column: string, text: string, first: number): { sql: string; values: string[] } {
  const values: string[] = []
  for (const char of new Set(text)) {
    if (char.codePointAt(0)! < 0x80) continue
    const capital = char.toUpperCase()
    if (capital === char || [...capital].length !== 1 || capital.toLowerCase() !== char) continue
    values.push(capital, char)
    if (values.length / 2 >= FOLDED_CHARACTERS_MAX) break
  }
  let sql = `lower(${column})`
  for (let k = 0; k < values.length; k += 2) sql = `replace(${sql}, ?${first + k}, ?${first + k + 1})`
  return { sql, values }
}

/**
 * Up to `limit` people who can use `app` in the organization now (an organization role, or a grant for this app; an
 * active account) and up to `limit` of the app's live API clients, whose name or address contains `query`, without
 * regard to case. A person whose address is the query itself comes first, so an app checking an address someone typed
 * finds it however many others contain it (Esign: an API client's people); then by name.
 */
export async function lookupMembers(db: D1Database, app: string, orgId: string, query: string, limit: number): Promise<{ people: LookupPersonRow[]; clients: { id: string; name: string }[] }> {
  const text = searchText(query)
  // ?1 to ?4 are the app, the organization, the text and the limit; the folding pairs follow, the same for every column.
  const name = folded('u.name', text, 5), email = folded('u.email', text, 5), client = folded('s.name', text, 5)
  const [people, clients] = await db.batch([
    db.prepare(
      `SELECT u.id, u.name, u.email, m.role AS member_role, g.role AS grant_role, g.custom_role_id, c.name AS custom_role_name,
         c.permissions AS custom_permissions
       FROM memberships m
       JOIN users u ON u.id = m.user_id AND u.status = 'active'
       LEFT JOIN app_grants g ON g.org_id = m.org_id AND g.user_id = m.user_id AND g.app = ?1
       LEFT JOIN custom_roles c ON c.id = g.custom_role_id
       WHERE m.org_id = ?2 AND (m.role <> 'APPS' OR g.role IS NOT NULL)
         AND (instr(${name.sql}, ?3) > 0 OR instr(${email.sql}, ?3) > 0)
       ORDER BY ${email.sql} = ?3 DESC, u.name COLLATE NOCASE, u.email LIMIT ?4`,
    ).bind(app, orgId, text, limit, ...name.values),
    db.prepare(
      `SELECT s.id, s.name FROM service_accounts s
       WHERE s.org_id = ?2 AND s.app = ?1 AND s.revoked_at IS NULL AND instr(${client.sql}, ?3) > 0
       ORDER BY s.name COLLATE NOCASE, s.id LIMIT ?4`,
    ).bind(app, orgId, text, limit, ...client.values),
  ])
  return { people: (people?.results ?? []) as LookupPersonRow[], clients: (clients?.results ?? []) as { id: string; name: string }[] }
}
