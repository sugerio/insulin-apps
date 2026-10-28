import { describe, expect, it } from 'vitest'
import { api, engine } from '../../src/app/shared/index.ts'
import { commandInsert, prepare, receiptInsert, securityInsert, stmt, transactionInsert, type Stmt } from '../../src/app/server/lib/ledger/statements.ts'
import { ledgerCache, loadLedger, LEDGER_CACHE_BYTES, stateAt } from '../../src/app/server/lib/read/ledger.ts'
import { PLAN_RULES, VS_1, WINDOWS } from '../shared/engine/fixtures/acme.ts'
import { LedgerBuilder, usd, uuid } from '../shared/engine/fixtures/builder.ts'
import { OWNER, openTestApp, seedOrg, seedUser, sendApi } from '../support/ledger-helpers.ts'

/**
 * The replay budget on a 10× synthetic org (20,000 transactions; memory, about 42 MB, is the dimension to budget, with
 * the in-process cache at most 48 MB). The cold read plus full replay must stay inside the Worker CPU limit even as wall
 * time on a loaded machine (wall ≥ CPU), and the cache entry inside the byte budget. The best of two cold runs is kept,
 * to damp other processes' load.
 */

const COLD_BUDGET_MS = 30_000
const ORG_LABEL = 'org:perf'

function tenfold(): LedgerBuilder {
  const b = new LedgerBuilder({ orgId: uuid(ORG_LABEL) })
  const common = b.stockClass('perf:CS', 'COMMON', 'Common Stock')
  const plan = b.plan('perf:P1', common, 'Synthetic Equity Plan')
  const schedule = b.vestingTerms('perf:VS-1', VS_1)
  for (let n = 0; n < 1250; n += 1) b.stakeholder(`perf:S${n}`, 'employee', { countryOfResidence: 'US' })
  const holder = (n: number) => uuid(`perf:S${n % 1250}`)
  b.command('perf:setup', (c) => {
    c.tx('TX_STOCK_CLASS_AUTHORIZED_SHARES_ADJUSTMENT', '2019-01-02', { stock_class_id: common, new_shares_authorized: '900000000' })
    c.tx('X_STOCK_PLAN_TERMS', '2019-01-02', { stock_plan_id: plan, return_rules: PLAN_RULES, default_termination_windows: WINDOWS, default_repurchase_window: { period: 90, period_type: 'DAYS' }, status: 'active', pour_over_plan_id: null })
    c.tx('TX_STOCK_PLAN_POOL_ADJUSTMENT', '2019-01-02', { stock_plan_id: plan, shares_reserved: '400000000', board_approval_date: '2019-01-02', stockholder_approval_date: '2019-01-02' })
  })
  for (let n = 0; n < 5000; n += 1) {
    const date = engine.addDays('2020-01-01', n % 900)
    b.command(`perf:grant:${n}`, (c) => {
      const lot = c.security(`perf:OPT-${n}`, { family: 'EQUITY_COMPENSATION', subtype: 'OPTION_NSO', stakeholderId: holder(n), stockClassId: common, stockPlanId: plan, parentSecurityId: null, displayId: `OPT-${n + 1}` })
      c.tx('TX_EQUITY_COMPENSATION_ISSUANCE', date, {
        security_id: lot, custom_id: `OPT-${n + 1}`, stakeholder_id: holder(n), stock_plan_id: plan, stock_class_id: common, compensation_type: 'OPTION_NSO',
        quantity: '48000', exercise_price: usd('0.1'), early_exercisable: false, vesting_terms_id: schedule.id, expiration_date: engine.addYears(date, 10),
        termination_exercise_windows: WINDOWS, board_approval_date: date, x_definition_sha256: schedule.sha,
      })
      c.tx('TX_VESTING_START', date, { security_id: lot, x_vesting_start_date: date })
    }, { source: 'import' })
  }
  for (let n = 0; n < 2500; n += 1) {
    b.command(`perf:exercise:${n}`, (c) => {
      const option = uuid(`perf:OPT-${n}`)
      const lot = c.security(`perf:CS-${n}`, { family: 'STOCK', subtype: 'COMMON', stakeholderId: holder(n), stockClassId: common, stockPlanId: plan, parentSecurityId: option, displayId: `CS-${n + 1}` })
      c.tx('TX_EQUITY_COMPENSATION_EXERCISE', '2025-06-02', {
        security_id: option, quantity: '12000', resulting_security_ids: [lot], x_exercise_price: usd('0.1'), x_exercise_cost: usd('1200'),
        x_portions: [{ portion: 'NSO', quantity: '12000', security_id: lot }], x_lots_consumed: { iso: '0', nso: '12000' },
      })
      c.tx('TX_STOCK_ISSUANCE', '2025-06-02', {
        security_id: lot, custom_id: `CS-${n + 1}`, stakeholder_id: holder(n), stock_class_id: common, stock_plan_id: plan, share_price: usd('0.1'),
        quantity: '12000', x_origin: 'EXERCISE', x_source_security_id: option, x_portion: 'NSO',
      })
    }, { source: 'import', type: 'exercise-option' })
  }
  for (let n = 2500; n < 5000; n += 1) {
    b.command(`perf:cancel:${n}`, (c) => {
      c.tx('TX_EQUITY_COMPENSATION_CANCELLATION', '2025-07-01', { security_id: uuid(`perf:OPT-${n}`), quantity: '4800', reason_text: 'Holder waiver', x_reason: 'HOLDER_WAIVER' })
    }, { source: 'import', type: 'cancel-security' })
  }
  for (let n = 0; b.headSeq < 20_000; n += 1) {
    b.command(`perf:warrant:${n}`, (c) => {
      const warrant = c.security(`perf:WAR-${n}`, { family: 'WARRANT', subtype: 'WARRANT', stakeholderId: holder(n), stockClassId: common, stockPlanId: null, parentSecurityId: null, displayId: `WAR-${n + 1}` })
      c.tx('TX_WARRANT_ISSUANCE', '2024-03-01', { security_id: warrant, custom_id: `WAR-${n + 1}`, stakeholder_id: holder(n), quantity: '1000', exercise_price: usd('0.5'), purchase_price: usd('0'), warrant_expiration_date: '2034-03-01' })
    }, { source: 'import' })
  }
  return b
}

