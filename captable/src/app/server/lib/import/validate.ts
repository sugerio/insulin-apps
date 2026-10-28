import { api, engine } from '#shared'
import type {
  ImportPreview,
  ImportProblem,
  ImportReferenceRow,
  ImportWritePlan,
  SourceLocation,
} from '../../../import/index.ts'
import { MAX_STATEMENT_BYTES, MAX_STATEMENT_PARAMETERS, statementBytes } from '../ledger/statements.ts'
import { importPlanStatementsForValidation } from './writer.ts'

const utf8 = new TextEncoder()
export const MAX_IMPORT_SECURITIES = 2_000

function issue(message: string, source: SourceLocation | null): ImportProblem {
  return { severity: 'error', code: 'DATABASE_CONSTRAINT', message, source }
}

function sourceFor(preview: ImportPreview, sourceId: string | null): SourceLocation | null {
  if (sourceId === null) return null
  return preview.draft.stakeholders.find((row) => row.sourceId === sourceId)?.source
    ?? preview.draft.shareClasses.find((row) => row.sourceId === sourceId)?.source
    ?? preview.draft.equityPlans.find((row) => row.sourceId === sourceId)?.source
    ?? preview.draft.securities.find((row) => row.sourceId === sourceId)?.source
    ?? preview.draft.vesting.find((row) => row.securitySourceId === sourceId)?.source
    ?? preview.draft.exercises.find((row) => row.sourceId === sourceId)?.source
    ?? preview.draft.cancellations.find((row) => row.sourceId === sourceId)?.source
    ?? null
}

function profileSource(preview: ImportPreview): SourceLocation | null {
  return preview.draft.totals?.company?.source
    ?? (preview.detectedFiles[0] ? { file: preview.detectedFiles[0].name, sheet: 'Company', row: 2, column: 'Company name' } : null)
}

function bounded(value: string, max: number): boolean {
  return value.length > 0 && value.length <= max
}

function addDuplicateProblems<T>(
  rows: readonly T[],
  value: (row: T) => string | null,
  label: string,
  source: (row: T) => SourceLocation | null,
  problems: ImportProblem[],
): void {
  const seen = new Set<string>()
  for (const row of rows) {
    const key = value(row)
    if (key === null) continue
    if (seen.has(key)) problems.push(issue(`${label} must be unique in the import.`, source(row)))
    seen.add(key)
  }
}

