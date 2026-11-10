// Roles (.github/hosting/DESIGN.md §2). A membership holds an organization role, OWNER > ADMIN > EDITOR > VIEWER, or
// APPS: access to specific apps, with a role per app (ADMIN > EDITOR > VIEWER, or a custom role) instead. The rules
// that need the database (the last OWNER, the actor's current role) are enforced in SQL; everything else is here.
import type { HostedApp, Permission } from './config.ts'

export const ROLES = ['OWNER', 'ADMIN', 'EDITOR', 'VIEWER', 'APPS'] as const
export type Role = (typeof ROLES)[number]
/** The roles that apply to the whole organization. */
export type OrgRole = Exclude<Role, 'APPS'>

export const ROLE_LABELS: Record<Role, string> = {
  OWNER: 'Owner',
  ADMIN: 'Admin',
  EDITOR: 'Editor',
  VIEWER: 'Viewer',
  APPS: 'Specific apps',
}

export const ROLE_SUMMARIES: Record<Role, string> = {
  OWNER: 'Everything an admin can do, plus owners, custom roles, single sign-on and deleting the organization. Admin in every app.',
  ADMIN: 'Invites people and manages their access and the apps\' integrations. Admin in every app.',
  EDITOR: 'Uses every app fully, except people, roles and integrations. Sees who is in the organization.',
  VIEWER: 'Read-only in every app (each app decides what that shows). Sees who is in the organization.',
  APPS: 'Only the apps they are given, with a role in each. Doesn\'t see the organization\'s people.',
}

export const APP_ROLES = ['ADMIN', 'EDITOR', 'VIEWER'] as const
export type AppRole = (typeof APP_ROLES)[number]

export const APP_ROLE_LABELS: Record<AppRole, string> = { ADMIN: 'Admin', EDITOR: 'Editor', VIEWER: 'Viewer' }

export const APP_ROLE_SUMMARIES: Record<AppRole, string> = {
  ADMIN: 'Everything in the app, including its people and integrations.',
  EDITOR: 'Uses the app fully, except its people, roles and integrations.',
  VIEWER: 'Read only; the app decides what that shows.',
}

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value)
}

export function isAppRole(value: unknown): value is AppRole {
  return typeof value === 'string' && (APP_ROLES as readonly string[]).includes(value)
}

function rank(role: Role): number {
  return ROLES.indexOf(role)
}

/** Everyone with an organization role sees the organization's people and roles; specific-apps members don't. */
export function canSeeMembers(role: Role): boolean {
  return role !== 'APPS'
}

/** OWNER and ADMIN invite people and manage members and invitations, within `grantableRoles`. */
export function canManageMembers(role: Role): boolean {
  return role === 'OWNER' || role === 'ADMIN'
}

/** Only OWNERs create, change and delete custom roles (anyone who manages members may give them). */
export function canManageCustomRoles(role: Role): boolean {
  return role === 'OWNER'
}

export function canRenameOrg(role: Role): boolean {
  return role === 'OWNER'
}

export function canDeleteOrg(role: Role): boolean {
  return role === 'OWNER'
}

/** Single sign-on and SCIM change how the whole organization signs in: OWNERs only. */
export function canManageSso(role: Role): boolean {
  return role === 'OWNER'
}

/** The roles an actor may give through an invitation or a change: OWNER any, ADMIN anything but OWNER. */
export function grantableRoles(actor: Role): Role[] {
  if (actor === 'OWNER') return [...ROLES]
  if (actor === 'ADMIN') return ROLES.filter((role) => role !== 'OWNER')
  return []
}

/** Whether `actor` may move a member from `current` to `next`. ADMIN can neither grant nor change OWNER. */
export function canChangeRole(actor: Role, current: Role, next: Role): boolean {
  if (actor === 'OWNER') return true
  if (actor === 'ADMIN') return current !== 'OWNER' && next !== 'OWNER'
  return false
}

/** Whether `actor` may remove a member whose role is `target` (leaving is separate: anyone may leave). */
export function canRemoveMember(actor: Role, target: Role): boolean {
  if (actor === 'OWNER') return true
  if (actor === 'ADMIN') return target !== 'OWNER'
  return false
}

/** Whether `actor` may revoke or resend an invitation for `role`: the same reach as granting it. */
export function canHandleInvitation(actor: Role, role: Role): boolean {
  return grantableRoles(actor).includes(role)
}

/** The role an organization role gives in every app (owners are admins there), or null for specific-apps members. */
export function appRoleOf(role: Role): AppRole | null {
  if (role === 'OWNER' || role === 'ADMIN') return 'ADMIN'
  if (role === 'EDITOR' || role === 'VIEWER') return role
  return null
}

/** Sort key for member lists: owners first. */
export function roleOrder(role: Role): number {
  return rank(role)
}

const APP_RANK: Record<AppRole, number> = { ADMIN: 0, EDITOR: 1, VIEWER: 2 }

/** Whether `role` has a permission whose least role is `least` (ADMIN has every permission). */
export function roleHas(role: AppRole, least: AppRole): boolean {
  return APP_RANK[role] <= APP_RANK[least]
}

/** A built-in role's permissions in an app: every permission at or below it. */
export function permissionsOf(app: HostedApp, role: AppRole): string[] {
  return app.permissions.filter((permission) => roleHas(role, permission.role)).map((permission) => permission.key)
}

/** The app's permissions among `keys`, in catalog order; unknown keys (an app dropped one) are left out. */
export function knownPermissions(app: HostedApp, keys: readonly string[]): Permission[] {
  const wanted = new Set(keys)
  return app.permissions.filter((permission) => wanted.has(permission.key))
}

/** The least built-in role that has every permission in `keys`: what a custom role is sent as (DESIGN.md §2.4). */
export function baseRoleFor(app: HostedApp, keys: readonly string[]): AppRole {
  let base: AppRole = 'VIEWER'
  for (const permission of knownPermissions(app, keys)) {
    if (APP_RANK[permission.role] < APP_RANK[base]) base = permission.role
  }
  return base
}
