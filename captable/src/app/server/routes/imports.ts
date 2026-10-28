import { api, engine } from '#shared'
import { Hono, type Context } from 'hono'
import { generateCapTableTemplate, type ImportProblem, type ImportWritePlan } from '../../import/index.ts'
import { insertAudit } from '../lib/audit.ts'
import { ApiError, clientIp, logError, notFound, userAgent } from '../lib/http.ts'
import { commitIdempotent, prepareIdempotency } from '../lib/idempotency.ts'
import { verifyOrgLedger } from '../lib/ledger/verify.ts'
import {
  buildCorePreview,
  fileDigests,
  importCounts,
  planSha256,
  previewOrgId,
  publicPreview,
  retryOrgId,
  uploadedFiles,
  type ImportFileDigest,
} from '../lib/import/preview.ts'
import { addImportProblems } from '../lib/import/validate.ts'
import { readImportForm } from '../lib/import/form.ts'
import {
  assertStoredTotals,
  expectedDatabaseCounts,
  expectedImportDatabaseCounts,
  writeImportPlan,
  type ImportDatabaseCounts,
} from '../lib/import/writer.ts'
import type { AppDeps, AppEnv } from '../types.ts'

const COMMIT_ROUTE = 'POST /api/import/runs/:runId/commit'
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

interface ImportRunRow {
  id: string
  console_organization_id: string | null
  source_system: api.ImportSource
  status: api.ImportRunStatus
  file_hashes: string
  as_of_date: string | null
  plan_sha256: string
  counts: string
  created_by: string
  org_id: string | null
  error_message: string | null
  timezone: string
  jurisdiction: string
  fiscal_year_end: string
  attempt_id: string | null
  attempt_expires_at: number | null
  created_at: number
  updated_at: number
}

interface OrgStatusRow { id: string; status: 'importing' | 'active' | 'archived' }

interface ActiveCompany {
  id: string
  org_key: string
  slug: string
  legal_name: string
  display_name: string
  entity_type: string
  jurisdiction: string
  incorporation_date: string | null
  timezone: string
  currency: string
  fiscal_year_end: string
  ein: string | null
  address: string | null
  share_unit: string
  settings: string
  stakeholders: number
  transactions: number
  documents: number
  collections: number
  payment_instructions: number
  signatories: number
  legends: number
  valuations: number
}

function parseRunId(c: Context<AppEnv>, route: typeof api.routes.commitImport | typeof api.routes.getImportRun): string {
  const parsed = route.params.safeParse(c.req.param())
  if (!parsed.success) throw notFound()
  return parsed.data.runId
}

function parseJson<T>(text: string, fallback: T): T {
  try { return JSON.parse(text) as T } catch { return fallback }
}

function runOutput(row: ImportRunRow): api.ImportRun {
  return api.importRunSchema.parse({
    runId: row.id,
    source: row.source_system,
    status: row.status,
    asOfDate: row.as_of_date,
    fileHashes: parseJson<ImportFileDigest[]>(row.file_hashes, []).map((file) => file.sha256),
    counts: parseJson(row.counts, {}),
    orgId: row.org_id,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  })
}

function audit(c: Context<AppEnv>, now: number, action: string, runId: string, orgId: string | null, result: 'success' | 'error', details: Record<string, unknown>) {
  const auth = c.get('auth')
  return insertAudit(c.env.DB, {
    occurredAt: now,
    consoleOrganizationId: auth.consoleOrganizationId,
    orgId,
    actorUserId: auth.user.id,
    actorEmail: auth.user.email,
    authMethod: auth.authMethod,
    action,
    targetType: 'import_run',
    targetId: runId,
    result,
    ip: clientIp(c),
    userAgent: userAgent(c),
    details,
  })
}

function sameDigests(left: readonly ImportFileDigest[], right: readonly ImportFileDigest[]): boolean {
  return engine.canonicalJson(left) === engine.canonicalJson(right)
}

