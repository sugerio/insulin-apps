import type { Bindings } from './env.ts'
import { LIMIT_KEYS } from './limits.ts'
import { callPlatform } from './platform-api.ts'

/**
 * Pulls the limits Insulin Apps' operators set (DESIGN.md §8.8): `GET <SUGER_LIMITS_URL>?since=<cursor>` with the
 * app's token, answering `{ defaults: { key: value }, organizations: [{ id, limits: { key: { value, until } } }],
 * cursor, more }`. Defaults replace what is stored; each organization listed has all its overrides replaced (`{}`
 * clears them). The cursor is saved after each page, so an interrupted tick resumes where it stopped. On anything
 * but 200 (503 not_configured without the platform's key, 404 from an older gateway) what is stored stays, and the
 * catalog's defaults apply only where nothing is stored.
 */
const NAME = 'limits'

const valueOf = (raw: unknown): number | null | undefined => {
  if (raw === null) return null
  if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) return raw
  return undefined
}

const untilOf = (raw: unknown): number | null => {
  if (typeof raw !== 'string') return null
  const parsed = Date.parse(raw)
  return Number.isFinite(parsed) ? parsed : null
}

export async function syncLimits(env: Bindings, now: number, deadline: number): Promise<{ pages: number; organizations: number; status: number | null }> {
  const db = env.DB
  const state = await db.prepare(`SELECT cursor FROM sync_state WHERE name = ?`).bind(NAME).first<{ cursor: string | null }>()
  let cursor = state?.cursor ?? null
  let pages = 0
  let organizations = 0
  let status: number | null = null
  for (; pages < 20 && Date.now() < deadline; ) {
    const response = await callPlatform(env, 'SUGER_LIMITS_URL', { query: cursor ? { since: cursor } : {} })
    if (!response) return { pages, organizations, status: null }
    status = response.status
    if (response.status !== 200) break
    const body = (await response.json().catch(() => null)) as { defaults?: Record<string, unknown>; organizations?: unknown; cursor?: unknown; more?: unknown } | null
    if (!body) break
    pages += 1
    const statements: D1PreparedStatement[] = []
    // The engine keeps daily backups as many days as the organization's backup_days: a change to it is sent again.
    const storedBackupDays = await db.prepare(`SELECT value FROM limit_defaults WHERE key = 'backup_days'`).first<{ value: number | null }>()
    const backupDefault = valueOf((body.defaults ?? {}).backup_days)
    if (backupDefault !== undefined && (storedBackupDays === null || storedBackupDays.value !== backupDefault)) {
      statements.push(db.prepare(`UPDATE collections SET settings_version = -1 WHERE state = 'active'`))
    }
    for (const [key, raw] of Object.entries(body.defaults ?? {})) {
      const value = valueOf(raw)
      if (!LIMIT_KEYS.has(key) || value === undefined) continue
      statements.push(db.prepare(
        `INSERT INTO limit_defaults (key, value, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      ).bind(key, value, now))
    }
    for (const entry of Array.isArray(body.organizations) ? (body.organizations as Record<string, unknown>[]) : []) {
      const org = typeof entry?.id === 'string' && entry.id.length <= 128 ? entry.id : null
      if (!org) continue
      organizations += 1
      statements.push(db.prepare(`DELETE FROM org_limits WHERE org_id = ?`).bind(org))
      statements.push(db.prepare(`UPDATE collections SET settings_version = -1 WHERE org_id = ? AND state = 'active'`).bind(org))
      for (const [key, raw] of Object.entries((entry.limits ?? {}) as Record<string, { value?: unknown; until?: unknown }>)) {
        const value = valueOf(raw?.value)
        if (!LIMIT_KEYS.has(key) || value === undefined) continue
        statements.push(db.prepare(`INSERT INTO org_limits (org_id, key, value, until, updated_at) VALUES (?, ?, ?, ?, ?)`).bind(org, key, value, untilOf(raw?.until), now))
      }
    }
    if (typeof body.cursor === 'string' || typeof body.cursor === 'number') cursor = String(body.cursor)
    statements.push(db.prepare(
      `INSERT INTO sync_state (name, cursor, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT (name) DO UPDATE SET cursor = excluded.cursor, updated_at = excluded.updated_at`,
    ).bind(NAME, cursor, now))
    await db.batch(statements)
    if (body.more !== true) break
  }
  return { pages, organizations, status }
}
