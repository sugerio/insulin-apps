import { loadCollection, type CollectionRow } from './access.ts'
import { EngineCallError, EngineClient } from './engine/client.ts'
import type { Bindings } from './env.ts'
import { eraseCollection } from './erase.ts'
import { deliverHold, holdOrganization, releaseOrganization } from './holds.ts'
import { ApiError, logError } from './http.ts'
import { hideKept } from './kept.ts'
import { atAwakeStop, effectiveLimit, ensureAwakeBlock, expireReservations, formatBytes, inUnit, LIMITS, MONTHLY, periodOf, release, reservationsOf, resetsAt, SECONDS_PER_HOUR, supportSentence, type LimitKey } from './limits.ts'
import { syncLimits } from './limits-sync.ts'
import { appLink, MAIL, sendMail, sendMailToAll } from './mail.ts'
import { syncMembers } from './members.ts'
import { finishImport, syncOutbox } from './outbox.ts'
import { failWaiting, keptUntil, refused, submitImport, waitForNextMonth, type ImportKind, type WaitingRequest } from './routes/sources.ts'
import { bumpOrgSettings, pushSettings, readOrgSettings } from './settings.ts'
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
 * 5. The awake-hours stop held in the engine for organizations at 100%, and let go for those a raised limit or the
 *    new month frees (holds.ts).
 * 6. Imports waiting for next month's documents learned (started on the 1st, organizations in turn), and imports
 *    whose start the engine never confirmed (asked again, sent again when they waited).
 * 7. Deletions: collections still being deleted, and deleted organizations' purges, retried until the engine agrees.
 * 8. Limit overrides past their end, and settings the engine hasn't taken yet (hiding rules, time zone, days of
 *    backups, a push that failed), those tried longest ago first.
 * 9. Limits watched, organizations in turn: 80% mail to admins; keep-ready paused at 90% of awake hours.
 * 10. Reservations past their expiry released, waiting notes kept before Knowledge hid them hidden, old rows pruned.
 *
 * Each step runs with its deadline on its own copy of the bindings (`DEADLINE`): engine and platform calls give up
 * then, their answers' bodies included.
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
  const within = (ms: number) => Math.min(deadline, Date.now() + ms)
  const until = (end: number): Bindings => ({ ...env, DEADLINE: end })
  await step('limits', () => { const end = within(4_000); return syncLimits(until(end), now, end) })
  await step('members', () => { const end = within(5_000); return syncMembers(until(end), now, end) })
  await step('outbox', () => { const end = within(5_000); return syncOutbox(until(end), now, end) })
  const rest = until(deadline)
  await step('holds', () => awakeHolds(rest, now, deadline))
  await step('waitingImports', () => startWaitingImports(rest, now, deadline))
  await step('staleImports', () => askAboutStaleImports(rest, now, deadline))
  await step('deletions', () => retryDeletions(rest, now, deadline))
  await step('overrides', () => endOverrides(env.DB, now))
  await step('settings', () => pushStaleSettings(rest, now, deadline))
  await step('limitsWatch', () => watchLimits(rest, now, { deadline }))
  await step('reservations', () => expireReservations(env.DB, now))
  await step('hiddenNotes', () => hideWaitingNotes(env.DB, now, deadline))
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
    const engine = new EngineClient(env.ENGINE, row.org_id, env.DEADLINE)
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
      await new EngineClient(env.ENGINE, row.org_id, env.DEADLINE).purge(row.org_id)
      await db.prepare(`UPDATE org_purges SET done_at = ? WHERE org_id = ?`).bind(now, row.org_id).run()
      purged += 1
    } catch (error) {
      logError('purge_failed', error, { org: row.org_id })
    }
  }
  return { deleted, purged }
}

/**
 * Collections whose engine settings the engine hasn't taken yet: their revision is ahead of the one it took (their
 * organization's rules or limits changed, or a push failed). Those tried longest ago go first, so collections whose
 * push keeps failing never keep the others from theirs.
 */
