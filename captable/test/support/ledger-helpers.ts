import { afterEach, expect, vi } from 'vitest'
import { api, engine } from '../../src/app/shared/index.ts'
import type { AppConfig } from '../../src/app/server/lib/config.ts'
import {
  commandInsert,
  dependencyInsert,
  prepare,
  receiptInsert,
  securityInsert,
  stmt,
  transactionInsert,
  type Stmt,
} from '../../src/app/server/lib/ledger/statements.ts'
import type { Actor } from '../../src/app/server/lib/ledger/types.ts'
import { ledgerCache } from '../../src/app/server/lib/read/ledger.ts'
import { buildAcme, VALUATIONS, VS_1, type Acme } from '../shared/engine/fixtures/acme.ts'
import { uuid, type LedgerBuilder } from '../shared/engine/fixtures/builder.ts'
import { appRequest, consoleHeaders, createTestDatabase, type ConsoleIdentity } from './server-harness.ts'

/**
 * The synthetic "Acme Robotics, Inc." org of the engine's demo fixture (`buildAcme`), loaded into a fresh migrated test
 * database the way a committed import leaves it, with console identities for the three admin roles and a pinned clock.
 * All names, ids, addresses and numbers are fictional.
 */

/** The demo's day: the engine's golden numbers are as of 2026-10-21. */
export const ACME_TODAY = '2026-10-21'
/** 13:00 in Los Angeles (the org's time zone) on the demo's day. */
export const ACME_NOW = Date.UTC(2026, 9, 21, 20)
export const SEED_USER_ID = '10000000-0000-4000-8000-00000000a001'
export const OWNER_USER_ID = '10000000-0000-4000-8000-00000000a002'
export const ADMIN_USER_ID = '10000000-0000-4000-8000-00000000a003'
export const EDITOR_USER_ID = '10000000-0000-4000-8000-00000000a004'
export const OWNER_EMAIL = 'owner@example.test'
export const ADMIN_EMAIL = 'admin@example.test'
export const EDITOR_EMAIL = 'editor@example.test'
export const VS1_TEMPLATE_ID = uuid('template:VS-1')
export const ORIGIN = 'http://app.test'
/** The request configuration the app derives for the test origin, for calls that bypass the router. */
export const TEST_CONFIG: AppConfig = { origin: ORIGIN, portalEnabled: true }
const IMPORT_ROUTE = 'POST /api/import'
const IMPORT_ACTOR = 'import:seed'

export type Identity = Record<string, string>

/** OWNER and ADMIN manage the cap table (admin_rw); EDITOR reads everything (admin_ro). */
export const OWNER: Identity = consoleHeaders({ userId: OWNER_USER_ID, role: 'OWNER', email: OWNER_EMAIL, name: 'Owner Example' })
export const ADMIN: Identity = consoleHeaders({ userId: ADMIN_USER_ID, role: 'ADMIN', email: ADMIN_EMAIL, name: 'Admin Example' })
export const EDITOR: Identity = consoleHeaders({ userId: EDITOR_USER_ID, role: 'EDITOR', email: EDITOR_EMAIL, name: 'Editor Example' })

/** A console USER/VIEWER: holder access only while the e-mail matches a stakeholder's own address. */
export function holderIdentity(email: string, overrides: Partial<ConsoleIdentity> = {}): Identity {
  return consoleHeaders({
    userId: `holder-${engine.sha256Hex(email.toLowerCase()).slice(0, 12)}`,
    role: 'VIEWER', email, name: 'Holder Example', ...overrides,
  })
}

/** The ledger actor of a console administrator, for tests that call the ledger's functions directly. */
export function consoleActor(userId: string, email: string): Actor {
  return { kind: 'user', userId, email, authMethod: 'console', receiptActor: userId, fullAccess: true }
}

// ---------------------------------------------------------------------------------------------------------------------
// The clock: the app reads `Date.now()` at call time, so a fake Date pins every request's "now" (and the org's today).

export interface TestClock {
  time: number
}

