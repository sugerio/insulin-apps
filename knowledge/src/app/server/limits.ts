import { ApiError } from './http.ts'
import type { Bindings } from './env.ts'

/**
 * Free limits (design section 12; DESIGN.md §8.8). The catalog is package.json `insulin.limits` (a test keeps this
 * copy equal to it); Insulin Apps' operators change the defaults and each organization's overrides in the operator
 * console, and the tick pulls them from `/__insulin/limits` (limits-sync.ts) into `limit_defaults` and `org_limits`.
 * The effective limit is the organization's override (until its end date), else the default stored from the
 * platform, else the catalog's default.
 *
 * Use is reserved before work with one conditional statement (used + reserved + n ≤ limit), settled after, and
 * released on failure, so two requests never pass the same last unit. Every way in counts: the site, AI assistants,
 * API clients and the tick.
 */
export const LIMITS = [
  { key: 'collections', label: 'Collections', unit: 'count', default: 20 },
  { key: 'documents', label: 'Documents', unit: 'count', default: 500 },
  { key: 'file_bytes', label: 'Largest file', unit: 'bytes', default: 26214400 },
  { key: 'storage_bytes', label: 'Stored files', unit: 'bytes', default: 2147483648 },
  { key: 'learned_month', label: 'Documents learned a month', unit: 'count', default: 1000 },
  { key: 'questions_month', label: 'Questions a month', unit: 'count', default: 5000 },
  { key: 'answers_month', label: 'Built-in answers a month', unit: 'count', default: 2000 },
  { key: 'awake_hours_month', label: 'Awake hours a month', unit: 'hours', default: 100 },
  { key: 'ready_collections', label: 'Collections kept ready', unit: 'count', default: 1 },
  { key: 'backup_days', label: 'Days of daily backups', unit: 'days', default: 30 },
] as const

export type LimitKey = (typeof LIMITS)[number]['key']
export const LIMIT_KEYS = new Set<string>(LIMITS.map((limit) => limit.key))
/** Limits counted per calendar month (UTC); they drop to 0 on the 1st. */
export const MONTHLY = new Set<LimitKey>(['learned_month', 'questions_month', 'answers_month', 'awake_hours_month'])
/** Awake hours are kept in seconds. */
export const SECONDS_PER_HOUR = 3600
/** Awake time is reserved in blocks of ten minutes per wake. */
export const AWAKE_BLOCK_SECONDS = 600

/** The month a time falls in, UTC: `2026-11`. */
export const periodOf = (now: number) => new Date(now).toISOString().slice(0, 7)

/** When a monthly limit starts again: the first of next month, UTC. */
export function resetsAt(now: number): string {
  const date = new Date(now)
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1)).toISOString().replace('.000Z', 'Z')
}

/** "December 1" for the messages. */
function resetDay(now: number): string {
  const date = new Date(resetsAt(now))
  return date.toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' })
}

/** The effective limit of an organization: a number, or null for unlimited. */
export async function effectiveLimit(db: D1Database, org: string, key: LimitKey, now: number): Promise<number | null> {
  const row = await db.prepare(
    `SELECT
       (SELECT CASE WHEN value IS NULL THEN 'unlimited' ELSE value END FROM org_limits WHERE org_id = ?1 AND key = ?2 AND (until IS NULL OR until > ?3)) AS override,
       (SELECT CASE WHEN value IS NULL THEN 'unlimited' ELSE value END FROM limit_defaults WHERE key = ?2) AS fallback`,
  ).bind(org, key, now).first<{ override: number | string | null; fallback: number | string | null }>()
  const chosen = row?.override ?? row?.fallback ?? null
  if (chosen === 'unlimited') return null
  if (typeof chosen === 'number') return chosen
  return LIMITS.find((limit) => limit.key === key)!.default
}

export async function effectiveLimits(db: D1Database, org: string, now: number): Promise<Record<LimitKey, number | null>> {
  const entries = await Promise.all(LIMITS.map(async (limit) => [limit.key, await effectiveLimit(db, org, limit.key, now)] as const))
  return Object.fromEntries(entries) as Record<LimitKey, number | null>
}

/** SQL for what an organization uses of a limit now (?1 the organization, ?2 the period). */
function usedSql(key: LimitKey): string {
  switch (key) {
    case 'collections':
      return `(SELECT COUNT(*) FROM collections WHERE org_id = ?1 AND state = 'active')`
    case 'documents':
      return `(SELECT COALESCE(SUM(documents), 0) FROM collections WHERE org_id = ?1 AND state = 'active')`
    case 'storage_bytes':
      return `(SELECT COALESCE(SUM(bytes), 0) FROM collections WHERE org_id = ?1 AND state = 'active')`
    case 'ready_collections':
      return `(SELECT COUNT(*) FROM collections WHERE org_id = ?1 AND state = 'active' AND keep_ready IS NOT NULL)`
    default:
      return `(SELECT COALESCE(SUM(used), 0) FROM usage_counters WHERE org_id = ?1 AND period = ?2 AND key = '${key}')`
  }
}

