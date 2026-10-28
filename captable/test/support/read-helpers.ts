import { expect, vi } from 'vitest'
import { api, engine } from '../../src/app/shared/index.ts'
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
import { ledgerCache } from '../../src/app/server/lib/read/ledger.ts'
import { buildAcme, VALUATIONS, VS_1, type Acme } from '../shared/engine/fixtures/acme.ts'
import { uuid, type LedgerBuilder } from '../shared/engine/fixtures/builder.ts'
import {
  appRequest,
  consoleHeaders,
  CONSOLE_ORGANIZATION_ID,
  createLegacyTestDatabase,
  useAppNowForTests,
  type ConsoleIdentity,
  type TestDatabase,
} from './server-harness.ts'

export const ACME_TODAY = '2026-10-21'
export const ACME_NOW = Date.UTC(2026, 9, 21, 20)
export const SEED_USER_ID = '10000000-0000-4000-8000-00000000a001'
export const VS1_TEMPLATE_ID = uuid('template:VS-1')

export const OWNER = consoleHeaders({
  userId: 'owner-user', role: 'OWNER', email: 'owner@example.test', name: 'Owner Example',
})
export const ADMIN = consoleHeaders({
  userId: 'admin-user', role: 'ADMIN', email: 'admin@example.test', name: 'Admin Example',
})
export const EDITOR = consoleHeaders({
  userId: 'editor-user', role: 'EDITOR', email: 'editor@example.test', name: 'Editor Example',
})

export function holderIdentity(email: string, overrides: Partial<ConsoleIdentity> = {}): Record<string, string> {
  return consoleHeaders({
    userId: `holder-${engine.sha256Hex(email).slice(0, 12)}`,
    role: 'VIEWER', email, name: 'Holder Example', ...overrides,
  })
}

export interface AcmeSeed {
  acme: Acme
  orgId: string
  batchId: string
  id: (label: string) => string
}

async function flush(db: D1Database, statements: Stmt[]): Promise<void> {
  for (let start = 0; start < statements.length; start += 400) {
    await db.batch(statements.slice(start, start + 400).map((statement) => prepare(db, statement)))
  }
  statements.length = 0
}

export function holderName(label: string): string {
  return `Synthetic Holder ${label}`
}

export async function seedOrg(
  db: D1Database,
  id = '00000000-0000-4000-8000-000000000001',
  key = 'acme-robotics',
  status: 'staging' | 'active' = 'active',
  consoleOrganizationId = CONSOLE_ORGANIZATION_ID,
): Promise<string> {
  const now = Date.UTC(2026, 9, 19)
  await db.prepare(
    `INSERT INTO orgs
     (id, console_organization_id, org_key, slug, status, legal_name, display_name, settings, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'Acme Robotics, Inc.', 'Acme Robotics', ?, ?, ?)`,
  ).bind(
    id, consoleOrganizationId, key, status === 'active' ? key : `${key}--r01`, status,
    JSON.stringify({ companyContact: { name: 'Acme Equity Team', email: 'equity@example.test' } }),
    now, now,
  ).run()
  await db.prepare(
    'INSERT INTO ledger_heads (org_id, seq, genesis_hash, head_hash, updated_at) VALUES (?, 0, ?, NULL, ?)',
  ).bind(id, engine.genesisHash(id), now).run()
  return id
}