async function activeCompany(db: D1Database, consoleOrganizationId: string): Promise<ActiveCompany | null> {
  return db.prepare(
    `SELECT o.*,
       (SELECT COUNT(*) FROM stakeholders s WHERE s.org_id = o.id) AS stakeholders,
       (SELECT COUNT(*) FROM transactions t WHERE t.org_id = o.id) AS transactions,
       (SELECT COUNT(*) FROM documents d WHERE d.org_id = o.id) AS documents,
       (SELECT COUNT(*) FROM document_collections c WHERE c.org_id = o.id) AS collections,
       (SELECT COUNT(*) FROM payment_instructions p WHERE p.org_id = o.id) AS payment_instructions,
       (SELECT COUNT(*) FROM org_signatories s WHERE s.org_id = o.id) AS signatories,
       (SELECT COUNT(*) FROM legends l WHERE l.org_id = o.id) AS legends,
       (SELECT COUNT(*) FROM valuations v WHERE v.org_id = o.id) AS valuations
     FROM orgs o WHERE o.console_organization_id = ? AND o.status = 'active' LIMIT 1`,
  ).bind(consoleOrganizationId).first<ActiveCompany>()
}

function unavailableMessage(company: ActiveCompany): string | null {
  if (company.stakeholders > 0 || company.transactions > 0) {
    return 'Import is only available before the company has stakeholders or ledger activity'
  }
  const configured = [
    company.documents > 0 ? 'documents' : null,
    company.collections > 0 ? 'document collections' : null,
    company.payment_instructions > 0 ? 'payment instructions' : null,
    company.signatories > 0 ? 'signatories' : null,
    company.legends > 0 ? 'legends' : null,
    company.valuations > 0 ? 'valuations' : null,
  ].filter((name): name is string => name !== null)
  return configured.length > 0
    ? `This company already has ${configured.join(', ')}. Import only replaces a company without saved business records.`
    : null
}

function planSourceIds(plan: ImportWritePlan): string[] {
  return [...new Set([
    ...plan.referenceRows.filter((row) => row.entity !== 'org_profile')
      .map((row) => row.sourceId).filter((id): id is string => id !== null),
    ...plan.commands.flatMap((command) => command.securities.map((security) => security.sourceId)),
  ])]
}

async function sourceIdsAlreadyActive(
  db: D1Database,
  consoleOrganizationId: string,
  plan: ImportWritePlan,
): Promise<boolean> {
  const sourceIds = planSourceIds(plan)
  for (let offset = 0; offset < sourceIds.length; offset += 400) {
    const ids = JSON.stringify(sourceIds.slice(offset, offset + 400))
    const found = await db.prepare(
      `WITH wanted(value) AS (SELECT value FROM json_each(?1))
       SELECT
	         EXISTS (SELECT 1 FROM stakeholders s JOIN orgs o ON o.id = s.org_id AND o.status = 'active'
	                 AND o.console_organization_id = ?2
	                 JOIN wanted w ON w.value = s.pulley_id) OR
	         EXISTS (SELECT 1 FROM stock_classes c JOIN orgs o ON o.id = c.org_id AND o.status = 'active'
	                 AND o.console_organization_id = ?2
	                 JOIN wanted w ON w.value = c.pulley_id) OR
	         EXISTS (SELECT 1 FROM stock_plans p JOIN orgs o ON o.id = p.org_id AND o.status = 'active'
	                 AND o.console_organization_id = ?2
	                 JOIN wanted w ON w.value = p.pulley_id) OR
	         EXISTS (SELECT 1 FROM vesting_terms v JOIN orgs o ON o.id = v.org_id AND o.status = 'active'
	                 AND o.console_organization_id = ?2
	                 JOIN wanted w ON w.value = v.pulley_id) OR
	         EXISTS (SELECT 1 FROM securities s JOIN orgs o ON o.id = s.org_id AND o.status = 'active'
	                 AND o.console_organization_id = ?2
	                 JOIN wanted w ON w.value = s.pulley_id) OR
	         EXISTS (SELECT 1 FROM certificates c JOIN orgs o ON o.id = c.org_id AND o.status = 'active'
	                 AND o.console_organization_id = ?2
	                 JOIN wanted w ON w.value = c.pulley_id) AS found`,
	    ).bind(ids, consoleOrganizationId).first<number>('found')
    if (found === 1) return true
  }
  return false
}

function profileOf(plan: ImportWritePlan): Extract<ImportWritePlan['referenceRows'][number], { entity: 'org_profile' }> {
  const profile = plan.referenceRows.find((row) => row.entity === 'org_profile')
  if (!profile) throw new Error('The reviewed import has no company profile')
  return profile
}