async function pushStaleSettings(env: Bindings, now: number, deadline: number): Promise<number> {
  const { results } = await env.DB.prepare(
    `SELECT id, org_id FROM collections WHERE state = 'active' AND settings_pushed < settings_revision ORDER BY settings_tried_at IS NOT NULL, settings_tried_at, id LIMIT 25`,
  ).all<{ id: string; org_id: string }>()
  let pushed = 0
  for (const collection of results) {
    if (Date.now() > deadline) break
    if (await pushSettings(env, collection, now)) pushed += 1
  }
  return pushed
}

/**
 * Limit overrides past their end: the default applies again, and the row goes. An override of the days of backups
 * changes what the engine keeps, so its organization's collections are sent their settings again.
 */
export async function endOverrides(db: D1Database, now: number): Promise<number> {
  const { results } = await db.prepare(`SELECT org_id, key FROM org_limits WHERE until IS NOT NULL AND until <= ? LIMIT 100`).bind(now).all<{ org_id: string; key: string }>()
  if (!results.length) return 0
  const statements: D1PreparedStatement[] = []
  for (const row of results) {
    if (row.key === 'backup_days') statements.push(bumpOrgSettings(db, row.org_id))
    statements.push(db.prepare(`DELETE FROM org_limits WHERE org_id = ? AND key = ? AND until IS NOT NULL AND until <= ?`).bind(row.org_id, row.key, now))
  }
  await db.batch(statements)
  return results.length
}

/**
 * The awake-hours stop held in the engine: organizations at 100% of the month's awake hours are held until the 1st
 * (holds.ts), and those held let go once a raised limit frees them or the month they were held for is over. Every
 * organization's use and limit are read in a few grouped queries.
 */
export async function awakeHolds(env: Bindings, now: number, deadline: number): Promise<{ held: number; released: number; resent: number }> {
  const db = env.DB
  let held = 0
  let released = 0
  let resent = 0
  // Let go: the month it was held for is over, or a raised limit frees it.
  const { results: holds } = await db.prepare(`SELECT org_id, until FROM org_holds WHERE until != 0 ORDER BY held_at LIMIT 100`).all<{ org_id: string; until: number }>()
  for (const hold of holds) {
    if (Date.now() > deadline) return { held, released, resent }
    if (hold.until > now && (await atAwakeStop(db, hold.org_id, now)).stopped) continue
    if (await releaseOrganization(env, hold.org_id, now)) released += 1
  }
  // What the engine hasn't taken yet (a send that failed, or an answer that came late): sent again.
  const { results: behind } = await db.prepare(`SELECT org_id FROM org_holds WHERE delivered != version ORDER BY held_at LIMIT 100`).all<{ org_id: string }>()
  for (const row of behind) {
    if (Date.now() > deadline) return { held, released, resent }
    if (await deliverHold(env, row.org_id)) resent += 1
  }
  const period = periodOf(now)
  const { results: used } = await db.prepare(
    `SELECT org_id, SUM(used) AS used FROM usage_counters WHERE period = ?1 AND key = 'awake_hours_month' AND org_id NOT IN (SELECT org_id FROM org_holds WHERE until > ?2)
     GROUP BY org_id HAVING SUM(used) > 0 ORDER BY SUM(used) DESC LIMIT 500`,
  ).bind(period, now).all<{ org_id: string; used: number }>()
  if (!used.length) return { held, released, resent }
  const [defaults, overrides] = await db.batch<{ org_id?: string; value: number | null }>([
    db.prepare(`SELECT value FROM limit_defaults WHERE key = 'awake_hours_month'`),
    db.prepare(`SELECT org_id, value FROM org_limits WHERE key = 'awake_hours_month' AND (until IS NULL OR until > ?) AND org_id IN (SELECT value FROM json_each(?))`).bind(now, JSON.stringify(used.map((row) => row.org_id))),
  ])
  const fallback = defaults!.results[0]
  const limitOf = (org: string): number | null => {
    const override = overrides!.results.find((row) => row.org_id === org)
    if (override) return override.value
    if (fallback) return fallback.value
    return LIMITS.find((limit) => limit.key === 'awake_hours_month')!.default
  }
  for (const row of used) {
    if (Date.now() > deadline) break
    const limit = limitOf(row.org_id)
    if (limit === null || Number(row.used) < limit * SECONDS_PER_HOUR) continue
    if (await holdOrganization(env, row.org_id, Date.parse(resetsAt(now)), now)) held += 1
  }
  return { held, released, resent }
}