export async function seedReferences(
  db: D1Database,
  b: LedgerBuilder,
  options: { staging?: boolean } = {},
): Promise<{ batchId: string; created: number }> {
  const orgId = b.orgId
  const batchId = uuid('batch:1')
  const created = Date.UTC(2026, 9, 1)
  await seedOrg(db, orgId, 'acme-robotics', options.staging ? 'staging' : 'active')
  const statements: Stmt[] = [
    stmt(
      "INSERT INTO users (id, email, display_name, version, created_at, updated_at) VALUES (?, 'seed.admin@example.test', 'Seed Admin', 1, ?, ?)",
      SEED_USER_ID, created, created,
    ),
  ]
  const labels = new Map<string, string>()
  for (let n = 1; n <= 43; n += 1) {
    const label = `S${String(n).padStart(2, '0')}`
    labels.set(uuid(label), label)
  }
  for (const holder of b.reference.stakeholders) {
    const label = labels.get(holder.id) ?? holder.id.slice(0, 8)
    const holderNumber = Number(label.slice(1))
    const institution = holder.relationship === 'investor' && holderNumber >= 31 && holderNumber <= 33
    statements.push(stmt(
      `INSERT INTO stakeholders (id, org_id, kind, display_name, relationship, country_of_residence, tax_status, portal_access,
         created_at, updated_at, pulley_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'auto', ?, ?, ?)`,
      holder.id, orgId, institution ? 'institution' : 'individual', holderName(label), holder.relationship,
      holder.countryOfResidence ?? 'US', (holder.countryOfResidence ?? 'US') === 'US' ? 'us' : 'non_us',
      created, created, `syn-${label}`,
    ))
  }
  const prefixes: Record<string, string> = {
    'Common Stock': 'CS', 'Series Seed Preferred': 'PS', 'Series A-1 Preferred': 'PA', 'Series A-2 Preferred': 'PB',
  }
  for (const stockClass of b.reference.stockClasses) {
    statements.push(stmt(
      `INSERT INTO stock_classes (id, org_id, name, class_type, default_id_prefix, par_value, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, '0.0001', ?, ?)`,
      stockClass.id, orgId, stockClass.name, stockClass.classType,
      prefixes[stockClass.name] ?? (stockClass.classType === 'COMMON' ? 'CS' : 'PS'), created, created,
    ))
  }
  for (const plan of b.reference.stockPlans) {
    statements.push(stmt(
      `INSERT INTO stock_plans (id, org_id, name, stock_class_id, board_approval_date, stockholder_approval_date, effective_date,
         expiration_date, created_at, updated_at)
       VALUES (?, ?, ?, ?, '2023-01-20', '2023-01-25', '2023-01-20', '2033-01-20', ?, ?)`,
      plan.id, orgId, plan.name, plan.stockClassId, created, created,
    ))
  }
  b.reference.vestingTerms.forEach((terms, index) => {
    statements.push(stmt(
      `INSERT INTO vesting_terms (id, org_id, name, is_template, definition, definition_sha256, algorithm_version, created_at)
       VALUES (?, ?, ?, 0, ?, ?, 1, ?)`,
      terms.id, orgId, `Imported schedule ${index + 1}`, engine.canonicalJson(terms.definition),
      terms.definitionSha256, created,
    ))
  })
  await flush(db, statements)
  return { batchId, created }
}