async function prepareImportingCompany(
  c: Context<AppEnv>,
  run: ImportRunRow,
  previewPlan: ImportWritePlan,
  files: Awaited<ReturnType<typeof uploadedFiles>>,
  active: ActiveCompany | null,
  attemptId: string,
  now: number,
): Promise<{ plan: ImportWritePlan; orgId: string }> {
  const consoleOrganizationId = c.get('auth').consoleOrganizationId
  if (run.attempt_id && run.attempt_expires_at && run.attempt_expires_at > now) {
    throw new ApiError('conflict', 'This import is already running', undefined, { reason: 'state_changed' })
  }
  const prior = run.org_id
    ? await c.env.DB.prepare(
      'SELECT id, status FROM orgs WHERE id = ? AND console_organization_id = ?',
    ).bind(run.org_id, consoleOrganizationId).first<OrgStatusRow>()
    : null

  let plan: ImportWritePlan
  let orgId: string
  if (run.status === 'previewed' && prior?.status === 'importing') {
    orgId = prior.id
    if (orgId === previewPlan.orgId) plan = previewPlan
    else {
      const preview = buildCorePreview(run.source_system, files, {
        asOfDate: previewPlan.asOfDate,
        today: engine.orgToday(active?.timezone ?? run.timezone, now),
        orgId,
        fallbackCurrency: active?.currency ?? 'USD',
      })
      if (!preview.canImport || !preview.plan) throw new Error('The import can no longer be rebuilt for its company')
      plan = preview.plan
    }
  } else {
    if (prior?.status === 'active') throw new Error('The previous import company is not in a resumable state')
    orgId = prior ? retryOrgId(run.id, prior.id) : previewOrgId(run.id)
    const rebuilt = orgId === previewPlan.orgId
      ? { canImport: true, plan: previewPlan }
      : buildCorePreview(run.source_system, files, {
        asOfDate: previewPlan.asOfDate,
        today: engine.orgToday(active?.timezone ?? run.timezone, now),
        orgId,
        fallbackCurrency: active?.currency ?? 'USD',
      })
    if (!rebuilt.canImport || !rebuilt.plan) throw new Error('The import could not be rebuilt for a retry')
    plan = rebuilt.plan
  }
  const profile = profileOf(plan)
  const suffix = orgId.replaceAll('-', '').slice(0, 12)
  const derivedKey = profile.displayName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'imported-company'
  const orgKey = active?.org_key ?? `${derivedKey.slice(0, 27)}-${suffix}`
  const slug = active ? `${active.slug.slice(0, 47)}-${suffix}` : orgKey
  const statements: D1PreparedStatement[] = [
    c.env.DB.prepare(
      `UPDATE import_runs SET status = 'previewed', attempt_id = ?, attempt_expires_at = ?, error_message = NULL, updated_at = ?
       WHERE id = ? AND console_organization_id = ? AND status IN ('previewed', 'failed')
         AND (attempt_id IS NULL OR attempt_expires_at <= ?)`,
    ).bind(attemptId, now + 10 * 60_000, now, run.id, consoleOrganizationId, now),
    c.env.DB.prepare('INSERT INTO batch_assertions (ok) VALUES (changes() = 1)'),
    c.env.DB.prepare(
      `UPDATE orgs SET status = 'archived', version = version + 1, updated_at = ?
       WHERE console_organization_id = ? AND status = 'importing' AND id <> ? AND EXISTS (
         SELECT 1 FROM import_runs r WHERE r.org_id = orgs.id
           AND r.console_organization_id = ?
           AND (r.status = 'failed' OR (r.attempt_expires_at IS NOT NULL AND r.attempt_expires_at <= ?))
       )`,
    ).bind(now, consoleOrganizationId, orgId, consoleOrganizationId, now),
  ]
  if (prior && prior.id !== orgId && prior.status === 'importing') {
    statements.push(
      c.env.DB.prepare(
        `UPDATE orgs SET status = 'archived', version = version + 1, updated_at = ?
         WHERE id = ? AND console_organization_id = ? AND status = 'importing'`,
      ).bind(now, prior.id, consoleOrganizationId),
      c.env.DB.prepare('INSERT INTO batch_assertions (ok) VALUES (changes() = 1)'),
    )
  }
  if (prior?.id !== orgId) {
    statements.push(
      c.env.DB.prepare(
        `INSERT INTO orgs
         (id, console_organization_id, org_key, slug, status, legal_name, display_name, entity_type, jurisdiction, incorporation_date,
          timezone, currency, fiscal_year_end, ein, address, share_unit, settings, version, created_at, updated_at, pulley_id)
         VALUES (?, ?, ?, ?, 'importing', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, NULL)`,
      ).bind(
        orgId, consoleOrganizationId, orgKey, slug,
        active?.legal_name ?? profile.legalName,
        active?.display_name ?? profile.displayName,
        active?.entity_type ?? 'C_CORPORATION',
        active?.jurisdiction ?? run.jurisdiction,
        active?.incorporation_date ?? null,
        active?.timezone ?? run.timezone,
        profile.currency,
        active?.fiscal_year_end ?? run.fiscal_year_end,
        active?.ein ?? null,
        active?.address ?? null,
        profile.shareUnit,
        active?.settings ?? JSON.stringify(api.DEFAULT_ORG_SETTINGS),
        now, now,
      ),
      c.env.DB.prepare(
        'INSERT INTO ledger_heads (org_id, seq, genesis_hash, head_hash, updated_at) VALUES (?, 0, ?, NULL, ?)',
      ).bind(orgId, engine.genesisHash(orgId), now),
    )
  }
  statements.push(
    c.env.DB.prepare(
      `UPDATE import_runs SET org_id = ?, updated_at = ?
       WHERE id = ? AND console_organization_id = ? AND attempt_id = ?`,
    ).bind(orgId, now, run.id, consoleOrganizationId, attemptId),
    c.env.DB.prepare('INSERT INTO batch_assertions (ok) VALUES (changes() = 1)'),
  )
  try {
    await c.env.DB.batch(statements)
  } catch (error) {
    const current = await c.env.DB.prepare(
      `SELECT attempt_id, attempt_expires_at FROM import_runs
       WHERE id = ? AND console_organization_id = ?`,
    ).bind(run.id, consoleOrganizationId).first<{ attempt_id: string | null; attempt_expires_at: number | null }>()
    if (current?.attempt_id && current.attempt_id !== attemptId && (current.attempt_expires_at ?? 0) > now) {
      throw new ApiError('conflict', 'This import is already running', undefined, { reason: 'state_changed' })
    }
    throw error
  }
  return { plan, orgId }
}

