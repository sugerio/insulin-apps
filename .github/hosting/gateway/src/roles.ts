// Organization roles, with the Insulin console's names and order: OWNER > ADMIN > EDITOR > USER > VIEWER.
// The last-OWNER rule needs the database (orgs.ts enforces it in SQL); everything else is decided here.

export const ROLES = ['OWNER', 'ADMIN', 'EDITOR', 'USER', 'VIEWER'] as const
export type Role = (typeof ROLES)[number]

export const ROLE_LABELS: Record<Role, string> = {
  OWNER: 'Owner',
  ADMIN: 'Admin',
  EDITOR: 'Editor',
  USER: 'User',
  VIEWER: 'Viewer',
}

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value)
}

function rank(role: Role): number {
  return ROLES.indexOf(role)
}

/** EDITOR and above see the member list with e-mail addresses; USER and VIEWER see only the organization and their role. */
export function canSeeMembers(role: Role): boolean {
  return rank(role) <= rank('EDITOR')
}

/** OWNER and ADMIN invite people and manage members and invitations, within `grantableRoles`. */
export function canManageMembers(role: Role): boolean {
  return role === 'OWNER' || role === 'ADMIN'
}

export function canRenameOrg(role: Role): boolean {
  return role === 'OWNER'
}

export function canDeleteOrg(role: Role): boolean {
  return role === 'OWNER'
}

/** The roles an actor may give through an invitation or a role change: OWNER any, ADMIN ADMIN and below. */
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
