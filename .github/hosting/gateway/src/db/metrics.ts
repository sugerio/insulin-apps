// What apps report every hour (DESIGN.md §8.6): gauges per organization, and for the app as a whole (org_id ''), kept
// hourly for three days and as the last report of each UTC day for 400. A report is stored in four statements whatever
// its size: the organizations travel as one JSON parameter that json_each unpacks, so a report never meets D1's limits
// on statements per invocation or parameters per statement.

export const HOUR_MS = 60 * 60 * 1000
export const DAY_MS = 24 * HOUR_MS
export const HOURLY_RETENTION_MS = 3 * DAY_MS
export const DAILY_RETENTION_MS = 400 * DAY_MS

/** A metric's name and value, as the report checked them. */
export type Metrics = Record<string, number>

export interface MetricsReport {
  app: string
  /** The top of the UTC hour the values were measured in. */
  hour: number
  /** The app-wide gauges, or null when this request carries none. */
  appMetrics: Metrics | null
  organizations: { id: string; metrics: Metrics }[]
  now: number
}

/** The UTC day (its first millisecond) an hour belongs to. */
export function dayOf(hour: number): number {
  return Math.floor(hour / DAY_MS) * DAY_MS
}

/**
 * How many of an app's expired rows each report deletes, per table: more than one report can add (500 organizations
 * and the app), so the app's own reports keep its retention whatever the rest of the traffic.
 */
const PRUNE_PER_REPORT = 1000

/**
 * Stores a report: each value it carries replaces the one for that hour, so a resent report changes nothing, and a
 * day keeps its latest hour. Organizations the gateway doesn't know are skipped. It also deletes the app's rows past
 * their retention. Returns how many organizations were stored.
 */
export async function storeReport(db: D1Database, report: MetricsReport): Promise<number> {
  const day = dayOf(report.hour)
  const statements: D1PreparedStatement[] = [
    db.prepare('DELETE FROM app_metrics_hourly WHERE rowid IN (SELECT rowid FROM app_metrics_hourly WHERE app = ?1 AND hour < ?2 LIMIT ?3)')
      .bind(report.app, report.now - HOURLY_RETENTION_MS, PRUNE_PER_REPORT),
    db.prepare('DELETE FROM app_metrics_daily WHERE rowid IN (SELECT rowid FROM app_metrics_daily WHERE app = ?1 AND day < ?2 LIMIT ?3)')
      .bind(report.app, report.now - DAILY_RETENTION_MS, PRUNE_PER_REPORT),
  ]
  if (report.appMetrics) {
    const metrics = JSON.stringify(report.appMetrics)
    statements.push(
      db.prepare(
        `INSERT INTO app_metrics_hourly (app, org_id, hour, metrics, received_at) VALUES (?1, '', ?2, ?3, ?4)
         ON CONFLICT (app, hour, org_id) DO UPDATE SET metrics = excluded.metrics, received_at = excluded.received_at`,
      ).bind(report.app, report.hour, metrics, report.now),
      db.prepare(
        `INSERT INTO app_metrics_daily (app, org_id, day, hour, metrics) VALUES (?1, '', ?2, ?3, ?4)
         ON CONFLICT (app, day, org_id) DO UPDATE SET hour = excluded.hour, metrics = excluded.metrics
         WHERE excluded.hour >= app_metrics_daily.hour`,
      ).bind(report.app, day, report.hour, metrics),
    )
  }
  let stored = 0
  if (report.organizations.length) {
    const rows = JSON.stringify(report.organizations)
    const results = await db.batch([
      ...statements,
      db.prepare(
        `INSERT INTO app_metrics_hourly (app, org_id, hour, metrics, received_at)
         SELECT ?1, json_extract(j.value, '$.id'), ?2, json(json_extract(j.value, '$.metrics')), ?3 FROM json_each(?4) j
         WHERE EXISTS (SELECT 1 FROM orgs o WHERE o.id = json_extract(j.value, '$.id'))
         ON CONFLICT (app, hour, org_id) DO UPDATE SET metrics = excluded.metrics, received_at = excluded.received_at`,
      ).bind(report.app, report.hour, report.now, rows),
      db.prepare(
        `INSERT INTO app_metrics_daily (app, org_id, day, hour, metrics)
         SELECT ?1, json_extract(j.value, '$.id'), ?2, ?3, json(json_extract(j.value, '$.metrics')) FROM json_each(?4) j
         WHERE EXISTS (SELECT 1 FROM orgs o WHERE o.id = json_extract(j.value, '$.id'))
         ON CONFLICT (app, day, org_id) DO UPDATE SET hour = excluded.hour, metrics = excluded.metrics
         WHERE excluded.hour >= app_metrics_daily.hour`,
      ).bind(report.app, day, report.hour, rows),
    ])
    stored = results[statements.length]?.meta.changes ?? 0
  } else if (statements.length) {
    await db.batch(statements)
  }
  return stored
}