const WAITING_CURSOR = 'waiting_imports'

/** Organizations with imports waiting, in order of id after the saved cursor, wrapping round to the start. */
async function waitingOrganizations(db: D1Database, batch: number): Promise<string[]> {
  const cursor = (await db.prepare(`SELECT cursor FROM sync_state WHERE name = ?`).bind(WAITING_CURSOR).first<{ cursor: string | null }>())?.cursor ?? ''
  const page = (after: string, limit: number) => db.prepare(`SELECT DISTINCT org_id FROM imports WHERE state = 'waiting' AND org_id > ? ORDER BY org_id LIMIT ?`)
    .bind(after, limit).all<{ org_id: string }>().then((rows) => rows.results.map((row) => row.org_id))
  const orgs = await page(cursor, batch)
  if (orgs.length < batch && cursor) for (const org of await page('', batch - orgs.length)) if (!orgs.includes(org) && org <= cursor) orgs.push(org)
  return orgs
}

type WaitingRow = { id: string; org_id: string; collection_id: string; kind: ImportKind; request: string | null }

/**
 * Imports waiting for next month's documents learned (routes/sources.ts): on the 1st, or when the limit was raised,
 * each is claimed and sent to the engine, organizations in turn from where the last tick stopped (the cursor is
 * saved), oldest first within each. One the new month has no room for waits for the next 1st, its files and
 * reservations kept until then. Nothing is reserved for an import while it waits but what it held when it was added.
 */
export async function startWaitingImports(input: Bindings, now: number, deadline: number): Promise<number> {
  if (!input.ENGINE) return 0
  const env: Bindings = { ...input, DEADLINE: Math.min(input.DEADLINE ?? deadline, deadline) }
  const db = env.DB
  let started = 0
  for (const org of await waitingOrganizations(db, 20)) {
    if (Date.now() > deadline) break
    const { results } = await db.prepare(`SELECT id, org_id, collection_id, kind, request FROM imports WHERE org_id = ? AND state = 'waiting' ORDER BY created_at, rowid LIMIT 10`)
      .bind(org).all<WaitingRow>()
    let full = false
    for (const row of results) {
      if (Date.now() > deadline) return started
      const outcome = await startWaiting(env, row, now)
      if (outcome === 'started') started += 1
      if (outcome === 'full' || outcome === 'stopped') {
        full = outcome === 'full'
        break
      }
    }
    // The month is full again: imports that waited for this 1st wait for the next one, their files kept till then.
    if (full) await waitForTheNextFirst(env, org, now, deadline)
    await db.prepare(
      `INSERT INTO sync_state (name, cursor, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT (name) DO UPDATE SET cursor = excluded.cursor, updated_at = excluded.updated_at`,
    ).bind(WAITING_CURSOR, org, now).run()
  }
  return started
}

/**
 * Starts one waiting import. One statement reserves its learning (only while it still waits, has no learning held
 * already, and the month has room) and the next claims it (only with that reservation held): two ticks at once
 * reserve and send it once. The import keeps its request until the engine has answered: when the answer doesn't come
 * it waits again, its learning still reserved, and the next tick sends it again with the same id, which the engine
 * answers with the import it already has. A refusal fails it, and its starter is told.
 */
