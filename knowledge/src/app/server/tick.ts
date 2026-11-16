import type { CollectionRow } from './access.ts'
import { EngineCallError, EngineClient } from './engine/client.ts'
import type { Bindings } from './env.ts'
import { logError } from './http.ts'
import { effectiveLimit, expireReservations, formatBytes, inUnit, LIMITS, periodOf, resetsAt, SECONDS_PER_HOUR, supportSentence, usageOf, type LimitKey } from './limits.ts'
import { syncLimits } from './limits-sync.ts'
import { MAIL, sendMail, sendMailToAll } from './mail.ts'
import { syncMembers } from './members.ts'
import { syncOutbox } from './outbox.ts'
import { pushSettings, readOrgSettings } from './settings.ts'
import { reportUsage } from './usage-metrics.ts'

/**
 * The platform's five-minute tick (`POST /api/scheduled`): every organization's due work, each step bounded so the
 * whole fits well inside the tick's 25 seconds, safe to repeat and to overlap with requests (the next tick picks up
 * what one leaves). One step failing never stops the others.
 *
 * 1. Limits from the operator console (limits-sync.ts).
 * 2. Member events: leaving, returning, roles, owners, revoked clients, deleted organizations (members.ts), with a
 *    resync after 410.
 * 3. The engine's outbox: history, counts, usage, finished imports and their mail (outbox.ts).
 * 4. Deletions: collections still being deleted, and deleted organizations' purges, retried until the engine agrees.
 * 5. Settings the engine hasn't heard yet (hiding rules, time zone).
 * 6. Keep-ready paused at 90% of awake hours (and back on a new month); 80% mail to admins once per month and limit.
 * 7. Reservations past their expiry released.
 * 8. The hour's usage report (usage-metrics.ts), whatever happened before.
 */
const BUDGET_MS = 20_000

export async function runTick(env: Bindings, now: number): Promise<Record<string, unknown>> {
  const started = Date.now()
  const deadline = started + BUDGET_MS
  const summary: Record<string, unknown> = {}
  const step = async (name: string, work: () => Promise<unknown>) => {
    if (Date.now() > deadline) {
      summary[name] = 'skipped'
      return
    }
    try {
      summary[name] = await work()
    } catch (error) {
      logError('tick_step_failed', error, { step: name })
      summary[name] = 'failed'
    }
  }
  await step('limits', () => syncLimits(env, now, started + 4_000))
  await step('members', () => syncMembers(env, now, started + 9_000))
  await step('outbox', () => syncOutbox(env, now, started + 14_000))
  await step('deletions', () => retryDeletions(env, now))
  await step('settings', () => pushStaleSettings(env, now))
  await step('limitsWatch', () => watchLimits(env, now))
  await step('reservations', () => expireReservations(env.DB, now))
  summary.usageReport = await reportUsage({ DB: env.DB, SUGER_METRICS_URL: env.SUGER_METRICS_URL, SUGER_APP_TOKEN: env.SUGER_APP_TOKEN, METRICS_FETCH: env.GATEWAY_FETCH }, now)
  return summary
}

/** Collections being deleted and organizations to purge: asked again of the engine until it says they are gone. */
export async function retryDeletions(env: Bindings, now: number): Promise<{ deleted: number; purged: number }> {
  if (!env.ENGINE) return { deleted: 0, purged: 0 }
  const db = env.DB
  let deleted = 0
  let purged = 0
  const { results } = await db.prepare(`SELECT id, org_id FROM collections WHERE state = 'deleting' ORDER BY updated_at LIMIT 25`).all<{ id: string; org_id: string }>()
  for (const row of results) {
    const engine = new EngineClient(env.ENGINE, row.org_id)
    try {
      await engine.deleteCollection(row.id)
      const status = await engine.getCollection(row.id).catch((error) => (error instanceof EngineCallError && error.status === 404 ? null : Promise.reject(error)))
      if (!status || status.state === 'deleted') {
        await db.prepare(`UPDATE collections SET state = 'deleted', engine_state = 'deleted', updated_at = ? WHERE id = ? AND org_id = ? AND state = 'deleting'`).bind(now, row.id, row.org_id).run()
        deleted += 1
      }
    } catch (error) {
      logError('delete_retry_failed', error, { org: row.org_id })
    }
  }
  const { results: purges } = await db.prepare(`SELECT org_id FROM org_purges WHERE done_at IS NULL ORDER BY requested_at LIMIT 10`).all<{ org_id: string }>()
  for (const row of purges) {
    try {
      await new EngineClient(env.ENGINE, row.org_id).purge(row.org_id)
      await db.prepare(`UPDATE org_purges SET done_at = ? WHERE org_id = ?`).bind(now, row.org_id).run()
      purged += 1
    } catch (error) {
      logError('purge_failed', error, { org: row.org_id })
    }
  }
  return { deleted, purged }
}

