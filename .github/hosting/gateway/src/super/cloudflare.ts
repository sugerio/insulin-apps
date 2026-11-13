// The Cloudflare resources the platform runs on (DESIGN.md §11.5), read once an hour by the five-minute tick with a
// read-only API token: every insulin-apps Worker with its requests, errors and CPU time, and every insulin-apps D1
// database with its size and the rows it read and wrote, for the last day and the month so far. The console compares
// them with the plan's allowances and projects the month, so the operators see a limit coming. The token is sent to
// api.cloudflare.com only, never logged, and no redirect is followed.
import type { CloudflareConfig } from '../config.ts'
import { log } from '../log.ts'

const API = 'https://api.cloudflare.com/client/v4'
const TIMEOUT_MS = 20_000
/** The platform's Workers and databases are named insulin-apps-<name> (deploy-apps.mjs). */
export const RESOURCE_PREFIX = 'insulin-apps-'

/**
 * What the Workers Paid plan includes each month, and the hard limits that matter here, as Cloudflare documents them.
 * Usage past an included amount is billed rather than refused; a hard limit refuses. Check them against Cloudflare's
 * pricing and limits pages when the plan changes.
 */
export const PLAN = {
  workerRequestsPerMonth: 10_000_000,
  d1RowsReadPerMonth: 25_000_000_000,
  d1RowsWrittenPerMonth: 50_000_000,
  d1StorageBytes: 5 * 1024 ** 3,
  /** The most one D1 database may hold (a hard limit: writes fail past it). */
  d1DatabaseMaxBytes: 10 * 1024 ** 3,
} as const

export interface WorkerUsage {
  name: string
  requests24h: number
  errors24h: number
  requestsMonth: number
  errorsMonth: number
  /** CPU time per request in the last day, microseconds: median and 99th percentile, or null without requests. */
  cpuP50: number | null
  cpuP99: number | null
}

export interface DatabaseUsage {
  name: string
  id: string
  sizeBytes: number
  tables: number | null
  rowsRead24h: number
  rowsWritten24h: number
  rowsReadMonth: number
  rowsWrittenMonth: number
}

export interface Snapshot {
  takenAt: number
  /** The first millisecond of the UTC month the month's figures count from. */
  monthStart: number
  workers: WorkerUsage[] | null
  databases: DatabaseUsage[] | null
  /** What failed, by part ("workers", "databases", "analytics"), as a short code; empty when everything was read. */
  problems: string[]
}

type Fetch = typeof fetch

