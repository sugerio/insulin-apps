import { ApiError, browserOnly, notFound } from './http.ts'
import { can, type Caller, type Permission } from './identity.ts'

/**
 * Who may do what in a collection (design section 08). Three kinds of roles work together:
 *
 * - the role in Knowledge (the platform's app role and permissions, `identity.ts`);
 * - the collection role: Owner, Admin, Editor or Viewer, from being its owner, its general access (everyone in the
 *   organization who can use Knowledge, up to Editor) and a share by name; the highest wins. API clients get a role
 *   only from a share with them by name, never from general access;
 * - the organization role: an organization owner sees every collection's basic information and deletes one at a
 *   time, and gets nothing else without a collection role.
 *
 * Then the Viewer cap: without `knowledge.collections.edit` (a Viewer in Knowledge, or a custom role without it),
 * every collection role acts as Viewer. Each action needs both the collection role and the permission below, checked
 * on the server for every way in; sharing, settings, export, transfer and delete are browser-only.
 */
export type CollectionRole = 'OWNER' | 'ADMIN' | 'EDITOR' | 'VIEWER'
export const ROLE_RANK: Record<CollectionRole, number> = { VIEWER: 1, EDITOR: 2, ADMIN: 3, OWNER: 4 }

export type Action = 'read' | 'report' | 'change' | 'remove' | 'share' | 'settings' | 'export' | 'transfer' | 'delete'

export const ACTIONS: Record<Action, { role: CollectionRole; permission: Permission; browserOnly: boolean; what: string }> = {
  read: { role: 'VIEWER', permission: 'knowledge.use', browserOnly: false, what: 'ask it or read it' },
  report: { role: 'VIEWER', permission: 'knowledge.use', browserOnly: false, what: 'report an answer' },
  change: { role: 'EDITOR', permission: 'knowledge.collections.edit', browserOnly: false, what: 'change what is in it' },
  remove: { role: 'ADMIN', permission: 'knowledge.collections.share', browserOnly: false, what: 'remove a file for good' },
  share: { role: 'ADMIN', permission: 'knowledge.collections.share', browserOnly: true, what: 'share it' },
  settings: { role: 'ADMIN', permission: 'knowledge.collections.share', browserOnly: true, what: 'change its settings' },
  export: { role: 'ADMIN', permission: 'knowledge.collections.export', browserOnly: true, what: 'export it' },
  transfer: { role: 'OWNER', permission: 'knowledge.collections.share', browserOnly: true, what: 'transfer it' },
  delete: { role: 'OWNER', permission: 'knowledge.use', browserOnly: true, what: 'delete it' },
}

export interface CollectionRow {
  id: string
  org_id: string
  owner_id: string
  owner_since: number
  name: string
  purpose: string
  created_at: number
  created_by: string
  last_used_at: number | null
  documents: number
  active_documents: number
  bytes: number
  facts: number
  version: number
  general_role: 'VIEWER' | 'EDITOR' | null
  assistants: number
  keep_ready: string | null
  keep_ready_paused: number
  awake_minutes: number
  state: 'active' | 'deleting' | 'deleted'
  engine_state: string
  last_restore_point_at: number | null
  last_backup_at: number | null
  settings_version: number
  updated_at: number
}

const ROLE_NAMES: Record<CollectionRole, string> = { OWNER: 'Owner', ADMIN: 'Admin', EDITOR: 'Editor', VIEWER: 'Viewer' }

export const highest = (roles: (CollectionRole | null | undefined)[]): CollectionRole | null =>
  roles.reduce<CollectionRole | null>((best, role) => (role && (!best || ROLE_RANK[role] > ROLE_RANK[best]) ? role : best), null)

/** A collection of the caller's organization that isn't deleted; another organization's ids are simply not found. */
export async function loadCollection(db: D1Database, org: string, id: string): Promise<CollectionRow | null> {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return null
  return db.prepare(`SELECT * FROM collections WHERE id = ? AND org_id = ? AND state != 'deleted'`).bind(id, org).first<CollectionRow>()
}