function failureCause(error: unknown): string {
  const message = error instanceof Error ? error.message.toLowerCase() : ''
  if (message.includes('constraint')) return 'database_constraint'
  if (message.includes('batch assertion')) return 'state_changed'
  if (message.includes('100,000 bytes') || message.includes('100 parameters')) return 'statement_limit'
  if (message.includes('integrity check')) return 'ledger_integrity'
  if (message.includes('totals do not match')) return 'totals_mismatch'
  return 'internal'
}

function internalImportError(error: unknown, stage: string): ApiError {
  const message = error instanceof Error ? error.message.toLowerCase() : ''
  if (message.includes('unique constraint failed: orgs.')) {
    return new ApiError('conflict', 'Another import or setup changed the company. Check it and try again.', undefined, {
      reason: 'state_changed',
    })
  }
  const cause = failureCause(error)
  if (cause === 'database_constraint' || cause === 'statement_limit') {
    return new ApiError('invariant_violation', 'The reviewed files contain a value that cannot be stored. Preview the files again.')
  }
  if (cause === 'state_changed' && stage === 'finalize') {
    return new ApiError('conflict', 'The company changed while importing. Check it and try again.', undefined, { reason: 'state_changed' })
  }
  return new ApiError('internal', 'The import could not be completed. You can retry it.')
}

async function markFailed(
  c: Context<AppEnv>,
  runId: string,
  orgId: string | null,
  attemptId: string | null,
  message: string,
  reasonCode: string,
  stage: string,
  cause: string,
  now: number,
) {
  const consoleOrganizationId = c.get('auth').consoleOrganizationId
  const plain = message.slice(0, 1000) || 'The import could not be completed'
  const condition = attemptId === null ? 'attempt_id IS NULL' : 'attempt_id = ?'
  const values = attemptId === null
    ? [plain, now, runId, consoleOrganizationId]
    : [plain, now, runId, consoleOrganizationId, attemptId]
  const result = await c.env.DB.prepare(
    `UPDATE import_runs SET status = 'failed', error_message = ?, attempt_id = NULL, attempt_expires_at = NULL, updated_at = ?
     WHERE id = ? AND console_organization_id = ? AND status <> 'committed' AND ${condition}`,
  ).bind(...values).run()
  if (result.meta.changes === 1) {
    await audit(c, now, 'import.failed', runId, orgId, 'error', { reasonCode, stage, cause }).run()
  }
}

