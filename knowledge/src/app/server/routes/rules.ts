import { Hono } from 'hono'
import { z } from 'zod'
import { HAS_ROLE_SQL, type CollectionRow } from '../access.ts'
import type { AppEnv } from '../env.ts'
import { ApiError, browserOnly, forbidden, logError, readJson } from '../http.ts'
import { applyHiding } from '../hiding.ts'
import { idempotent } from '../idempotency.ts'
import { can, type Caller } from '../identity.ts'
import { effectiveLimits, formatBytes, inUnit, LIMITS, MONTHLY, periodOf, resetsAt, SECONDS_PER_HOUR, usageOf } from '../limits.ts'
import { MAIL, sendMail } from '../mail.ts'
import { hideKept } from '../kept.ts'
import { bumpOrgSettings, DEFAULT_HIDING, pushSettings, readOrgSettings, validTimeZone } from '../settings.ts'
import { callerOf, engineFor, iso, json, now, type Ctx } from './common.ts'

/**
 * Rules and data, and Health (Admin in Knowledge, `knowledge.rules.manage`; design section 09, J11 and J12). Being an
 * Admin here gives no access to any collection's content: per-collection numbers are shown only for collections the
 * admin has a role in, and the organization as totals.
 */
const hidingSchema = z.object({
  emails: z.boolean(),
  phones: z.boolean(),
  cards: z.boolean(),
  apiKeys: z.boolean(),
  secrets: z.boolean(),
  words: z.array(z.string().trim().min(2).max(100)).max(200),
}).strict()

const writerSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('builtin') }).strict(),
  z.object({
    kind: z.literal('own'),
    integrationKey: z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/, 'use the key of an integration your organization stored on insulinapps.com'),
    url: z.string().url().max(500).refine((value) => value.startsWith('https://'), 'use an https address'),
    model: z.string().trim().min(1).max(200),
  }).strict(),
])

function requireRules(c: Ctx): Caller {
  const caller = callerOf(c)
  if (!can(caller, 'knowledge.rules.manage')) throw forbidden('Only Admins in Knowledge can see Rules and data and Health.')
  return caller
}

/** Collections the caller has a role in (owner, general access, own share). */
async function collectionsWithRole(db: D1Database, caller: Caller): Promise<CollectionRow[]> {
  const { results } = await db.prepare(
      `SELECT c.* FROM collections c WHERE c.org_id = ?1 AND c.state = 'active' AND ${HAS_ROLE_SQL} ORDER BY lower(c.name)`,
  ).bind(caller.organizationId, caller.kind, caller.id).all<CollectionRow>()
  return results
}

/** Usage beside each limit, in the limit's unit. */
async function usageBesideLimits(db: D1Database, org: string, at: number) {
  const limits = await effectiveLimits(db, org, at)
  const usage = await usageOf(db, org, at)
  return LIMITS.map((limit) => {
    const entry = usage[limit.key]
    const used = entry ? Math.round(inUnit(limit.key, entry.used) * 100) / 100 : null
    const value = limits[limit.key]
    return {
      key: limit.key,
      label: limit.label,
      unit: limit.unit,
      limit: value,
      used,
      reserved: entry ? Math.round(inUnit(limit.key, entry.reserved) * 100) / 100 : null,
      percent: used !== null && value ? Math.min(100, Math.round((used / value) * 100)) : null,
      resetsAt: MONTHLY.has(limit.key) ? resetsAt(at) : null,
    }
  })
}