async function startWaiting(env: Bindings, row: WaitingRow, now: number): Promise<'started' | 'full' | 'stopped' | 'skipped'> {
  const db = env.DB
  const org = row.org_id
  const ref = `import:${row.id}`
  const collection = await loadCollection(db, org, row.collection_id)
  if (!collection || collection.state !== 'active') {
    await release(db, org, (await reservationsOf(db, org, ref)).map((reservation) => reservation.id), now)
    await db.prepare(`UPDATE imports SET state = 'cancelled', request = NULL, finished_at = ? WHERE id = ? AND org_id = ? AND state = 'waiting'`).bind(now, row.id, org).run()
    return 'skipped'
  }
  // Nothing starts at the awake-hours stop; it waits, holding nothing more.
  if ((await atAwakeStop(db, org, now)).stopped) return 'stopped'
  const request = JSON.parse(row.request ?? '{"files":[],"notes":[]}') as WaitingRequest
  const amount = request.export ? request.export.documents : request.files.length + request.notes.length
  const limit = await effectiveLimit(db, org, 'learned_month', now)
  const period = periodOf(now)
  const [, claim] = await db.batch([
    db.prepare(
      `INSERT INTO reservations (id, org_id, period, key, amount, consumed, state, ref, created_at, expires_at)
       SELECT ?1, ?2, ?3, 'learned_month', ?4, 0, 'held', ?5, ?6, ?7
       WHERE EXISTS (SELECT 1 FROM imports WHERE id = ?8 AND org_id = ?2 AND state = 'waiting')
         AND NOT EXISTS (SELECT 1 FROM reservations WHERE org_id = ?2 AND ref = ?5 AND key = 'learned_month' AND state = 'held')
         AND (?9 IS NULL OR (SELECT COALESCE(SUM(used), 0) FROM usage_counters WHERE org_id = ?2 AND period = ?3 AND key = 'learned_month')
           + (SELECT COALESCE(SUM(amount - consumed), 0) FROM reservations WHERE org_id = ?2 AND period = ?3 AND key = 'learned_month' AND state = 'held') + ?4 <= ?9)`,
    ).bind(crypto.randomUUID(), org, period, amount, ref, now, now + DAY_MS, row.id, limit),
    db.prepare(
      `UPDATE imports SET state = 'queued' WHERE id = ?1 AND org_id = ?2 AND state = 'waiting'
         AND EXISTS (SELECT 1 FROM reservations WHERE org_id = ?2 AND ref = ?3 AND key = 'learned_month' AND state = 'held')`,
    ).bind(row.id, org, ref),
  ])
  if (claim?.meta.changes !== 1) {
    const still = await db.prepare(`SELECT state FROM imports WHERE id = ? AND org_id = ?`).bind(row.id, org).first<{ state: string }>()
    return still?.state === 'waiting' ? 'full' : 'skipped'
  }
  const backToWaiting = () => db.prepare(`UPDATE imports SET state = 'waiting' WHERE id = ? AND org_id = ? AND state = 'queued'`).bind(row.id, org).run()
  try {
    await ensureAwakeBlock(env, org, collection.id, now)
  } catch (error) {
    // No awake time left for it now: it waits, its learning free again.
    await backToWaiting()
    await release(db, org, (await reservationsOf(db, org, ref)).filter((reservation) => reservation.key === 'learned_month').map((reservation) => reservation.id), now)
    if (error instanceof ApiError && error.code === 'quota_exceeded') return 'stopped'
    throw error
  }
  // Marked sent before it goes: from now on it may be in the engine, so it can't be cancelled until the engine says not.
  await db.prepare(`UPDATE imports SET request = json_set(request, '$.sentAt', ?, '$.sends', COALESCE(json_extract(request, '$.sends'), 0) + 1) WHERE id = ? AND org_id = ? AND request IS NOT NULL`)
    .bind(now, row.id, org).run()
  try {
    await submitImport(env, new EngineClient(env.ENGINE!, org, env.DEADLINE), org, collection, row.kind, request, row.id, now, { onRefused: 'fail' })
  } catch (error) {
    if (!refused(error)) {
      // The engine may or may not have it: it waits again and is sent again, never cancelled.
      await backToWaiting()
      logError('waiting_import_unconfirmed', error, { org })
      return 'skipped'
    }
  }
  await db.prepare(`UPDATE imports SET request = NULL WHERE id = ? AND org_id = ? AND state != 'waiting'`).bind(row.id, org).run()
  return 'started'
}

