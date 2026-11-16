import type { Bindings } from './env.ts'
import { log, logError } from './http.ts'
import type { AppRole, Caller, OrgRole } from './identity.ts'
import { appRoleOf } from './identity.ts'
import { MAIL, sendMail } from './mail.ts'
import { callPlatform } from './platform-api.ts'

/**
 * The organization's people and API clients as Knowledge knows them (table `members`), and how sharing follows them
 * when they leave, return or change role (design section 08, DESIGN.md §12.3):
 *
 * - A person or client who leaves loses access at once: their shares go on hold. A person who returns gets their
 *   shares back ("Welcome back"); an API client that was revoked doesn't come back.
 * - When an owner leaves or becomes a Viewer in Knowledge, the longest-standing owner of the organization becomes the
 *   collection's owner ("Ownership moved"); an owner demoted to Viewer keeps Viewer access. A returning former owner
 *   gets their other shares back, not ownership.
 * - A deleted organization's collections are purged in the engine.
 *
 * The platform's member events arrive on the tick; after a gap of more than 90 days (410 cursor_expired) Knowledge
 * resyncs: a fresh cursor first, everyone it holds marked unchecked, then each checked with member status, saving
 * progress as it goes, and only then events again from the saved cursor.
 *
 * Shapes Knowledge reads from the platform (§12.3, as the gateway's src/members/ builds them):
 *   lookup  { members: [{ type: 'person', id, name, email, appRole } | { type: 'client', id, name }] }
 *   status  { org, owners: [{ user, since }], members: [{ id, type, status: member | left | revoked | gone, orgRole?, appRole? }] },
 *           404 org_deleted for an organization that no longer exists (404 unknown_organization isn't that)
 *   events  { events: [{ id, type, org, at, user? | client? | owners?, orgRole?, appRole? }], cursor, more }; `returned`
 *           is also sent the first time someone gains access, and events about ids Knowledge doesn't hold are ignored
 */
export type PrincipalType = 'person' | 'client'

export interface MemberRow {
  org_id: string
  principal_type: PrincipalType
  principal_id: string
  name: string | null
  email: string | null
  app_role: AppRole | null
  org_role: OrgRole | null
  away: number
  owner_since: number | null
  unchecked: number
}

const ORG_ROLES = new Set(['OWNER', 'ADMIN', 'EDITOR', 'VIEWER', 'APPS'])
const orgRoleOf = (value: unknown): OrgRole | null => (typeof value === 'string' && ORG_ROLES.has(value.toUpperCase()) ? (value.toUpperCase() as OrgRole) : null)
const text = (value: unknown, max = 254): string | null => (typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null)
const timeOf = (value: unknown, fallback: number): number => {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return fallback
}

/** Remembers who called (name, address, roles), for mail and the sharing dialog. Writes only when something changed. */
export async function rememberCaller(db: D1Database, caller: Caller, now: number): Promise<void> {
  await db.prepare(
    `INSERT INTO members (org_id, principal_type, principal_id, name, email, app_role, org_role, away, unchecked, seen_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, 0, ?8, ?8)
     ON CONFLICT (org_id, principal_type, principal_id) DO UPDATE SET
       name = COALESCE(excluded.name, members.name), email = COALESCE(excluded.email, members.email), app_role = excluded.app_role,
       org_role = COALESCE(excluded.org_role, members.org_role), seen_at = excluded.seen_at, updated_at = excluded.updated_at
     WHERE members.name IS NOT COALESCE(excluded.name, members.name) OR members.email IS NOT COALESCE(excluded.email, members.email)
       OR members.app_role IS NOT excluded.app_role OR members.org_role IS NOT COALESCE(excluded.org_role, members.org_role)
       OR members.seen_at IS NULL OR members.seen_at < excluded.seen_at - 3600000`,
  ).bind(caller.organizationId, caller.kind, caller.id, caller.name, caller.email, caller.appRole, caller.orgRole, now).run()
}

export async function memberOf(db: D1Database, org: string, type: PrincipalType, id: string): Promise<MemberRow | null> {
  return db.prepare(`SELECT * FROM members WHERE org_id = ? AND principal_type = ? AND principal_id = ?`).bind(org, type, id).first<MemberRow>()
}