/**
 * The caller's role in a collection: `granted` is the highest of owner, general access and their own active share
 * (an API client: its own share only); `role` is that after the Viewer cap.
 */
export async function roleIn(db: D1Database, caller: Caller, collection: CollectionRow): Promise<{ granted: CollectionRole | null; role: CollectionRole | null }> {
  const share = await db.prepare(
    `SELECT role FROM collection_shares WHERE collection_id = ? AND org_id = ? AND principal_type = ? AND principal_id = ? AND status = 'active'`,
  ).bind(collection.id, collection.org_id, caller.kind, caller.id).first<{ role: CollectionRole }>()
  const granted = caller.kind === 'client'
    ? share?.role ?? null
    : highest([collection.owner_id === caller.id ? 'OWNER' : null, collection.general_role, share?.role])
  return { granted, role: capped(caller, granted) }
}

/** The Viewer cap: without permission to change content, any collection role acts as Viewer. */
export function capped(caller: Caller, role: CollectionRole | null): CollectionRole | null {
  if (!role) return null
  return can(caller, 'knowledge.collections.edit') ? role : 'VIEWER'
}

/** The SQL condition (on collections `c`) for collections where the caller has any role: ?1 org, ?2 type, ?3 id. */
export const HAS_ROLE_SQL = `(
  (?2 = 'person' AND (c.owner_id = ?3 OR c.general_role IS NOT NULL))
  OR EXISTS (SELECT 1 FROM collection_shares s WHERE s.collection_id = c.id AND s.org_id = ?1 AND s.principal_type = ?2 AND s.principal_id = ?3 AND s.status = 'active')
)`

/**
 * Loads a collection and checks the caller may do `action` in it, or throws: 404 for an id that isn't the
 * organization's, 403 browser_only off the site for browser-only actions, 409 while it is being deleted, 403
 * assistants_off when AI assistants and API clients are switched off, and 403 for a role or permission that falls short.
 */
export async function authorize(db: D1Database, caller: Caller, id: string, action: Action): Promise<{ collection: CollectionRow; role: CollectionRole }> {
  const rule = ACTIONS[action]
  if (rule.browserOnly && caller.via !== 'browser') throw browserOnly()
  const collection = await loadCollection(db, caller.organizationId, id)
  if (!collection) throw notFound("There's no such collection. It may have been deleted, or the link is wrong.")
  if (collection.state === 'deleting') throw new ApiError('deleting', `${quoted(collection.name)} is being deleted.`)
  const { role } = await roleIn(db, caller, collection)
  if (!role) {
    const owner = await ownerName(db, collection)
    throw new ApiError('forbidden', `You don't have access to ${quoted(collection.name)}. Ask ${owner ?? 'its owner'}${owner ? ', its owner,' : ''} to share it with you.`)
  }
  if (caller.via !== 'browser' && !collection.assistants) {
    throw new ApiError('assistants_off', `AI assistants and API clients are turned off for ${quoted(collection.name)}. Its owner or an admin can turn them on in its Sharing.`)
  }
  if (ROLE_RANK[role] < ROLE_RANK[rule.role]) {
    throw new ApiError('forbidden', `Your role in ${quoted(collection.name)} is ${ROLE_NAMES[role]}, which can't ${rule.what}.${role === 'VIEWER' && !can(caller, 'knowledge.collections.edit') ? ' Your role in Knowledge can only read.' : ''}`, { role })
  }
  if (!can(caller, rule.permission)) {
    throw new ApiError('forbidden', `Your role in Knowledge doesn't allow you to ${rule.what}.`, { role })
  }
  return { collection, role }
}

/** The owner's name, as Knowledge knows it. */
export async function ownerName(db: D1Database, collection: Pick<CollectionRow, 'org_id' | 'owner_id'>): Promise<string | null> {
  const row = await db.prepare(`SELECT name, email FROM members WHERE org_id = ? AND principal_type = 'person' AND principal_id = ?`).bind(collection.org_id, collection.owner_id).first<{ name: string | null; email: string | null }>()
  return row?.name ?? row?.email ?? null
}

export const quoted = (name: string) => `“${name}”`
