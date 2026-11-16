// The Cloudflare resources the platform runs on (DESIGN.md §11.5), read once an hour by the five-minute tick with a
// read-only API token: every insulin-apps Worker with its requests, errors and CPU time, and the D1 database each one
// binds, with its size and the rows it read and wrote yesterday and this month; and for the apps' engines (DESIGN.md
// §8.7, Workers named insulin-apps-<app>-engine), their container instances and the account's Durable Object
// requests, Containers' vCPU, memory and disk time and R2 storage and operations. The console compares them with the
// plan's allowances and projects the month, so the operators see a limit coming. The token needs only Workers Scripts:
// Read, Account Analytics: Read and Containers: Read, never a D1 permission, which could query the apps' databases (the
// databases come from the Workers' bindings and their sizes from the analytics), nor an R2 one, which would read every
// object in the engines' buckets (their sizes and operations come from the analytics too). It is sent to
// api.cloudflare.com only, never logged, and no redirect is followed.
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
  // Durable Objects' pricing page: 1 million requests and 400,000 GB-s of duration a month.
  durableObjectRequestsPerMonth: 1_000_000,
  durableObjectDurationGbSecondsPerMonth: 400_000,
  // Containers' pricing page: 375 vCPU-minutes, 25 GiB-hours of memory and 200 GB-hours of disk a month.
  containerVcpuSecondsPerMonth: 375 * 60,
  containerMemoryGibSecondsPerMonth: 25 * 60 * 60,
  containerDiskGbSecondsPerMonth: 200 * 60 * 60,
  // R2's pricing page: 10 GB-month of Standard storage, 1 million Class A and 10 million Class B operations a month.
  r2StorageBytes: 10 * 1000 ** 3,
  r2ClassAPerMonth: 1_000_000,
  r2ClassBPerMonth: 10_000_000,
  // Workers AI's pricing page: 10,000 neurons a day at no charge.
  workersAiNeuronsPerDay: 10_000,
} as const

/** An engine Worker's name: an app's Worker name with -engine (list-apps.mjs refuses app names ending in -engine). */
export function isEngineWorker(name: string): boolean {
  return name.startsWith(RESOURCE_PREFIX) && name.endsWith('-engine') && name !== `${RESOURCE_PREFIX}engine`
}

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

/**
 * One app's engine Worker and what it runs; each figure is null when it couldn't be read (unknown, never zero). Its
 * R2 buckets are the deploy's, insulin-apps-<app>-engine-<binding>, and its container applications those whose Durable
 * Object namespace is one of its bindings (or whose name starts with its own, as Wrangler names them).
 */
export interface EngineUsage {
  name: string
  containerApplications: number | null
  /** Instances running or starting now, from the Containers API's health counts. */
  containerInstances: number | null
  vcpuSecondsMonth: number | null
  memoryGibSecondsMonth: number | null
  diskGbSecondsMonth: number | null
  r2Bytes: number | null
  r2Objects: number | null
  r2ClassAMonth: number | null
  r2ClassBMonth: number | null
}

/**
 * The engines' account-wide figures, which the plan's allowances are for; each null when unread. Two are never read:
 * Cloudflare documents no GraphQL field for Durable Objects' duration (GB-s) nor a GraphQL dataset for Workers AI's
 * neurons, so they stay unknown rather than guessed (DESIGN.md §11.5). Container snapshots have no API either: their
 * count comes from the app's usage report.
 */
export interface EngineTotals {
  durableObjectRequestsMonth: number | null
  durableObjectDurationGbSecondsMonth: number | null
  vcpuSecondsMonth: number | null
  memoryGibSecondsMonth: number | null
  diskGbSecondsMonth: number | null
  r2Bytes: number | null
  r2ClassAMonth: number | null
  r2ClassBMonth: number | null
  workersAiNeuronsMonth: number | null
}