export interface MetricsRow {
  app: string
  org_id: string
  hour: number
  metrics: string
}

export interface DailyRow {
  day: number
  metrics: string
}

/** A stored metrics object, read back; anything malformed reads as no metrics. */
export function parseMetrics(json: string | null | undefined): Metrics {
  if (!json) return {}
  try {
    const value: unknown = JSON.parse(json)
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
    return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, number] => typeof entry[1] === 'number' && Number.isFinite(entry[1])))
  } catch {
    return {}
  }
}

/** Each app's latest report hour and when it arrived, for the apps that have reported in the hourly window. */
export async function latestReports(db: D1Database): Promise<{ app: string; hour: number; received_at: number; organizations: number }[]> {
  const { results } = await db.prepare(
    `SELECT h.app, h.hour, MAX(h.received_at) AS received_at, SUM(h.org_id <> '') AS organizations
     FROM app_metrics_hourly h
     WHERE h.hour = (SELECT MAX(x.hour) FROM app_metrics_hourly x WHERE x.app = h.app)
     GROUP BY h.app, h.hour ORDER BY h.app`,
  ).all<{ app: string; hour: number; received_at: number; organizations: number }>()
  return results
}

/** Every row of an app's latest report: the app-wide one ('') and each organization's. */
export async function latestReport(db: D1Database, app: string): Promise<MetricsRow[]> {
  const { results } = await db.prepare(
    `SELECT app, org_id, hour, metrics FROM app_metrics_hourly
     WHERE app = ?1 AND hour = (SELECT MAX(hour) FROM app_metrics_hourly WHERE app = ?1)`,
  ).bind(app).all<MetricsRow>()
  return results
}

/** One organization's latest numbers in each app that has reported it in the hourly window. */
export async function latestForOrg(db: D1Database, orgId: string): Promise<MetricsRow[]> {
  const { results } = await db.prepare(
    `SELECT h.app, h.org_id, h.hour, h.metrics FROM app_metrics_hourly h
     WHERE h.org_id = ?1 AND h.hour = (SELECT MAX(x.hour) FROM app_metrics_hourly x WHERE x.app = h.app AND x.org_id = ?1)
     ORDER BY h.app`,
  ).bind(orgId).all<MetricsRow>()
  return results
}

/** Each day's last report for one app and organization ('' for the app as a whole) since `since`, oldest first. */
export async function dailySeries(db: D1Database, app: string, orgId: string, since: number): Promise<DailyRow[]> {
  const { results } = await db.prepare(
    'SELECT day, metrics FROM app_metrics_daily WHERE app = ?1 AND org_id = ?2 AND day >= ?3 ORDER BY day',
  ).bind(app, orgId, since).all<DailyRow>()
  return results
}

/**
 * The organizations whose `metric` grew most in an app between its latest report and the report exactly a day before
 * it, with both values. An organization missing from either report isn't compared.
 */
export async function fastestGrowing(db: D1Database, app: string, metric: string, limit: number): Promise<{ org_id: string; now: number; before: number }[]> {
  const path = `$.${metric}`
  const { results } = await db.prepare(
    `WITH latest AS (SELECT MAX(hour) AS hour FROM app_metrics_hourly WHERE app = ?1)
     SELECT n.org_id, json_extract(n.metrics, ?2) AS now, COALESCE(json_extract(b.metrics, ?2), 0) AS before
     FROM app_metrics_hourly n
     JOIN app_metrics_hourly b ON b.app = n.app AND b.org_id = n.org_id AND b.hour = (SELECT hour FROM latest) - ?3
     WHERE n.app = ?1 AND n.org_id <> '' AND n.hour = (SELECT hour FROM latest)
       AND json_extract(n.metrics, ?2) > COALESCE(json_extract(b.metrics, ?2), 0)
     ORDER BY json_extract(n.metrics, ?2) - COALESCE(json_extract(b.metrics, ?2), 0) DESC LIMIT ?4`,
  ).bind(app, path, DAY_MS, limit).all<{ org_id: string; now: number; before: number }>()
  return results
}

/** Deletes up to `limit` hourly rows past three days and daily rows past 400 (housekeeping). */
export function pruneMetricsStatements(db: D1Database, now: number, limit: number): D1PreparedStatement[] {
  return [
    db.prepare('DELETE FROM app_metrics_hourly WHERE rowid IN (SELECT rowid FROM app_metrics_hourly WHERE hour < ?1 LIMIT ?2)')
      .bind(now - HOURLY_RETENTION_MS, limit),
    db.prepare('DELETE FROM app_metrics_daily WHERE rowid IN (SELECT rowid FROM app_metrics_daily WHERE day < ?1 LIMIT ?2)')
      .bind(now - DAILY_RETENTION_MS, limit),
  ]
}
