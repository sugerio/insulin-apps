// Member events in one app's terms (DESIGN.md §12.3). The triggers of migration 0012 write each change once, for every
// app ('*') or for one; here a stored event becomes what that app needs: `left` when the person can no longer use it,
// `returned` when they can again (or for the first time), `role_changed` with their app and organization roles, the
// organization's `owners`, `client_revoked` and `org_deleted`. No I/O, so the unit tests import it directly.
import { grantAccess } from '../access.ts'
import type { HostedApp } from '../config.ts'
import type { MemberEventRow } from '../db/members.ts'
import type { GrantRole } from '../db/grants.ts'
import { appRoleOf, isRole, permissionsOf, type AppRole, type Role } from '../roles.ts'

/** What an app reads. Ids are strings; `at` is an ISO time. */
export type MemberEvent =
  | { id: string; type: 'left'; org: string; at: string; user: string }
  | { id: string; type: 'returned' | 'role_changed'; org: string; at: string; user: string; orgRole: Role; appRole: AppRole; permissions?: string[] }
  | { id: string; type: 'owners'; org: string; at: string; owners: { user: string; since: string }[] }
  | { id: string; type: 'client_revoked'; org: string; at: string; client: string }
  | { id: string; type: 'org_deleted'; org: string; at: string }

interface GrantPayload {
  role?: unknown
  permissions?: unknown
}

function iso(ms: number): string {
  return new Date(ms).toISOString()
}

function parse(payload: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(payload)
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** The app role and permissions an organization role gives, as the identity headers would carry them. */
function fromOrgRole(app: HostedApp, role: Role): { appRole: AppRole; permissions: string[] } | null {
  const appRole = appRoleOf(role)
  return appRole ? { appRole, permissions: permissionsOf(app, appRole) } : null
}

/** The app role and permissions a grant (a built-in role, or a custom role's permissions) gives. */
function fromGrant(app: HostedApp, grant: GrantPayload): { appRole: AppRole; permissions: string[] } | null {
  if (typeof grant.role !== 'string') return null
  const permissions = Array.isArray(grant.permissions) ? JSON.stringify(grant.permissions) : null
  const access = grantAccess(app, {
    role: grant.role as GrantRole, customRoleId: grant.role === 'CUSTOM' ? 'custom' : null, customRoleName: null, customPermissions: permissions,
  })
  return access ? { appRole: access.role, permissions: access.permissions } : null
}

/** Permissions travel only for an app with a catalog, as x-suger-app-permissions does. */
function withRoles(app: HostedApp, base: { id: string; type: 'returned' | 'role_changed'; org: string; at: string; user: string }, orgRole: Role, roles: { appRole: AppRole; permissions: string[] }): MemberEvent {
  return { ...base, orgRole, appRole: roles.appRole, ...(app.permissions.length ? { permissions: roles.permissions } : {}) }
}

/** One stored event in `app`'s terms, or null for one that says nothing to it (or is malformed). */
export function memberEventFor(app: HostedApp, row: MemberEventRow): MemberEvent | null {
  const base = { id: String(row.id), org: row.org_id, at: iso(row.at) }
  const payload = parse(row.payload)
  switch (row.type) {
    case 'org_deleted':
      return { ...base, type: 'org_deleted' }
    case 'client_revoked':
      return row.subject ? { ...base, type: 'client_revoked', client: row.subject } : null
    case 'owners': {
      const owners = Array.isArray(payload.owners) ? payload.owners as { user?: unknown; since?: unknown }[] : []
      return {
        ...base,
        type: 'owners',
        owners: owners.filter((owner) => typeof owner.user === 'string' && typeof owner.since === 'number')
          .sort((a, b) => (a.since as number) - (b.since as number) || String(a.user).localeCompare(String(b.user)))
          .map((owner) => ({ user: owner.user as string, since: iso(owner.since as number) })),
      }
    }
    case 'left':
      return row.subject ? { ...base, type: 'left', user: row.subject } : null
    case 'returned':
    case 'role_changed': {
      if (!row.subject) return null
      const person = { ...base, type: row.type, user: row.subject }
      if (row.app !== '*') {
        // A specific-apps member's grant for this app.
        const roles = fromGrant(app, payload)
        return roles ? withRoles(app, person, 'APPS', roles) : null
      }
      const orgRole = payload.orgRole
      if (!isRole(orgRole)) return null
      if (row.type === 'returned') {
        const roles = fromOrgRole(app, orgRole)
        return roles ? withRoles(app, person, orgRole, roles) : null
      }
      if (orgRole === 'APPS') {
        // From an organization role to specific apps: this app is among them, or the person can no longer use it.
        const after = (payload.grantsAfter && typeof payload.grantsAfter === 'object' ? payload.grantsAfter : {}) as Record<string, GrantPayload>
        const grant = Object.hasOwn(after, app.name) ? after[app.name] : undefined
        const roles = grant ? fromGrant(app, grant) : null
        return roles ? withRoles(app, person, 'APPS', roles) : { ...base, type: 'left', user: row.subject }
      }
      const roles = fromOrgRole(app, orgRole)
      if (!roles) return null
      // From specific apps to an organization role: an app they didn't have is one they come back to.
      const before = Array.isArray(payload.grantsBefore) ? payload.grantsBefore : []
      const returned = payload.from === 'APPS' && !before.includes(app.name)
      return withRoles(app, { ...person, type: returned ? 'returned' : 'role_changed' }, orgRole, roles)
    }
    default:
      return null
  }
}