export function rulesRoutes() {
  const app = new Hono<AppEnv>()

  app.get('/rules', async (c) => {
    const caller = requireRules(c)
    const settings = await readOrgSettings(c.env.DB, caller.organizationId)
    return json(c, { timeZone: settings.timeZone, answerWriter: settings.answerWriter, hiding: settings.hiding, supportConfigured: Boolean(c.env.SUPPORT_EMAIL?.trim()) })
  })

  // Changing what is hidden, the time zone or who writes answers. Stricter hiding re-reads existing files in the
  // engine (it counts as learning); every collection hears about it, now or on the next tick. Browser-only.
  app.put('/rules', async (c) => {
    const caller = requireRules(c)
    if (caller.via !== 'browser') throw browserOnly()
    const body = await readJson(c, z.object({ timeZone: z.string().optional(), answerWriter: writerSchema.optional(), hiding: hidingSchema.optional() }).strict())
    if (body.timeZone !== undefined && !validTimeZone(body.timeZone)) throw new ApiError('bad_request', 'Pick a time zone from the list, such as Europe/Berlin.')
    const db = c.env.DB
    const at = now(c)
    const current = await readOrgSettings(db, caller.organizationId)
    const writer = body.answerWriter ?? current.answerWriter
    const hiding = body.hiding ?? current.hiding
    const engineChanged = body.timeZone !== undefined || body.hiding !== undefined
    const saved = db.prepare(
      `INSERT INTO org_settings (org_id, time_zone, answer_writer, integration_key, model_url, model, hiding, version, updated_by, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
       ON CONFLICT (org_id) DO UPDATE SET time_zone = excluded.time_zone, answer_writer = excluded.answer_writer, integration_key = excluded.integration_key,
         model_url = excluded.model_url, model = excluded.model, hiding = excluded.hiding, version = org_settings.version + ?11, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
    ).bind(
      caller.organizationId, body.timeZone ?? current.timeZone, writer.kind,
      writer.kind === 'own' ? writer.integrationKey : null, writer.kind === 'own' ? writer.url : null, writer.kind === 'own' ? writer.model : null,
      JSON.stringify(hiding), Math.max(1, current.version + (engineChanged ? 1 : 0)), caller.id, at, engineChanged ? 1 : 0,
    )
    // The rules and every collection's new settings revision, in one batch.
    await db.batch(engineChanged ? [saved, bumpOrgSettings(db, caller.organizationId)] : [saved])
    const settings = await readOrgSettings(db, caller.organizationId)
    // What Knowledge keeps of corrections and waiting notes is hidden with the new rules too.
    if (body.hiding !== undefined) await hideKept(db, caller.organizationId, settings.hiding)
    if (engineChanged && c.env.ENGINE) {
      const { results } = await db.prepare(`SELECT id, org_id FROM collections WHERE org_id = ? AND state = 'active' AND settings_pushed < settings_revision LIMIT 20`).bind(caller.organizationId).all<Pick<CollectionRow, 'id' | 'org_id'>>()
      for (const collection of results) await pushSettings(c.env, collection, at)
    }
    return json(c, { timeZone: settings.timeZone, answerWriter: settings.answerWriter, hiding: settings.hiding })
  })

  // "Try it": what the rules would hide in a text, with the same detectors the engine applies before learning.
  app.post('/rules/hiding-preview', async (c) => {
    const caller = requireRules(c)
    const body = await readJson(c, z.object({ text: z.string().max(20_000), hiding: hidingSchema.optional() }).strict())
    const rules = body.hiding ?? (await readOrgSettings(c.env.DB, caller.organizationId)).hiding ?? DEFAULT_HIDING
    const result = applyHiding(body.text, rules)
    return json(c, { text: result.text, hidden: result.hidden, found: result.found.map((range) => ({ kind: range.kind, start: range.start, end: range.end })) })
  })

  // "Ask for more": a message to Insulin Apps support (SUGER_SUPPORT_EMAIL) with the organization's usage.
  app.post('/rules/ask-for-more', async (c) => {
    const caller = requireRules(c)
    const body = await readJson(c, z.object({ limit: z.string().max(40).optional(), note: z.string().trim().max(2000).optional() }).strict())
    return idempotent(c, body, false, async () => {
      const support = c.env.SUPPORT_EMAIL?.trim()
      if (!support) throw new ApiError('not_configured', "Insulin Apps support's address isn't set up here, so the request can't be sent. Ask your Insulin Apps operator.")
      const at = now(c)
      const rows = await usageBesideLimits(c.env.DB, caller.organizationId, at)
      const show = (row: (typeof rows)[number], value: number | null) => (value === null ? 'unlimited' : row.unit === 'bytes' ? formatBytes(value) : `${value}`)
      const lines = rows.map((row) => `- ${row.label}${row.key === body.limit ? ' (asked for)' : ''}: ${row.used === null ? '–' : show(row, row.used)} of ${show(row, row.limit)}`).join('\n')
      const sent = await sendMail(c.env, caller.organizationId, { to: support, ...MAIL.askForMore(caller.organizationId, caller.name ?? caller.email ?? caller.id, body.note ?? '', lines) }, 'ask_for_more')
      if (!sent) throw new ApiError('unreachable', "The request couldn't be sent right now. Try again in a minute.")
      return json(c, { sent: true }, 202)
    })
  })

  app.get('/usage', async (c) => {
    const caller = requireRules(c)
    const db = c.env.DB
    const at = now(c)
    const collections = await collectionsWithRole(db, caller)
    const { results: awake } = await db.prepare(`SELECT collection_id, awake_seconds FROM collection_usage WHERE org_id = ? AND period = ?`).bind(caller.organizationId, periodOf(at)).all<{ collection_id: string; awake_seconds: number }>()
    return json(c, {
      period: periodOf(at),
      limits: await usageBesideLimits(db, caller.organizationId, at),
      collections: collections.map((collection) => ({
        id: collection.id,
        name: collection.name,
        awakeHours: Math.round(((awake.find((row) => row.collection_id === collection.id)?.awake_seconds ?? 0) / SECONDS_PER_HOUR) * 100) / 100,
        keepReady: collection.keep_ready !== null,
        keepReadyPaused: collection.keep_ready_paused === 1,
      })),
    })
  })

  // Health: each collection the admin has a role in, in plain words, and the organization's totals only.
  app.get('/health', async (c) => {
    const caller = requireRules(c)
    const db = c.env.DB
    const collections = await collectionsWithRole(db, caller)
    const totals = await db.prepare(
      `SELECT COUNT(*) AS collections, COALESCE(SUM(documents), 0) AS documents, COALESCE(SUM(bytes), 0) AS bytes,
         SUM(CASE WHEN engine_state IN ('ready', 'learning', 'saving', 'waking', 'waking_from_backup', 'going_back', 'repairing') THEN 1 ELSE 0 END) AS awake,
         SUM(CASE WHEN engine_state IN ('learning', 'saving') THEN 1 ELSE 0 END) AS learning,
         SUM(CASE WHEN keep_ready IS NOT NULL THEN 1 ELSE 0 END) AS kept_ready
       FROM collections WHERE org_id = ? AND state = 'active'`,
    ).bind(caller.organizationId).first<Record<string, number>>()
    // Engine events waiting to be recorded (outbox.ts parks one D1 couldn't apply, and its collection's later ones).
    const { results: waiting } = await db.prepare(
      `SELECT collection_id, MIN(parked_at) AS since FROM parked_events WHERE org_id = ? GROUP BY collection_id`,
    ).bind(caller.organizationId).all<{ collection_id: string; since: number }>()
    const waitingSince = new Map(waiting.map((row) => [row.collection_id, row.since]))
    let engine: { reachable: boolean; label: string | null } = { reachable: false, label: null }
    if (c.env.ENGINE) {
      try {
        engine = { reachable: true, label: (await engineFor(c).health()).engine }
      } catch (error) {
        logError('engine_health_failed', error)
      }
    }
    return json(c, {
      engine,
      organization: totals,
      // The organization's totals only: how many collections have changes waiting to be recorded, and since when.
      waiting: { collections: waiting.length, since: iso(waiting.length ? Math.min(...waiting.map((row) => row.since)) : null) },
      backupDays: (await readOrgSettings(db, caller.organizationId)).backupDays,
      collections: collections.map((collection) => ({
        id: collection.id,
        name: collection.name,
        state: collection.engine_state,
        version: collection.version,
        documents: collection.documents,
        lastRestorePointAt: iso(collection.last_restore_point_at),
        lastBackupAt: iso(collection.last_backup_at),
        lastUsedAt: iso(collection.last_used_at),
        waitingSince: iso(waitingSince.get(collection.id) ?? null),
      })),
    })
  })

  return app
}