async function upsertMember(db: D1Database, org: string, type: PrincipalType, id: string, fields: { name?: string | null; email?: string | null; appRole?: AppRole | null; orgRole?: OrgRole | null }, now: number): Promise<void> {
  await db.prepare(
    `INSERT INTO members (org_id, principal_type, principal_id, name, email, app_role, org_role, away, unchecked, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, 0, ?8)
     ON CONFLICT (org_id, principal_type, principal_id) DO UPDATE SET
       name = COALESCE(excluded.name, members.name), email = COALESCE(excluded.email, members.email),
       app_role = COALESCE(excluded.app_role, members.app_role), org_role = COALESCE(excluded.org_role, members.org_role), updated_at = excluded.updated_at`,
  ).bind(org, type, id, fields.name ?? null, fields.email ?? null, fields.appRole ?? null, fields.orgRole ?? null, now).run()
}

// ------------------------------------------------------------------ the member lookup (sharing dialog)

export interface FoundMember {
  type: PrincipalType
  id: string
  name: string
  email: string | null
  appRole: AppRole | null
}

/**
 * People who can use Knowledge in the caller's organization, and the app's API clients, matching `q`: at most 20, with
 * name, address and role in Knowledge only. The platform decides who matches from the browser request's signed
 * `x-suger-member-lookup` header; the app's token alone reads no one. Null when the platform can't answer.
 */
export async function lookupMembers(env: Bindings, caller: Caller, q: string, lookupHeader: string | null, now: number): Promise<FoundMember[] | null> {
  if (!lookupHeader) return null
  const response = await callPlatform(env, 'SUGER_MEMBERS_URL', { query: { q }, headers: { 'x-suger-member-lookup': lookupHeader } })
  if (!response || response.status !== 200) return null
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>
  const list = (Array.isArray(body.members) ? body.members : Array.isArray(body.results) ? body.results : Array.isArray(body.matches) ? body.matches : []) as Record<string, unknown>[]
  const found: FoundMember[] = []
  for (const entry of list.slice(0, 20)) {
    const id = text(entry.id, 128)
    if (!id) continue
    const type: PrincipalType = entry.type === 'client' ? 'client' : 'person'
    const member: FoundMember = { type, id, name: text(entry.name, 200) ?? text(entry.email) ?? 'Someone', email: type === 'person' ? text(entry.email) : null, appRole: appRoleOf(text(entry.appRole) ?? text(entry.role)) }
    found.push(member)
    await upsertMember(env.DB, caller.organizationId, type, id, { name: member.name, email: member.email, appRole: member.appRole }, now)
  }
  return found
}

// ------------------------------------------------------------------ member status

interface StatusEntry {
  id: string
  type: PrincipalType
  member: boolean
  gone: boolean
  appRole: AppRole | null
  orgRole: OrgRole | null
}

/**
 * Member status for up to 100 people or clients: whether each is still a member who can use Knowledge, and their
 * roles; the organization's owners; `deleted` when the organization no longer exists. Null when it can't be asked.
 */
export async function memberStatus(env: Bindings, org: string, ids: string[]): Promise<{ entries: StatusEntry[]; owners: { id: string; since: number }[] } | 'deleted' | null> {
  const response = await callPlatform(env, 'SUGER_MEMBER_STATUS_URL', { method: 'POST', body: { org, ids: ids.slice(0, 100) } })
  if (!response) return null
  if (response.status === 404) {
    const body = (await response.json().catch(() => ({}))) as { error?: string }
    return body.error === 'org_deleted' ? 'deleted' : null
  }
  if (response.status !== 200) return null
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>
  const list = (Array.isArray(body.members) ? body.members : Array.isArray(body.statuses) ? body.statuses : Array.isArray(body.results) ? body.results : []) as Record<string, unknown>[]
  const entries = list.flatMap((entry): StatusEntry[] => {
    const id = text(entry.id, 128)
    if (!id) return []
    const gone = entry.gone === true || entry.status === 'gone'
    const member = !gone && (entry.status === 'member' || entry.member === true)
    return [{ id, type: entry.type === 'client' ? 'client' : 'person', member, gone, appRole: appRoleOf(text(entry.appRole) ?? text(entry.app_role)), orgRole: orgRoleOf(entry.orgRole ?? entry.org_role) }]
  })
  return { entries, owners: ownersOf(body.owners, Date.now()) }
}

function ownersOf(raw: unknown, now: number): { id: string; since: number }[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((entry) => {
    if (typeof entry === 'string') return [{ id: entry, since: now }]
    const record = entry as Record<string, unknown>
    const id = text(record?.user ?? record?.id ?? record?.userId, 128)
    return id ? [{ id, since: timeOf(record.since ?? record.ownerSince, now) }] : []
  })
}