export async function seedAcme(
  db: D1Database,
  options: {
    extend?: (acme: Acme) => void
    emails?: Record<string, string>
    settings?: Record<string, unknown>
    staging?: boolean
    edges?: boolean
  } = {},
): Promise<AcmeSeed> {
  ledgerCache().clear()
  const acme = buildAcme()
  options.extend?.(acme)
  const { b } = acme
  const orgId = b.orgId
  const { batchId, created } = await seedReferences(db, b, { staging: options.staging })
  if (options.settings) {
    await db.prepare('UPDATE orgs SET settings = json_patch(settings, ?), version = version + 1 WHERE id = ?')
      .bind(JSON.stringify(options.settings), orgId).run()
  }
  const statements: Stmt[] = [stmt(
    `INSERT INTO vesting_terms (id, org_id, name, description, is_template, definition, definition_sha256, algorithm_version, created_at)
     VALUES (?, ?, 'VS-1 4 years monthly, 1-year cliff', 'Standard schedule', 1, ?, ?, 1, ?)`,
    VS1_TEMPLATE_ID, orgId, engine.canonicalJson(VS_1), engine.definitionSha256(VS_1), created,
  )]
  VALUATIONS.forEach((valuation, index) => {
    statements.push(stmt(
      `INSERT INTO valuations (id, org_id, valuation_type, name, provider, effective_date, expiration_date, board_approval_date,
         created_at, pulley_id)
       VALUES (?, ?, '409A', ?, 'Synthetic Valuations LLC', ?, ?, ?, ?, ?)`,
      valuation.id, orgId, `409A V${index + 1}`, valuation.effectiveDate, valuation.expirationDate,
      valuation.effectiveDate, created, `syn-val-${index + 1}`,
    ))
    for (const price of valuation.prices) {
      statements.push(stmt(
        'INSERT INTO valuation_prices (org_id, valuation_id, stock_class_id, price_per_share) VALUES (?, ?, ?, ?)',
        orgId, valuation.id, price.stockClassId, price.pricePerShare,
      ))
    }
  })
  await flush(db, statements)
  if (options.staging) return { acme, orgId, batchId, id: (label: string) => uuid(label) }

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
      consoleOrganizationId: CONSOLE_ORGANIZATION_ID,
      scope: orgId,
      actor: imported ? `import:${batchId}` : user ? SEED_USER_ID : 'system:seed',
      route: imported ? 'POST /api/import/runs/:id/apply' : `POST /api/orgs/:orgId/commands/${command.type}`,
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
      authMethod: null,
      note: command.reversesCommandId !== null ? 'Seeded reversal' : null,
      reversesCommandId: command.reversesCommandId,
      expectedLedgerSeq: null,
      declaredTxCount: command.declaredTxCount,
      firstSeq: command.firstSeq,
      lastSeq: command.lastSeq,
      result: '{}',
      now: command.createdAt,
    }))
    for (const security of b.reference.securities.filter((entry) => entry.originCommandId === command.id)) {
      statements.push(securityInsert(orgId, security, {
        now: command.createdAt,
        pulleyId: imported ? `security_syn-${security.displayId}` : null,
      }))
    }
    for (const row of rowsByCommand.get(command.id) ?? []) statements.push(transactionInsert(row))
    if (options.edges !== false) {
      for (const edge of engine.commandDependencies(history, command.id)) statements.push(dependencyInsert(orgId, edge))
    }
    if (statements.length >= 350) await flush(db, statements)
  }
  for (const [label, email] of Object.entries(options.emails ?? {})) {
    statements.push(stmt(
      `INSERT INTO stakeholder_emails (id, org_id, stakeholder_id, email, kind, added_by, created_at)
       VALUES (?, ?, ?, ?, 'self', ?, ?)`,
      uuid(`email:${label}:${email}`), orgId, uuid(label), email.toLowerCase(), SEED_USER_ID, created,
    ))
  }
  await flush(db, statements)
  return { acme, orgId, batchId, id: (label: string) => uuid(label) }
}

export async function recordCommittedImport(db: D1Database, orgId: string, source: api.ImportSource): Promise<void> {
  const now = ACME_NOW - 1_000
  await db.prepare(
    `INSERT INTO import_runs
       (id, console_organization_id, source_system, status, file_hashes, as_of_date, plan_sha256, counts, created_by, org_id,
        error_message, timezone, jurisdiction, fiscal_year_end, created_at, updated_at)
     VALUES (?, ?, ?, 'committed', '[]', '2026-10-20', ?, '{}', ?, ?, NULL, 'UTC', 'US-DE', '12-31', ?, ?)`,
  ).bind(crypto.randomUUID(), CONSOLE_ORGANIZATION_ID, source, '0'.repeat(64), SEED_USER_ID, orgId, now, now).run()
}

