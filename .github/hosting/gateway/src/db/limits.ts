// App limits (DESIGN.md §8.8). The deploy writes each app's catalog (its package.json insulin.limits) to
// `app_limit_catalog` (scripts/limits-catalog.mjs); console admins put a default of their own in its place
// (`app_limit_defaults`) or override a limit for one organization (`org_app_limits`), each change stamped with the next
// number of `app_limit_sequence`; `org_app_limit_changes` keeps each organization's latest change, so an app reading
// GET /__insulin/limits after its cursor gets every organization changed since, with all its current overrides. A value
// is a whole number, or NULL for unlimited.
import type { Operator } from '../super/db.ts'

export type LimitUnit = 'count' | 'bytes' | 'hours' | 'days'
export const LIMIT_UNITS: readonly LimitUnit[] = ['count', 'bytes', 'hours', 'days']

/** One limit of an app's catalog. */
export interface CatalogRow {
  app: string
  key: string
  label: string
  unit: LimitUnit
  default_value: number
  position: number
}

/** A default the console's admins set, or an organization's override: who set it, when and why. */
export interface DefaultRow {
  key: string
  value: number | null
  reason: string
  changed_by: string
  changed_at: number
}

export interface OverrideRow extends DefaultRow {
  org_id: string
  app: string
  until: number | null
}

/** An app's catalog, in its own order. */
export async function appCatalog(db: D1Database, app: string): Promise<CatalogRow[]> {
  const { results } = await db.prepare(
    'SELECT app, key, label, unit, default_value, position FROM app_limit_catalog WHERE app = ?1 ORDER BY position, key',
  ).bind(app).all<CatalogRow>()
  return results
}

/** Every app's catalog, in each app's order. */
export async function allCatalogs(db: D1Database): Promise<CatalogRow[]> {
  const { results } = await db.prepare(
    'SELECT app, key, label, unit, default_value, position FROM app_limit_catalog ORDER BY app, position, key',
  ).all<CatalogRow>()
  return results
}

export async function appDefaults(db: D1Database, app: string): Promise<DefaultRow[]> {
  const { results } = await db.prepare(
    'SELECT key, value, reason, changed_by, changed_at FROM app_limit_defaults WHERE app = ?1',
  ).bind(app).all<DefaultRow>()
  return results
}

export async function allDefaults(db: D1Database): Promise<(DefaultRow & { app: string })[]> {
  const { results } = await db.prepare('SELECT app, key, value, reason, changed_by, changed_at FROM app_limit_defaults').all<DefaultRow & { app: string }>()
  return results
}

/** An organization's overrides in every app. */
export async function orgOverrides(db: D1Database, orgId: string): Promise<OverrideRow[]> {
  const { results } = await db.prepare(
    'SELECT org_id, app, key, value, until, reason, changed_by, changed_at FROM org_app_limits WHERE org_id = ?1 ORDER BY app, key',
  ).bind(orgId).all<OverrideRow>()
  return results
}

/** The default in force: the admins' if they set one, else the catalog's. */
export function defaultInForce(catalog: CatalogRow, set: DefaultRow | undefined): number | null {
  return set ? set.value : catalog.default_value
}

/** The limit an organization has now: its override until it ends, else the default in force. */
export function limitInForce(catalog: CatalogRow, set: DefaultRow | undefined, override: OverrideRow | undefined, now: number): number | null {
  if (override && (override.until === null || override.until > now)) return override.value
  return defaultInForce(catalog, set)
}

/** What GET /__insulin/limits reads in one snapshot. */
export interface LimitsPage {
  catalog: CatalogRow[]
  defaults: DefaultRow[]
  /** The organizations changed after the cursor (at most `limit` + 1), oldest change first, with their overrides. */
  changes: { org_id: string; seq: number; key: string | null; value: number | null; until: number | null }[]
  /** The newest change number of all. */
  latest: number
}