/** What an organization uses of each limit, and what it has reserved; awake hours in seconds. */
export async function usageOf(db: D1Database, org: string, now: number): Promise<Record<string, { used: number; reserved: number }>> {
  const period = periodOf(now)
  const keys = LIMITS.filter((limit) => limit.key !== 'file_bytes' && limit.key !== 'backup_days').map((limit) => limit.key)
  const row = await db.prepare(
    `SELECT ${keys.map((key) => `${usedSql(key)} AS "${key}"`).join(', ')}`,
  ).bind(org, period).first<Record<string, number>>()
  const reserved = await db.prepare(
    `SELECT key, COALESCE(SUM(amount - consumed), 0) AS pending FROM reservations WHERE org_id = ?1 AND state = 'held' AND period IN (?2, 'all') GROUP BY key`,
  ).bind(org, period).all<{ key: string; pending: number }>()
  const pending = new Map(reserved.results.map((entry) => [entry.key, Number(entry.pending)]))
  return Object.fromEntries(keys.map((key) => [key, { used: Number(row?.[key] ?? 0), reserved: pending.get(key) ?? 0 }]))
}

/** In the limit's own unit: awake hours as hours, everything else as stored. */
export const inUnit = (key: string, value: number) => (key === 'awake_hours_month' ? value / SECONDS_PER_HOUR : value)
/** A limit in the unit use is kept in (awake hours as seconds). */
export const limitInStored = (key: string, value: number) => (key === 'awake_hours_month' ? value * SECONDS_PER_HOUR : value)

const PHRASES: Record<string, (limit: number) => string> = {
  collections: (limit) => `its ${limit.toLocaleString('en-US')} collections`,
  documents: (limit) => `its ${limit.toLocaleString('en-US')} documents`,
  file_bytes: (limit) => `its largest file size of ${formatBytes(limit)}`,
  storage_bytes: (limit) => `its ${formatBytes(limit)} of stored files`,
  learned_month: (limit) => `this month's ${limit.toLocaleString('en-US')} documents learned`,
  questions_month: (limit) => `this month's ${limit.toLocaleString('en-US')} questions`,
  answers_month: (limit) => `this month's ${limit.toLocaleString('en-US')} written answers`,
  awake_hours_month: (limit) => `this month's ${limit.toLocaleString('en-US')} awake hours`,
  ready_collections: (limit) => `its ${limit.toLocaleString('en-US')} collection${limit === 1 ? '' : 's'} kept ready`,
}