export function withRsuAndSar(acme: Acme): void {
  const { b, id, cls, plan } = acme
  b.stakeholder('S42', 'consultant', { countryOfResidence: 'US' })
  b.stakeholder('S43', 'consultant', { countryOfResidence: 'US' })
  b.command('grant:RSU-1', (c) => {
    const lot = c.security('RSU-1', {
      family: 'EQUITY_COMPENSATION', subtype: 'RSU', stakeholderId: id('S42'), stockClassId: cls.CS,
      stockPlanId: plan, parentSecurityId: null,
    })
    c.tx('TX_EQUITY_COMPENSATION_ISSUANCE', '2025-01-15', {
      security_id: lot, custom_id: 'RSU-1', stakeholder_id: id('S42'), stock_plan_id: plan,
      stock_class_id: cls.CS, compensation_type: 'RSU', quantity: '1000', expiration_date: null,
      termination_exercise_windows: [],
    })
  })
  b.command('grant:SAR-1', (c) => {
    const lot = c.security('SAR-1', {
      family: 'EQUITY_COMPENSATION', subtype: 'SAR', stakeholderId: id('S43'), stockClassId: cls.CS,
      stockPlanId: plan, parentSecurityId: null,
    })
    c.tx('TX_EQUITY_COMPENSATION_ISSUANCE', '2025-01-15', {
      security_id: lot, custom_id: 'SAR-1', stakeholder_id: id('S43'), stock_plan_id: plan,
      stock_class_id: cls.CS, compensation_type: 'SSAR', quantity: '1000',
      base_price: { amount: '0.44', currency: 'USD' }, expiration_date: '2035-01-15',
      termination_exercise_windows: [],
    })
  })
}

export async function addStakeholder(
  db: D1Database,
  orgId: string,
  label: string,
  relationship: engine.Relationship,
  options: { email?: string; country?: string; now?: number } = {},
): Promise<string> {
  const id = uuid(label)
  const now = options.now ?? ACME_NOW
  await db.prepare(
    `INSERT INTO stakeholders (id, org_id, kind, display_name, relationship, country_of_residence, tax_status, portal_access, created_at, updated_at)
     VALUES (?, ?, 'individual', ?, ?, ?, ?, 'auto', ?, ?)`,
  ).bind(
    id, orgId, holderName(label), relationship, options.country ?? 'US',
    (options.country ?? 'US') === 'US' ? 'us' : 'non_us', now, now,
  ).run()
  if (options.email) await addEmail(db, orgId, id, options.email, now)
  return id
}

export async function addEmail(
  db: D1Database,
  orgId: string,
  stakeholderId: string,
  email: string,
  now = ACME_NOW,
): Promise<void> {
  await db.prepare(
    `INSERT INTO stakeholder_emails (id, org_id, stakeholder_id, email, kind, added_by, created_at)
     VALUES (?, ?, ?, ?, 'self', ?, ?)`,
  ).bind(crypto.randomUUID(), orgId, stakeholderId, email.toLowerCase(), SEED_USER_ID, now).run()
}

let documentCounter = 0

export async function addDocument(
  db: D1Database,
  orgId: string,
  kind: api.DocumentKind,
  options: { now?: number; uploadedBy?: string; holderVisible?: boolean } = {},
): Promise<string> {
  documentCounter += 1
  const id = crypto.randomUUID()
  const now = options.now ?? ACME_NOW - 60_000
  await db.prepare(
    `INSERT INTO documents
       (id, org_id, filename, content_type, byte_size, sha256, kind, source, uploaded_by, created_at, updated_at, holder_visible)
     VALUES (?, ?, ?, 'application/pdf', 2048, ?, ?, 'upload', ?, ?, ?, ?)`,
  ).bind(
    id, orgId, `Synthetic-${kind.toLowerCase()}-${documentCounter}.pdf`, engine.sha256Hex(`document:${id}`), kind,
    options.uploadedBy ?? SEED_USER_ID, now, now, options.holderVisible ? 1 : 0,
  ).run()
  return id
}