/**
 * `app`'s catalog and defaults, and the organizations where it is used whose overrides changed after `since`, oldest
 * change first, at most `limit` + 1 of them, each with every override it has now (a row with a null key for none).
 * With `onlyOverridden`, organizations without a current override are left out (an app's first read).
 */
export async function limitsAfter(db: D1Database, app: string, since: number, limit: number, onlyOverridden: boolean): Promise<LimitsPage> {
  const [catalog, defaults, changes, latest] = await db.batch([
    db.prepare('SELECT app, key, label, unit, default_value, position FROM app_limit_catalog WHERE app = ?1 ORDER BY position, key').bind(app),
    db.prepare('SELECT key, value, reason, changed_by, changed_at FROM app_limit_defaults WHERE app = ?1').bind(app),
    db.prepare(
      `SELECT p.org_id, p.seq, l.key, l.value, l.until FROM (
         SELECT c.org_id, c.seq FROM org_app_limit_changes c
         WHERE c.app = ?1 AND c.seq > ?2 AND EXISTS (SELECT 1 FROM app_orgs a WHERE a.app = ?1 AND a.org_id = c.org_id)
           AND (?4 = 0 OR EXISTS (SELECT 1 FROM org_app_limits o WHERE o.org_id = c.org_id AND o.app = ?1))
         ORDER BY c.seq LIMIT ?3) p
       LEFT JOIN org_app_limits l ON l.org_id = p.org_id AND l.app = ?1
       ORDER BY p.seq, l.key`,
    ).bind(app, since, limit + 1, onlyOverridden ? 1 : 0),
    db.prepare('SELECT seq FROM app_limit_sequence WHERE id = 1'),
  ])
  return {
    catalog: (catalog?.results ?? []) as CatalogRow[],
    defaults: (defaults?.results ?? []) as DefaultRow[],
    changes: (changes?.results ?? []) as LimitsPage['changes'],
    latest: ((latest?.results ?? [])[0] as { seq: number } | undefined)?.seq ?? 0,
  }
}

const NEXT_SEQ = 'UPDATE app_limit_sequence SET seq = seq + 1 WHERE id = 1'
const CURRENT_SEQ = '(SELECT seq FROM app_limit_sequence WHERE id = 1)'

/** The console's audit record of a limit change, written only when `condition` holds (before the change applies). */
function limitAudit(db: D1Database, entry: { operator: Operator; action: string; targetType: 'app' | 'org'; targetId: string; targetLabel: string; reason: string; now: number }, condition: string, params: unknown[]): D1PreparedStatement {
  // The audit's own parameters are ?1 to ?8; the condition's follow from ?9.
  return db.prepare(
    `INSERT INTO super_audit (at, operator_id, operator_email, action, target_type, target_id, target_label, reason)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8 WHERE ${condition}`,
  ).bind(entry.now, entry.operator.id, entry.operator.email, entry.action, entry.targetType, entry.targetId, entry.targetLabel, entry.reason, ...params)
}

/**
 * Sets an app's default for one limit (a number, or null for unlimited) in place of the catalog's, and records it, in
 * one batch: only for a key in the app's catalog, and only when it differs from the default the admins set before, so
 * a repeated form changes and records nothing. True when it changed.
 */
export async function setLimitDefault(db: D1Database, change: { app: string; key: string; value: number | null; reason: string; operator: Operator; label: string; now: number }): Promise<boolean> {
  // A key of the catalog whose default isn't already this value; the parameters name the app, the key and the value.
  const applies = (app: string, key: string, value: string) => `EXISTS (SELECT 1 FROM app_limit_catalog WHERE app = ${app} AND key = ${key})
    AND NOT EXISTS (SELECT 1 FROM app_limit_defaults WHERE app = ${app} AND key = ${key} AND value IS ${value})`
  const results = await db.batch([
    limitAudit(db, { operator: change.operator, action: 'app.limit_default', targetType: 'app', targetId: change.app, targetLabel: change.label, reason: change.reason, now: change.now },
      applies('?9', '?10', '?11'), [change.app, change.key, change.value]),
    db.prepare(`${NEXT_SEQ} AND ${applies('?1', '?2', '?3')}`).bind(change.app, change.key, change.value),
    db.prepare(
      `INSERT INTO app_limit_defaults (app, key, value, reason, changed_by, changed_at, seq)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ${CURRENT_SEQ} WHERE ${applies('?1', '?2', '?3')}
       ON CONFLICT (app, key) DO UPDATE SET value = excluded.value, reason = excluded.reason, changed_by = excluded.changed_by,
         changed_at = excluded.changed_at, seq = excluded.seq`,
    ).bind(change.app, change.key, change.value, change.reason, change.operator.email, change.now),
  ])
  return (results[2]?.meta.changes ?? 0) > 0
}