const WHAT_NOW: Record<string, (now: number) => string> = {
  collections: () => 'Delete a collection to start a new one.',
  documents: () => 'Remove files for good to make room; "Stop using" keeps them stored.',
  file_bytes: () => 'Split the file, or save it in a smaller format.',
  storage_bytes: () => 'Remove files for good to free space; "Stop using" keeps them stored.',
  learned_month: (now) => `New files wait until ${resetDay(now)}; everything already learned keeps answering.`,
  questions_month: (now) => `Knowledge can't answer until ${resetDay(now)}.`,
  answers_month: (now) => `Until ${resetDay(now)}, answers show their sources without a written answer.`,
  awake_hours_month: (now) => `Knowledge can't answer until ${resetDay(now)}.`,
  ready_collections: () => 'Turn off keep-ready on another collection first.',
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${Math.round((bytes / 1024 ** 3) * 10) / 10} GB`
  if (bytes >= 1024 ** 2) return `${Math.round((bytes / 1024 ** 2) * 10) / 10} MB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`
  return `${bytes} bytes`
}

/** "For a higher limit, contact …": Insulin Apps support, from SUGER_SUPPORT_EMAIL; never an address written here. */
export function supportSentence(env: Pick<Bindings, 'SUPPORT_EMAIL'>): string {
  const address = env.SUPPORT_EMAIL?.trim()
  return address ? `For a higher limit, contact Insulin Apps support at ${address}.` : 'For a higher limit, contact Insulin Apps support.'
}

/** The 429 of a limit (DESIGN.md §8.8): `{ error: 'quota_exceeded', limit, resets_at, message }`. */
export function quotaExceeded(env: Pick<Bindings, 'SUPPORT_EMAIL'>, key: LimitKey, limit: number, now: number): ApiError {
  const monthly = MONTHLY.has(key)
  const message = `Your organization has used ${PHRASES[key]?.(limit) ?? 'this limit'}. ${WHAT_NOW[key]?.(now) ?? ''} ${supportSentence(env)}`.replace(/\s+/g, ' ').trim()
  return new ApiError('quota_exceeded', message, { limit: key, resets_at: monthly ? resetsAt(now) : null })
}

export interface Reservation {
  id: string
  key: LimitKey
  amount: number
}

/**
 * Reserves use of one or more limits for a piece of work, all or nothing. Each reservation is one conditional
 * INSERT that passes only while used + reserved + amount stays within the limit; if any key doesn't fit, the ones
 * that did are released and the 429 of the first that didn't is thrown. `ref` names the work (an import, a question).
 */
export async function reserve(env: Bindings, org: string, items: { key: LimitKey; amount: number }[], ref: string, now: number, ttlMs = 24 * 60 * 60 * 1000): Promise<Reservation[]> {
  const db = env.DB
  const wanted = items.filter((item) => item.amount > 0)
  if (!wanted.length) return []
  const limits = await Promise.all(wanted.map((item) => effectiveLimit(db, org, item.key, now)))
  const period = periodOf(now)
  const reservations = wanted.map((item) => ({ id: crypto.randomUUID(), key: item.key, amount: item.amount }))
  const statements = reservations.map((reservation, index) => {
    const limit = limits[index] ?? null
    const keyPeriod = MONTHLY.has(reservation.key) ? period : 'all'
    const condition = limit === null
      ? '1'
      : `${usedSql(reservation.key)} + (SELECT COALESCE(SUM(amount - consumed), 0) FROM reservations WHERE org_id = ?1 AND period = ?3 AND key = ?4 AND state = 'held') + ?5 <= ?6`
    return db.prepare(
      `INSERT INTO reservations (id, org_id, period, key, amount, consumed, state, ref, created_at, expires_at)
       SELECT ?7, ?1, ?3, ?4, ?5, 0, 'held', ?8, ?9, ?10 WHERE ${condition}`,
    ).bind(org, period, keyPeriod, reservation.key, reservation.amount, limit === null ? 0 : limitInStored(reservation.key, limit), reservation.id, ref, now, now + ttlMs)
  })
  const results = await db.batch(statements)
  const failed = results.findIndex((result) => result.meta.changes !== 1)
  if (failed === -1) return reservations
  await release(db, org, reservations.filter((_, index) => results[index]?.meta.changes === 1).map((reservation) => reservation.id), now)
  const item = wanted[failed]!
  throw quotaExceeded(env, item.key, limits[failed] ?? 0, now)
}

/**
 * Settles reservations: a monthly limit's use grows by what the work actually used (at most what was reserved), the
 * rest is released; a standing limit (documents, stored bytes) is counted from the collections themselves, so its
 * reservation only ends. Idempotent: a reservation is settled once.
 */
export async function settle(db: D1Database, org: string, settled: { id: string; used: number }[], now: number): Promise<void> {
  const statements = settleStatements(db, org, settled, now)
  if (statements.length) await db.batch(statements)
}

/** The statements of `settle`, for a caller's own batch (an outbox event applied with its effects, all or nothing). */
export function settleStatements(db: D1Database, org: string, settled: { id: string; used: number }[], now: number): D1PreparedStatement[] {
  const statements: D1PreparedStatement[] = []
  for (const { id, used } of settled) {
    statements.push(db.prepare(
      `INSERT INTO usage_counters (org_id, period, key, used, updated_at)
       SELECT org_id, period, key, MIN(?3, amount), ?4 FROM reservations WHERE id = ?1 AND org_id = ?2 AND state = 'held' AND period != 'all'
       ON CONFLICT (org_id, period, key) DO UPDATE SET used = used + excluded.used, updated_at = excluded.updated_at`,
    ).bind(id, org, Math.max(0, used), now))
    statements.push(db.prepare(`UPDATE reservations SET state = 'settled', settled_at = ?3 WHERE id = ?1 AND org_id = ?2 AND state = 'held'`).bind(id, org, now))
  }
  return statements
}

/** Releases reservations whose work failed or didn't happen. */
export async function release(db: D1Database, org: string, ids: string[], now: number): Promise<void> {
  const statements = releaseStatements(db, org, ids, now)
  if (statements.length) await db.batch(statements)
}

export function releaseStatements(db: D1Database, org: string, ids: string[], now: number): D1PreparedStatement[] {
  return ids.map((id) => db.prepare(`UPDATE reservations SET state = 'released', settled_at = ?3 WHERE id = ?1 AND org_id = ?2 AND state = 'held'`).bind(id, org, now))
}

/** The held reservations of a piece of work (an import's), to settle or release them later. */
export async function reservationsOf(db: D1Database, org: string, ref: string): Promise<{ id: string; key: LimitKey; amount: number }[]> {
  const { results } = await db.prepare(`SELECT id, key, amount FROM reservations WHERE org_id = ? AND ref = ? AND state = 'held'`).bind(org, ref).all<{ id: string; key: LimitKey; amount: number }>()
  return results
}

/** Adds use that was never reserved, as the engine's ledger reports it: awake time, mostly. */
export function addUse(db: D1Database, org: string, key: LimitKey, amount: number, now: number): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO usage_counters (org_id, period, key, used, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)
     ON CONFLICT (org_id, period, key) DO UPDATE SET used = used + excluded.used, updated_at = excluded.updated_at`,
  ).bind(org, periodOf(now), key, amount, now)
}