async function finalize(
  c: Context<AppEnv>,
  run: ImportRunRow,
  orgId: string,
  activeId: string | null,
  counts: api.ImportCounts,
  databaseCounts: ImportDatabaseCounts,
  expectedSeq: number,
  expectedHash: string | null,
  attemptId: string,
  mutation: Awaited<ReturnType<typeof prepareIdempotency>>,
  now: number,
): Promise<Response | null> {
  const consoleOrganizationId = c.get('auth').consoleOrganizationId
  const statements: D1PreparedStatement[] = [
    c.env.DB.prepare(
      `INSERT INTO batch_assertions (ok)
       SELECT status = 'importing'
         AND (SELECT seq FROM ledger_heads WHERE org_id = orgs.id) = ?
         AND (SELECT head_hash FROM ledger_heads WHERE org_id = orgs.id) IS ?
       FROM orgs WHERE id = ? AND console_organization_id = ?`,
    ).bind(expectedSeq, expectedHash, orgId, consoleOrganizationId),
  ]
  if (activeId) {
    statements.push(
      c.env.DB.prepare(
        `UPDATE orgs SET status = 'archived', version = version + 1, updated_at = ?
         WHERE id = ? AND console_organization_id = ? AND status = 'active'
           AND NOT EXISTS (SELECT 1 FROM stakeholders WHERE org_id = orgs.id)
           AND NOT EXISTS (SELECT 1 FROM transactions WHERE org_id = orgs.id)
           AND NOT EXISTS (SELECT 1 FROM documents WHERE org_id = orgs.id)
           AND NOT EXISTS (SELECT 1 FROM document_collections WHERE org_id = orgs.id)
           AND NOT EXISTS (SELECT 1 FROM payment_instructions WHERE org_id = orgs.id)
           AND NOT EXISTS (SELECT 1 FROM org_signatories WHERE org_id = orgs.id)
           AND NOT EXISTS (SELECT 1 FROM legends WHERE org_id = orgs.id)
           AND NOT EXISTS (SELECT 1 FROM valuations WHERE org_id = orgs.id)`,
      ).bind(now, activeId, consoleOrganizationId),
      c.env.DB.prepare('INSERT INTO batch_assertions (ok) VALUES (changes() = 1)'),
    )
  }
  statements.push(
    c.env.DB.prepare(
      `UPDATE orgs SET status = 'active', version = version + 1, updated_at = ?
       WHERE id = ? AND console_organization_id = ? AND status = 'importing'`,
    ).bind(now, orgId, consoleOrganizationId),
    c.env.DB.prepare('INSERT INTO batch_assertions (ok) VALUES (changes() = 1)'),
    c.env.DB.prepare(
      `INSERT INTO batch_assertions (ok)
       SELECT COUNT(*) = 1 FROM orgs
       WHERE console_organization_id = ? AND status = 'active'`,
    ).bind(consoleOrganizationId),
    c.env.DB.prepare(
      `INSERT INTO batch_assertions (ok)
       SELECT (SELECT COUNT(*) FROM stakeholders WHERE org_id = ?1) = ?2
         AND (SELECT COUNT(*) FROM stock_classes WHERE org_id = ?1) = ?3
         AND (SELECT COUNT(*) FROM stock_plans WHERE org_id = ?1) = ?4
         AND (SELECT COUNT(*) FROM securities WHERE org_id = ?1) = ?5
         AND (SELECT COUNT(*) FROM commands WHERE org_id = ?1) = ?6
         AND (SELECT COUNT(*) FROM transactions WHERE org_id = ?1) = ?7
         AND (SELECT COUNT(*) FROM stakeholder_emails WHERE org_id = ?1) = ?8
         AND (SELECT COUNT(*) FROM vesting_terms WHERE org_id = ?1) = ?9
         AND (SELECT COUNT(*) FROM certificates WHERE org_id = ?1) = ?10
         AND (SELECT COUNT(*) FROM command_dependencies WHERE org_id = ?1) = ?11`,
    ).bind(orgId, databaseCounts.stakeholders, databaseCounts.shareClasses, databaseCounts.equityPlans,
      databaseCounts.securities, databaseCounts.commands, databaseCounts.transactions,
      databaseCounts.stakeholderEmails, databaseCounts.vestingTerms, databaseCounts.certificates,
      databaseCounts.dependencies),
    c.env.DB.prepare(
      `UPDATE import_runs SET status = 'committed', org_id = ?, counts = ?, error_message = NULL,
         attempt_id = NULL, attempt_expires_at = NULL, updated_at = ?
       WHERE id = ? AND console_organization_id = ? AND status = 'previewed' AND org_id = ? AND attempt_id = ?`,
    ).bind(orgId, JSON.stringify(counts), now, run.id, consoleOrganizationId, orgId, attemptId),
    c.env.DB.prepare('INSERT INTO batch_assertions (ok) VALUES (changes() = 1)'),
    audit(c, now, 'import.committed', run.id, orgId, 'success', {
      counts,
      summary: `Imported ${counts.stakeholders} stakeholders from ${run.source_system === 'template' ? 'a spreadsheet' : 'Pulley'}`,
    }),
  )
  const body = api.importCommitResponseSchema.parse({ orgId, counts })
  return commitIdempotent(c.env.DB, mutation, statements, 200, body, now)
}

