// The Cloudflare resources the platform runs on (DESIGN.md §11.5), read once an hour by the five-minute tick with a
// read-only API token: every insulin-apps Worker with its requests, errors and CPU time, and the D1 database each one
// binds, with its size and the rows it read and wrote yesterday and this month. The console compares them with the
// plan's allowances and projects the month, so the operators see a limit coming. The token needs only Workers Scripts:
// Read and Account Analytics: Read, never a D1 permission, which could query the apps' databases: the databases come
// from the Workers' bindings and their sizes from the analytics. It is sent to api.cloudflare.com only, never logged,
// and no redirect is followed.
import type { CloudflareConfig } from '../config.ts'
import { log } from '../log.ts'

const API = 'https://api.cloudflare.com/client/v4'
const TIMEOUT_MS = 20_000
/** The platform's Workers and databases are named insulin-apps-<name> (deploy-apps.mjs). */
export const RESOURCE_PREFIX = 'insulin-apps-'
/** The Worker every request from outside reaches. */
export const GATEWAY_WORKER = `${RESOURCE_PREFIX}gateway`

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

/** A Worker's usage; each figure is null when the analytics couldn't be read (unknown, never zero). */
export interface WorkerUsage {
  name: string
  requests24h: number | null
  errors24h: number | null
  requestsMonth: number | null
  errorsMonth: number | null
  /** CPU time per request in the last day, microseconds: median and 99th percentile, or null without requests. */
  cpuP50: number | null
  cpuP99: number | null
}

export interface DatabaseUsage {
  /** The Worker that binds it (each Worker has one database, named after it). */
  name: string
  id: string
  /** Its size from the analytics, or null when they couldn't be read. */
  sizeBytes: number | null
  /** D1's analytics count by UTC day, so the shortest window they give is a whole day: yesterday. Null when unread. */
  rowsReadYesterday: number | null
  rowsWrittenYesterday: number | null
  rowsReadMonth: number | null
  rowsWrittenMonth: number | null
}

