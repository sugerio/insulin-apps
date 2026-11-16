import { loadCollection, type CollectionRow } from './access.ts'
import { EngineCallError, EngineClient } from './engine/client.ts'
import type { Bindings } from './env.ts'
import { eraseCollection } from './erase.ts'
import { ApiError, logError } from './http.ts'
import { ensureAwakeBlock, expireReservations, formatBytes, inUnit, LIMITS, MONTHLY, periodOf, release, reservationsOf, reserve, resetsAt, SECONDS_PER_HOUR, supportSentence, type LimitKey } from './limits.ts'
import { syncLimits } from './limits-sync.ts'
import { appLink, MAIL, sendMail, sendMailToAll } from './mail.ts'
import { syncMembers } from './members.ts'
import { finishImport, syncOutbox } from './outbox.ts'
import { failWaiting, keptUntil, submitImport, waitForNextMonth, type ImportKind, type WaitingRequest } from './routes/sources.ts'
import { pushSettings, readOrgSettings } from './settings.ts'
import { reportUsage } from './usage-metrics.ts'

/**
 * The platform's five-minute tick (`POST /api/scheduled`): every organization's due work, safe to repeat and to
 * overlap with requests (the next tick picks up what one leaves). Every step checks the deadline inside its loops and
 * leaves the rest for the next tick, so the whole fits well inside the tick's 25 seconds. One step failing never
 * stops the others.
 *
 * 1. The hour's usage report (usage-metrics.ts), first, so nothing else can crowd it out.
 * 2. Limits from the operator console (limits-sync.ts).
 * 3. Member events: leaving, returning, roles, owners, revoked clients, deleted organizations (members.ts), with a
 *    resync after 410 and on the first tick.
 * 4. The engine's outbox: history, counts, usage, finished imports and their mail (outbox.ts).
 * 5. Imports waiting for next month's documents learned (started on the 1st), and imports whose start the engine
 *    never confirmed (asked again).
 * 6. Deletions: collections still being deleted, and deleted organizations' purges, retried until the engine agrees.
 * 7. Settings the engine hasn't heard yet (hiding rules, time zone, days of backups, a push that failed).
 * 8. Limits watched, organizations in turn: 80% mail to admins; keep-ready paused at 90% of awake hours.
 * 9. Reservations past their expiry released, and old rows pruned.
 */
const BUDGET_MS = 20_000
const DAY_MS = 24 * 60 * 60 * 1000

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
  summary.usageReport = await reportUsage({ DB: env.DB, SUGER_METRICS_URL: env.SUGER_METRICS_URL, SUGER_APP_TOKEN: env.SUGER_APP_TOKEN, METRICS_FETCH: env.GATEWAY_FETCH }, now)
  await step('limits', () => syncLimits(env, now, Math.min(deadline, Date.now() + 4_000)))
  await step('members', () => syncMembers(env, now, Math.min(deadline, Date.now() + 5_000)))
  await step('outbox', () => syncOutbox(env, now, Math.min(deadline, Date.now() + 5_000)))
  await step('waitingImports', () => startWaitingImports(env, now, deadline))
  await step('staleImports', () => askAboutStaleImports(env, now, deadline))
  await step('deletions', () => retryDeletions(env, now, deadline))
  await step('settings', () => pushStaleSettings(env, now, deadline))
  await step('limitsWatch', () => watchLimits(env, now, { deadline }))
  await step('reservations', () => expireReservations(env.DB, now))
  await step('prune', () => prune(env.DB, now))
  return summary
}