// ------------------------------------------------------------------ applying what happened

/** The organization's owners, and since when: the longest-standing one takes collections whose owner left. */
export async function applyOwners(db: D1Database, org: string, owners: { id: string; since: number }[], now: number): Promise<void> {
  const statements = [db.prepare(`UPDATE members SET owner_since = NULL, updated_at = ?2 WHERE org_id = ?1 AND owner_since IS NOT NULL`).bind(org, now)]
  for (const owner of owners) {
    statements.push(db.prepare(
      `INSERT INTO members (org_id, principal_type, principal_id, org_role, app_role, owner_since, away, unchecked, updated_at)
       VALUES (?1, 'person', ?2, 'OWNER', 'ADMIN', ?3, 0, 0, ?4)
       ON CONFLICT (org_id, principal_type, principal_id) DO UPDATE SET owner_since = excluded.owner_since, org_role = 'OWNER', updated_at = excluded.updated_at`,
    ).bind(org, owner.id, owner.since, now))
  }
  await db.batch(statements)
}

/** The longest-standing owner of the organization still here, other than `except`. */
async function longestStandingOwner(env: Bindings, org: string, except: string): Promise<string | null> {
  const pick = () => env.DB.prepare(
    `SELECT principal_id FROM members WHERE org_id = ? AND principal_type = 'person' AND owner_since IS NOT NULL AND away = 0 AND principal_id != ?
     ORDER BY owner_since, principal_id LIMIT 1`,
  ).bind(org, except).first<{ principal_id: string }>()
  let row = await pick()
  if (!row) {
    // Nobody known as an owner yet: ask the platform who the owners are.
    const status = await memberStatus(env, org, [except]).catch(() => null)
    if (status && status !== 'deleted' && status.owners.length) {
      await applyOwners(env.DB, org, status.owners, Date.now())
      row = await pick()
    }
  }
  return row?.principal_id ?? null
}

/**
 * Moves every collection a person owns to the organization's longest-standing owner: they left (`left`) or became a
 * Viewer in Knowledge (`viewer`, and they keep Viewer access). The new owner gets "Ownership moved".
 */
async function moveOwnership(env: Bindings, org: string, from: string, why: 'left' | 'viewer', now: number): Promise<number> {
  const db = env.DB
  const { results: owned } = await db.prepare(`SELECT id, name FROM collections WHERE org_id = ? AND owner_id = ? AND state != 'deleted'`).bind(org, from).all<{ id: string; name: string }>()
  if (!owned.length) return 0
  const to = await longestStandingOwner(env, org, from)
  if (!to) {
    log('ownership_not_moved', { org, collections: owned.length })
    return 0
  }
  const previous = await memberOf(db, org, 'person', from)
  const recipient = await memberOf(db, org, 'person', to)
  for (const collection of owned) {
    const statements = [
      db.prepare(`UPDATE collections SET owner_id = ?3, owner_since = ?4, updated_at = ?4 WHERE id = ?1 AND org_id = ?2 AND owner_id = ?5`).bind(collection.id, org, to, now, from),
      db.prepare(`DELETE FROM collection_shares WHERE collection_id = ? AND org_id = ? AND principal_type = 'person' AND principal_id = ?`).bind(collection.id, org, to),
      db.prepare(`INSERT INTO activity (id, org_id, collection_id, collection_name, action, actor_id, at, detail) VALUES (?, ?, ?, ?, 'ownership_moved', NULL, ?, ?)`)
        .bind(crypto.randomUUID(), org, collection.id, collection.name, now, JSON.stringify({ from, to, why })),
    ]
    if (why === 'viewer') {
      statements.push(db.prepare(
        `INSERT INTO collection_shares (collection_id, org_id, principal_type, principal_id, role, status, shared_by, shared_at, updated_at)
         VALUES (?1, ?2, 'person', ?3, 'VIEWER', 'active', ?4, ?5, ?5)
         ON CONFLICT (collection_id, principal_type, principal_id) DO UPDATE SET status = 'active', updated_at = excluded.updated_at`,
      ).bind(collection.id, org, from, to, now))
    }
    await db.batch(statements)
    if (recipient?.email) {
      await sendMail(env, org, { to: recipient.email, ...MAIL.ownershipMoved(previous?.name ?? previous?.email ?? 'Its owner', collection.name, why) }, 'ownership_moved')
    }
  }
  return owned.length
}

