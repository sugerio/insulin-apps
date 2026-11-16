import { getCurrentUser, type AppRole } from '@fours/app/server'
import { api } from '#shared'
import { readAppEnv } from '#platform'
import { resolveAccess } from './access/resolve.ts'
import type { AuthContext } from '../types.ts'

const PREVIEW = {
  userId: 'preview-user',
  organizationId: 'preview-organization',
  appId: 'preview-app',
  role: 'OWNER' as const,
  email: 'preview@example.test',
  name: 'Preview admin',
}

function storableEmail(value: string | null): string | null {
  const email = value?.trim().toLowerCase() || null
  return email !== null && email.length <= 254 && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ? email : null
}

export interface PlatformGrant {
  /** The effective permissions: the role's own, narrowed by `x-suger-app-permissions` when the platform sends it. */
  permissions: ReadonlySet<api.Permission>
  accessVia: api.AccessVia
}

/**
 * What the hosting platform sends beyond `getCurrentUser`: with `isScheduleTick` below, the only place that reads
 * identity headers directly.
 *
 * `x-suger-app-permissions` (space-separated keys) can only take permissions away: the result is the role's own set
 * intersected with the header, unknown keys ignored. A request that forged the header therefore gains nothing its
 * role didn't already give. `x-suger-access-via` says whether a person in the browser, an AI agent (MCP) or an API
 * client sent the request; the Insulin console sends neither, which means the role's full set, in the browser.
 */
export function readPlatformGrant(request: Request, role: AppRole): PlatformGrant {
  const own = api.rolePermissions(role)
  const header = request.headers.get('x-suger-app-permissions')
  const listed = header === null ? null : new Set(header.split(/[\s,]+/).filter(Boolean))
  const permissions = new Set(listed === null ? own : own.filter((permission) => listed.has(permission)))
  // Absent (the Insulin console) means the browser; a value that isn't one of the three counts as an API client, the
  // most limited channel, so a garbled header never passes for a person in the browser.
  const raw = request.headers.get('x-suger-access-via')
  const via = api.accessViaSchema.safeParse(raw?.trim().toLowerCase())
  return { permissions, accessVia: raw === null ? 'browser' : via.success ? via.data : 'api' }
}

/** The headers that carry a person, an organization, a role or permissions: the platform's tick carries none of them. */
const IDENTITY_HEADERS = [
  'x-suger-user-id', 'x-suger-organization-id', 'x-suger-app-role', 'x-suger-app-permissions', 'x-suger-user-email',
  'x-suger-user-name',
]

const markedSchedule = (request: Request) => request.headers.get('x-suger-access-via')?.trim().toLowerCase() === 'schedule'

/**
 * Whether a request is the platform's five-minute tick (package.json `insulin.scheduled`): `x-suger-access-via` exactly
 * `schedule`, and no identity at all. The gateway removes every incoming `x-suger-*` header, so only its own tick can
 * send one; a member, an API client or an AI agent never passes, whatever it sends. The tick reaches
 * `POST /api/scheduled` only: on every other route a request marked `schedule` is nobody (`resolveCurrentIdentity`).
 */
export function isScheduleTick(request: Request): boolean {
  if (request.headers.get('x-suger-access-via') !== 'schedule') return false
  return IDENTITY_HEADERS.every((name) => !request.headers.has(name)) && getCurrentUser(request) === null
}

export async function resolveCurrentIdentity(
  request: Request,
  db: D1Database,
  now: number,
): Promise<AuthContext | null> {
  // The platform's tick is nobody here, whatever else it carries, and never the preview's stand-in either.
  if (markedSchedule(request)) return null
  const consoleUser = getCurrentUser(request)
  const preview = consoleUser === null
    && import.meta.env.DEV
    && readAppEnv('SUGER_ACCESS_MODE') !== 'console'
  const current = consoleUser ?? (preview ? PREVIEW : null)
  if (!current) return null
  if (current.userId.length < 3 || current.userId.length > 80
    || current.organizationId.length < 1 || current.organizationId.length > 128) return null

  const storedEmail = storableEmail(current.email)
  const displayName = current.name?.slice(0, 200) ?? null
  await db.prepare(
    `INSERT INTO users (id, email, display_name, version, created_at, updated_at)
     VALUES (?, ?, ?, 1, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       display_name = excluded.display_name,
       version = users.version + 1,
       updated_at = excluded.updated_at
     WHERE users.display_name IS NOT excluded.display_name`,
  ).bind(current.userId, storedEmail, displayName, now, now).run()

  const grant = readPlatformGrant(request, current.role)
  const access = await resolveAccess(db, {
    permissions: grant.permissions,
    email: current.email,
    organizationId: current.organizationId,
  })
  return {
    user: { id: current.userId, email: current.email, displayName: current.name },
    consoleOrganizationId: current.organizationId,
    consoleRole: current.role as AppRole,
    permissions: grant.permissions,
    accessVia: grant.accessVia,
    preview,
    authMethod: 'console',
    fullAccess: grant.permissions.has('captable.manage'),
    orgAccess: access.orgAccess,
    portalMatches: access.portalMatches,
  }
}
