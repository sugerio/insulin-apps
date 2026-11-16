import type { CollectionSettings, HidingRules, KeepReady } from '../../../engine/src/contract.ts'
import type { CollectionRow } from './access.ts'
import { EngineClient } from './engine/client.ts'
import type { Bindings } from './env.ts'
import { logError } from './http.ts'

/**
 * An organization's Rules and data (table `org_settings`): its time zone (until insulinapps.com keeps one), who
 * writes answers on the site (the built-in model through the engine, or the organization's own model through its
 * integration on the platform), and what is hidden before anything is learned. Every collection's engine settings
 * are built from these and the collection's own (keep-ready window, minutes awake).
 */
export interface OrgSettings {
  timeZone: string
  answerWriter: { kind: 'builtin' } | { kind: 'own'; integrationKey: string; url: string; model: string }
  hiding: HidingRules
  version: number
}

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

export async function readOrgSettings(db: D1Database, org: string): Promise<OrgSettings> {
  const row = await db.prepare(`SELECT time_zone, answer_writer, integration_key, model_url, model, hiding, version FROM org_settings WHERE org_id = ?`).bind(org).first<SettingsRow>()
  if (!row) return { timeZone: 'UTC', answerWriter: { kind: 'builtin' }, hiding: DEFAULT_HIDING, version: 0 }
  let hiding = DEFAULT_HIDING
  try {
    hiding = { ...DEFAULT_HIDING, ...(JSON.parse(row.hiding) as Partial<HidingRules>) }
  } catch {
    // A row this app wrote is always valid JSON (a CHECK says so); keep the defaults otherwise.
  }
  const answerWriter = row.answer_writer === 'own' && row.integration_key && row.model_url && row.model
    ? { kind: 'own' as const, integrationKey: row.integration_key, url: row.model_url, model: row.model }
    : { kind: 'builtin' as const }
  return { timeZone: row.time_zone, answerWriter, hiding, version: row.version }
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

export function engineSettings(collection: Pick<CollectionRow, 'keep_ready' | 'keep_ready_paused' | 'awake_minutes'>, org: OrgSettings): CollectionSettings {
  return { hiding: org.hiding, keepReady: keepReadyOf(collection, org.timeZone), awakeMinutes: collection.awake_minutes }
}

/** Tells the engine a collection's settings; on success records the organization settings version it now has. */
export async function pushSettings(env: Bindings, collection: CollectionRow, org: OrgSettings, now: number): Promise<boolean> {
  if (!env.ENGINE) return false
  try {
    await new EngineClient(env.ENGINE, collection.org_id).putCollection(collection.id, engineSettings(collection, org))
    await env.DB.prepare(`UPDATE collections SET settings_version = ?3, settings_synced = ?4 WHERE id = ?1 AND org_id = ?2`).bind(collection.id, collection.org_id, org.version, now).run()
    return true
  } catch (error) {
    logError('settings_push_failed', error, { org: collection.org_id })
    return false
  }
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