export function importRoutes(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  app.get('/template', () => {
    const bytes = generateCapTableTemplate()
    const body = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
    return new Response(body, { headers: {
      'Content-Type': XLSX,
      'Content-Disposition': "attachment; filename*=UTF-8''cap-table-template.xlsx",
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "sandbox; default-src 'none'",
    } })
  })

  app.post('/preview', async (c) => {
    const auth = c.get('auth')
    const form = await readImportForm(c, api.importPreviewFormSchema)
    const files = await uploadedFiles(form.files)
    const digests = fileDigests(files)
    const runId = crypto.randomUUID()
    const now = deps.now()
    const active = await activeCompany(c.env.DB, auth.consoleOrganizationId)
    const corePreview = buildCorePreview(form.source, files, {
      asOfDate: form.asOfDate,
      today: engine.orgToday(active?.timezone ?? form.timezone, now),
      orgId: previewOrgId(runId),
      fallbackCurrency: active?.currency ?? 'USD',
    })
    const unavailable = active ? unavailableMessage(active) : null
    const availabilityProblems: ImportProblem[] = unavailable
      ? [{ severity: 'error', code: 'COMPANY_NOT_EMPTY', message: unavailable, source: null }]
      : []
    const preview = addImportProblems(corePreview, availabilityProblems)
    const counts = importCounts(preview)
    const body = api.importPreviewResponseSchema.parse({ runId, preview: publicPreview(preview) })
    await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT INTO import_runs
         (id, console_organization_id, source_system, status, file_hashes, as_of_date, plan_sha256, counts, created_by, org_id,
          error_message, timezone, jurisdiction, fiscal_year_end, created_at, updated_at)
         VALUES (?, ?, ?, 'previewed', ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?)`,
      ).bind(runId, auth.consoleOrganizationId, form.source, JSON.stringify(digests),
        preview.plan?.asOfDate ?? preview.draft.asOfDate,
        planSha256(preview.plan), JSON.stringify(counts), auth.user.id,
        form.timezone, form.jurisdiction, form.fiscalYearEnd, now, now),
      audit(c, now, 'import.previewed', runId, null, 'success', {
        source: form.source,
        canImport: preview.canImport,
        errors: preview.problems.filter((problem) => problem.severity === 'error').length,
        warnings: preview.problems.filter((problem) => problem.severity === 'warning').length,
        counts,
      }),
    ])
    return c.json(body, 201)
  })

  app.get('/runs/:runId', async (c) => {
    const runId = parseRunId(c, api.routes.getImportRun)
    const row = await c.env.DB.prepare(
      'SELECT * FROM import_runs WHERE id = ? AND console_organization_id = ?',
    ).bind(runId, c.get('auth').consoleOrganizationId).first<ImportRunRow>()
    if (!row) throw notFound('Import run not found')
    return c.json(runOutput(row))
  })

  app.post('/runs/:runId/commit', async (c) => {
    const auth = c.get('auth')
    const runId = parseRunId(c, api.routes.commitImport)
    const form = await readImportForm(c, api.importCommitFormSchema)
    const files = await uploadedFiles(form.files)
    const digests = fileDigests(files)
    const mutation = await prepareIdempotency(c, runId, COMMIT_ROUTE, {
      fileHashes: digests,
      asOfDate: form.asOfDate,
      timezone: form.timezone,
      jurisdiction: form.jurisdiction,
      fiscalYearEnd: form.fiscalYearEnd,
    })
    if (mutation.replay) return mutation.replay
    const run = await c.env.DB.prepare(
      'SELECT * FROM import_runs WHERE id = ? AND console_organization_id = ?',
    ).bind(runId, auth.consoleOrganizationId).first<ImportRunRow>()
    if (!run) throw notFound('Import run not found')
    let failureOrgId = run.org_id
    let failureStage = 'validate'
    let attemptId: string | null = null
    try {
      if (!sameDigests(parseJson<ImportFileDigest[]>(run.file_hashes, []), digests)) {
        throw new ApiError('digest_mismatch', 'These are not the same files that were reviewed')
      }
      if (run.as_of_date !== form.asOfDate) {
        throw new ApiError('digest_mismatch', 'Use the same as-of date that was reviewed')
      }
      if (run.timezone !== form.timezone || run.jurisdiction !== form.jurisdiction
        || run.fiscal_year_end !== form.fiscalYearEnd) {
        throw new ApiError('digest_mismatch', 'Use the same company profile details that were reviewed')
      }
      if (run.status === 'committed') {
        if (!run.org_id) throw new Error('The committed import has no company')
        const body = api.importCommitResponseSchema.parse({ orgId: run.org_id, counts: parseJson(run.counts, {}) })
        const replay = await commitIdempotent(c.env.DB, mutation, [], 200, body, deps.now())
        return replay ?? c.json(body)
      }
      const active = await activeCompany(c.env.DB, auth.consoleOrganizationId)
      const unavailable = active ? unavailableMessage(active) : null
      if (unavailable) {
        throw new ApiError('conflict', unavailable, undefined, { reason: 'state_changed' })
      }
      const preview = buildCorePreview(run.source_system, files, {
        asOfDate: form.asOfDate,
        today: engine.orgToday(active?.timezone ?? run.timezone, deps.now()),
        orgId: previewOrgId(run.id),
        fallbackCurrency: active?.currency ?? 'USD',
      })
      if (planSha256(preview.plan) !== run.plan_sha256) {
        throw new ApiError('digest_mismatch', 'The reviewed import has changed; preview the files again')
      }
      if (!preview.canImport || !preview.plan) {
        throw new ApiError('invariant_violation', 'Fix the import problems and preview the files again', undefined, {
          violations: [{ code: 'IMPORT_NOT_READY', message: 'The reviewed files still contain blocking problems' }],
        })
      }
      if (await sourceIdsAlreadyActive(c.env.DB, auth.consoleOrganizationId, preview.plan)) {
        throw new ApiError('conflict', 'These records have already been imported', undefined, { reason: 'state_changed' })
      }

      const startedAt = deps.now()
      failureStage = 'prepare'
      attemptId = crypto.randomUUID()
      const importing = await prepareImportingCompany(c, run, preview.plan, files, active, attemptId, startedAt)
      failureOrgId = importing.orgId
      const counts = expectedDatabaseCounts(importing.plan)
      failureStage = 'write'
      const written = await writeImportPlan(
        c.env.DB, deps, importing.plan, auth.consoleOrganizationId, auth.user.id, startedAt,
      )
      const databaseCounts = expectedImportDatabaseCounts(importing.plan, written.expectedDependencies)
      failureStage = 'verify'
      const verification = await verifyOrgLedger(c.env.DB, importing.orgId, deps.now(), { asOf: importing.plan.asOfDate })
      if (!verification.report.ok) throw new Error('The imported ledger did not pass its integrity check')
      failureStage = 'totals'
      assertStoredTotals(written.expectedMetricFingerprint, verification.state)
      const finishedAt = deps.now()
      failureStage = 'finalize'
      const committed = await finalize(c, run, importing.orgId, active?.id ?? null, counts, databaseCounts,
        written.expectedLedgerSeq, written.expectedHeadHash, attemptId, mutation, finishedAt)
      const body = api.importCommitResponseSchema.parse({ orgId: importing.orgId, counts })
      return committed ?? c.json(body)
    } catch (error) {
      if (!(error instanceof ApiError)) {
        logError('import_failed', error, { runId: run.id, orgId: failureOrgId, stage: failureStage })
      }
      const publicError = error instanceof ApiError ? error : internalImportError(error, failureStage)
      await markFailed(c, run.id, failureOrgId, attemptId, publicError.message,
        error instanceof ApiError ? error.code : 'internal', failureStage, failureCause(error), deps.now())
      throw publicError
    }
  })

  return app
}