async function load(db: D1Database, b: LedgerBuilder, now: number): Promise<void> {
  const orgId = b.orgId
  const statements: Stmt[] = []
  const flush = async () => {
    for (let start = 0; start < statements.length; start += 500) await db.batch(statements.slice(start, start + 500).map((s) => prepare(db, s)))
    statements.length = 0
  }
  await seedUser(db, now)
  b.reference.stakeholders.forEach((holder, n) => statements.push(stmt(
    "INSERT INTO stakeholders (id, org_id, kind, display_name, relationship, country_of_residence, tax_status, created_at, updated_at) VALUES (?, ?, 'individual', ?, 'employee', 'US', 'us', ?, ?)",
    holder.id, orgId, `Synthetic Holder P${n}`, now, now,
  )))
  for (const c of b.reference.stockClasses) statements.push(stmt("INSERT INTO stock_classes (id, org_id, name, class_type, default_id_prefix, created_at, updated_at) VALUES (?, ?, ?, ?, 'CS', ?, ?)", c.id, orgId, c.name, c.classType, now, now))
  for (const p of b.reference.stockPlans) statements.push(stmt('INSERT INTO stock_plans (id, org_id, name, stock_class_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', p.id, orgId, p.name, p.stockClassId, now, now))
  for (const t of b.reference.vestingTerms) statements.push(stmt("INSERT INTO vesting_terms (id, org_id, name, is_template, definition, definition_sha256, created_at) VALUES (?, ?, 'VS-1', 1, ?, ?, ?)", t.id, orgId, engine.canonicalJson(t.definition), t.definitionSha256, now))
  await flush()
  const rows = new Map<string, engine.TransactionRow[]>()
  for (const row of b.rows) rows.set(row.command_id, [...(rows.get(row.command_id) ?? []), row])
  const securities = new Map<string, engine.SecurityIdentity[]>()
  for (const security of b.reference.securities) securities.set(security.originCommandId, [...(securities.get(security.originCommandId) ?? []), security])
  for (const command of b.reference.commands) {
    const receiptId = uuid(`perf:receipt:${command.id}`)
    const hash = engine.sha256Hex(command.id)
    statements.push(receiptInsert({ id: receiptId, consoleOrganizationId: 'performance-test-organization', scope: orgId, actor: 'import:seed', route: 'POST /api/import', key: `perf:${command.id}`, requestSha256: hash, status: 200, body: '{}', now }))
    statements.push(commandInsert({
      id: command.id, orgId, type: command.type, receiptId, requestSha256: hash, actorKind: 'import', actorUserId: null, authMethod: null, note: null,
      reversesCommandId: null, expectedLedgerSeq: null, declaredTxCount: command.declaredTxCount, firstSeq: command.firstSeq, lastSeq: command.lastSeq,
      result: '{}', now,
    }))
    for (const security of securities.get(command.id) ?? []) statements.push(securityInsert(orgId, security, { now, pulleyId: `syn-${security.displayId}` }))
    for (const row of rows.get(command.id) ?? []) statements.push(transactionInsert(row))
    if (statements.length >= 2000) await flush()
  }
  await flush()
}

