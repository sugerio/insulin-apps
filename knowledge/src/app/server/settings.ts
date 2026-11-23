import type { CollectionSettings, HidingRules, KeepReady } from '../../../engine/src/contract.ts'
import type { CollectionRow } from './access.ts'
import { EngineCallError, EngineClient } from './engine/client.ts'
import type { Bindings } from './env.ts'
import { logError } from './http.ts'
import { effectiveLimit } from './limits.ts'

/**
 * An organization's Rules and data (table `org_settings`): its time zone (until insulin-apps.com keeps one), who
 * writes answers on the site (the built-in model through the engine, or the organization's own model through its
 * integration on the platform), and what is hidden before anything is learned. Every collection's engine settings
 * are built from these and the collection's own (keep-ready window, minutes awake).
 */
export interface OrgSettings {
  timeZone: string
  answerWriter: { kind: 'builtin' } | { kind: 'own'; integrationKey: string; url: string; model: string }
  hiding: HidingRules
  /** Days of daily backups the engine keeps: the organization's backup_days limit. */
  backupDays: number
  version: number
}

/** "Unlimited" days of daily backups, as a number the engine can keep to: the most it takes. */
const UNLIMITED_BACKUP_DAYS = 3650

/** Days of backups the engine takes: 1 to 3650, whatever the limit says (0 keeps one day; unlimited keeps ten years). */
export const backupDaysFor = (limit: number | null) => (limit === null ? UNLIMITED_BACKUP_DAYS : Math.min(UNLIMITED_BACKUP_DAYS, Math.max(1, Math.round(limit))))

export const DEFAULT_HIDING: HidingRules = { emails: true, phones: true, cards: true, apiKeys: true, secrets: true, words: [] }

interface SettingsRow {
  time_zone: string
  answer_writer: 'builtin' | 'own'
  integration_key: string | null
  model_url: string | null
  model: string | null
  hiding: string
  version: number
}

export async function readOrgSettings(db: D1Database, org: string, now = Date.now()): Promise<OrgSettings> {
  const backupDays = backupDaysFor(await effectiveLimit(db, org, 'backup_days', now))
  const row = await db.prepare(`SELECT time_zone, answer_writer, integration_key, model_url, model, hiding, version FROM org_settings WHERE org_id = ?`).bind(org).first<SettingsRow>()
  if (!row) return { timeZone: 'UTC', answerWriter: { kind: 'builtin' }, hiding: DEFAULT_HIDING, backupDays, version: 0 }
  let hiding = DEFAULT_HIDING
  try {
    hiding = { ...DEFAULT_HIDING, ...(JSON.parse(row.hiding) as Partial<HidingRules>) }
  } catch {
    // A row this app wrote is always valid JSON (a CHECK says so); keep the defaults otherwise.
  }
  const answerWriter = row.answer_writer === 'own' && row.integration_key && row.model_url && row.model
    ? { kind: 'own' as const, integrationKey: row.integration_key, url: row.model_url, model: row.model }
    : { kind: 'builtin' as const }
  return { timeZone: row.time_zone, answerWriter, hiding, backupDays, version: row.version }
}

export function keepReadyOf(collection: Pick<CollectionRow, 'keep_ready' | 'keep_ready_paused'>, timeZone: string): KeepReady | null {
  if (!collection.keep_ready) return null
  try {
    const window = JSON.parse(collection.keep_ready) as { days: number[]; start: string; hours: number }
    return { timeZone, days: window.days, start: window.start, hours: window.hours, paused: collection.keep_ready_paused === 1 }
  } catch {
    return null
  }
}

export function engineSettings(collection: Pick<CollectionRow, 'keep_ready' | 'keep_ready_paused' | 'awake_minutes' | 'settings_revision'>, org: OrgSettings): CollectionSettings {
  return { hiding: org.hiding, keepReady: keepReadyOf(collection, org.timeZone), awakeMinutes: collection.awake_minutes, backupDays: org.backupDays, revision: collection.settings_revision }
}

/** Every active collection of an organization has new engine settings (its rules or limits changed): one statement. */
export function bumpOrgSettings(db: D1Database, org: string): D1PreparedStatement {
  return db.prepare(`UPDATE collections SET settings_revision = settings_revision + 1 WHERE org_id = ? AND state = 'active'`).bind(org)
}

/**
 * Tells the engine a collection's settings at their current revision, and records the revision it took. The
 * revision is read with the collection's own settings and the organization's are read after, so what is sent is never
 * older than the revision it carries; the engine refuses a revision older than it has (409 stale_settings: a newer
 * push won, nothing to do). On failure the revision stays behind and the tick sends them again, the collections tried
 * longest ago first.
 */
export async function pushSettings(env: Bindings, collection: Pick<CollectionRow, 'id' | 'org_id'>, now: number): Promise<boolean> {
  if (!env.ENGINE) return false
  const db = env.DB
  const row = await db.prepare(`SELECT * FROM collections WHERE id = ? AND org_id = ? AND state = 'active'`).bind(collection.id, collection.org_id).first<CollectionRow>()
  if (!row) return false
  const settings = engineSettings(row, await readOrgSettings(db, row.org_id, now))
  try {
    await new EngineClient(env.ENGINE, row.org_id, env.DEADLINE).putCollection(row.id, settings)
  } catch (error) {
    const newer = error instanceof EngineCallError && error.code === 'stale_settings'
    if (!newer) logError('settings_push_failed', error, { org: row.org_id })
    await db.prepare(`UPDATE collections SET settings_tried_at = ?3 WHERE id = ?1 AND org_id = ?2`).bind(row.id, row.org_id, now).run()
    return newer
  }
  await markPushed(db, row, settings.revision, now)
  return true
}

/** The engine took a collection's settings at `revision`. */
export async function markPushed(db: D1Database, collection: Pick<CollectionRow, 'id' | 'org_id'>, revision: number, now: number): Promise<void> {
  await db.prepare(`UPDATE collections SET settings_pushed = MAX(settings_pushed, ?3), settings_synced = ?4, settings_tried_at = ?4 WHERE id = ?1 AND org_id = ?2`)
    .bind(collection.id, collection.org_id, revision, now).run()
}

/** Whether a time zone is one the runtime knows (IANA names, such as Europe/Berlin). */
export function validTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone })
    return zone.length <= 64
  } catch {
    return false
  }
}