/** Someone left the organization or Knowledge (or an API client was revoked): shares on hold, owned collections moved. */
export async function applyLeft(env: Bindings, org: string, type: PrincipalType, id: string, now: number): Promise<void> {
  const db = env.DB
  await db.batch([
    db.prepare(
      `INSERT INTO members (org_id, principal_type, principal_id, away, unchecked, updated_at) VALUES (?1, ?2, ?3, 1, 0, ?4)
       ON CONFLICT (org_id, principal_type, principal_id) DO UPDATE SET away = 1, unchecked = 0, owner_since = NULL, updated_at = excluded.updated_at`,
    ).bind(org, type, id, now),
    db.prepare(`UPDATE collection_shares SET status = 'on_hold', updated_at = ?4 WHERE org_id = ?1 AND principal_type = ?2 AND principal_id = ?3 AND status = 'active'`).bind(org, type, id, now),
  ])
  if (type === 'person') await moveOwnership(env, org, id, 'left', now)
}

/** A person came back: their shares on hold are active again, and they get "Welcome back". */
export async function applyReturned(env: Bindings, org: string, type: PrincipalType, id: string, fields: { appRole?: AppRole | null; orgRole?: OrgRole | null; email?: string | null }, now: number): Promise<number> {
  const db = env.DB
  await upsertMember(db, org, type, id, { appRole: fields.appRole, orgRole: fields.orgRole, email: fields.email }, now)
  const [, restored] = await db.batch([
    db.prepare(`UPDATE members SET away = 0, unchecked = 0, updated_at = ?4 WHERE org_id = ?1 AND principal_type = ?2 AND principal_id = ?3`).bind(org, type, id, now),
    db.prepare(`UPDATE collection_shares SET status = 'active', updated_at = ?4 WHERE org_id = ?1 AND principal_type = ?2 AND principal_id = ?3 AND status = 'on_hold'`).bind(org, type, id, now),
  ])
  const count = restored?.meta.changes ?? 0
  if (type === 'person' && count > 0) {
    const member = await memberOf(db, org, type, id)
    if (member?.email) await sendMail(env, org, { to: member.email, ...MAIL.welcomeBack(count) }, 'welcome_back')
  }
  return count
}

/** New roles: a person who is now a Viewer in Knowledge no longer owns collections (they keep Viewer access). */
export async function applyRoleChanged(env: Bindings, org: string, type: PrincipalType, id: string, appRole: AppRole | null, orgRole: OrgRole | null, now: number): Promise<void> {
  await upsertMember(env.DB, org, type, id, { appRole, orgRole }, now)
  if (type === 'person' && appRole === 'VIEWER') await moveOwnership(env, org, id, 'viewer', now)
}

/** The organization was deleted on insulinapps.com: everything of it in the engine is purged, and its records here go. */
export async function applyOrgDeleted(env: Bindings, org: string, now: number): Promise<void> {
  const db = env.DB
  await db.batch([
    db.prepare(`INSERT INTO org_purges (org_id, requested_at) VALUES (?, ?) ON CONFLICT (org_id) DO NOTHING`).bind(org, now),
    db.prepare(`UPDATE collections SET state = 'deleted', deleted_at = ?2, updated_at = ?2 WHERE org_id = ?1 AND state != 'deleted'`).bind(org, now),
    db.prepare(`DELETE FROM collection_shares WHERE org_id = ?`).bind(org),
    db.prepare(`DELETE FROM members WHERE org_id = ?`).bind(org),
    db.prepare(`DELETE FROM staged_files WHERE org_id = ?`).bind(org),
    db.prepare(`DELETE FROM org_settings WHERE org_id = ?`).bind(org),
    db.prepare(`DELETE FROM fact_checks WHERE org_id = ?`).bind(org),
    db.prepare(`UPDATE reservations SET state = 'released', settled_at = ?2 WHERE org_id = ?1 AND state = 'held'`).bind(org, now),
  ])
}

interface MemberEvent {
  id: string
  type: string
  org: string
  at: number
  principal: { type: PrincipalType; id: string } | null
  appRole: AppRole | null
  orgRole: OrgRole | null
  email: string | null
  owners: { id: string; since: number }[]
}