export interface Snapshot {
  takenAt: number
  /** The first millisecond of the UTC month the month's figures count from. */
  monthStart: number
  workers: WorkerUsage[] | null
  databases: DatabaseUsage[] | null
  /** The engine Workers; empty when there are none, null when the Workers couldn't be listed (or an older snapshot). */
  engines: EngineUsage[] | null
  /** Null when there is no engine to read for (or an older snapshot). */
  engineTotals: EngineTotals | null
  /**
   * What failed, by part ("workers", "settings", "analytics", "storage", and for engines "containers", "r2",
   * "durable_objects", "container_usage"), as a short code; empty when everything was read.
   */
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

/** What a Worker's settings bind: its D1 database (by id) and its Durable Object namespaces (by id). */
interface WorkerBindings {
  name: string
  databases: string[]
  namespaces: string[]
}

/**
 * The bindings of each Worker, from its settings (Workers Scripts: Read): the D1 database's id, named after the Worker,
 * as the deploy names each database after its Worker, and an engine's Durable Object namespaces, which its container
 * applications name.
 */
async function workerBindings(fetchImpl: Fetch, config: CloudflareConfig, names: string[]): Promise<WorkerBindings[]> {
  return Promise.all(names.map(async (name) => {
    const body = record(await call(fetchImpl, config, `/accounts/${config.accountId}/workers/scripts/${encodeURIComponent(name)}/settings`))
    if (body.success !== true) throw new CloudflareError('api_error')
    const bindings = list(record(body.result).bindings).map(record)
    return {
      name,
      databases: bindings.filter((binding) => binding.type === 'd1').map((binding) => binding.id ?? binding.database_id)
        .filter((id): id is string => typeof id === 'string'),
      namespaces: bindings.filter((binding) => binding.type === 'durable_object_namespace').map((binding) => binding.namespace_id)
        .filter((id): id is string => typeof id === 'string'),
    }
  }))
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

// The engines' figures (DESIGN.md §11.5), each product in a GraphQL request of its own, so one that fails leaves the
// others. The datasets and fields are the ones Cloudflare documents (developers.cloudflare.com, checked 2026-11-16):
// "r2StorageAdaptiveGroups" (max payloadSize, metadataSize, objectCount; dimension bucketName) and
// "r2OperationsAdaptiveGroups" (sum requests; dimensions bucketName, actionType) on R2's metrics and analytics page;
// "durableObjectsInvocationsAdaptiveGroups" (sum requests) on Durable Objects' metrics and analytics page; and
// "containersUsageAdaptiveGroups" (sum cpuTimeSec, and allocatedMemory and allocatedDisk in byte-seconds; dimension
// applicationId) on the GraphQL API's tutorial on Containers metrics. Durable Objects' page documents no field for
// duration (GB-s), and no dataset for Workers AI's neurons is documented, so those two stay unknown.
const R2_QUERY = `query ($account: String!, $dayStart: Time!, $monthStart: Time!, $end: Time!) {
  viewer {
    accounts(filter: { accountTag: $account }) {
      r2Storage: r2StorageAdaptiveGroups(limit: 1000, filter: { datetime_geq: $dayStart, datetime_leq: $end }) {
        dimensions { bucketName }
        max { payloadSize metadataSize objectCount }
      }
      r2Operations: r2OperationsAdaptiveGroups(limit: 10000, filter: { datetime_geq: $monthStart, datetime_leq: $end }) {
        dimensions { bucketName actionType }
        sum { requests }
      }
    }
  }
}`

const DURABLE_OBJECTS_QUERY = `query ($account: String!, $monthStartDate: Date!, $endDate: Date!) {
  viewer {
    accounts(filter: { accountTag: $account }) {
      durableObjects: durableObjectsInvocationsAdaptiveGroups(limit: 1000, filter: { date_geq: $monthStartDate, date_leq: $endDate }) {
        sum { requests }
      }
    }
  }
}`

const CONTAINER_USAGE_QUERY = `query ($account: String!, $monthStart: Time!, $end: Time!) {
  viewer {
    accounts(filter: { accountTag: $account }) {
      containers: containersUsageAdaptiveGroups(limit: 1000, filter: { datetime_geq: $monthStart, datetime_lt: $end }) {
        dimensions { applicationId }
        sum { cpuTimeSec allocatedMemory allocatedDisk }
      }
    }
  }
}`

// R2's operation classes, as its pricing page lists them; anything else (deleting, say) is free and not counted.
const R2_CLASS_A = new Set([
  'ListBuckets', 'PutBucket', 'ListObjects', 'PutObject', 'CopyObject', 'CompleteMultipartUpload', 'CreateMultipartUpload',
  'LifecycleStorageTierTransition', 'ListMultipartUploads', 'UploadPart', 'UploadPartCopy', 'ListParts', 'PutBucketEncryption',
  'PutBucketCors', 'PutBucketLifecycleConfiguration',
])
const R2_CLASS_B = new Set([
  'HeadBucket', 'HeadObject', 'GetObject', 'UsageSummary', 'GetBucketEncryption', 'GetBucketLocation', 'GetBucketCors',
  'GetBucketLifecycleConfiguration',
])

interface R2Bucket { bytes: number; objects: number; classA: number; classB: number }

/** The platform's R2 buckets (insulin-apps-*): the most each held in the last day, and its operations this month. */
async function r2Usage(fetchImpl: Fetch, config: CloudflareConfig, now: number, monthStart: number): Promise<Map<string, R2Bucket>> {
  const account = await graphql(fetchImpl, config, R2_QUERY, {
    dayStart: new Date(now - DAY_MS).toISOString(), monthStart: new Date(monthStart).toISOString(), end: new Date(now).toISOString(),
  })
  const buckets = new Map<string, R2Bucket>()
  const bucket = (name: string) => {
    let entry = buckets.get(name)
    if (!entry) buckets.set(name, entry = { bytes: 0, objects: 0, classA: 0, classB: 0 })
    return entry
  }
  for (const group of list(account.r2Storage).map(record)) {
    const name = record(group.dimensions).bucketName
    if (typeof name !== 'string' || !name.startsWith(RESOURCE_PREFIX)) continue
    const max = record(group.max)
    const entry = bucket(name)
    entry.bytes = Math.max(entry.bytes, number(max.payloadSize) + number(max.metadataSize))
    entry.objects = Math.max(entry.objects, number(max.objectCount))
  }
  for (const group of list(account.r2Operations).map(record)) {
    const dimensions = record(group.dimensions)
    const name = dimensions.bucketName
    if (typeof name !== 'string' || !name.startsWith(RESOURCE_PREFIX)) continue
    const requests = number(record(group.sum).requests)
    if (R2_CLASS_A.has(String(dimensions.actionType))) bucket(name).classA += requests
    else if (R2_CLASS_B.has(String(dimensions.actionType))) bucket(name).classB += requests
  }
  return buckets
}

/** Durable Object requests this month, all of the account's. */
async function durableObjectRequests(fetchImpl: Fetch, config: CloudflareConfig, now: number, monthStart: number): Promise<number> {
  const account = await graphql(fetchImpl, config, DURABLE_OBJECTS_QUERY, { monthStartDate: date(monthStart), endDate: date(now) })
  return list(account.durableObjects).map(record).reduce((sum, group) => sum + number(record(group.sum).requests), 0)
}

interface ContainerTime { vcpuSeconds: number; memoryGibSeconds: number; diskGbSeconds: number }

/** Each container application's vCPU, memory and disk time this month (memory in GiB-s, disk in GB-s, as billed). */
async function containerUsage(fetchImpl: Fetch, config: CloudflareConfig, now: number, monthStart: number): Promise<Map<string, ContainerTime>> {
  const account = await graphql(fetchImpl, config, CONTAINER_USAGE_QUERY, { monthStart: new Date(monthStart).toISOString(), end: new Date(now).toISOString() })
  const usage = new Map<string, ContainerTime>()
  for (const group of list(account.containers).map(record)) {
    const id = record(group.dimensions).applicationId
    const sum = record(group.sum)
    const key = typeof id === 'string' ? id : ''
    const entry = usage.get(key) ?? { vcpuSeconds: 0, memoryGibSeconds: 0, diskGbSeconds: 0 }
    entry.vcpuSeconds += number(sum.cpuTimeSec)
    entry.memoryGibSeconds += number(sum.allocatedMemory) / 1024 ** 3
    entry.diskGbSeconds += number(sum.allocatedDisk) / 1000 ** 3
    usage.set(key, entry)
  }
  return usage
}

interface ContainerApplication {
  id: string
  name: string
  namespace: string | null
  /** Running or starting now, or null when the API gave no health counts. */
  instances: number | null
}

/**
 * The account's container applications (Containers: Read), with the instances each has running or starting: the
 * health counts of GET /accounts/{account}/containers/applications ("active" with "assigned" or "starting"), page by
 * page, at most ten.
 */
async function containerApplications(fetchImpl: Fetch, config: CloudflareConfig): Promise<ContainerApplication[]> {
  const applications: ContainerApplication[] = []
  let token: string | null = null
  for (let page = 0; page < 10; page += 1) {
    const query: string = token ? `?page_token=${encodeURIComponent(token)}` : ''
    const body = record(await call(fetchImpl, config, `/accounts/${config.accountId}/containers/applications${query}`))
    if (body.success !== true) throw new CloudflareError('api_error')
    for (const item of list(body.result).map(record)) {
      if (typeof item.id !== 'string' || typeof item.name !== 'string') continue
      const counts = record(record(item.health).instances)
      const live = ['active', 'assigned', 'starting'].map((state) => counts[state]).filter((value): value is number => typeof value === 'number')
      const namespace = record(item.durable_objects).namespace_id
      applications.push({
        id: item.id,
        name: item.name,
        namespace: typeof namespace === 'string' ? namespace : null,
        instances: live.length ? live.reduce((sum, value) => sum + number(value), 0) : null,
      })
    }
    const next = record(body.result_info).next_page_token
    token = typeof next === 'string' && next ? next : null
    if (!token) break
  }
  return applications
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
  const engineNames = names?.filter(isEngineWorker) ?? null
  // Without an engine there is nothing of one to read; when the Workers couldn't be listed, the account's engine figures
  // are still read, since there may be one.
  const readEngines = engineNames === null || engineNames.length > 0
  const [bindings, applications, buckets, objectRequests, containerTime] = await Promise.all([
    names ? workerBindings(fetchImpl, config, names).catch(failed('settings')) : null,
    readEngines ? containerApplications(fetchImpl, config).catch(failed('containers')) : null,
    readEngines ? r2Usage(fetchImpl, config, now, monthStart).catch(failed('r2')) : null,
    readEngines ? durableObjectRequests(fetchImpl, config, now, monthStart).catch(failed('durable_objects')) : null,
    readEngines ? containerUsage(fetchImpl, config, now, monthStart).catch(failed('container_usage')) : null,
  ])
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
  const bound = bindings?.flatMap((worker) => worker.databases.map((id) => ({ name: worker.name, id }))).sort((a, b) => a.name.localeCompare(b.name)) ?? null
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
  const total = <T>(items: T[] | null, value: (item: T) => number) => (items ? items.reduce((sum, item) => sum + value(item), 0) : null)
  const engines = engineNames?.map((name): EngineUsage => {
    const namespaces = new Set(bindings?.find((worker) => worker.name === name)?.namespaces ?? [])
    const apps = applications?.filter((app) => (app.namespace !== null && namespaces.has(app.namespace)) || app.name === name || app.name.startsWith(`${name}-`)) ?? null
    const time = apps && containerTime ? apps.map((app) => containerTime.get(app.id) ?? { vcpuSeconds: 0, memoryGibSeconds: 0, diskGbSeconds: 0 }) : null
    const r2 = buckets ? [...buckets].filter(([bucket]) => bucket.startsWith(`${name}-`)).map(([, entry]) => entry) : null
    return {
      name,
      containerApplications: apps?.length ?? null,
      containerInstances: apps && apps.every((app) => app.instances !== null) ? total(apps, (app) => app.instances ?? 0) : null,
      vcpuSecondsMonth: total(time, (entry) => entry.vcpuSeconds),
      memoryGibSecondsMonth: total(time, (entry) => entry.memoryGibSeconds),
      diskGbSecondsMonth: total(time, (entry) => entry.diskGbSeconds),
      r2Bytes: total(r2, (entry) => entry.bytes),
      r2Objects: total(r2, (entry) => entry.objects),
      r2ClassAMonth: total(r2, (entry) => entry.classA),
      r2ClassBMonth: total(r2, (entry) => entry.classB),
    }
  }) ?? null
  const time = containerTime ? [...containerTime.values()] : null
  const allBuckets = buckets ? [...buckets.values()] : null
  const engineTotals: EngineTotals | null = readEngines ? {
    durableObjectRequestsMonth: objectRequests,
    // No documented source: unknown, never guessed.
    durableObjectDurationGbSecondsMonth: null,
    vcpuSecondsMonth: total(time, (entry) => entry.vcpuSeconds),
    memoryGibSecondsMonth: total(time, (entry) => entry.memoryGibSeconds),
    diskGbSecondsMonth: total(time, (entry) => entry.diskGbSeconds),
    r2Bytes: total(allBuckets, (entry) => entry.bytes),
    r2ClassAMonth: total(allBuckets, (entry) => entry.classA),
    r2ClassBMonth: total(allBuckets, (entry) => entry.classB),
    workersAiNeuronsMonth: null,
  } : null
  // The parts run at once, so they fail in any order: sorted, the same failures always read the same.
  problems.sort()
  if (problems.length) log('cloudflare_snapshot_partial', { problems: problems.join(', ') })
  return { takenAt: now, monthStart, workers, databases: databaseUsage, engines, engineTotals, problems }
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
      // Snapshots from before the engines were read have neither: unknown.
      engines: Array.isArray(value.engines) ? (value.engines as EngineUsage[]) : null,
      engineTotals: typeof value.engineTotals === 'object' && value.engineTotals !== null && !Array.isArray(value.engineTotals) ? (value.engineTotals as EngineTotals) : null,
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
  // The engines' (DESIGN.md §8.7), account-wide like the plan's allowances; only figures that were read make a meter.
  const engines = snapshot.engineTotals
  if (engines) {
    const monthly = (key: string, label: string, used: number | null, limit: number) => {
      if (used !== null) rows.push({ key, label, used, limit, projected: project(used), unit: 'count', hard: false })
    }
    monthly('do_requests', 'Durable Object requests this month', engines.durableObjectRequestsMonth, PLAN.durableObjectRequestsPerMonth)
    monthly('do_duration', 'Durable Object duration this month, GB-s', engines.durableObjectDurationGbSecondsMonth, PLAN.durableObjectDurationGbSecondsPerMonth)
    monthly('container_vcpu', 'Containers vCPU-seconds this month', engines.vcpuSecondsMonth, PLAN.containerVcpuSecondsPerMonth)
    monthly('container_memory', 'Containers memory this month, GiB-s', engines.memoryGibSecondsMonth, PLAN.containerMemoryGibSecondsPerMonth)
    monthly('container_disk', 'Containers disk this month, GB-s', engines.diskGbSecondsMonth, PLAN.containerDiskGbSecondsPerMonth)
    if (engines.r2Bytes !== null) {
      rows.push({ key: 'r2_storage', label: 'R2 storage, all engine buckets', used: engines.r2Bytes, limit: PLAN.r2StorageBytes, projected: null, unit: 'bytes', hard: false })
    }
    monthly('r2_class_a', 'R2 Class A operations this month', engines.r2ClassAMonth, PLAN.r2ClassAPerMonth)
    monthly('r2_class_b', 'R2 Class B operations this month', engines.r2ClassBMonth, PLAN.r2ClassBPerMonth)
    if (engines.workersAiNeuronsMonth !== null) {
      // The free allocation is per day, so a month's is the days in it.
      const days = Math.round((monthEnd - snapshot.monthStart) / DAY_MS)
      monthly('ai_neurons', 'Workers AI neurons this month', engines.workersAiNeuronsMonth, PLAN.workersAiNeuronsPerDay * days)
    }
  }
  return rows
}

/** The share of a limit that counts as a warning on the overview: 80%, or a projection past the limit. */
export function isWarning(row: Headroom): boolean {
  return row.used >= row.limit * 0.8 || (row.projected !== null && row.projected >= row.limit)
}