/**
 * Before a question wakes or keeps a collection awake: the hard stop at 100% of awake hours (429), and a ten-minute
 * block reserved for the collection unless one with time left is already held, in which case its expiry moves on.
 */
export async function ensureAwakeBlock(env: Bindings, org: string, collectionId: string, now: number): Promise<void> {
  const db = env.DB
  const limit = await effectiveLimit(db, org, 'awake_hours_month', now)
  if (limit !== null) {
    const used = await db.prepare(`SELECT COALESCE(SUM(used), 0) AS used FROM usage_counters WHERE org_id = ? AND period = ? AND key = 'awake_hours_month'`).bind(org, periodOf(now)).first<{ used: number }>()
    if (Number(used?.used ?? 0) >= limit * SECONDS_PER_HOUR) throw quotaExceeded(env, 'awake_hours_month', limit, now)
  }
  const extended = await db.prepare(
    `UPDATE reservations SET expires_at = ?4 WHERE org_id = ?1 AND ref = ?2 AND key = 'awake_hours_month' AND period = ?3 AND state = 'held' AND amount > consumed AND expires_at > ?5`,
  ).bind(org, `awake:${collectionId}`, periodOf(now), now + AWAKE_BLOCK_SECONDS * 1000, now).run()
  if (extended.meta.changes > 0) return
  await reserve(env, org, [{ key: 'awake_hours_month', amount: AWAKE_BLOCK_SECONDS }], `awake:${collectionId}`, now, AWAKE_BLOCK_SECONDS * 1000)
}

/**
 * The engine's ledger reported awake (or learning, export, kept-ready) time: it counts as used whatever was reserved,
 * and uses up the collection's held awake blocks, oldest first. The statements go in the caller's batch.
 */
export async function consumeAwake(db: D1Database, org: string, collectionId: string, seconds: number, now: number): Promise<D1PreparedStatement[]> {
  const period = periodOf(now)
  const statements = [
    addUse(db, org, 'awake_hours_month', seconds, now),
    db.prepare(
      `INSERT INTO collection_usage (collection_id, period, org_id, awake_seconds) VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT (collection_id, period) DO UPDATE SET awake_seconds = awake_seconds + excluded.awake_seconds`,
    ).bind(collectionId, period, org, seconds),
  ]
  const { results: blocks } = await db.prepare(
    `SELECT id, amount, consumed FROM reservations WHERE org_id = ? AND ref = ? AND key = 'awake_hours_month' AND state = 'held' ORDER BY created_at, id`,
  ).bind(org, `awake:${collectionId}`).all<{ id: string; amount: number; consumed: number }>()
  let left = seconds
  for (const block of blocks) {
    if (left <= 0) break
    const take = Math.min(left, block.amount - block.consumed)
    left -= take
    const done = block.consumed + take >= block.amount
    statements.push(db.prepare(
      `UPDATE reservations SET consumed = consumed + ?3, state = CASE WHEN ?4 THEN 'settled' ELSE state END, settled_at = CASE WHEN ?4 THEN ?5 ELSE settled_at END
       WHERE id = ?1 AND org_id = ?2 AND state = 'held'`,
    ).bind(block.id, org, take, done ? 1 : 0, now))
  }
  return statements
}

/** Releases reservations past their expiry: awake blocks nobody used, and work that never settled (a crash). */
export async function expireReservations(db: D1Database, now: number): Promise<number> {
  const result = await db.prepare(`UPDATE reservations SET state = 'released', settled_at = ?1 WHERE state = 'held' AND expires_at < ?1`).bind(now).run()
  return result.meta.changes
}