function readEvent(raw: Record<string, unknown>, now: number): MemberEvent | null {
  const type = text(raw.type, 40)
  const org = text(raw.org ?? raw.organizationId ?? raw.organization, 128)
  if (!type || !org) return null
  // The gateway names a person as `user` and an API client as `client`, both ids.
  const nested = [raw.user, raw.client, raw.member].find((value) => value && typeof value === 'object') as Record<string, unknown> | undefined
  const principalId = text(typeof raw.user === 'string' ? raw.user : typeof raw.client === 'string' ? raw.client : nested?.id, 128)
  const isClient = type === 'client_revoked' || raw.client !== undefined || nested?.type === 'client'
  const roles = (raw.roles ?? {}) as Record<string, unknown>
  return {
    id: text(raw.id, 128) ?? '',
    type,
    org,
    at: timeOf(raw.at, now),
    principal: principalId ? { type: isClient ? 'client' : 'person', id: principalId } : null,
    appRole: appRoleOf(text(raw.appRole ?? raw.app_role ?? roles.app ?? nested?.appRole)),
    orgRole: orgRoleOf(raw.orgRole ?? raw.org_role ?? roles.org ?? nested?.orgRole),
    email: text(nested?.email ?? raw.email),
    owners: ownersOf(raw.owners, now),
  }
}

/** Whether Knowledge holds anything of someone: a row in the members cache, a share or a collection they own. */
async function holds(db: D1Database, org: string, type: PrincipalType, id: string): Promise<boolean> {
  const row = await db.prepare(
    `SELECT EXISTS (SELECT 1 FROM members WHERE org_id = ?1 AND principal_type = ?2 AND principal_id = ?3)
       OR EXISTS (SELECT 1 FROM collection_shares WHERE org_id = ?1 AND principal_type = ?2 AND principal_id = ?3)
       OR (?2 = 'person' AND EXISTS (SELECT 1 FROM collections WHERE org_id = ?1 AND owner_id = ?3)) AS held`,
  ).bind(org, type, id).first<{ held: number }>()
  return Boolean(row?.held)
}

/** Applies one member event (each is safe to apply twice). */
export async function applyMemberEvent(env: Bindings, raw: Record<string, unknown>, now: number): Promise<void> {
  const event = readEvent(raw, now)
  if (!event) return
  const who = event.principal
  switch (event.type) {
    case 'left':
    case 'client_revoked':
      if (who) await applyLeft(env, event.org, who.type, who.id, now)
      break
    case 'returned':
      if (who && (await holds(env.DB, event.org, who.type, who.id))) await applyReturned(env, event.org, who.type, who.id, { appRole: event.appRole, orgRole: event.orgRole, email: event.email }, now)
      break
    case 'role_changed':
      if (who && (await holds(env.DB, event.org, who.type, who.id))) await applyRoleChanged(env, event.org, who.type, who.id, event.appRole, event.orgRole, now)
      break
    case 'owners':
      await applyOwners(env.DB, event.org, event.owners, now)
      break
    case 'org_deleted':
      await applyOrgDeleted(env, event.org, now)
      break
    default:
      break
  }
}

const EVENTS = 'member_events'

async function readSync(db: D1Database, name: string): Promise<{ cursor: string | null; resync_started_at: number | null; progress: string | null } | null> {
  return db.prepare(`SELECT cursor, resync_started_at, progress FROM sync_state WHERE name = ?`).bind(name).first()
}

async function writeSync(db: D1Database, name: string, fields: { cursor: string | null; resyncStartedAt: number | null; progress?: string | null }, now: number): Promise<void> {
  await db.prepare(
    `INSERT INTO sync_state (name, cursor, resync_started_at, progress, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)
     ON CONFLICT (name) DO UPDATE SET cursor = excluded.cursor, resync_started_at = excluded.resync_started_at, progress = excluded.progress, updated_at = excluded.updated_at`,
  ).bind(name, fields.cursor, fields.resyncStartedAt, fields.progress ?? null, now).run()
}

/** A fresh cursor (a call without `since`), or null. */
async function freshCursor(env: Bindings): Promise<string | null> {
  const response = await callPlatform(env, 'SUGER_MEMBER_EVENTS_URL')
  if (!response || response.status !== 200) return null
  const body = (await response.json().catch(() => ({}))) as { cursor?: unknown }
  return typeof body.cursor === 'string' || typeof body.cursor === 'number' ? String(body.cursor) : null
}

/**
 * Pulls member events since the saved cursor and applies them, page after page while `more`, saving the cursor
 * after each page, until `deadline`. The first call takes the current cursor and applies nothing; a 410 starts a resync.
 */