export interface Snapshot {
  takenAt: number
  /** The first millisecond of the UTC month the month's figures count from. */
  monthStart: number
  workers: WorkerUsage[] | null
  databases: DatabaseUsage[] | null
  /** What failed, by part ("workers", "settings", "analytics", "storage"), as a short code; empty when everything was read. */
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

/**
 * The D1 database each Worker binds, from its settings (Workers Scripts: Read): the database's id, named after the
 * Worker, as the deploy names each database after its Worker.
 */
async function boundDatabases(fetchImpl: Fetch, config: CloudflareConfig, names: string[]): Promise<{ name: string; id: string }[]> {
  const found = await Promise.all(names.map(async (name) => {
    const body = record(await call(fetchImpl, config, `/accounts/${config.accountId}/workers/scripts/${encodeURIComponent(name)}/settings`))
    if (body.success !== true) throw new CloudflareError('api_error')
    return list(record(body.result).bindings).map(record).filter((binding) => binding.type === 'd1')
      .map((binding) => binding.id ?? binding.database_id).filter((id): id is string => typeof id === 'string')
      .map((id) => ({ name, id }))
  }))
  return found.flat().sort((a, b) => a.name.localeCompare(b.name))
}

// Workers' invocations for the last 24 hours and the month so far, and D1's rows for yesterday and the month (D1's
// analytics count by UTC day), in one GraphQL request.
const ANALYTICS_QUERY = `query ($account: String!, $dayStart: Time!, $monthStart: Time!, $end: Time!, $yesterday: Date!, $monthStartDate: Date!, $endDate: Date!) {
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
      d1Yesterday: d1AnalyticsAdaptiveGroups(limit: 1000, filter: { date_geq: $yesterday, date_leq: $yesterday }) {
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

// Each database's size, the largest it was each day of the last two (so there is one for today early in the day), in
// a request of its own: a part that fails leaves the rest of the snapshot.
const STORAGE_QUERY = `query ($account: String!, $yesterday: Date!, $endDate: Date!) {
  viewer {
    accounts(filter: { accountTag: $account }) {
      storage: d1StorageAdaptiveGroups(limit: 1000, filter: { date_geq: $yesterday, date_leq: $endDate }) {
        dimensions { databaseId date }
        max { databaseSizeBytes }
      }
    }
  }
}`

interface Analytics {
  workers: Map<string, { requests24h: number; errors24h: number; requestsMonth: number; errorsMonth: number; cpuP50: number | null; cpuP99: number | null }>
  databases: Map<string, { rowsReadYesterday: number; rowsWrittenYesterday: number; rowsReadMonth: number; rowsWrittenMonth: number }>
}

function date(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

const DAY_MS = 24 * 60 * 60 * 1000

/** The first (only) account of a GraphQL answer, or an error. */
async function graphql(fetchImpl: Fetch, config: CloudflareConfig, query: string, variables: Record<string, string>): Promise<Record<string, unknown>> {
  const body = record(await call(fetchImpl, config, '/graphql', { method: 'POST', body: JSON.stringify({ query, variables: { account: config.accountId, ...variables } }) }))
  if (list(body.errors).length) throw new CloudflareError('graphql_error')
  return record(list(record(record(body.data).viewer).accounts)[0])
}

async function analytics(fetchImpl: Fetch, config: CloudflareConfig, now: number, monthStart: number): Promise<Analytics> {
  const account = await graphql(fetchImpl, config, ANALYTICS_QUERY, {
    dayStart: new Date(now - DAY_MS).toISOString(),
    monthStart: new Date(monthStart).toISOString(),
    end: new Date(now).toISOString(),
    yesterday: date(now - DAY_MS),
    monthStartDate: date(monthStart),
    endDate: date(now),
  })
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
    if (!entry) dbs.set(id, entry = { rowsReadYesterday: 0, rowsWrittenYesterday: 0, rowsReadMonth: 0, rowsWrittenMonth: 0 })
    return entry
  }
  for (const group of list(account.d1Yesterday).map(record)) {
    const id = record(group.dimensions).databaseId
    if (typeof id !== 'string') continue
    const entry = database(id)
    entry.rowsReadYesterday += number(record(group.sum).rowsRead)
    entry.rowsWrittenYesterday += number(record(group.sum).rowsWritten)
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

/** Each database's latest size: the most recent day's largest. */
async function storage(fetchImpl: Fetch, config: CloudflareConfig, now: number): Promise<Map<string, number>> {
  const account = await graphql(fetchImpl, config, STORAGE_QUERY, { yesterday: date(now - DAY_MS), endDate: date(now) })
  const latest = new Map<string, { date: string; size: number }>()
  for (const group of list(account.storage).map(record)) {
    const dimensions = record(group.dimensions)
    const id = dimensions.databaseId
    const day = typeof dimensions.date === 'string' ? dimensions.date : ''
    if (typeof id !== 'string') continue
    const size = number(record(group.max).databaseSizeBytes)
    const seen = latest.get(id)
    if (!seen || day > seen.date) latest.set(id, { date: day, size })
  }
  return new Map([...latest].map(([id, entry]) => [id, entry.size]))
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
  const failed = (part: string) => (error: unknown) => { problems.push(`${part}:${code(error)}`); return null }
  const [names, usage, sizes] = await Promise.all([
    workerNames(fetchImpl, config).catch(failed('workers')),
    analytics(fetchImpl, config, now, monthStart).catch(failed('analytics')),
    storage(fetchImpl, config, now).catch(failed('storage')),
  ])
  const bound = names ? await boundDatabases(fetchImpl, config, names).catch(failed('settings')) : null
  // A Worker or database the analytics don't mention had no traffic (zero); with no analytics at all, it's unknown.
  const known = (value: number | undefined) => (usage ? value ?? 0 : null)
  const workers = names?.map((name) => {
    const entry = usage?.workers.get(name)
    return {
      name,
      requests24h: known(entry?.requests24h),
      errors24h: known(entry?.errors24h),
      requestsMonth: known(entry?.requestsMonth),
      errorsMonth: known(entry?.errorsMonth),
      cpuP50: entry?.cpuP50 ?? null,
      cpuP99: entry?.cpuP99 ?? null,
    }
  }) ?? null
  const databaseUsage = bound?.map((db) => {
    const entry = usage?.databases.get(db.id)
    return {
      ...db,
      sizeBytes: sizes?.get(db.id) ?? null,
      rowsReadYesterday: known(entry?.rowsReadYesterday),
      rowsWrittenYesterday: known(entry?.rowsWrittenYesterday),
      rowsReadMonth: known(entry?.rowsReadMonth),
      rowsWrittenMonth: known(entry?.rowsWrittenMonth),
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
 * storage of all databases together, and the largest database against the hard limit. Requests are the gateway's:
 * every request from outside reaches it first, and its calls to the apps go over service bindings, which Cloudflare
 * doesn't bill as requests. The allowances are the account's, so the meters assume an account that runs Insulin Apps
 * alone.
 */
export function headroom(snapshot: Snapshot): Headroom[] {
  const elapsed = snapshot.takenAt - snapshot.monthStart
  const monthEnd = Date.UTC(new Date(snapshot.monthStart).getUTCFullYear(), new Date(snapshot.monthStart).getUTCMonth() + 1, 1)
  // Less than an hour into the month is too little to project from: the meter then shows no projection.
  const project = (used: number) => (elapsed < 60 * 60 * 1000 ? null : Math.round(used * ((monthEnd - snapshot.monthStart) / elapsed)))
  const rows: Headroom[] = []
  // A figure that wasn't read makes no meter: an unknown is never shown as zero.
  const gateway = snapshot.workers?.find((worker) => worker.name === GATEWAY_WORKER)
  if (gateway && gateway.requestsMonth !== null) {
    rows.push({ key: 'requests', label: 'Gateway requests this month', used: gateway.requestsMonth, limit: PLAN.workerRequestsPerMonth, projected: project(gateway.requestsMonth), unit: 'count', hard: false })
  }
  if (snapshot.databases) {
    // A meter needs every database's figure: a total that leaves one out understates, and none at all isn't zero.
    const any = snapshot.databases.length > 0
    const rowsKnown = any && snapshot.databases.every((db) => db.rowsReadMonth !== null && db.rowsWrittenMonth !== null)
    const sizesKnown = any && snapshot.databases.every((db) => db.sizeBytes !== null)
    const read = snapshot.databases.reduce((sum, db) => sum + (db.rowsReadMonth ?? 0), 0)
    const written = snapshot.databases.reduce((sum, db) => sum + (db.rowsWrittenMonth ?? 0), 0)
    const storage = snapshot.databases.reduce((sum, db) => sum + (db.sizeBytes ?? 0), 0)
    const largest = snapshot.databases.reduce<DatabaseUsage | null>((top, db) => (!top || (db.sizeBytes ?? 0) > (top.sizeBytes ?? 0) ? db : top), null)
    if (rowsKnown) {
      rows.push(
        { key: 'rows_read', label: 'D1 rows read this month', used: read, limit: PLAN.d1RowsReadPerMonth, projected: project(read), unit: 'count', hard: false },
        { key: 'rows_written', label: 'D1 rows written this month', used: written, limit: PLAN.d1RowsWrittenPerMonth, projected: project(written), unit: 'count', hard: false },
      )
    }
    if (sizesKnown) rows.push({ key: 'storage', label: 'D1 storage, all databases', used: storage, limit: PLAN.d1StorageBytes, projected: null, unit: 'bytes', hard: false })
    if (sizesKnown && largest) {
      rows.push({ key: 'largest_db', label: `Largest database (${largest.name})`, used: largest.sizeBytes ?? 0, limit: PLAN.d1DatabaseMaxBytes, projected: null, unit: 'bytes', hard: true })
    }
  }
  return rows
}

/** The share of a limit that counts as a warning on the overview: 80%, or a projection past the limit. */
export function isWarning(row: Headroom): boolean {
  return row.used >= row.limit * 0.8 || (row.projected !== null && row.projected >= row.limit)
}