describe('replay of a 10× synthetic org', () => {
  it('cold-reads and replays 20,000 transactions within the budget, cached within the 48 MB budget', async () => {
    const now = Date.UTC(2026, 9, 21, 20)
    const { db } = await openTestApp(now)
    const b = tenfold()
    expect(b.headSeq).toBe(20_000)
    await seedOrg(db, b.orgId, 'acme-robotics')
    await load(db, b, now)
    // Wall time, read with performance.now (the test pins Date).
    const cold = async () => {
      ledgerCache().clear()
      const started = performance.now()
      const loaded = await loadLedger(db, b.orgId)
      const state = stateAt(loaded!, { asOf: '2026-10-21' })
      return { loaded, state, ms: performance.now() - started }
    }
    const firstRun = await cold()
    const { loaded, state, ms: secondMs } = await cold()
    const coldMs = Math.min(firstRun.ms, secondMs)
    const metrics = engine.computeMetrics(state)
    expect(loaded!.transactions).toHaveLength(20_000)
    expect(state.violations.filter((violation) => violation.severity === 'error')).toEqual([])
    // 5,000 × 48,000 granted − 2,500 × 12,000 exercised − 2,500 × 4,800 cancelled.
    const options = [...state.securities.values()].filter((security) => security.identity.family === 'EQUITY_COMPENSATION')
    expect(engine.Dec.sum(options.map((security) => security.outstanding)).toString()).toBe('198000000')
    expect(metrics.plans[0]!.equityOutstanding.isPositive()).toBe(true)
    console.log(JSON.stringify({ event: 'replay_budget', transactions: 20_000, coldMs, cacheBytes: ledgerCache().bytes }))
    expect(coldMs).toBeLessThan(COLD_BUDGET_MS)
    expect(ledgerCache().size).toBe(1)
    expect(ledgerCache().bytes).toBeLessThanOrEqual(LEDGER_CACHE_BYTES)
    expect(ledgerCache().bytes).toBeGreaterThan(30 * 1024 * 1024)

    // Through the router: the first request after a cold cache loads and replays; the next one is served from the cached
    // ledger and its memoized state (the same objects), so it neither reads the ledger again nor replays. The dashboard
    // load also runs the bounded due processing, which finds nothing due here and writes nothing.
    ledgerCache().clear()
    const first = performance.now()
    const response = await sendApi('GET', `/api/orgs/${b.orgId}/cap-table?tab=ownership`, OWNER)
    const coldHttpMs = performance.now() - first
    expect(response.status).toBe(200)
    const table = api.capTableResponseSchema.parse(await response.json())
    expect(table.ownership).toHaveLength(1250)
    const cached = await loadLedger(db, b.orgId)
    const memoized = stateAt(cached!, { asOf: '2026-10-21' })
    const second = performance.now()
    const warm = await sendApi('GET', `/api/orgs/${b.orgId}/dashboard`, OWNER)
    const warmHttpMs = performance.now() - second
    expect(warm.status).toBe(200)
    expect(await loadLedger(db, b.orgId)).toBe(cached)
    expect(stateAt(cached!, { asOf: '2026-10-21' })).toBe(memoized)
    console.log(JSON.stringify({ event: 'replay_budget_http', coldHttpMs, warmHttpMs }))
    expect(coldHttpMs).toBeLessThan(COLD_BUDGET_MS)
    expect(warmHttpMs).toBeLessThan(10_000)
  }, 600_000)
})