async function call(fetchImpl: Fetch, config: CloudflareConfig, path: string, init: RequestInit = {}): Promise<unknown> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const response = await fetchImpl(`${API}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${config.apiToken}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
      redirect: 'manual',
      signal: controller.signal,
    })
    if (!response.ok) throw new CloudflareError(`http_${response.status}`)
    return await response.json()
  } catch (error) {
    if (error instanceof CloudflareError) throw error
    throw new CloudflareError((error as { name?: string } | null)?.name === 'AbortError' ? 'timeout' : 'unreachable')
  } finally {
    clearTimeout(timer)
  }
}

class CloudflareError extends Error {
  override name = 'CloudflareError'
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function number(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

function code(error: unknown): string {
  return error instanceof CloudflareError ? error.message : 'invalid_response'
}

/** The account's insulin-apps Worker scripts, by name. */
async function workerNames(fetchImpl: Fetch, config: CloudflareConfig): Promise<string[]> {
  const body = record(await call(fetchImpl, config, `/accounts/${config.accountId}/workers/scripts`))
  if (body.success !== true) throw new CloudflareError('api_error')
  return list(body.result).map((script) => record(script).id).filter((id): id is string => typeof id === 'string' && id.startsWith(RESOURCE_PREFIX)).sort()
}

/** The account's insulin-apps D1 databases, with their size and table count. */
async function databases(fetchImpl: Fetch, config: CloudflareConfig): Promise<{ name: string; id: string; sizeBytes: number; tables: number | null }[]> {
  const body = record(await call(fetchImpl, config, `/accounts/${config.accountId}/d1/database?per_page=100`))
  if (body.success !== true) throw new CloudflareError('api_error')
  return list(body.result).map(record)
    .filter((db) => typeof db.name === 'string' && db.name.startsWith(RESOURCE_PREFIX) && typeof db.uuid === 'string')
    .map((db) => ({ name: db.name as string, id: db.uuid as string, sizeBytes: number(db.file_size), tables: typeof db.num_tables === 'number' ? db.num_tables : null }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

// Workers' invocations and D1's queries, for the last day and the month so far, in one GraphQL request.
const ANALYTICS_QUERY = `query ($account: String!, $dayStart: Time!, $monthStart: Time!, $end: Time!, $dayStartDate: Date!, $monthStartDate: Date!, $endDate: Date!) {
  viewer {
    accounts(filter: { accountTag: $account }) {
      day: workersInvocationsAdaptive(limit: 1000, filter: { datetime_geq: $dayStart, datetime_lt: $end }) {
        dimensions { scriptName }
        sum { requests errors }
        quantiles { cpuTimeP50 cpuTimeP99 }
      }
      month: workersInvocationsAdaptive(limit: 1000, filter: { datetime_geq: $monthStart, datetime_lt: $end }) {
        dimensions { scriptName }
        sum { requests errors }
      }
      d1Day: d1AnalyticsAdaptiveGroups(limit: 1000, filter: { date_geq: $dayStartDate, date_leq: $endDate }) {
        dimensions { databaseId }
        sum { rowsRead rowsWritten }
      }
      d1Month: d1AnalyticsAdaptiveGroups(limit: 1000, filter: { date_geq: $monthStartDate, date_leq: $endDate }) {
        dimensions { databaseId }
        sum { rowsRead rowsWritten }
      }
    }
  }
}`

interface Analytics {
  workers: Map<string, { requests24h: number; errors24h: number; requestsMonth: number; errorsMonth: number; cpuP50: number | null; cpuP99: number | null }>
  databases: Map<string, { rowsRead24h: number; rowsWritten24h: number; rowsReadMonth: number; rowsWrittenMonth: number }>
}

function date(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

async function analytics(fetchImpl: Fetch, config: CloudflareConfig, now: number, monthStart: number): Promise<Analytics> {
  const dayStart = now - 24 * 60 * 60 * 1000
  const body = record(await call(fetchImpl, config, '/graphql', {
    method: 'POST',
    body: JSON.stringify({
      query: ANALYTICS_QUERY,
      variables: {
        account: config.accountId,
        dayStart: new Date(dayStart).toISOString(),
        monthStart: new Date(monthStart).toISOString(),
        end: new Date(now).toISOString(),
        dayStartDate: date(dayStart),
        monthStartDate: date(monthStart),
        endDate: date(now),
      },
    }),
  }))
  if (list(body.errors).length) throw new CloudflareError('graphql_error')
  const account = record(list(record(record(body.data).viewer).accounts)[0])
  const workers: Analytics['workers'] = new Map()
  const worker = (name: string) => {
    let entry = workers.get(name)
    if (!entry) workers.set(name, entry = { requests24h: 0, errors24h: 0, requestsMonth: 0, errorsMonth: 0, cpuP50: null, cpuP99: null })
    return entry
  }
  for (const group of list(account.day).map(record)) {
    const name = record(group.dimensions).scriptName
    if (typeof name !== 'string') continue
    const entry = worker(name)
    entry.requests24h += number(record(group.sum).requests)
    entry.errors24h += number(record(group.sum).errors)
    const quantiles = record(group.quantiles)
    if (typeof quantiles.cpuTimeP50 === 'number') entry.cpuP50 = Math.max(entry.cpuP50 ?? 0, quantiles.cpuTimeP50)
    if (typeof quantiles.cpuTimeP99 === 'number') entry.cpuP99 = Math.max(entry.cpuP99 ?? 0, quantiles.cpuTimeP99)
  }
  for (const group of list(account.month).map(record)) {
    const name = record(group.dimensions).scriptName
    if (typeof name !== 'string') continue
    const entry = worker(name)
    entry.requestsMonth += number(record(group.sum).requests)
    entry.errorsMonth += number(record(group.sum).errors)
  }
  const dbs: Analytics['databases'] = new Map()
  const database = (id: string) => {
    let entry = dbs.get(id)
    if (!entry) dbs.set(id, entry = { rowsRead24h: 0, rowsWritten24h: 0, rowsReadMonth: 0, rowsWrittenMonth: 0 })
    return entry
  }
  for (const group of list(account.d1Day).map(record)) {
    const id = record(group.dimensions).databaseId
    if (typeof id !== 'string') continue
    const entry = database(id)
    entry.rowsRead24h += number(record(group.sum).rowsRead)
    entry.rowsWritten24h += number(record(group.sum).rowsWritten)
  }
  for (const group of list(account.d1Month).map(record)) {
    const id = record(group.dimensions).databaseId
    if (typeof id !== 'string') continue
    const entry = database(id)
    entry.rowsReadMonth += number(record(group.sum).rowsRead)
    entry.rowsWrittenMonth += number(record(group.sum).rowsWritten)
  }
  return { workers, databases: dbs }
}

export function monthStartOf(now: number): number {
  const day = new Date(now)
  return Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), 1)
}

/**
 * Reads the account's resources now. Each part that fails is left out (null) and named in `problems` with a short
 * code; the snapshot is kept anyway, so the console shows what it could read.
 */
export async function takeSnapshot(config: CloudflareConfig, now: number, fetchImpl: Fetch = fetch): Promise<Snapshot> {
  const monthStart = monthStartOf(now)
  const problems: string[] = []
  const [names, dbs, usage] = await Promise.all([
    workerNames(fetchImpl, config).catch((error) => { problems.push(`workers:${code(error)}`); return null }),
    databases(fetchImpl, config).catch((error) => { problems.push(`databases:${code(error)}`); return null }),
    analytics(fetchImpl, config, now, monthStart).catch((error) => { problems.push(`analytics:${code(error)}`); return null }),
  ])
  const workers = names?.map((name) => {
    const entry = usage?.workers.get(name)
    return {
      name,
      requests24h: entry?.requests24h ?? 0,
      errors24h: entry?.errors24h ?? 0,
      requestsMonth: entry?.requestsMonth ?? 0,
      errorsMonth: entry?.errorsMonth ?? 0,
      cpuP50: entry?.cpuP50 ?? null,
      cpuP99: entry?.cpuP99 ?? null,
    }
  }) ?? null
  const databaseUsage = dbs?.map((db) => {
    const entry = usage?.databases.get(db.id)
    return {
      ...db,
      rowsRead24h: entry?.rowsRead24h ?? 0,
      rowsWritten24h: entry?.rowsWritten24h ?? 0,
      rowsReadMonth: entry?.rowsReadMonth ?? 0,
      rowsWrittenMonth: entry?.rowsWrittenMonth ?? 0,
    }
  }) ?? null
  if (problems.length) log('cloudflare_snapshot_partial', { problems: problems.join(', ') })
  return { takenAt: now, monthStart, workers, databases: databaseUsage, problems }
}

/** A stored snapshot, read back; null when it isn't one. */
export function parseSnapshot(json: string): Snapshot | null {
  try {
    const value = record(JSON.parse(json))
    if (typeof value.takenAt !== 'number' || typeof value.monthStart !== 'number') return null
    return {
      takenAt: value.takenAt,
      monthStart: value.monthStart,
      workers: Array.isArray(value.workers) ? (value.workers as WorkerUsage[]) : null,
      databases: Array.isArray(value.databases) ? (value.databases as DatabaseUsage[]) : null,
      problems: list(value.problems).filter((problem): problem is string => typeof problem === 'string'),
    }
  } catch {
    return null
  }
}

export interface Headroom {
  key: string
  label: string
  used: number
  limit: number
  /** What the month will reach at this pace (null for a level that isn't per month, like a database's size). */
  projected: number | null
  unit: 'count' | 'bytes'
  /** A hard limit refuses past it; an included amount is billed past it. */
  hard: boolean
}

/**
 * The account against the plan: the month's requests and rows so far with the month's projection at this pace, the
 * storage of all databases together, and the largest database against the hard limit.
 */
export function headroom(snapshot: Snapshot): Headroom[] {
  const elapsed = Math.max(snapshot.takenAt - snapshot.monthStart, 60 * 60 * 1000)
  const monthEnd = Date.UTC(new Date(snapshot.monthStart).getUTCFullYear(), new Date(snapshot.monthStart).getUTCMonth() + 1, 1)
  const project = (used: number) => Math.round(used * ((monthEnd - snapshot.monthStart) / elapsed))
  const rows: Headroom[] = []
  if (snapshot.workers) {
    const requests = snapshot.workers.reduce((sum, worker) => sum + worker.requestsMonth, 0)
    rows.push({ key: 'requests', label: 'Worker requests this month', used: requests, limit: PLAN.workerRequestsPerMonth, projected: project(requests), unit: 'count', hard: false })
  }
  if (snapshot.databases) {
    const read = snapshot.databases.reduce((sum, db) => sum + db.rowsReadMonth, 0)
    const written = snapshot.databases.reduce((sum, db) => sum + db.rowsWrittenMonth, 0)
    const storage = snapshot.databases.reduce((sum, db) => sum + db.sizeBytes, 0)
    const largest = snapshot.databases.reduce<DatabaseUsage | null>((top, db) => (!top || db.sizeBytes > top.sizeBytes ? db : top), null)
    rows.push(
      { key: 'rows_read', label: 'D1 rows read this month', used: read, limit: PLAN.d1RowsReadPerMonth, projected: project(read), unit: 'count', hard: false },
      { key: 'rows_written', label: 'D1 rows written this month', used: written, limit: PLAN.d1RowsWrittenPerMonth, projected: project(written), unit: 'count', hard: false },
      { key: 'storage', label: 'D1 storage, all databases', used: storage, limit: PLAN.d1StorageBytes, projected: null, unit: 'bytes', hard: false },
    )
    if (largest) {
      rows.push({ key: 'largest_db', label: `Largest database (${largest.name})`, used: largest.sizeBytes, limit: PLAN.d1DatabaseMaxBytes, projected: null, unit: 'bytes', hard: true })
    }
  }
  return rows
}

/** The share of a limit that counts as a warning on the overview: 80%, or a projection past the limit. */
export function isWarning(row: Headroom): boolean {
  return row.used >= row.limit * 0.8 || (row.projected !== null && row.projected >= row.limit)
}