export async function linkAdmin(
  db: D1Database,
  orgId: string,
  email: string,
  stakeholderId: string,
): Promise<string> {
  const id = crypto.randomUUID()
  await db.prepare(
    "INSERT INTO admin_stakeholder_links (id, org_id, email, stakeholder_id, source, created_at) VALUES (?, ?, ?, ?, 'admin', ?)",
  ).bind(id, orgId, email.toLowerCase(), stakeholderId, ACME_NOW).run()
  return id
}

export interface ReadHarness extends AcmeSeed {
  db: D1Database
  testDb: TestDatabase
  owner: Record<string, string>
  admin: Record<string, string>
  editor: Record<string, string>
  path: (suffix: string) => string
  api: (
    method: string,
    path: string,
    identity?: Record<string, string>,
    body?: unknown,
    headers?: Record<string, string>,
  ) => Promise<Response>
  close: () => Promise<void>
}

export async function readHarness(
  options: Parameters<typeof seedAcme>[1] & { now?: number } = {},
): Promise<ReadHarness> {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(options.now ?? ACME_NOW)
  useAppNowForTests(options.now ?? ACME_NOW)
  process.env.SUGER_ACCESS_MODE = 'console'
  const testDb = await createLegacyTestDatabase()
  const seed = await seedAcme(testDb.db as D1Database, options)
  const apiRequest = (
    method: string,
    path: string,
    identity: Record<string, string> = OWNER,
    body?: unknown,
    headers: Record<string, string> = {},
  ) => appRequest(path, {
    method,
    headers: {
      Accept: 'application/json',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  }, identity)
  return {
    ...seed,
    db: testDb.db as D1Database,
    testDb,
    owner: OWNER,
    admin: ADMIN,
    editor: EDITOR,
    path: (suffix: string) => `/api/orgs/${seed.orgId}${suffix}`,
    api: apiRequest,
    close: async () => {
      await testDb.close()
      delete process.env.SUGER_ACCESS_MODE
      vi.useRealTimers()
      useAppNowForTests(undefined)
      ledgerCache().clear()
    },
  }
}

export interface CommandRun<T = api.CommandResult> {
  preview: T
  response: Response
  body: unknown
}

export async function runCommand(
  harness: ReadHarness,
  identity: Record<string, string>,
  name: string,
  body: Record<string, unknown>,
  options: { key?: string; acknowledge?: string[] } = {},
): Promise<CommandRun> {
  const dry = await harness.api('POST', harness.path(`/commands/${name}?dryRun=true`), identity, body)
  const previewBody = await dry.json()
  expect(dry.status, `${name} dry run: ${JSON.stringify(previewBody)}`).toBe(200)
  const preview = previewBody as api.CommandResult
  const response = await harness.api('POST', harness.path(`/commands/${name}`), identity, {
    ...body,
    expectedLedgerSeq: preview.ledgerSeq,
    expectedDiffSha256: preview.diffSha256,
    acknowledge: options.acknowledge ?? preview.warnings.map((warning) => warning.code),
  }, options.key ? { 'Idempotency-Key': options.key } : {})
  const text = await response.text()
  return { preview, response, body: text ? JSON.parse(text) : null }
}

export async function commit(
  harness: ReadHarness,
  identity: Record<string, string>,
  name: string,
  body: Record<string, unknown>,
  options: { key?: string } = {},
): Promise<api.CommandResult> {
  const run = await runCommand(harness, identity, name, body, options)
  expect(run.response.status, `${name}: ${JSON.stringify(run.body)}`).toBe(200)
  return run.body as api.CommandResult
}

export async function getJson<T = Record<string, unknown>>(
  harness: ReadHarness,
  identity: Record<string, string>,
  suffix: string,
  status = 200,
): Promise<T> {
  const path = suffix.startsWith('/api/') ? suffix : harness.path(suffix)
  const response = await harness.api('GET', path, identity)
  const body = await response.json()
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