/** Collections whose engine settings are older than their organization's (a stricter hiding rule, a new time zone). */
async function pushStaleSettings(env: Bindings, now: number): Promise<number> {
  const { results } = await env.DB.prepare(
    `SELECT c.* FROM collections c JOIN org_settings s ON s.org_id = c.org_id WHERE c.state = 'active' AND c.settings_version < s.version ORDER BY c.updated_at LIMIT 25`,
  ).all<CollectionRow>()
  let pushed = 0
  const settings = new Map<string, Awaited<ReturnType<typeof readOrgSettings>>>()
  for (const collection of results) {
    if (!settings.has(collection.org_id)) settings.set(collection.org_id, await readOrgSettings(env.DB, collection.org_id))
    if (await pushSettings(env, collection, settings.get(collection.org_id)!, now)) pushed += 1
  }
  return pushed
}

/** The organization's admins Knowledge knows, with an address: who gets the 80% notice. */
async function adminAddresses(db: D1Database, org: string): Promise<string[]> {
  const { results } = await db.prepare(`SELECT email FROM members WHERE org_id = ? AND principal_type = 'person' AND app_role = 'ADMIN' AND away = 0 AND email IS NOT NULL`).bind(org).all<{ email: string }>()
  return results.map((row) => row.email)
}

/** Claims a notice for (organization, month, key, kind): true the first time only. */
async function claimAlert(db: D1Database, org: string, period: string, key: string, kind: string, now: number): Promise<boolean> {
  const result = await db.prepare(`INSERT INTO limit_alerts (org_id, period, key, kind, sent_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`).bind(org, period, key, kind, now).run()
  return result.meta.changes === 1
}

/**
 * For organizations with collections or use this month: 80% of any limit e-mails the organization's admins once per
 * month and limit; at 90% of awake hours keep-ready pauses (its owner gets mail once a month) and the engine is told;
 * below it (a new month, a raised limit) paused windows start again.
 */
export async function watchLimits(env: Bindings, now: number): Promise<{ alerts: number; paused: number; resumed: number }> {
  const db = env.DB
  const period = periodOf(now)
  const { results: orgs } = await db.prepare(
    `SELECT org_id FROM collections WHERE state = 'active' UNION SELECT org_id FROM usage_counters WHERE period = ? LIMIT 500`,
  ).bind(period).all<{ org_id: string }>()
  let alerts = 0
  let paused = 0
  let resumed = 0
  for (const { org_id: org } of orgs) {
    const usage = await usageOf(db, org, now)
    for (const limit of LIMITS) {
      const entry = usage[limit.key]
      if (!entry) continue
      const value = await effectiveLimit(db, org, limit.key as LimitKey, now)
      if (value === null || value <= 0) continue
      const used = inUnit(limit.key, entry.used)
      if (used < value * 0.8) continue
      if (!(await claimAlert(db, org, limit.key.endsWith('_month') ? period : 'all', limit.key, 'near', now))) continue
      const show = (amount: number) => (limit.unit === 'bytes' ? formatBytes(amount) : Math.round(amount).toLocaleString('en-US'))
      alerts += await sendMailToAll(env, org, await adminAddresses(db, org), MAIL.nearLimit(limit.label, show(used), show(value), supportSentence(env)), 'near_limit')
    }
    const awakeLimit = await effectiveLimit(db, org, 'awake_hours_month', now)
    const awake = (usage.awake_hours_month?.used ?? 0) / SECONDS_PER_HOUR
    const shouldPause = awakeLimit !== null && awake >= awakeLimit * 0.9
    const { results: ready } = await db.prepare(
      `SELECT * FROM collections WHERE org_id = ? AND state = 'active' AND keep_ready IS NOT NULL AND keep_ready_paused = ?`,
    ).bind(org, shouldPause ? 0 : 1).all<CollectionRow>()
    if (!ready.length) continue
    const settings = await readOrgSettings(db, org)
    for (const collection of ready) {
      const updated = { ...collection, keep_ready_paused: shouldPause ? 1 : 0 }
      await db.prepare(`UPDATE collections SET keep_ready_paused = ?, updated_at = ? WHERE id = ? AND org_id = ?`).bind(updated.keep_ready_paused, now, collection.id, org).run()
      await pushSettings(env, updated, settings, now)
      if (shouldPause) {
        paused += 1
        if (await claimAlert(db, org, period, `keep_ready:${collection.id}`, 'paused', now)) {
          const owner = await db.prepare(`SELECT email FROM members WHERE org_id = ? AND principal_type = 'person' AND principal_id = ?`).bind(org, collection.owner_id).first<{ email: string | null }>()
          const resets = new Date(resetsAt(now)).toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' })
          if (owner?.email) await sendMail(env, org, { to: owner.email, ...MAIL.keepReadyPaused(collection.name, Math.floor(awake), awakeLimit ?? 0, resets) }, 'keep_ready_paused')
        }
      } else {
        resumed += 1
      }
    }
  }
  return { alerts, paused, resumed }
}
