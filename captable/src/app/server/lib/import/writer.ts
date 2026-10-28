import { api, engine } from '#shared'
import { replayPlan, toEngineVestingDefinition, type ImportWritePlan } from '../../../import/index.ts'
import type { AppDeps } from '../../types.ts'
import {
  commandInsert,
  dependencyInsert,
  prepare,
  receiptInsert,
  sealAssertions,
  securityInsert,
  stmt,
  transactionInsert,
  vestingTermsInsert,
  type Stmt,
} from '../ledger/statements.ts'
import { uuidForImport } from './ids.ts'

const TARGET_BATCH_STATEMENTS = 250
const IMPORT_COMMAND_ROUTE = 'POST /api/import/runs/:runId/commit#command'

async function idsIn(db: D1Database, table: string, orgId: string): Promise<Set<string>> {
  const { results } = await db.prepare(`SELECT id FROM ${table} WHERE org_id = ?`).bind(orgId).all<{ id: string }>()
  return new Set(results.map((row) => row.id))
}

function referenceStatements(
  plan: ImportWritePlan,
  existing: {
    stakeholders: Set<string>
    emails: Set<string>
    classes: Set<string>
    plans: Set<string>
    vesting: Set<string>
  },
  userId: string,
  now: number,
): Stmt[][] {
  const units: Stmt[][] = []
  for (const row of plan.referenceRows) {
    if (row.entity === 'stakeholder') {
      if (!existing.stakeholders.has(row.id)) units.push([stmt(
          `INSERT INTO stakeholders
           (id, org_id, kind, display_name, relationship, tax_status, portal_access, version, created_at, updated_at, pulley_id)
           VALUES (?, ?, ?, ?, ?, 'unknown', 'auto', 1, ?, ?, ?)`,
          row.id, plan.orgId, row.kind, row.displayName, row.relationship, now, now, row.sourceId,
        )])
      if (row.email) {
        const emailId = uuidForImport(`email:${plan.orgId}:${row.id}:${row.email}`)
        if (!existing.emails.has(emailId)) units.push([stmt(
          `INSERT INTO stakeholder_emails
           (id, org_id, stakeholder_id, email, kind, added_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          emailId, plan.orgId, row.id, row.email.toLowerCase(), row.kind === 'individual' ? 'self' : 'contact',
          userId, now,
        )])
      }
    } else if (row.entity === 'stock_class' && !existing.classes.has(row.id)) {
      units.push([stmt(
        `INSERT INTO stock_classes
         (id, org_id, name, class_type, default_id_prefix, original_issue_price, currency, version, created_at, updated_at, pulley_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
        row.id, plan.orgId, row.name, row.classType, row.classType === 'COMMON' ? 'CS' : 'PS',
        row.originalIssuePrice?.amount ?? null, row.currency, now, now, row.sourceId,
      )])
    } else if (row.entity === 'stock_plan' && !existing.plans.has(row.id)) {
      units.push([stmt(
        `INSERT INTO stock_plans
         (id, org_id, name, stock_class_id, effective_date, version, created_at, updated_at, pulley_id)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)`,
        row.id, plan.orgId, row.name, row.stockClassId, row.effectiveDate, now, now, row.sourceId,
      )])
    } else if (row.entity === 'vesting_terms' && !existing.vesting.has(row.id)) {
      units.push([vestingTermsInsert({
        id: row.id,
        orgId: plan.orgId,
        name: row.name,
        definition: engine.canonicalJson(toEngineVestingDefinition(row.definition)),
        definitionSha256: row.definitionSha256,
        createdBy: userId,
        pulleyId: row.sourceId,
        now,
      })])
    }
  }
  return units
}

function plannedLedger(
  plan: ImportWritePlan,
  consoleOrganizationId: string,
  now: number,
  prefix: number,
  startSeq: number,
  startHash: string,
): {
  commandUnits: Stmt[][]
  dependencyUnits: Stmt[][]
  lastHash: string | null
  plannedState: engine.LedgerState
} {
  const { state } = replayPlan(plan)
  const dependencyUnits: Stmt[][] = []
  const commandUnits: Stmt[][] = []
  let seq = startSeq
  let previousHash = startHash
  for (const command of plan.commands.slice(prefix)) {
    const firstSeq = seq + 1
    const decoded: engine.LedgerTransaction[] = []
    for (const transaction of command.transactions) {
      seq += 1
      decoded.push(engine.decodeTransaction({
        id: transaction.id,
        seq,
        commandId: command.id,
        type: transaction.type,
        effectiveDate: transaction.effectiveDate,
        payload: transaction.payload,
        payloadVersion: transaction.payloadVersion,
        securityId: transaction.securityId,
        stakeholderId: transaction.stakeholderId,
        stockClassId: transaction.stockClassId,
        stockPlanId: transaction.stockPlanId,
        valuationId: transaction.valuationId,
        quantity: transaction.quantity,
        amount: transaction.amount,
        currency: transaction.currency,
        source: 'import',
      }))
    }
    const receiptId = uuidForImport(`command-receipt:${plan.orgId}:${command.id}`)
    const requestSha256 = engine.sha256Hex(engine.canonicalJson(command))
    const units: Stmt[] = [
      receiptInsert({
        id: receiptId,
        consoleOrganizationId,
        scope: plan.orgId,
        actor: `import:${plan.orgId}`,
        route: IMPORT_COMMAND_ROUTE,
        key: command.idempotencyKey,
        requestSha256,
        status: 200,
        body: '{}',
        now,
      }),
      commandInsert({
        id: command.id,
        orgId: plan.orgId,
        type: command.type,
        receiptId,
        requestSha256,
        actorKind: 'import',
        actorUserId: null,
        authMethod: null,
        note: null,
        reversesCommandId: null,
        expectedLedgerSeq: null,
        declaredTxCount: decoded.length,
        firstSeq,
        lastSeq: seq,
        result: JSON.stringify({ sourceId: command.sourceId }),
        now,
      }),
    ]
    for (const security of command.securities) {
      units.push(securityInsert(plan.orgId, {
        id: security.id,
        family: security.family,
        subtype: security.subtype,
        stakeholderId: security.stakeholderId,
        stockClassId: security.stockClassId,
        stockPlanId: security.stockPlanId,
        displayId: security.displayId,
        originCommandId: command.id,
        parentSecurityId: security.parentSecurityId,
      }, { now, pulleyId: security.sourceId }))
    }
    decoded.forEach((transaction, index) => {
      const planned = command.transactions[index]!
      const row = engine.buildTransactionRow(transaction, {
        orgId: plan.orgId,
        recordedAt: now,
        recordedBy: null,
        pulleyRef: planned.sourceRef,
      }, previousHash)
      previousHash = row.chain_hash
      units.push(transactionInsert(row))
    })
    units.push(...sealAssertions(plan.orgId, command.id, decoded.length, null))
    commandUnits.push(units)
  }
  for (const command of plan.commands) {
    for (const edge of engine.commandDependencies(state, command.id)) {
      dependencyUnits.push([dependencyInsert(plan.orgId, edge, { ignore: true })])
    }
  }
  return { commandUnits, dependencyUnits, lastHash: seq === 0 ? null : previousHash, plannedState: state }
}

function certificateUnits(plan: ImportWritePlan, existing: Set<string>, now: number): Stmt[][] {
  return plan.referenceRows.flatMap((row) => {
    if (row.entity !== 'certificate' || existing.has(row.id)) return []
    return [[stmt(
      `INSERT INTO certificates
       (id, org_id, security_id, certificate_number, status, issued_date, cancelled_date, cancel_reason,
        signatories, legends, version, created_at, updated_at, pulley_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, '[]', '[]', 1, ?, ?, ?)`,
      row.id, plan.orgId, row.securityId, row.certificateNumber, row.status, row.issuedDate, row.cancelledDate,
      row.status === 'ISSUED' ? null : 'Imported current certificate status', now, now, row.sourceId,
    )]]
  })
}

/** The exact insert statements a fresh import will use, before D1 prepares or executes any of them. */
export function importPlanStatementsForValidation(plan: ImportWritePlan): Stmt[] {
  const none = new Set<string>()
  const ledger = plannedLedger(plan, 'import-validation-organization', 0, 0, 0, engine.genesisHash(plan.orgId))
  return [
    ...referenceStatements(plan, {
      stakeholders: none, emails: none, classes: none, plans: none, vesting: none,
    }, 'import-preview-validator', 0),
    ...ledger.commandUnits,
    ...ledger.dependencyUnits,
    ...certificateUnits(plan, none, 0),
  ].flat()
}

function batchesOf(units: readonly Stmt[][]): Stmt[][] {
  const batches: Stmt[][] = []
  let current: Stmt[] = []
  for (const unit of units) {
    if (current.length > 0 && current.length + unit.length > TARGET_BATCH_STATEMENTS) {
      batches.push(current)
      current = []
    }
    current.push(...unit)
  }
  if (current.length > 0) batches.push(current)
  return batches
}

export interface ImportWriteResult {
  expectedHeadHash: string | null
  expectedLedgerSeq: number
  expectedMetricFingerprint: string
  expectedDependencies: number
  batches: number
}

/** Writes references and whole ledger commands in bounded D1 batches while the org remains invisible. */
export async function writeImportPlan(
  db: D1Database,
  deps: AppDeps,
  plan: ImportWritePlan,
  consoleOrganizationId: string,
  userId: string,
  now: number,
): Promise<ImportWriteResult> {
  const [stakeholders, emails, classes, plans, vesting, certificates, commandRows, head] = await Promise.all([
    idsIn(db, 'stakeholders', plan.orgId),
    idsIn(db, 'stakeholder_emails', plan.orgId),
    idsIn(db, 'stock_classes', plan.orgId),
    idsIn(db, 'stock_plans', plan.orgId),
    idsIn(db, 'vesting_terms', plan.orgId),
    idsIn(db, 'certificates', plan.orgId),
    db.prepare('SELECT id FROM commands WHERE org_id = ? ORDER BY first_seq').bind(plan.orgId).all<{ id: string }>(),
    db.prepare('SELECT seq, genesis_hash, head_hash FROM ledger_heads WHERE org_id = ?').bind(plan.orgId)
      .first<{ seq: number; genesis_hash: string; head_hash: string | null }>(),
  ])
  if (!head) throw new Error('The importing company has no ledger head')
  const existingCommandIds = commandRows.results.map((row) => row.id)
  const prefix = existingCommandIds.length
  if (prefix > plan.commands.length || existingCommandIds.some((id, index) => plan.commands[index]?.id !== id)) {
    throw new Error('The interrupted import does not match the reviewed command sequence')
  }
  const expectedSeq = plan.commands.slice(0, prefix).reduce((sum, command) => sum + command.transactions.length, 0)
  if (head.seq !== expectedSeq || (head.seq === 0 ? head.head_hash !== null : head.head_hash === null)) {
    throw new Error('The interrupted import ledger is not at a complete command boundary')
  }
  const ledger = plannedLedger(plan, consoleOrganizationId, now, prefix, head.seq, head.head_hash ?? head.genesis_hash)

  const units = [
    ...referenceStatements(plan, { stakeholders, emails, classes, plans, vesting }, userId, now),
    ...ledger.commandUnits,
    ...ledger.dependencyUnits,
    ...certificateUnits(plan, certificates, now),
  ]
  const batches = batchesOf(units)
  for (const [batchIndex, statements] of batches.entries()) {
    await deps.runImportBatch(db, statements.map((statement) => prepare(db, statement)), batchIndex)
  }
  return {
    expectedHeadHash: ledger.lastHash,
    expectedLedgerSeq: plan.commands.reduce((sum, command) => sum + command.transactions.length, 0),
    expectedMetricFingerprint: metricFingerprint(ledger.plannedState),
    expectedDependencies: ledger.dependencyUnits.length,
    batches: batches.length,
  }
}

export function metricFingerprint(state: engine.LedgerState): string {
  const metrics = engine.computeMetrics(state)
  const holderOutstanding = (stakeholderId: string) => engine.Dec.sum(
    metrics.securities
      .filter((security) => security.stakeholderId === stakeholderId && security.family !== 'CONVERTIBLE')
      .map((security) => security.outstanding),
  ).toCanonical()
  return engine.canonicalJson({
    company: {
      fullyDiluted: metrics.fullyDiluted.toCanonical(),
      issuedAndOutstanding: metrics.issuedAndOutstanding.toCanonical(),
    },
    classes: metrics.classes.map((row) => ({ id: row.stockClassId, outstanding: row.issuedAndOutstanding.toCanonical() }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    plans: metrics.plans.map((row) => ({
      id: row.stockPlanId,
      outstanding: row.equityOutstanding.toCanonical(),
      available: row.available.toCanonical(),
    })).sort((left, right) => left.id.localeCompare(right.id)),
    holders: metrics.holders.map((row) => ({
      id: row.stakeholderId,
      fullyDiluted: row.fullyDiluted.toCanonical(),
      outstanding: holderOutstanding(row.stakeholderId),
    })).sort((left, right) => left.id.localeCompare(right.id)),
  })
}

export function assertStoredTotals(expectedFingerprint: string, storedState: engine.LedgerState | null): void {
  if (!storedState || expectedFingerprint !== metricFingerprint(storedState)) {
    throw new Error('The stored cap table totals do not match the reviewed preview')
  }
}

export function expectedDatabaseCounts(plan: ImportWritePlan): api.ImportCounts {
  return api.importCountsSchema.parse({
    stakeholders: plan.referenceRows.filter((row) => row.entity === 'stakeholder').length,
    shareClasses: plan.referenceRows.filter((row) => row.entity === 'stock_class').length,
    equityPlans: plan.referenceRows.filter((row) => row.entity === 'stock_plan').length,
    securities: plan.commands.reduce((sum, command) => sum + command.securities.length, 0),
    commands: plan.commands.length,
    transactions: plan.commands.reduce((sum, command) => sum + command.transactions.length, 0),
  })
}

export interface ImportDatabaseCounts extends api.ImportCounts {
  stakeholderEmails: number
  vestingTerms: number
  certificates: number
  dependencies: number
}

export function expectedImportDatabaseCounts(plan: ImportWritePlan, dependencies: number): ImportDatabaseCounts {
  const counts = expectedDatabaseCounts(plan)
  return {
    ...counts,
    stakeholderEmails: plan.referenceRows.filter((row) => row.entity === 'stakeholder' && row.email !== null).length,
    vestingTerms: plan.referenceRows.filter((row) => row.entity === 'vesting_terms').length,
    certificates: plan.referenceRows.filter((row) => row.entity === 'certificate').length,
    dependencies,
  }
}