/** Puts the catalog's default back for one limit, and records it, in one batch. True when there was one to remove. */
export async function resetLimitDefault(db: D1Database, change: { app: string; key: string; reason: string; operator: Operator; label: string; now: number }): Promise<boolean> {
  const exists = 'EXISTS (SELECT 1 FROM app_limit_defaults WHERE app = ?9 AND key = ?10)'
  const results = await db.batch([
    limitAudit(db, { operator: change.operator, action: 'app.limit_default_reset', targetType: 'app', targetId: change.app, targetLabel: change.label, reason: change.reason, now: change.now },
      exists, [change.app, change.key]),
    db.prepare(`${NEXT_SEQ} AND EXISTS (SELECT 1 FROM app_limit_defaults WHERE app = ?1 AND key = ?2)`).bind(change.app, change.key),
    db.prepare('DELETE FROM app_limit_defaults WHERE app = ?1 AND key = ?2').bind(change.app, change.key),
  ])
  return (results[2]?.meta.changes ?? 0) > 0
}

/**
 * Overrides one limit for one organization (a number or null for unlimited, until an optional time), and records it,
 * in one batch: only for a key in the app's catalog and an organization that exists, and only when it differs from its
 * override now. The organization's change number moves on, so the app gets it at its next read. True when it changed.
 */
export async function setLimitOverride(db: D1Database, change: {
  orgId: string; app: string; key: string; value: number | null; until: number | null; reason: string; operator: Operator; label: string; now: number
}): Promise<boolean> {
  // A key of the catalog, an organization that exists, and an override that isn't already this one.
  const applies = (org: string, app: string, key: string, value: string, until: string) => `EXISTS (SELECT 1 FROM app_limit_catalog WHERE app = ${app} AND key = ${key})
    AND EXISTS (SELECT 1 FROM orgs WHERE id = ${org})
    AND NOT EXISTS (SELECT 1 FROM org_app_limits WHERE org_id = ${org} AND app = ${app} AND key = ${key} AND value IS ${value} AND until IS ${until})`
  const local = applies('?1', '?2', '?3', '?4', '?5')
  const results = await db.batch([
    limitAudit(db, { operator: change.operator, action: 'org.limit_override', targetType: 'org', targetId: change.orgId, targetLabel: change.label, reason: change.reason, now: change.now },
      applies('?9', '?10', '?11', '?12', '?13'), [change.orgId, change.app, change.key, change.value, change.until]),
    db.prepare(`${NEXT_SEQ} AND ${local}`).bind(change.orgId, change.app, change.key, change.value, change.until),
    db.prepare(
      `INSERT INTO org_app_limits (org_id, app, key, value, until, reason, changed_by, changed_at, seq)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ${CURRENT_SEQ} WHERE ${local}
       ON CONFLICT (org_id, app, key) DO UPDATE SET value = excluded.value, until = excluded.until, reason = excluded.reason,
         changed_by = excluded.changed_by, changed_at = excluded.changed_at, seq = excluded.seq`,
    ).bind(change.orgId, change.app, change.key, change.value, change.until, change.reason, change.operator.email, change.now),
    // The override this batch wrote carries the sequence's current number; only then does the organization's change move on.
    orgChangeStatement(db, change.orgId, change.app, `EXISTS (SELECT 1 FROM org_app_limits WHERE org_id = ?1 AND app = ?2 AND key = ?3 AND seq = ${CURRENT_SEQ})`, change.key),
  ])
  return (results[2]?.meta.changes ?? 0) > 0
}

