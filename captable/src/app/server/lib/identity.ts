import { getCurrentUser, type AppRole } from '@fours/app/server'
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

export async function resolveCurrentIdentity(
  request: Request,
  db: D1Database,
  now: number,
): Promise<AuthContext | null> {
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

  const access = await resolveAccess(db, {
    role: current.role,
    email: current.email,
    organizationId: current.organizationId,
  })
  return {
    user: { id: current.userId, email: current.email, displayName: current.name },
    consoleOrganizationId: current.organizationId,
    consoleRole: current.role as AppRole,
    preview,
    authMethod: 'console',
    fullAccess: current.role === 'OWNER' || current.role === 'ADMIN',
    orgAccess: access.orgAccess,
    portalMatches: access.portalMatches,
  }
}