/** The organization's imports that waited for an earlier 1st, now that this month is full too: kept for the next. */
async function waitForTheNextFirst(env: Bindings, org: string, now: number, deadline: number): Promise<void> {
  const { results } = await env.DB.prepare(
    `SELECT id, org_id, collection_id, kind, request FROM imports WHERE org_id = ? AND state = 'waiting' AND COALESCE(json_extract(request, '$.waitsFor'), '') != ? ORDER BY created_at, rowid LIMIT 20`,
  ).bind(org, resetsAt(now)).all<WaitingRow>()
  for (const row of results) {
    if (Date.now() > deadline) return
    const collection = await loadCollection(env.DB, org, row.collection_id)
    if (!collection) continue
    try {
      await waitAnotherMonth(env, new EngineClient(env.ENGINE!, org, env.DEADLINE), collection, row.id, JSON.parse(row.request ?? '{"files":[],"notes":[]}') as WaitingRequest, now)
    } catch (error) {
      logError('waiting_import_keep_failed', error, { org })
    }
  }
}

/** A waiting import the new month has no room for: its files and reservations are kept until the next 1st. */
async function waitAnotherMonth(env: Bindings, engine: EngineClient, collection: CollectionRow, importId: string, request: WaitingRequest, now: number): Promise<void> {
  const db = env.DB
  const waiting = { ...(await waitForNextMonth(engine, collection.id, request, now)), hidden: request.hidden }
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

/**
 * Imports the engine's answer to never reached (a dropped connection), asked again after an hour. One the engine
 * never had: a waiting import (it still has its request) waits again and is sent again; any other fails, nothing
 * learned and what it reserved free again, and whoever added it is told to add it again.
 */
async function askAboutStaleImports(env: Bindings, now: number, deadline: number): Promise<number> {
  if (!env.ENGINE) return 0
  const db = env.DB
  const { results } = await db.prepare(
    `SELECT id, org_id, collection_id, request IS NOT NULL AS waited FROM imports WHERE state = 'queued' AND created_at < ? ORDER BY created_at LIMIT 10`,
  ).bind(now - 60 * 60 * 1000).all<{ id: string; org_id: string; collection_id: string; waited: number }>()
  let settled = 0
  for (const row of results) {
    if (Date.now() > deadline) break
    const collection = await db.prepare(`SELECT id, name FROM collections WHERE id = ? AND org_id = ?`).bind(row.collection_id, row.org_id).first<{ id: string; name: string }>()
    if (!collection) continue
    try {
      const status = await new EngineClient(env.ENGINE, row.org_id, env.DEADLINE).getImport(row.collection_id, row.id)
      await finishImport(env, row.org_id, collection, row.id, status, now)
    } catch (error) {
      if (!(error instanceof EngineCallError && error.status === 404)) {
        logError('stale_import_failed', error, { org: row.org_id })
        continue
      }
      if (row.waited) {
        // The engine never had it: it waits again, no longer sent, and can be cancelled.
        await db.prepare(`UPDATE imports SET state = 'waiting', request = json_remove(request, '$.sentAt') WHERE id = ? AND org_id = ? AND state = 'queued'`).bind(row.id, row.org_id).run()
      } else {
        const message = 'Insulin Knowledge never received this, so nothing was learned. Add it again.'
        await finishImport(env, row.org_id, collection, row.id, { state: 'failed', error: { error: 'internal', message } }, now)
      }
    }
    settled += 1
  }
  return settled
}

/** Notes waiting for the 1st kept before Knowledge hid them: hidden with their organization's rules now. */
async function hideWaitingNotes(db: D1Database, now: number, deadline: number): Promise<number> {
  const { results } = await db.prepare(`SELECT DISTINCT org_id FROM imports WHERE request IS NOT NULL AND json_extract(request, '$.hidden') IS NULL LIMIT 20`).all<{ org_id: string }>()
  let hidden = 0
  for (const row of results) {
    if (Date.now() > deadline) break
    hidden += await hideKept(db, row.org_id, (await readOrgSettings(db, row.org_id, now)).hiding)
  }
  return hidden
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
      for (const collection of changing) {
        if (Date.now() > deadline) break
        await db.prepare(`UPDATE collections SET keep_ready_paused = ?, settings_revision = settings_revision + 1, updated_at = ? WHERE id = ? AND org_id = ?`)
          .bind(shouldPause ? 1 : 0, now, collection.id, org).run()
        await pushSettings(env, collection, now)
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