/** Checks every CHECK/UNIQUE/FK shape and D1 statement ceiling the import writer can hit. */
export function validateImportPlan(preview: ImportPreview, plan: ImportWritePlan): ImportProblem[] {
  const problems: ImportProblem[] = []
  const profile = plan.referenceRows.find(
    (row): row is Extract<ImportReferenceRow, { entity: 'org_profile' }> => row.entity === 'org_profile',
  )
  if (!profile) return [issue('The reviewed import has no company profile.', profileSource(preview))]
  const companySource = profileSource(preview)
  if (!bounded(profile.legalName, 200)) problems.push(issue('The company legal name must be 1–200 characters.', companySource))
  if (!bounded(profile.displayName, 100)) problems.push(issue('The company display name must be 1–100 characters.', companySource))
  if (!/^[A-Z]{3}$/.test(profile.currency)) problems.push(issue('The company currency must be a three-letter uppercase code.', companySource))
  if (!engine.Dec.isCanonical(profile.shareUnit) || profile.shareUnit === '0') {
    problems.push(issue('The share unit must be a positive exact decimal.', companySource))
  }

  const stakeholders = plan.referenceRows.filter(
    (row): row is Extract<ImportReferenceRow, { entity: 'stakeholder' }> => row.entity === 'stakeholder',
  )
  const classes = plan.referenceRows.filter(
    (row): row is Extract<ImportReferenceRow, { entity: 'stock_class' }> => row.entity === 'stock_class',
  )
  const plans = plan.referenceRows.filter(
    (row): row is Extract<ImportReferenceRow, { entity: 'stock_plan' }> => row.entity === 'stock_plan',
  )
  const vesting = plan.referenceRows.filter(
    (row): row is Extract<ImportReferenceRow, { entity: 'vesting_terms' }> => row.entity === 'vesting_terms',
  )
  const certificates = plan.referenceRows.filter(
    (row): row is Extract<ImportReferenceRow, { entity: 'certificate' }> => row.entity === 'certificate',
  )
  const securities = plan.commands.flatMap((command) => command.securities)
  const transactions = plan.commands.flatMap((command) => command.transactions)
  if (securities.length > MAX_IMPORT_SECURITIES) {
    problems.push(issue(`Import at most ${MAX_IMPORT_SECURITIES.toLocaleString('en-US')} securities at once.`, companySource))
  }

  for (const row of stakeholders) {
    const source = sourceFor(preview, row.sourceId)
    if (!bounded(row.displayName, 200)) problems.push(issue('Stakeholder names must be 1–200 characters.', source))
    if (row.email !== null && !api.emailSchema.safeParse(row.email.toLowerCase()).success) {
      problems.push(issue('Enter a valid stakeholder e-mail address of at most 254 characters.', source))
    }
  }
  for (const row of classes) {
    const source = sourceFor(preview, row.sourceId)
    if (!bounded(row.name, 100)) problems.push(issue('Share class names must be 1–100 characters.', source))
    if (!/^[A-Z]{3}$/.test(row.currency)) problems.push(issue('Share class currency must be a three-letter uppercase code.', source))
    if (row.originalIssuePrice && !engine.Dec.isCanonical(row.originalIssuePrice.amount)) {
      problems.push(issue('Original issue prices must be exact non-negative decimals.', source))
    }
  }
  for (const row of plans) {
    if (!bounded(row.name, 200)) problems.push(issue('Equity plan names must be 1–200 characters.', sourceFor(preview, row.sourceId)))
  }
  for (const row of vesting) {
    const source = sourceFor(preview, row.sourceId)
    if (!bounded(row.name, 200)) problems.push(issue('Vesting terms names must be 1–200 characters.', source))
    const definition = engine.canonicalJson(row.definition)
    if (utf8.encode(definition).byteLength > 262_144) problems.push(issue('A vesting schedule is too large to store.', source))
    if (!/^[0-9a-f]{64}$/.test(row.definitionSha256)) problems.push(issue('A vesting schedule has an invalid integrity hash.', source))
  }
  for (const row of certificates) {
    const source = sourceFor(preview, row.sourceId)
    if (!bounded(row.certificateNumber, 40)) problems.push(issue('Certificate numbers must be 1–40 characters.', source))
    if ((row.status === 'ISSUED') !== (row.cancelledDate === null)) {
      problems.push(issue('A cancelled or void certificate must include its cancellation date.', source))
    }
  }
  for (const security of securities) {
    if (!bounded(security.displayId, 40)) {
      problems.push(issue('Security IDs and certificate numbers must be 1–40 characters.', sourceFor(preview, security.sourceId)))
    }
  }
  for (const command of plan.commands) {
    if (!bounded(command.type, 64) || command.type.length < 3) {
      problems.push(issue('An imported ledger command has an invalid type.', sourceFor(preview, command.sourceId)))
    }
  }
  for (const transaction of transactions) {
    const source = sourceFor(preview, transaction.sourceRef.split(':')[0] ?? transaction.sourceRef)
    const payload = engine.canonicalJson(transaction.payload)
    if (utf8.encode(payload).byteLength > 65_536) problems.push(issue('An imported ledger record is too large to store.', source))
    if (transaction.currency !== null && !/^[A-Z]{3}$/.test(transaction.currency)) {
      problems.push(issue('Transaction currency must be a three-letter uppercase code.', source))
    }
    if (transaction.quantity !== null && (!engine.Dec.isCanonical(transaction.quantity) || transaction.quantity === '0')) {
      problems.push(issue('Transaction quantities must be non-zero exact decimals.', source))
    }
    if (transaction.amount !== null && !engine.Dec.isCanonical(transaction.amount)) {
      problems.push(issue('Transaction amounts must be exact non-negative decimals.', source))
    }
  }

  const classIds = new Set(classes.map((row) => row.id))
  const stakeholderIds = new Set(stakeholders.map((row) => row.id))
  const planIds = new Set(plans.map((row) => row.id))
  const securityIds = new Set(securities.map((row) => row.id))
  for (const row of plans) if (!classIds.has(row.stockClassId)) {
    problems.push(issue('An equity plan refers to a share class that is not in the import.', sourceFor(preview, row.sourceId)))
  }
  for (const row of securities) {
    const source = sourceFor(preview, row.sourceId)
    if (!stakeholderIds.has(row.stakeholderId)) problems.push(issue('A security refers to a stakeholder that is not in the import.', source))
    if (row.stockClassId !== null && !classIds.has(row.stockClassId)) problems.push(issue('A security refers to a share class that is not in the import.', source))
    if (row.stockPlanId !== null && !planIds.has(row.stockPlanId)) problems.push(issue('A security refers to an equity plan that is not in the import.', source))
  }
  for (const row of certificates) if (!securityIds.has(row.securityId)) {
    problems.push(issue('A certificate refers to a security that is not in the import.', sourceFor(preview, row.sourceId)))
  }

  addDuplicateProblems(stakeholders, (row) => row.id, 'Stakeholder IDs', (row) => sourceFor(preview, row.sourceId), problems)
  addDuplicateProblems(stakeholders, (row) => row.sourceId, 'Stakeholder source IDs', (row) => sourceFor(preview, row.sourceId), problems)
  addDuplicateProblems(classes, (row) => row.id, 'Share class IDs', (row) => sourceFor(preview, row.sourceId), problems)
  addDuplicateProblems(classes, (row) => row.name, 'Share class names', (row) => sourceFor(preview, row.sourceId), problems)
  addDuplicateProblems(classes, (row) => row.sourceId, 'Share class source IDs', (row) => sourceFor(preview, row.sourceId), problems)
  addDuplicateProblems(plans, (row) => row.id, 'Equity plan IDs', (row) => sourceFor(preview, row.sourceId), problems)
  addDuplicateProblems(plans, (row) => row.sourceId, 'Equity plan source IDs', (row) => sourceFor(preview, row.sourceId), problems)
  addDuplicateProblems(vesting, (row) => row.id, 'Vesting terms IDs', (row) => sourceFor(preview, row.sourceId), problems)
  addDuplicateProblems(vesting, (row) => row.sourceId, 'Vesting terms source IDs', (row) => sourceFor(preview, row.sourceId), problems)
  addDuplicateProblems(securities, (row) => row.id, 'Security IDs', (row) => sourceFor(preview, row.sourceId), problems)
  addDuplicateProblems(securities, (row) => row.displayId, 'Security display IDs', (row) => sourceFor(preview, row.sourceId), problems)
  addDuplicateProblems(securities, (row) => row.sourceId, 'Security source IDs', (row) => sourceFor(preview, row.sourceId), problems)
  addDuplicateProblems(certificates, (row) => row.id, 'Certificate IDs', (row) => sourceFor(preview, row.sourceId), problems)
  addDuplicateProblems(certificates, (row) => row.certificateNumber, 'Certificate numbers', (row) => sourceFor(preview, row.sourceId), problems)
  addDuplicateProblems(certificates.filter((row) => row.status === 'ISSUED'), (row) => row.securityId,
    'Issued certificates for one security', (row) => sourceFor(preview, row.sourceId), problems)
  addDuplicateProblems(plan.commands, (row) => row.id, 'Ledger command IDs', (row) => sourceFor(preview, row.sourceId), problems)
  addDuplicateProblems(plan.commands, (row) => row.idempotencyKey, 'Ledger command idempotency keys', (row) => sourceFor(preview, row.sourceId), problems)
  addDuplicateProblems(transactions, (row) => row.id, 'Ledger transaction IDs', (row) => sourceFor(preview, row.sourceRef), problems)
  addDuplicateProblems(transactions, (row) => row.sourceRef, 'Ledger source references', (row) => sourceFor(preview, row.sourceRef), problems)

  if (securities.length === 0) problems.push(issue('Add at least one share, option, warrant, or SAFE before importing.', companySource))

  try {
    for (const statement of importPlanStatementsForValidation(plan)) {
      if (statement.params.length > MAX_STATEMENT_PARAMETERS) {
        problems.push(issue('An imported record contains too many fields to store.', null))
        break
      }
      if (statementBytes(statement) > MAX_STATEMENT_BYTES) {
        problems.push(issue('An imported record is too large to store. Shorten it in the source file.', null))
        break
      }
    }
  } catch {
    problems.push(issue('The reviewed ledger plan could not be prepared for storage.', null))
  }
  return problems
}

export function addImportProblems(preview: ImportPreview, additions: readonly ImportProblem[]): ImportPreview {
  if (additions.length === 0) return preview
  const seen = new Set<string>()
  const problems = [...preview.problems, ...additions].filter((problem) => {
    const key = `${problem.severity}|${problem.code}|${problem.message}|${problem.source?.file ?? ''}|${problem.source?.sheet ?? ''}|${problem.source?.row ?? ''}|${problem.source?.column ?? ''}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  const canImport = preview.plan !== null && !problems.some((problem) => problem.severity === 'error')
  return { ...preview, problems, plan: canImport ? preview.plan : null, canImport }
}