/** Removes an organization's override of one limit, and records it, in one batch. True when there was one. */
export async function removeLimitOverride(db: D1Database, change: { orgId: string; app: string; key: string; reason: string; operator: Operator; label: string; now: number }): Promise<boolean> {
  const exists = 'EXISTS (SELECT 1 FROM org_app_limits WHERE org_id = ?9 AND app = ?10 AND key = ?11)'
  const local = 'EXISTS (SELECT 1 FROM org_app_limits WHERE org_id = ?1 AND app = ?2 AND key = ?3)'
  const results = await db.batch([
    limitAudit(db, { operator: change.operator, action: 'org.limit_override_removed', targetType: 'org', targetId: change.orgId, targetLabel: change.label, reason: change.reason, now: change.now },
      exists, [change.orgId, change.app, change.key]),
    db.prepare(`${NEXT_SEQ} AND ${local}`).bind(change.orgId, change.app, change.key),
    orgChangeStatement(db, change.orgId, change.app, local, change.key),
    db.prepare('DELETE FROM org_app_limits WHERE org_id = ?1 AND app = ?2 AND key = ?3').bind(change.orgId, change.app, change.key),
  ])
  return (results[3]?.meta.changes ?? 0) > 0
}

/** Moves an organization's change number in an app on to the sequence's current one, when `condition` (?1 org, ?2 app, ?3 key) holds. */
function orgChangeStatement(db: D1Database, orgId: string, app: string, condition: string, key: string): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO org_app_limit_changes (app, org_id, seq) SELECT ?2, ?1, ${CURRENT_SEQ} WHERE ${condition}
     ON CONFLICT (app, org_id) DO UPDATE SET seq = excluded.seq`,
  ).bind(orgId, app, key)
}

/** An organization at 80% or more of one of its limits, from its app's latest usage report. */
export interface LimitWatchRow {
  app: string
  org_id: string
  org_name: string
  key: string
  label: string
  unit: LimitUnit
  used: number
  limit_value: number
}

/**
 * Organizations whose latest reported usage (§8.6: the app reports under the same keys) is at 80% or more of their
 * limit in force, the fullest first. Unlimited limits, and limits the app doesn't report, are left out.
 */
export async function limitWatch(db: D1Database, now: number, limit = 20): Promise<LimitWatchRow[]> {
  const { results } = await db.prepare(
    `WITH latest AS (SELECT app, MAX(hour) AS hour FROM app_metrics_hourly GROUP BY app),
     usage AS (
       SELECT h.app, h.org_id, o.name AS org_name, c.key, c.label, c.unit, json_extract(h.metrics, '$.' || c.key) AS used,
         CASE WHEN l.key IS NOT NULL AND (l.until IS NULL OR l.until > ?1) THEN l.value
              WHEN d.key IS NOT NULL THEN d.value ELSE c.default_value END AS limit_value
       FROM latest
       JOIN app_metrics_hourly h ON h.app = latest.app AND h.hour = latest.hour AND h.org_id <> ''
       JOIN orgs o ON o.id = h.org_id
       JOIN app_limit_catalog c ON c.app = h.app
       LEFT JOIN app_limit_defaults d ON d.app = c.app AND d.key = c.key
       LEFT JOIN org_app_limits l ON l.org_id = h.org_id AND l.app = c.app AND l.key = c.key
       WHERE json_type(h.metrics, '$.' || c.key) IN ('integer', 'real'))
     SELECT app, org_id, org_name, key, label, unit, used, limit_value FROM usage
     WHERE limit_value IS NOT NULL AND limit_value > 0 AND used >= limit_value * 0.8
     ORDER BY used * 1.0 / limit_value DESC, org_name LIMIT ?2`,
  ).bind(now, limit).all<LimitWatchRow>()
  return results
}
