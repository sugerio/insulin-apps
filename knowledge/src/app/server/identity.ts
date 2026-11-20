import { getCurrentUser, type AppRole as PlatformRole } from '@fours/app/server'

/**
 * Who calls: the Insulin platform's identity (`getCurrentUser`) and, read here and nowhere else, the headers the
 * hosting gateway adds to it. The organization is the tenant.
 *
 * - `x-suger-app-permissions` (space-separated) can only take permissions away: the result is the role's own set
 *   intersected with the header, unknown keys ignored, so a forged header gains nothing. Without the header (the
 *   Insulin console) the role decides.
 * - `x-suger-access-via`: a person in the browser, an AI assistant acting as its person (`mcp`), an API client
 *   (`api`, a service account of its own), `public`, or `schedule` for the platform's tick. A public or scheduled
 *   request is nobody here; the tick reaches `POST /api/scheduled` only (`isScheduleTick`). Absent (the Insulin
 *   console) means the browser; anything unrecognised counts as an API client, the most limited way in.
 * - `x-suger-org-role` (OWNER, ADMIN, EDITOR, VIEWER, APPS) is the one header that gives powers rather than taking
 *   them away (organization owners see every collection's basic information and delete one), so it is honoured only
 *   when the deploy sets SUGER_TRUST_ORG_ROLE, and only for people: API clients have no organization role.
 */
export const PERMISSIONS = [
  'knowledge.use',
  'knowledge.collections.create',
  'knowledge.collections.edit',
  'knowledge.collections.share',
  'knowledge.collections.export',
  'knowledge.rules.manage',
] as const
export type Permission = (typeof PERMISSIONS)[number]
export type AppRole = 'ADMIN' | 'EDITOR' | 'VIEWER'
export type OrgRole = 'OWNER' | 'ADMIN' | 'EDITOR' | 'VIEWER' | 'APPS'
export type AccessVia = 'browser' | 'mcp' | 'api'

const ORG_ROLES = new Set<OrgRole>(['OWNER', 'ADMIN', 'EDITOR', 'VIEWER', 'APPS'])

/** Each built-in role's permissions (package.json `insulin.permissions`, where `role` is the least role with it). */
export function rolePermissions(role: AppRole): Permission[] {
  if (role === 'ADMIN') return [...PERMISSIONS]
  if (role === 'EDITOR') return PERMISSIONS.filter((permission) => permission !== 'knowledge.rules.manage')
  return ['knowledge.use']
}

/** The Insulin console may still send OWNER (treated as ADMIN) and USER (treated as VIEWER). */
export function appRoleOf(role: PlatformRole | string | null | undefined): AppRole | null {
  if (role === 'OWNER' || role === 'ADMIN') return 'ADMIN'
  if (role === 'EDITOR') return 'EDITOR'
  if (role === 'VIEWER' || role === 'USER') return 'VIEWER'
  return null
}

export interface Caller {
  /** A person's user id, or an API client's service account id. */
  id: string
  /** API clients are principals of their own: they reach a collection only when shared with them by name. */
  kind: 'person' | 'client'
  organizationId: string
  email: string | null
  name: string | null
  appRole: AppRole
  /** The organization role, when the deploy lets the app trust the header; null otherwise. */
  orgRole: OrgRole | null
  permissions: ReadonlySet<Permission>
  via: AccessVia
  /** The local preview's stand-in. */
  preview: boolean
}

/** The stand-in of the local preview, when the app runs without a platform identity: an organization owner. */
const PREVIEW = { userId: 'preview-user', organizationId: 'preview-organization', role: 'ADMIN' as const, email: 'preview@example.test', name: 'Preview owner' }

export const can = (caller: Caller, permission: Permission): boolean => caller.permissions.has(permission)

/** An owner of the organization, as the trusted header says: basic information of every collection, and deleting one. */
export const isOrgOwner = (caller: Caller): boolean => caller.kind === 'person' && caller.orgRole === 'OWNER'

/**
 * The caller, or null: a public or scheduled request, no identity, or an identity the platform contract doesn't
 * recognise. `preview` allows the local preview's stand-in; `trustOrgRole` is SUGER_TRUST_ORG_ROLE.
 */
export function readCaller(request: Request, options: { preview: boolean; trustOrgRole: boolean }): Caller | null {
  const raw = request.headers.get('x-suger-access-via')
  const via = raw?.trim().toLowerCase()
  if (via === 'public' || via === 'schedule') return null
  const user = getCurrentUser(request)
  const current = user ?? (options.preview ? PREVIEW : null)
  if (!current || !current.userId || current.userId.length > 128 || !current.organizationId || current.organizationId.length > 128) return null
  const appRole = appRoleOf(current.role)
  if (!appRole) return null
  const own = rolePermissions(appRole)
  const header = user ? request.headers.get('x-suger-app-permissions') : null
  const listed = header === null ? null : new Set(header.split(/[\s,]+/).filter(Boolean))
  const permissions = new Set(listed === null ? own : own.filter((permission) => listed.has(permission)))
  const accessVia: AccessVia = raw === null || via === 'browser' ? 'browser' : via === 'mcp' ? 'mcp' : 'api'
  const kind = accessVia === 'api' ? 'client' : 'person'
  const orgHeader = request.headers.get('x-suger-org-role')?.trim().toUpperCase() as OrgRole | undefined
  const orgRole = !user ? 'OWNER' : options.trustOrgRole && kind === 'person' && orgHeader && ORG_ROLES.has(orgHeader) ? orgHeader : null
  return {
    id: current.userId,
    kind,
    organizationId: current.organizationId,
    email: current.email?.trim().toLowerCase().slice(0, 254) || null,
    name: current.name?.slice(0, 200) || null,
    appRole,
    orgRole,
    permissions,
    via: accessVia,
    preview: !user,
  }
}

/** The headers that carry a person, an organization, a role or permissions: the tick carries none of them. */
const IDENTITY_HEADERS = [
  'x-suger-user-id', 'x-suger-organization-id', 'x-suger-app-role', 'x-suger-app-permissions', 'x-suger-user-email',
  'x-suger-user-name', 'x-suger-org-role', 'x-suger-member-lookup',
]

/**
 * Whether a request is the platform's five-minute tick (package.json `insulin.scheduled`): `x-suger-access-via`
 * exactly `schedule`, and no identity at all. The gateway removes every incoming `x-suger-*` header, so only its own
 * tick can send one; a member, an API client or an AI assistant never passes, whatever it sends.
 */
export function isScheduleTick(request: Request): boolean {
  if (request.headers.get('x-suger-access-via') !== 'schedule') return false
  return IDENTITY_HEADERS.every((name) => !request.headers.has(name)) && getCurrentUser(request) === null
}