export async function syncMembers(env: Bindings, now: number, deadline: number): Promise<{ applied: number; resync: boolean }> {
  const db = env.DB
  let state = await readSync(db, EVENTS)
  let applied = 0
  if (state?.resync_started_at) {
    const done = await continueResync(env, now, deadline)
    if (!done) return { applied, resync: true }
    state = await readSync(db, EVENTS)
  }
  if (!state?.cursor) {
    const cursor = await freshCursor(env)
    if (cursor !== null) await writeSync(db, EVENTS, { cursor, resyncStartedAt: null }, now)
    return { applied, resync: false }
  }
  let cursor = state.cursor
  for (let page = 0; page < 20 && Date.now() < deadline; page += 1) {
    const response = await callPlatform(env, 'SUGER_MEMBER_EVENTS_URL', { query: { since: cursor } })
    if (!response) break
    if (response.status === 410) {
      await startResync(env, now)
      await continueResync(env, now, deadline)
      return { applied, resync: true }
    }
    if (response.status !== 200) break
    const body = (await response.json().catch(() => ({}))) as { events?: unknown; cursor?: unknown; more?: unknown }
    const events = Array.isArray(body.events) ? (body.events as Record<string, unknown>[]) : []
    for (const event of events) {
      try {
        await applyMemberEvent(env, event, now)
        applied += 1
      } catch (error) {
        logError('member_event_failed', error, { type: String(event.type ?? '') })
        throw error
      }
    }
    if (typeof body.cursor === 'string' || typeof body.cursor === 'number') cursor = String(body.cursor)
    await writeSync(db, EVENTS, { cursor, resyncStartedAt: null }, now)
    if (body.more !== true) break
  }
  return { applied, resync: false }
}

/** After 410: a fresh cursor saved with the mark that a resync is under way, and everyone held marked unchecked. */
export async function startResync(env: Bindings, now: number): Promise<void> {
  const cursor = await freshCursor(env)
  await env.DB.batch([
    env.DB.prepare(`UPDATE members SET unchecked = 1, updated_at = ? WHERE unchecked = 0`).bind(now),
    env.DB.prepare(
      `INSERT INTO sync_state (name, cursor, resync_started_at, progress, updated_at) VALUES (?1, ?2, ?3, NULL, ?3)
       ON CONFLICT (name) DO UPDATE SET cursor = excluded.cursor, resync_started_at = excluded.resync_started_at, progress = NULL, updated_at = excluded.updated_at`,
    ).bind(EVENTS, cursor, now),
  ])
}

/**
 * Checks unchecked members with member status, 100 at a time per organization, saving progress as it goes (each
 * checked row is marked), until none are left (true) or the deadline (false).
 */
export async function continueResync(env: Bindings, now: number, deadline: number): Promise<boolean> {
  const db = env.DB
  for (let round = 0; round < 50 && Date.now() < deadline; round += 1) {
    const first = await db.prepare(`SELECT org_id FROM members WHERE unchecked = 1 ORDER BY org_id LIMIT 1`).first<{ org_id: string }>()
    if (!first) {
      const state = await readSync(db, EVENTS)
      await writeSync(db, EVENTS, { cursor: state?.cursor ?? (await freshCursor(env)), resyncStartedAt: null }, now)
      return true
    }
    const org = first.org_id
    const { results } = await db.prepare(`SELECT * FROM members WHERE org_id = ? AND unchecked = 1 ORDER BY principal_type, principal_id LIMIT 100`).bind(org).all<MemberRow>()
    const status = await memberStatus(env, org, results.map((row) => row.principal_id))
    if (status === null) return false
    if (status === 'deleted') {
      await applyOrgDeleted(env, org, now)
      continue
    }
    if (status.owners.length) await applyOwners(db, org, status.owners, now)
    for (const row of results) {
      const entry = status.entries.find((candidate) => candidate.id === row.principal_id)
      if (!entry || entry.gone || !entry.member) {
        if (!row.away) await applyLeft(env, org, row.principal_type, row.principal_id, now)
      } else {
        if (row.away && row.principal_type === 'person') await applyReturned(env, org, row.principal_type, row.principal_id, { appRole: entry.appRole, orgRole: entry.orgRole }, now)
        if (entry.appRole && entry.appRole !== row.app_role) await applyRoleChanged(env, org, row.principal_type, row.principal_id, entry.appRole, entry.orgRole, now)
      }
      await db.prepare(`UPDATE members SET unchecked = 0 WHERE org_id = ? AND principal_type = ? AND principal_id = ?`).bind(org, row.principal_type, row.principal_id).run()
    }
  }
  return false
}