function pinClock(time: number): TestClock {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(time)
  return {
    get time() { return Date.now() },
    set time(value: number) { vi.setSystemTime(value) },
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// The contract check every response passes (the shared route table): the declared status, a strict success body, and
// an error envelope whose code, violations and warnings the route documents.

function routePattern(path: string): RegExp {
  const pattern = path.split('/')
    .map((segment) => segment.startsWith(':') ? '([^/]+)' : segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('/')
  return new RegExp(`^${pattern}$`)
}

const CONTRACT_ROUTES = api.ROUTE_TABLE.map((route) => ({ route, pattern: routePattern(route.path) }))

function unknownKeys(raw: unknown, parsed: unknown, path = '<root>'): string[] {
  if (Array.isArray(raw) && Array.isArray(parsed)) return raw.flatMap((value, index) => unknownKeys(value, parsed[index], `${path}.${index}`))
  if (raw === null || parsed === null || typeof raw !== 'object' || typeof parsed !== 'object' || Array.isArray(raw) || Array.isArray(parsed)) return []
  const known = parsed as Record<string, unknown>
  return Object.entries(raw as Record<string, unknown>).flatMap(([key, value]) => Object.hasOwn(known, key)
    ? unknownKeys(value, known[key], path === '<root>' ? key : `${path}.${key}`)
    : [path === '<root>' ? key : `${path}.${key}`])
}

function issuesText(error: { issues: readonly { path: readonly PropertyKey[]; message: string }[] }): string {
  return error.issues.map((issue) => `${issue.path.map(String).join('.') || '<root>'}: ${issue.message}`).join('; ')
}

/** Throws when a response breaks the shared contract; the response itself is never consumed. */
export async function checkContract(method: string, path: string, response: Response, options: { allowInternal?: boolean } = {}): Promise<void> {
  const pathname = new URL(path, ORIGIN).pathname
  const match = CONTRACT_ROUTES.find(({ route, pattern }) => route.method === method && pattern.test(pathname))
  const route = match?.route
  const fail = (message: string): never => {
    throw new Error(`Contract mismatch for ${method} ${pathname} (${route?.id ?? 'unknown route'}): ${message}`)
  }
  if (!pathname.startsWith('/api/')) return
  if (route && response.headers.get('Cache-Control') !== 'no-store') fail('expected Cache-Control: no-store')
  const isJson = /^application\/json(?:\s*;|$)/i.test(response.headers.get('Content-Type') ?? '')
  if (response.status >= 400) {
    if (!isJson) fail(`expected a JSON error, received ${response.headers.get('Content-Type') ?? 'no Content-Type'}`)
    // The platform-level refusal without a console identity has its own body (asserted where it is tested).
    if (response.status === 401) return
    const body = await response.clone().json() as unknown
    const parsed = api.apiErrorBodySchema.safeParse(body)
    if (!parsed.success) return fail(`error body: ${issuesText(parsed.error)}`)
    const extra = unknownKeys(body, parsed.data)
    if (extra.length > 0) fail(`error body has unknown key(s): ${extra.join(', ')}`)
    const { code } = parsed.data.error
    if (code === 'internal' && !options.allowInternal) fail('500 internal')
    if (api.API_ERROR_STATUS[code] !== response.status) fail(`${code} must use status ${api.API_ERROR_STATUS[code]}, received ${response.status}`)
    if (!route) return
    if (!route.errors.includes(code)) fail(`undocumented error code ${code}`)
    const violations = (parsed.data.error.violations ?? []).map((violation) => violation.code).filter((item) => !route.violations.includes(item))
    if (code === 'invariant_violation' && violations.length > 0) fail(`undocumented violation code(s): ${violations.join(', ')}`)
    const warnings = (parsed.data.error.warnings ?? []).map((warning) => warning.code).filter((item) => !route.warnings.includes(item))
    if (code === 'warnings_unacknowledged' && warnings.length > 0) fail(`undocumented warning code(s): ${warnings.join(', ')}`)
    return
  }
  if (!route || response.status !== route.response.status) {
    if (route) fail(`expected status ${route.response.status}, received ${response.status}`)
    return
  }
  if (response.headers.has('Idempotent-Replay') && response.headers.get('Idempotent-Replay') !== 'true') fail('Idempotent-Replay must be true')
  if (route.response.kind === 'json') {
    if (!isJson) fail('expected application/json')
    const body = await response.clone().json() as unknown
    const parsed = route.response.schema.safeParse(body)
    if (!parsed.success) return fail(`success body: ${issuesText(parsed.error)}`)
    const extra = unknownKeys(body, parsed.data)
    if (extra.length > 0) fail(`success body has unknown key(s): ${extra.join(', ')}`)
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Requests through the public router

/** A JSON API call as the web app makes it, checked against the contract. A mutation gets a fresh key unless given one. */
export async function sendApi(
  method: string,
  path: string,
  identity: Identity | null,
  body?: unknown,
  headers: Record<string, string> = {},
  options: { allowInternal?: boolean } = {},
): Promise<Response> {
  const response = await appRequest(path, {
    method,
    headers: {
      Accept: 'application/json',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  }, identity ?? {})
  await checkContract(method, path, response, options)
  return response
}

/** Starts every request together (after one shared release) and keeps the input order in the result. */
export async function concurrently<T>(requests: readonly (() => Promise<T>)[]): Promise<T[]> {
  let release!: () => void
  const ready = new Promise<void>((resolve) => { release = resolve })
  const running = requests.map(async (request) => {
    await ready
    return request()
  })
  release()
  return Promise.all(running)
}

// ---------------------------------------------------------------------------------------------------------------------
// Seeding

async function flush(db: D1Database, statements: Stmt[]): Promise<void> {
  for (let start = 0; start < statements.length; start += 400) {
    await db.batch(statements.slice(start, start + 400).map((statement) => prepare(db, statement)))
  }
  statements.length = 0
}

/** Holders labelled S01–S43 get neutral synthetic names; nothing names a person. */
export function holderName(label: string): string {
  return `Synthetic Holder ${label}`
}

/** The company row and its empty ledger head, as company setup leaves them. */
export async function seedOrg(db: D1Database, id = '00000000-0000-4000-8000-000000000001', key = 'acme-robotics'): Promise<string> {
  const now = Date.UTC(2026, 9, 19)
  await db.prepare(
    `INSERT INTO orgs (id, org_key, slug, status, legal_name, display_name, settings, created_at, updated_at)
     VALUES (?, ?, ?, 'active', 'Acme Robotics, Inc.', 'Acme Robotics', ?, ?, ?)`,
  ).bind(id, key, key, JSON.stringify({ companyContact: { name: 'Acme Equity Team', email: 'equity@example.test' } }), now, now).run()
  await db.prepare('INSERT INTO ledger_heads (org_id, seq, genesis_hash, head_hash, updated_at) VALUES (?, 0, ?, NULL, ?)')
    .bind(id, engine.genesisHash(id), now).run()
  return id
}

/** The user who recorded the seeded history and uploaded its documents. */
export async function seedUser(db: D1Database, now: number): Promise<void> {
  await db.prepare("INSERT INTO users (id, email, display_name, version, created_at, updated_at) VALUES (?, 'seed.admin@example.test', 'Seed Admin', 1, ?, ?)")
    .bind(SEED_USER_ID, now, now).run()
}

/**
 * The reference rows of a synthetic ledger: its company, the seed user, stakeholders, classes, plans and vesting terms.
 * Imported rows carry a source id, the provenance the app reads.
 */
export async function seedReferences(db: D1Database, b: LedgerBuilder): Promise<{ created: number }> {
  const orgId = b.orgId
  const created = Date.UTC(2026, 9, 1)
  await seedOrg(db, orgId, 'acme-robotics')
  await seedUser(db, created)
  const statements: Stmt[] = []
  const labels = new Map<string, string>()
  for (let n = 1; n <= 43; n += 1) labels.set(uuid(`S${String(n).padStart(2, '0')}`), `S${String(n).padStart(2, '0')}`)
  for (const holder of b.reference.stakeholders) {
    const label = labels.get(holder.id) ?? holder.id.slice(0, 8)
    const number = Number(label.slice(1))
    const institution = holder.relationship === 'investor' && number >= 31 && number <= 33
    statements.push(stmt(
      `INSERT INTO stakeholders (id, org_id, kind, display_name, relationship, country_of_residence, tax_status, portal_access,
         created_at, updated_at, pulley_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'auto', ?, ?, ?)`,
      holder.id, orgId, institution ? 'institution' : 'individual', holderName(label), holder.relationship,
      holder.countryOfResidence ?? 'US', (holder.countryOfResidence ?? 'US') === 'US' ? 'us' : 'non_us', created, created, `syn-${label}`,
    ))
  }
  const prefixes: Record<string, string> = { 'Common Stock': 'CS', 'Series Seed Preferred': 'PS', 'Series A-1 Preferred': 'PA', 'Series A-2 Preferred': 'PB' }
  for (const stockClass of b.reference.stockClasses) {
    statements.push(stmt(
      `INSERT INTO stock_classes (id, org_id, name, class_type, default_id_prefix, par_value, created_at, updated_at, pulley_id)
       VALUES (?, ?, ?, ?, ?, '0.0001', ?, ?, ?)`,
      stockClass.id, orgId, stockClass.name, stockClass.classType, prefixes[stockClass.name] ?? (stockClass.classType === 'COMMON' ? 'CS' : 'PS'),
      created, created, `syn-${stockClass.id.slice(0, 8)}`,
    ))
  }
  for (const plan of b.reference.stockPlans) {
    statements.push(stmt(
      `INSERT INTO stock_plans (id, org_id, name, stock_class_id, board_approval_date, stockholder_approval_date, effective_date,
         expiration_date, created_at, updated_at, pulley_id)
       VALUES (?, ?, ?, ?, '2023-01-20', '2023-01-25', '2023-01-20', '2033-01-20', ?, ?, ?)`,
      plan.id, orgId, plan.name, plan.stockClassId, created, created, `syn-${plan.id.slice(0, 8)}`,
    ))
  }
  b.reference.vestingTerms.forEach((terms, index) => {
    statements.push(stmt(
      `INSERT INTO vesting_terms (id, org_id, name, is_template, definition, definition_sha256, algorithm_version, created_at, pulley_id)
       VALUES (?, ?, ?, 0, ?, ?, 1, ?, ?)`,
      terms.id, orgId, `Imported schedule ${index + 1}`, engine.canonicalJson(terms.definition), terms.definitionSha256, created, `syn-vt-${index + 1}`,
    ))
  })
  await flush(db, statements)
  return { created }
}

export interface AcmeSeed {
  acme: Acme
  orgId: string
  id: (label: string) => string
}

/**
 * Seeds the Acme org. `extend` adds builder steps (more commands) before the load; `emails` gives holders their own
 * address (label → address). Each command's dependency edges are recorded as the writer records them, from the engine
 * (`edges: false` leaves them out, as a broken load would).
 */
export async function seedAcme(
  db: D1Database,
  options: { extend?: (acme: Acme) => void; emails?: Record<string, string>; settings?: Record<string, unknown>; edges?: boolean } = {},
): Promise<AcmeSeed> {
  ledgerCache().clear()
  const acme = buildAcme()
  options.extend?.(acme)
  const { b } = acme
  const orgId = b.orgId
  const { created } = await seedReferences(db, b)
  if (options.settings) {
    await db.prepare('UPDATE orgs SET settings = json_patch(settings, ?), version = version + 1 WHERE id = ?').bind(JSON.stringify(options.settings), orgId).run()
  }
  const statements: Stmt[] = [stmt(
    `INSERT INTO vesting_terms (id, org_id, name, description, is_template, definition, definition_sha256, algorithm_version, created_at)
     VALUES (?, ?, 'VS-1 4 years monthly, 1-year cliff', 'Standard schedule', 1, ?, ?, 1, ?)`,
    VS1_TEMPLATE_ID, orgId, engine.canonicalJson(VS_1), engine.definitionSha256(VS_1), created,
  )]
  VALUATIONS.forEach((valuation, index) => {
    statements.push(stmt(
      `INSERT INTO valuations (id, org_id, valuation_type, name, provider, effective_date, expiration_date, board_approval_date, created_at, pulley_id)
       VALUES (?, ?, '409A', ?, 'Synthetic Valuations LLC', ?, ?, ?, ?, ?)`,
      valuation.id, orgId, `409A V${index + 1}`, valuation.effectiveDate, valuation.expirationDate, valuation.effectiveDate, created, `syn-val-${index + 1}`,
    ))
    for (const price of valuation.prices) {
      statements.push(stmt(
        'INSERT INTO valuation_prices (org_id, valuation_id, stock_class_id, price_per_share) VALUES (?, ?, ?, ?)',
        orgId, valuation.id, price.stockClassId, price.pricePerShare,
      ))
    }
  })
  await flush(db, statements)

  // The engine's edges for every command, from the whole history (a command only ever relies on earlier ones).
  const history = engine.replay(b.reference, b.transactions, { asOf: '2099-12-31' })
  const rowsByCommand = new Map<string, engine.TransactionRow[]>()
  for (const row of b.rows) rowsByCommand.set(row.command_id, [...(rowsByCommand.get(row.command_id) ?? []), row])
  for (const command of b.reference.commands) {
    const imported = command.actorKind === 'import'
    const user = command.actorKind === 'user'
    const receiptId = uuid(`receipt:${command.id}`)
    const requestSha256 = engine.sha256Hex(`seed:${command.id}`)
    statements.push(receiptInsert({
      id: receiptId,
      scope: orgId,
      actor: imported ? IMPORT_ACTOR : user ? SEED_USER_ID : 'system:seed',
      route: imported ? IMPORT_ROUTE : `POST /api/orgs/:orgId/commands/${command.type}`,
      key: `seed:${command.id}`,
      requestSha256,
      status: 200,
      body: '{}',
      now: command.createdAt,
    }))
    statements.push(commandInsert({
      id: command.id,
      orgId,
      type: command.type,
      receiptId,
      requestSha256,
      actorKind: command.actorKind,
      actorUserId: user ? SEED_USER_ID : null,
      authMethod: user ? 'console' : null,
      note: command.reversesCommandId !== null ? 'Seeded reversal' : null,
      reversesCommandId: command.reversesCommandId,
      expectedLedgerSeq: null,
      declaredTxCount: command.declaredTxCount,
      firstSeq: command.firstSeq,
      lastSeq: command.lastSeq,
      result: '{}',
      now: command.createdAt,
    }))
    for (const security of b.reference.securities.filter((s) => s.originCommandId === command.id)) {
      statements.push(securityInsert(orgId, security, { now: command.createdAt, pulleyId: imported ? `syn-${security.displayId}` : null }))
    }
    for (const row of rowsByCommand.get(command.id) ?? []) statements.push(transactionInsert(row))
    if (options.edges !== false) for (const edge of engine.commandDependencies(history, command.id)) statements.push(dependencyInsert(orgId, edge))
    if (statements.length >= 350) await flush(db, statements)
  }
  await flush(db, statements)
  for (const [label, email] of Object.entries(options.emails ?? {})) await addEmail(db, orgId, uuid(label), email, created)
  return { acme, orgId, id: (label: string) => uuid(label) }
}

/**
 * Adds two consultants holding award types outside the main options and warrants fixtures, both vested at grant: S42 an RSU and S43
 * a stock-settled SAR (model-ready in the engine; the option and warrant commands must not treat them as options).
 */
export function withRsuAndSar(acme: Acme): void {
  const { b, id, cls, plan } = acme
  b.stakeholder('S42', 'consultant', { countryOfResidence: 'US' })
  b.stakeholder('S43', 'consultant', { countryOfResidence: 'US' })
  b.command('grant:RSU-1', (c) => {
    const lot = c.security('RSU-1', { family: 'EQUITY_COMPENSATION', subtype: 'RSU', stakeholderId: id('S42'), stockClassId: cls.CS, stockPlanId: plan, parentSecurityId: null })
    c.tx('TX_EQUITY_COMPENSATION_ISSUANCE', '2025-01-15', {
      security_id: lot, custom_id: 'RSU-1', stakeholder_id: id('S42'), stock_plan_id: plan, stock_class_id: cls.CS, compensation_type: 'RSU',
      quantity: '1000', expiration_date: null, termination_exercise_windows: [],
    })
  })
  b.command('grant:SAR-1', (c) => {
    const lot = c.security('SAR-1', { family: 'EQUITY_COMPENSATION', subtype: 'SAR', stakeholderId: id('S43'), stockClassId: cls.CS, stockPlanId: plan, parentSecurityId: null })
    c.tx('TX_EQUITY_COMPENSATION_ISSUANCE', '2025-01-15', {
      security_id: lot, custom_id: 'SAR-1', stakeholder_id: id('S43'), stock_plan_id: plan, stock_class_id: cls.CS, compensation_type: 'SSAR',
      quantity: '1000', base_price: { amount: '0.44', currency: 'USD' }, expiration_date: '2035-01-15', termination_exercise_windows: [],
    })
  })
}

/** A stakeholder row created after the import (the ledger only needs the row). */
export async function addStakeholder(
  db: D1Database,
  orgId: string,
  label: string,
  relationship: engine.Relationship,
  options: { email?: string; country?: string; now?: number } = {},
): Promise<string> {
  const id = uuid(label)
  const now = options.now ?? ACME_NOW
  const country = options.country ?? 'US'
  await db.prepare(
    `INSERT INTO stakeholders (id, org_id, kind, display_name, relationship, country_of_residence, tax_status, portal_access, created_at, updated_at)
     VALUES (?, ?, 'individual', ?, ?, ?, ?, 'auto', ?, ?)`,
  ).bind(id, orgId, holderName(label), relationship, country, country === 'US' ? 'us' : 'non_us', now, now).run()
  if (options.email) await addEmail(db, orgId, id, options.email, now)
  return id
}

/** A stakeholder's own address, as the e-mail API stores one (`kind` self unless given). Returns its id. */
export async function addEmail(
  db: D1Database,
  orgId: string,
  stakeholderId: string,
  email: string,
  now = ACME_NOW,
  kind: 'self' | 'contact' | 'representative' = 'self',
): Promise<string> {
  const id = crypto.randomUUID()
  await db.prepare(
    `INSERT INTO stakeholder_emails (id, org_id, stakeholder_id, email, kind, contact_name, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).bind(id, orgId, stakeholderId, email.toLowerCase(), kind, kind === 'self' ? null : 'Synthetic Contact', now).run()
  return id
}

let documentCounter = 0

/** A document row as an upload leaves it (commands check and link the record; its bytes aren't needed). */
export async function addDocument(db: D1Database, orgId: string, kind: api.DocumentKind, options: { now?: number; uploadedBy?: string } = {}): Promise<string> {
  documentCounter += 1
  const id = crypto.randomUUID()
  const now = options.now ?? ACME_NOW - 60_000
  await db.prepare(
    `INSERT INTO documents (id, org_id, filename, content_type, byte_size, sha256, kind, source, uploaded_by, created_at, updated_at)
     VALUES (?, ?, ?, 'application/pdf', 2048, ?, ?, 'upload', ?, ?, ?)`,
  ).bind(id, orgId, `Synthetic-${kind.toLowerCase()}-${documentCounter}.pdf`, engine.sha256Hex(`document:${id}`), kind,
    options.uploadedBy ?? SEED_USER_ID, now, now).run()
  return id
}

/** Links an administrator's console e-mail to a stakeholder to exercise the self-dealing block. */
export async function linkAdmin(db: D1Database, orgId: string, email: string, stakeholderId: string): Promise<string> {
  const id = crypto.randomUUID()
  await db.prepare(
    "INSERT INTO admin_stakeholder_links (id, org_id, email, stakeholder_id, source, created_at) VALUES (?, ?, ?, ?, 'admin', ?)",
  ).bind(id, orgId, email.toLowerCase(), stakeholderId, ACME_NOW).run()
  return id
}

// ---------------------------------------------------------------------------------------------------------------------
// The harness

// Every test seeds a whole synthetic org into a fresh database and replays it through the router: more than the
// default five seconds on a cold or loaded machine.
vi.setConfig({ testTimeout: 60_000 })

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
})

/**
 * A fresh test database with the clock pinned and the console access mode on; closed after the test. `now` defaults
 * to 13:00 in Los Angeles on the demo's day.
 */
export async function openTestApp(now = ACME_NOW): Promise<{ db: D1Database; clock: TestClock }> {
  const clock = pinClock(now)
  process.env.SUGER_ACCESS_MODE = 'console'
  const testDb = await createTestDatabase()
  cleanups.push(async () => {
    ledgerCache().clear()
    await testDb.close()
    delete process.env.SUGER_ACCESS_MODE
    vi.useRealTimers()
  })
  return { db: testDb.db as unknown as D1Database, clock }
}

export interface LedgerHarness extends AcmeSeed {
  db: D1Database
  clock: TestClock
  config: AppConfig
  /** OWNER (admin_rw). */
  sa: Identity
  /** ADMIN (admin_rw). */
  rw: Identity
  /** EDITOR (admin_ro). */
  ro: Identity
  path: (suffix: string) => string
  api: (method: string, path: string, identity?: Identity | null, body?: unknown, headers?: Record<string, string>) => Promise<Response>
}

/** The Acme org at 13:00 on the demo's day, with OWNER, ADMIN and EDITOR console identities already known to the app. */
export async function ledgerHarness(options: Parameters<typeof seedAcme>[1] & { now?: number } = {}): Promise<LedgerHarness> {
  const { db, clock } = await openTestApp(options.now ?? ACME_NOW)
  const seed = await seedAcme(db, options)
  // Each console identity becomes a user row on its first request; tests that call the ledger directly need them.
  for (const identity of [OWNER, ADMIN, EDITOR]) expect((await sendApi('GET', '/api/me', identity)).status).toBe(200)
  return {
    ...seed,
    db,
    clock,
    config: TEST_CONFIG,
    sa: OWNER,
    rw: ADMIN,
    ro: EDITOR,
    path: (suffix: string) => `/api/orgs/${seed.orgId}${suffix}`,
    api: (method, path, identity = OWNER, body, headers = {}) => sendApi(method, path, identity, body, headers),
  }
}

export interface CommandRun<T = api.CommandResult> {
  preview: T
  response: Response
  body: unknown
}

/** The two-step flow of the UI: a dry run, then the real call with its head, diff hash and acknowledgements. */
export async function runCommand(
  l: LedgerHarness,
  identity: Identity,
  name: string,
  body: Record<string, unknown>,
  options: { key?: string; acknowledge?: string[] } = {},
): Promise<CommandRun> {
  const dry = await l.api('POST', l.path(`/commands/${name}?dryRun=true`), identity, body)
  const previewBody = await dry.json() as unknown
  expect(dry.status, `${name} dry run: ${JSON.stringify(previewBody)}`).toBe(200)
  const preview = previewBody as api.CommandResult
  const response = await l.api('POST', l.path(`/commands/${name}`), identity, {
    ...body,
    expectedLedgerSeq: preview.ledgerSeq,
    expectedDiffSha256: preview.diffSha256,
    acknowledge: options.acknowledge ?? preview.warnings.map((warning) => warning.code),
  }, options.key ? { 'Idempotency-Key': options.key } : {})
  const text = await response.text()
  return { preview, response, body: text ? JSON.parse(text) as unknown : null }
}

/** Runs a command and expects it to commit. */
export async function commit(l: LedgerHarness, identity: Identity, name: string, body: Record<string, unknown>, options: { key?: string } = {}): Promise<api.CommandResult> {
  const run = await runCommand(l, identity, name, body, options)
  expect(run.response.status, `${name}: ${JSON.stringify(run.body)}`).toBe(200)
  return run.body as api.CommandResult
}

export async function getJson<T = Record<string, unknown>>(l: LedgerHarness, identity: Identity, suffix: string, status = 200): Promise<T> {
  const response = await l.api('GET', suffix.startsWith('/api/') ? suffix : l.path(suffix), identity)
  const body = await response.json() as unknown
  expect(response.status, `GET ${suffix}: ${JSON.stringify(body).slice(0, 500)}`).toBe(status)
  return body as T
}

export function errorOf(body: unknown): {
  code: string
  reason?: string
  violations?: { code: string }[]
  warnings?: { code: string }[]
  dependents?: { commandId: string }[]
} {
  return (body as { error: { code: string } }).error
}

/** The cumulative HTTP result: FD, options, plan available, class and total I&O, capital, holders and pending awards. */
export async function demoRow(l: LedgerHarness, identity = l.sa): Promise<string[]> {
  const table = await getJson<api.CapTableResponse>(l, identity, '/cap-table?tab=options')
  const dashboard = await getJson<api.DashboardResponse>(l, identity, '/dashboard')
  const options = (table.rows ?? []).reduce((sum, row) => sum.add(row.numbers!.outstanding), engine.Dec.ZERO)
  const common = table.classes.find((stockClass) => stockClass.name === 'Common Stock')!
  return [
    table.metrics.fullyDiluted,
    options.toString(),
    table.metrics.planAvailable,
    common.issuedAndOutstanding,
    table.metrics.issuedAndOutstanding,
    table.metrics.capitalContribution,
    String(dashboard.company.stakeholdersWithSecurities),
    String(dashboard.inProgress.executionPending),
  ]
}

/** The ledger head's seq. */
export async function headSeq(l: { db: D1Database; orgId: string }): Promise<number> {
  return (await l.db.prepare('SELECT seq FROM ledger_heads WHERE org_id = ?').bind(l.orgId).first<number>('seq'))!
}

/** One COUNT(*) AS n. */
export async function count(db: D1Database, sql: string, ...params: unknown[]): Promise<number> {
  return (await db.prepare(sql).bind(...params).first<number>('n'))!
}

// ---------------------------------------------------------------------------------------------------------------------
// Races at the commit boundary

/** Injects a rival commit at the exact point the operation under test submits its D1 batch. */
export function batchRaceInjector(db: D1Database) {
  let injection: {
    rival: (statements: D1PreparedStatement[]) => Promise<void>
    matches: (statements: D1PreparedStatement[]) => boolean
  } | null = null
  let injections = 0
  const binding = new Proxy(db, {
    get(target, property) {
      if (property === 'batch') {
        return async (statements: D1PreparedStatement[]) => {
          const pending = injection
          if (pending?.matches(statements)) {
            injection = null
            injections += 1
            await pending.rival(statements)
          }
          return target.batch(statements)
        }
      }
      const value = Reflect.get(target, property, target) as unknown
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value
    },
  })
  return {
    binding,
    arm(
      rival: (statements: D1PreparedStatement[]) => Promise<void>,
      matches: (statements: D1PreparedStatement[]) => boolean = () => true,
    ) { injection = { rival, matches } },
    injections() { return injections },
  }
}

/** The preview's D1 keeps each prepared statement's SQL (`sql`); tests use it only to pick a transaction boundary. */
export function batchIncludesSql(statements: D1PreparedStatement[], fragment: string): boolean {
  return statements.some((statement) => ((statement as unknown as { sql?: string }).sql ?? '').includes(fragment))
}