/** Collections being deleted and organizations to purge: asked again of the engine until it says they are gone. */
export async function retryDeletions(env: Bindings, now: number, deadline = Date.now() + 5_000): Promise<{ deleted: number; purged: number }> {
  if (!env.ENGINE) return { deleted: 0, purged: 0 }
  const db = env.DB
  let deleted = 0
  let purged = 0
  const { results } = await db.prepare(`SELECT id, org_id FROM collections WHERE state = 'deleting' ORDER BY updated_at LIMIT 25`).all<{ id: string; org_id: string }>()
  for (const row of results) {
    if (Date.now() > deadline) break
    const engine = new EngineClient(env.ENGINE, row.org_id)
    try {
      const answer = await engine.deleteCollection(row.id)
      const status = answer.state === 'deleted' ? null : await engine.getCollection(row.id).catch((error) => (error instanceof EngineCallError && error.status === 404 ? null : Promise.reject(error)))
      if (!status || status.state === 'deleted') {
        await eraseCollection(db, row.org_id, row.id, now)
        deleted += 1
      }
    } catch (error) {
      logError('delete_retry_failed', error, { org: row.org_id })
    }
  }
  const { results: purges } = await db.prepare(`SELECT org_id FROM org_purges WHERE done_at IS NULL ORDER BY requested_at LIMIT 10`).all<{ org_id: string }>()
  for (const row of purges) {
    if (Date.now() > deadline) break
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

/**
 * Collections whose engine settings are behind: older than their organization's (a stricter hiding rule, a new time
 * zone), changed since (days of backups), or a push that failed (version -1).
 */
async function pushStaleSettings(env: Bindings, now: number, deadline: number): Promise<number> {
  const { results } = await env.DB.prepare(
    `SELECT c.* FROM collections c LEFT JOIN org_settings s ON s.org_id = c.org_id WHERE c.state = 'active' AND c.settings_version < COALESCE(s.version, 0) ORDER BY c.updated_at LIMIT 25`,
  ).all<CollectionRow>()
  let pushed = 0
  const settings = new Map<string, Awaited<ReturnType<typeof readOrgSettings>>>()
  for (const collection of results) {
    if (Date.now() > deadline) break
    if (!settings.has(collection.org_id)) settings.set(collection.org_id, await readOrgSettings(env.DB, collection.org_id, now))
    if (await pushSettings(env, collection, settings.get(collection.org_id)!, now)) pushed += 1
  }
  return pushed
}

/**
 * Imports waiting for next month's documents learned (routes/sources.ts): on the 1st, or when the limit was raised,
 * each is reserved and sent to the engine, oldest first. One the new month has no room for either waits for the next
 * 1st, its files and reservations kept until then. One whose files the engine no longer holds fails, and its starter
 * is told.
 */
export async function startWaitingImports(env: Bindings, now: number, deadline: number): Promise<number> {
  if (!env.ENGINE) return 0
  const db = env.DB
  const { results } = await db.prepare(`SELECT id, org_id, collection_id, kind, request FROM imports WHERE state = 'waiting' ORDER BY created_at LIMIT 20`)
    .all<{ id: string; org_id: string; collection_id: string; kind: ImportKind; request: string | null }>()
  const full = new Set<string>()
  let started = 0
  for (const row of results) {
    if (Date.now() > deadline) break
    const collection = await loadCollection(db, row.org_id, row.collection_id)
    const ref = `import:${row.id}`
    if (!collection || collection.state !== 'active') {
      await release(db, row.org_id, (await reservationsOf(db, row.org_id, ref)).map((reservation) => reservation.id), now)
      await db.prepare(`UPDATE imports SET state = 'cancelled', request = NULL, finished_at = ? WHERE id = ? AND org_id = ? AND state = 'waiting'`).bind(now, row.id, row.org_id).run()
      continue
    }
    const request = JSON.parse(row.request ?? '{"files":[],"notes":[]}') as WaitingRequest
    const engine = new EngineClient(env.ENGINE, row.org_id)
    if (!full.has(row.org_id)) {
      try {
        await ensureAwakeBlock(env, row.org_id, collection.id, now)
        await reserve(env, row.org_id, [{ key: 'learned_month', amount: request.files.length + request.notes.length }], ref, now)
      } catch (error) {
        if (!(error instanceof ApiError && error.code === 'quota_exceeded')) throw error
        full.add(row.org_id)
      }
    }
    if (full.has(row.org_id)) {
      if (request.waitsFor !== resetsAt(now)) {
        try {
          await waitAnotherMonth(env, engine, collection, row.id, request, now)
        } catch (error) {
          logError('waiting_import_keep_failed', error, { org: row.org_id })
        }
      }
      continue
    }
    const claimed = await db.prepare(`UPDATE imports SET state = 'queued', request = NULL WHERE id = ? AND org_id = ? AND state = 'waiting'`).bind(row.id, row.org_id).run()
    if (claimed.meta.changes !== 1) continue
    try {
      await submitImport(env, engine, row.org_id, collection, row.kind, request, row.id, now, { onRefused: 'fail' })
      started += 1
    } catch (error) {
      logError('waiting_import_failed', error, { org: row.org_id })
    }
  }
  return started
}

/** A waiting import the new month has no room for: its files and reservations are kept until the next 1st. */
async function waitAnotherMonth(env: Bindings, engine: EngineClient, collection: CollectionRow, importId: string, request: WaitingRequest, now: number): Promise<void> {
  const db = env.DB
  const waiting = await waitForNextMonth(engine, collection.id, request, now)
  if (!waiting.files.length && !waiting.notes.length) {
    await failWaiting(env, collection.org_id, collection, importId, waiting.lost ?? [], now)
    await db.prepare(`UPDATE imports SET request = NULL WHERE id = ? AND org_id = ?`).bind(importId, collection.org_id).run()
    return
  }
  await db.batch([
    db.prepare(`UPDATE reservations SET expires_at = ? WHERE org_id = ? AND ref = ? AND state = 'held'`).bind(keptUntil(now), collection.org_id, `import:${importId}`),
    db.prepare(`UPDATE imports SET request = ? WHERE id = ? AND org_id = ? AND state = 'waiting'`).bind(JSON.stringify(waiting), importId, collection.org_id),
  ])
}

/** Imports the engine's answer to never reached (a dropped connection): asked again, and cancelled if it never had them. */
async function askAboutStaleImports(env: Bindings, now: number, deadline: number): Promise<number> {
  if (!env.ENGINE) return 0
  const db = env.DB
  const { results } = await db.prepare(
    `SELECT id, org_id, collection_id FROM imports WHERE state = 'queued' AND created_at < ? ORDER BY created_at LIMIT 10`,
  ).bind(now - 60 * 60 * 1000).all<{ id: string; org_id: string; collection_id: string }>()
  let settled = 0
  for (const row of results) {
    if (Date.now() > deadline) break
    const collection = await db.prepare(`SELECT id, name FROM collections WHERE id = ? AND org_id = ?`).bind(row.collection_id, row.org_id).first<{ id: string; name: string }>()
    if (!collection) continue
    try {
      const status = await new EngineClient(env.ENGINE, row.org_id).getImport(row.collection_id, row.id)
      await finishImport(env, row.org_id, collection, row.id, status, now)
    } catch (error) {
      if (!(error instanceof EngineCallError && error.status === 404)) {
        logError('stale_import_failed', error, { org: row.org_id })
        continue
      }
      // The engine never had it: nothing was learned, and what it reserved is free again.
      await finishImport(env, row.org_id, collection, row.id, { state: 'cancelled' }, now)
    }
    settled += 1
  }
  return settled
}

/** Prunes what nothing needs any more: outbox marks past the outbox's 7 days, finished reservations, old answers to changes. */
export async function prune(db: D1Database, now: number): Promise<number> {
  const results = await db.batch([
    db.prepare(`DELETE FROM engine_events WHERE id IN (SELECT id FROM engine_events WHERE at < ? LIMIT 1000)`).bind(now - 8 * DAY_MS),
    db.prepare(`DELETE FROM reservations WHERE id IN (SELECT id FROM reservations WHERE state != 'held' AND COALESCE(settled_at, created_at) < ? LIMIT 1000)`).bind(now - 40 * DAY_MS),
    db.prepare(`DELETE FROM idempotency WHERE rowid IN (SELECT rowid FROM idempotency WHERE created_at < ? LIMIT 1000)`).bind(now - DAY_MS),
  ])
  return results.reduce((sum, result) => sum + (result.meta.changes ?? 0), 0)
}

/** The organization's admins Knowledge knows, with an address: who gets the 80% notice. */
async function adminAddresses(db: D1Database, org: string): Promise<string[]> {
  const { results } = await db.prepare(`SELECT email FROM members WHERE org_id = ? AND principal_type = 'person' AND app_role = 'ADMIN' AND away = 0 AND email IS NOT NULL`).bind(org).all<{ email: string }>()
  return results.map((row) => row.email)
}

/** Claims a notice for (organization, period, key, kind): true the first time only. */
async function claimAlert(db: D1Database, org: string, period: string, key: string, kind: string, now: number): Promise<boolean> {
  const result = await db.prepare(`INSERT INTO limit_alerts (org_id, period, key, kind, sent_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`).bind(org, period, key, kind, now).run()
  return result.meta.changes === 1
}

const WATCH_BATCH = 200
const WATCH_CURSOR = 'limits_watch'

/** The organizations to watch this time: after the saved cursor, in order of id, wrapping round to the start. */
async function organizationsInTurn(db: D1Database, period: string, batch: number): Promise<string[]> {
  const cursor = (await db.prepare(`SELECT cursor FROM sync_state WHERE name = ?`).bind(WATCH_CURSOR).first<{ cursor: string | null }>())?.cursor ?? ''
  const page = (after: string, limit: number) => db.prepare(
    `SELECT org_id FROM (SELECT org_id FROM collections WHERE state = 'active' UNION SELECT org_id FROM usage_counters WHERE period = ?1) WHERE org_id > ?2 ORDER BY org_id LIMIT ?3`,
  ).bind(period, after, limit).all<{ org_id: string }>().then((rows) => rows.results.map((row) => row.org_id))
  const orgs = await page(cursor, batch)
  if (orgs.length < batch && cursor) for (const org of await page('', batch - orgs.length)) if (!orgs.includes(org) && org <= cursor) orgs.push(org)
  return orgs
}

/**
 * Watches organizations' use against their limits, a batch at a time in turn (the cursor is saved), with every
 * organization's use and limits read in a few grouped queries:
 *
 * - 80% of a limit e-mails the organization's admins: once per month for a monthly limit, and once per crossing for
 *   a standing one (it can mail again after use went back below 80%);
 * - at 90% of awake hours keep-ready pauses (its owner gets mail once a month) and the engine is told; below it (a
 *   new month, a raised limit) paused windows start again.
 */
export async function watchLimits(env: Bindings, now: number, options: { batch?: number; deadline?: number } = {}): Promise<{ alerts: number; paused: number; resumed: number; organizations: string[] }> {
  const db = env.DB
  const deadline = options.deadline ?? Date.now() + 5_000
  const period = periodOf(now)
  const orgs = await organizationsInTurn(db, period, options.batch ?? WATCH_BATCH)
  const done: string[] = []
  let alerts = 0
  let paused = 0
  let resumed = 0
  if (!orgs.length) return { alerts, paused, resumed, organizations: done }
  const list = JSON.stringify(orgs)
  type Row = Record<string, string | number | null>
  const [standing, counters, defaults, overrides, sent, ready] = await db.batch<Row>([
    db.prepare(`SELECT org_id, COUNT(*) AS collections, COALESCE(SUM(documents), 0) AS documents, COALESCE(SUM(bytes), 0) AS storage_bytes,
      SUM(CASE WHEN keep_ready IS NOT NULL THEN 1 ELSE 0 END) AS ready_collections FROM collections WHERE state = 'active' AND org_id IN (SELECT value FROM json_each(?)) GROUP BY org_id`).bind(list),
    db.prepare(`SELECT org_id, key, SUM(used) AS used FROM usage_counters WHERE period = ? AND org_id IN (SELECT value FROM json_each(?)) GROUP BY org_id, key`).bind(period, list),
    db.prepare(`SELECT key, value FROM limit_defaults`),
    db.prepare(`SELECT org_id, key, value FROM org_limits WHERE (until IS NULL OR until > ?) AND org_id IN (SELECT value FROM json_each(?))`).bind(now, list),
    db.prepare(`SELECT org_id, period, key FROM limit_alerts WHERE kind = 'near' AND org_id IN (SELECT value FROM json_each(?))`).bind(list),
    db.prepare(`SELECT * FROM collections WHERE state = 'active' AND keep_ready IS NOT NULL AND org_id IN (SELECT value FROM json_each(?))`).bind(list),
  ])
  const limitOf = (org: string, key: LimitKey): number | null => {
    const override = overrides!.results.find((row) => row.org_id === org && row.key === key)
    if (override) return override.value === null ? null : Number(override.value)
    const fallback = defaults!.results.find((row) => row.key === key)
    if (fallback) return fallback.value === null ? null : Number(fallback.value)
    return LIMITS.find((limit) => limit.key === key)!.default
  }
  for (const org of orgs) {
    if (Date.now() > deadline) break
    const own = standing!.results.find((row) => row.org_id === org)
    const usedOf = (key: string) => Number((MONTHLY.has(key as LimitKey) ? counters!.results.find((row) => row.org_id === org && row.key === key)?.used : own?.[key]) ?? 0)
    for (const limit of LIMITS) {
      if (limit.key === 'file_bytes' || limit.key === 'backup_days') continue
      const value = limitOf(org, limit.key)
      if (value === null || value <= 0) continue
      const used = inUnit(limit.key, usedOf(limit.key))
      const alertPeriod = MONTHLY.has(limit.key) ? period : 'all'
      const alerted = sent!.results.some((row) => row.org_id === org && row.key === limit.key && row.period === alertPeriod)
      if (used < value * 0.8) {
        // A standing limit notices again on its next crossing.
        if (alerted && alertPeriod === 'all') await db.prepare(`DELETE FROM limit_alerts WHERE org_id = ? AND period = 'all' AND key = ? AND kind = 'near'`).bind(org, limit.key).run()
        continue
      }
      if (alerted || !(await claimAlert(db, org, alertPeriod, limit.key, 'near', now))) continue
      const show = (amount: number) => (limit.unit === 'bytes' ? formatBytes(amount) : Math.round(amount).toLocaleString('en-US'))
      alerts += await sendMailToAll(env, org, await adminAddresses(db, org), MAIL.nearLimit(limit.label, show(used), show(value), supportSentence(env), appLink(env, '/rules')), 'near_limit')
    }
    const awakeLimit = limitOf(org, 'awake_hours_month')
    const awake = usedOf('awake_hours_month') / SECONDS_PER_HOUR
    const shouldPause = awakeLimit !== null && awake >= awakeLimit * 0.9
    const changing = ready!.results.filter((row) => row.org_id === org && Number(row.keep_ready_paused) !== (shouldPause ? 1 : 0)) as unknown as CollectionRow[]
    if (changing.length) {
      const settings = await readOrgSettings(db, org, now)
      for (const collection of changing) {
        const updated = { ...collection, keep_ready_paused: shouldPause ? 1 : 0 }
        await db.prepare(`UPDATE collections SET keep_ready_paused = ?, updated_at = ? WHERE id = ? AND org_id = ?`).bind(updated.keep_ready_paused, now, collection.id, org).run()
        await pushSettings(env, updated, settings, now)
        if (!shouldPause) {
          resumed += 1
          continue
        }
        paused += 1
        if (await claimAlert(db, org, period, `keep_ready:${collection.id}`, 'paused', now)) {
          const owner = await db.prepare(`SELECT email FROM members WHERE org_id = ? AND principal_type = 'person' AND principal_id = ?`).bind(org, collection.owner_id).first<{ email: string | null }>()
          const resets = new Date(resetsAt(now)).toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' })
          if (owner?.email) await sendMail(env, org, { to: owner.email, ...MAIL.keepReadyPaused(collection.name, Math.floor(awake), awakeLimit ?? 0, resets, appLink(env, `/collections/${collection.id}/sharing`)) }, 'keep_ready_paused')
        }
      }
    }
    done.push(org)
  }
  // The next tick starts after the last organization watched, wrapping round at the end.
  const last = done.at(-1) ?? null
  if (last !== null) {
    await db.prepare(
      `INSERT INTO sync_state (name, cursor, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT (name) DO UPDATE SET cursor = excluded.cursor, updated_at = excluded.updated_at`,
    ).bind(WATCH_CURSOR, last, now).run()
  }
  return { alerts, paused, resumed, organizations: done }
}
