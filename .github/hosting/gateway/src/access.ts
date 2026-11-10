// Someone's access to one app in one organization (.github/hosting/DESIGN.md §2): from their organization role, or
// from their grant for that app (a built-in role or a custom role). Every way into an app (a browser session, an MCP
// grant, a service account) ends here, at every request, so a change of role applies at once.
import type { HostedApp } from './config.ts'
import { findAccessRow, type AccessRow, type GrantRole } from './db/grants.ts'
import {
  APP_ROLE_LABELS, appRoleOf, baseRoleFor, isAppRole, knownPermissions, permissionsOf, type AppRole, type Role,
} from './roles.ts'

export interface AppAccess {
  /** What the app is told (x-suger-app-role): for a custom role, the least built-in role covering its permissions. */
  role: AppRole
  /** What the app is told (x-suger-app-permissions); empty for an app without a catalog. */
  permissions: string[]
  /** For people: "Admin", "Editor", "Viewer", or the custom role's name. */
  label: string
  /** Where it comes from: the organization role, or a grant for this app. */
  source: 'org' | 'app'
  /** May manage this app's people and integrations: an OWNER or ADMIN, or a grant of ADMIN. Never a custom role. */
  admin: boolean
  customRole: { id: string; name: string } | null
}

function parseKeys(json: string | null): string[] {
  if (!json) return []
  try {
    const value: unknown = JSON.parse(json)
    return Array.isArray(value) ? value.filter((key): key is string => typeof key === 'string') : []
  } catch {
    return []
  }
}

/** Access from an organization role alone (no lookup needed); null for a specific-apps member. */
export function orgAccess(app: HostedApp, role: Role): AppAccess | null {
  const appRole = appRoleOf(role)
  if (!appRole) return null
  return {
    role: appRole,
    permissions: permissionsOf(app, appRole),
    label: APP_ROLE_LABELS[appRole],
    source: 'org',
    admin: role === 'OWNER' || role === 'ADMIN',
    customRole: null,
  }
}

/** Access from a grant: a built-in role, or a custom role and its permissions. */
export function grantAccess(app: HostedApp, grant: { role: GrantRole; customRoleId: string | null; customRoleName: string | null; customPermissions: string | null }): AppAccess | null {
  if (isAppRole(grant.role)) {
    return { role: grant.role, permissions: permissionsOf(app, grant.role), label: APP_ROLE_LABELS[grant.role], source: 'app', admin: grant.role === 'ADMIN', customRole: null }
  }
  if (grant.role !== 'CUSTOM' || !grant.customRoleId) return null
  const keys = knownPermissions(app, parseKeys(grant.customPermissions)).map((permission) => permission.key)
  return {
    role: baseRoleFor(app, keys),
    permissions: keys,
    label: grant.customRoleName ?? 'Custom role',
    source: 'app',
    admin: false,
    customRole: { id: grant.customRoleId, name: grant.customRoleName ?? 'Custom role' },
  }
}

export function accessFromRow(app: HostedApp, row: AccessRow | null): AppAccess | null {
  if (!row) return null
  if (row.member_role !== 'APPS') return orgAccess(app, row.member_role)
  if (!row.grant_role) return null
  return grantAccess(app, {
    role: row.grant_role,
    customRoleId: row.custom_role_id,
    customRoleName: row.custom_role_name,
    customPermissions: row.custom_permissions,
  })
}

/**
 * The user's access to `app` in `orgId`, or null. `knownRole` is their membership role when the caller has it already
 * (the session's active organization): an organization role then needs no query.
 */
export async function appAccess(db: D1Database, app: HostedApp, orgId: string, userId: string, knownRole?: Role): Promise<AppAccess | null> {
  if (knownRole && knownRole !== 'APPS') return orgAccess(app, knownRole)
  return accessFromRow(app, await findAccessRow(db, orgId, userId, app.name))
}
