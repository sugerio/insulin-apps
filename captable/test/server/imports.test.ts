import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, engine } from '../../src/app/shared/index.ts'
import { buildTemplateImportPreview, toEngineVestingDefinition, type UploadedImportFile } from '../../src/app/import/index.ts'
import { validateImportPlan } from '../../src/app/server/lib/import/validate.ts'
import { acmeExportFiles } from '../import/support/acme.ts'
import { buildWorkbook, table, type WorkbookCell } from '../import/support/workbook.ts'
import {
  appRequest,
  consoleHeaders,
  createTestDatabase,
  failImportBatchForTests,
  pauseImportBatchForTests,
  useAppNowForTests,
  type TestDatabase,
} from '../support/server-harness.ts'

const AS_OF = '2026-10-27'
const NOW = Date.UTC(2026, 9, 27, 12)
let testDb: TestDatabase | undefined

afterEach(async () => {
  failImportBatchForTests(undefined)
  pauseImportBatchForTests(undefined)
  useAppNowForTests(undefined)
  await testDb?.close()
  testDb = undefined
  delete process.env.SUGER_ACCESS_MODE
})

function bytesBlob(bytes: Uint8Array): Blob {
  return new Blob([bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
}

function importForm(source: api.ImportSource, files: readonly UploadedImportFile[], asOfDate = AS_OF): FormData {
  const form = new FormData()
  form.set('source', source)
  form.set('asOfDate', asOfDate)
  form.set('timezone', 'America/New_York')
  form.set('jurisdiction', 'US-NY')
  form.set('fiscalYearEnd', '09-30')
  for (const file of files) form.append('files', bytesBlob(file.bytes), file.name)
  return form
}

function commitForm(files: readonly UploadedImportFile[], asOfDate = AS_OF): FormData {
  const form = new FormData()
  form.set('asOfDate', asOfDate)
  form.set('timezone', 'America/New_York')
  form.set('jurisdiction', 'US-NY')
  form.set('fiscalYearEnd', '09-30')
  for (const file of files) form.append('files', bytesBlob(file.bytes), file.name)
  return form
}

async function preview(source: api.ImportSource, files: readonly UploadedImportFile[], asOfDate = AS_OF) {
  const response = await appRequest('/api/import/preview', { method: 'POST', body: importForm(source, files, asOfDate) })
  return { response, body: await response.json() as api.ImportPreviewResponse }
}

async function commit(runId: string, files: readonly UploadedImportFile[], key: string = crypto.randomUUID(), asOfDate = AS_OF) {
  const response = await appRequest(`/api/import/runs/${runId}/commit`, {
    method: 'POST',
    headers: { 'Idempotency-Key': key },
    body: commitForm(files, asOfDate),
  })
  return { response, body: await response.json() as api.ImportCommitResponse & { error?: { message: string } } }
}

type TemplateData = Record<'Company' | 'Stakeholders' | 'Share classes' | 'Equity plans' | 'Shares' | 'Options' | 'Warrants' | 'SAFEs', Array<Record<string, WorkbookCell>>>

const TEMPLATE_HEADERS: Record<keyof TemplateData, string[]> = {
  Company: ['Company name', 'As-of date', 'Currency'],
  Stakeholders: ['Stakeholder ID', 'Name', 'Type', 'Relationship', 'Email', 'Termination date', 'Termination type'],
  'Share classes': ['Class ID', 'Name', 'Type', 'Authorized shares', 'Conversion ratio', 'Original issue price'],
  'Equity plans': ['Plan ID', 'Name', 'Share class ID', 'Pool size', 'Effective date', 'Exercise window after termination (days)'],
  Shares: ['Certificate ID', 'Stakeholder ID', 'Share class ID', 'Plan ID', 'Shares', 'Issue date', 'Price per share'],
  Options: ['Grant ID', 'Stakeholder ID', 'Plan ID', 'Type', 'Options granted', 'Exercise price', 'Grant date', 'Expiration date', 'Vesting start date', 'Vesting months', 'Cliff months', 'Vest every (months)', 'Early exercise', 'FMV at grant', 'Exercised', 'Vested', 'Vested outstanding', 'Cancelled', 'Cancellation date', 'Cancellation reason'],
  Warrants: ['Warrant ID', 'Stakeholder ID', 'Share class ID', 'Shares', 'Exercise price', 'Issue date', 'Expiration date'],
  SAFEs: ['SAFE ID', 'Stakeholder ID', 'Principal', 'Issue date', 'Valuation cap', 'Discount %', 'Type'],
}

function templateFile(holders = 1, options: {
  companyName?: string
  currency?: string
  holderName?: string
  className?: string
  certificateId?: string
  firstEmail?: string
  noSecurities?: boolean
} = {}): UploadedImportFile {
  const stakeholders = Array.from({ length: holders }, (_, index) => ({
    'Stakeholder ID': `holder_${index + 1}`,
    Name: index === 0 ? options.holderName ?? `Holder ${index + 1}` : `Holder ${index + 1}`,
    Type: 'Individual',
    Relationship: index === 0 ? 'Founder' : 'Investor',
    Email: index === 0 ? options.firstEmail ?? 'holder.one@example.test' : '',
    'Termination date': '',
    'Termination type': '',
  }))
  const shares = Array.from({ length: holders }, (_, index) => ({
    'Certificate ID': index === 0 ? options.certificateId ?? `CS-${index + 1}` : `CS-${index + 1}`,
    'Stakeholder ID': `holder_${index + 1}`,
    'Share class ID': 'common',
    'Plan ID': '',
    Shares: { number: '1' },
    'Issue date': { date: '2024-01-02' },
    'Price per share': { number: '0.01' },
  }))
  const data: TemplateData = {
    Company: [{
      'Company name': options.companyName ?? 'Import Example, Inc.',
      'As-of date': { date: AS_OF },
      Currency: options.currency ?? 'USD',
    }],
    Stakeholders: stakeholders,
    'Share classes': [{
      'Class ID': 'common', Name: options.className ?? 'Common Stock', Type: 'Common',
      'Authorized shares': { number: String(Math.max(1000, holders)) }, 'Conversion ratio': '',
      'Original issue price': { number: '0.01' },
    }],
    'Equity plans': [],
    Shares: options.noSecurities ? [] : shares,
    Options: [],
    Warrants: [],
    SAFEs: [],
  }
  return {
    name: 'cap-table.xlsx',
    bytes: buildWorkbook([
      { name: 'Instructions', rows: [['Generated in the test']] },
      ...Object.entries(TEMPLATE_HEADERS).map(([name, headers]) => ({
        name,
        rows: table(headers, data[name as keyof TemplateData]),
      })),
    ]),
  }
}

async function openDatabase() {
  process.env.SUGER_ACCESS_MODE = 'console'
  useAppNowForTests(NOW)
  testDb = await createTestDatabase()
  return testDb
}

describe('company import routes', () => {
  it('keeps preview runs and commits inside their console organization', async () => {
    await openDatabase()
    const file = templateFile()
    const first = await preview('template', [file])
    expect(first.response.status).toBe(201)
    expect(await testDb!.db.prepare(
      'SELECT console_organization_id FROM import_runs WHERE id = ?',
    ).bind(first.body.runId).first('console_organization_id')).toBe('console-org-1')
    expect(await testDb!.db.prepare(
      "SELECT console_organization_id FROM audit_events WHERE target_type = 'import_run' AND target_id = ?",
    ).bind(first.body.runId).first('console_organization_id')).toBe('console-org-1')
    const secondOwner = consoleHeaders({
      organizationId: 'console-org-2', userId: 'second-import-owner', role: 'OWNER',
      email: 'second.import.owner@example.test', name: 'Second Import Owner',
    })

    expect((await appRequest(`/api/import/runs/${first.body.runId}`, {}, secondOwner)).status).toBe(404)
    const foreignCommit = await appRequest(`/api/import/runs/${first.body.runId}/commit`, {
      method: 'POST', headers: { 'Idempotency-Key': 'foreign-import-commit-key' }, body: commitForm([file]),
    }, secondOwner)
    expect(foreignCommit.status).toBe(404)
    expect(await appRequest(`/api/import/runs/${first.body.runId}`)).toMatchObject({ status: 200 })

    const secondPreview = await appRequest('/api/import/preview', {
      method: 'POST', body: importForm('template', [file]),
    }, secondOwner)
    expect(secondPreview.status).toBe(201)
    const secondRunId = (await secondPreview.json() as api.ImportPreviewResponse).runId
    expect((await appRequest(`/api/import/runs/${secondRunId}`)).status).toBe(404)
    expect((await appRequest(`/api/import/runs/${secondRunId}`, {}, secondOwner)).status).toBe(200)
  })

  it('never replays an import commit receipt into another console organization', async () => {
    await openDatabase()
    const userId = 'opaque-user-in-two-organizations'
    const inFirst = consoleHeaders({
      organizationId: 'console-org-1', userId, email: 'both@example.test', name: 'Both',
    })
    const inSecond = consoleHeaders({
      organizationId: 'console-org-2', userId, email: 'both@example.test', name: 'Both',
    })
    const file = templateFile()
    const previewed = await appRequest('/api/import/preview', {
      method: 'POST', body: importForm('template', [file]),
    }, inFirst)
    const { runId } = await previewed.json() as api.ImportPreviewResponse
    const send = (identity: Record<string, string>) => appRequest(`/api/import/runs/${runId}/commit`, {
      method: 'POST', headers: { 'Idempotency-Key': 'same-user-same-key' }, body: commitForm([file]),
    }, identity)
    expect((await send(inFirst)).status).toBe(200)
    expect((await send(inFirst)).headers.get('Idempotent-Replay')).toBe('true')
    expect((await send(inSecond)).status).toBe(404)
  })

  it('rejects a plan whose generated D1 statement exceeds the storage ceiling', () => {
    const core = buildTemplateImportPreview(templateFile(), {
      asOfDate: AS_OF,
      today: AS_OF,
      orgId: crypto.randomUUID(),
    })
    expect(core.plan).not.toBeNull()
    const plan = structuredClone(core.plan!)
    const definition = {
      type: 'EXPLICIT' as const,
      events: Array.from({ length: 1_000 }, (_, index) => ({
        date: '2026-01-01', quantity: '1', sourceId: `event_${String(index).padStart(4, '0')}_${'x'.repeat(80)}`,
        kind: 'EXPLICIT' as const,
      })),
    }
    plan.referenceRows.push({
      entity: 'vesting_terms', id: crypto.randomUUID(), name: 'Oversized vesting schedule', definition,
      definitionSha256: engine.definitionSha256(toEngineVestingDefinition(definition)), sourceId: null,
    })
    const problems = validateImportPlan({ ...core, plan, canImport: true }, plan)
    expect(problems.some((problem) => problem.message.includes('too large to store'))).toBe(true)
  })

  it('generates the template, previews both sources, enforces roles, content type, and file limits', async () => {
    await openDatabase()
    const download = await appRequest('/api/import/template')
    expect(download.status).toBe(200)
    expect(download.headers.get('Content-Type')).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    expect(download.headers.get('Content-Disposition')).toContain('cap-table-template.xlsx')
    expect((await download.arrayBuffer()).byteLength).toBeGreaterThan(1_000)

    const own = await preview('template', [templateFile()])
    expect(own.response.status, JSON.stringify(own.body)).toBe(201)
    expect(own.body.preview).toMatchObject({ canImport: true, counts: { stakeholders: 1, shareClasses: 1, securities: 1 } })
    expect(own.body.preview).not.toHaveProperty('plan')
    expect(own.body.preview.problems.every((problem) => !('code' in problem))).toBe(true)

    const pulley = await preview('pulley', acmeExportFiles())
    expect(pulley.response.status, JSON.stringify(pulley.body)).toBe(201)
    expect(pulley.body.preview).toMatchObject({ canImport: true, counts: { stakeholders: 4, shareClasses: 2 } })

    expect((await appRequest('/api/import/template', {}, consoleHeaders({ role: 'EDITOR', userId: 'import-editor' }))).status).toBe(403)
    expect((await appRequest('/api/import/template', {}, consoleHeaders({ role: 'USER', userId: 'import-user' }))).status).toBe(403)
    expect((await appRequest('/api/import/template', {}, consoleHeaders({ role: 'VIEWER', userId: 'import-viewer' }))).status).toBe(403)
    expect((await appRequest('/api/import/template', {}, {})).status).toBe(401)
    for (const role of ['EDITOR', 'USER', 'VIEWER'] as const) {
      const identity = consoleHeaders({ role, userId: `import-${role.toLowerCase()}` })
      expect((await appRequest('/api/import/preview', {
        method: 'POST', body: importForm('template', [templateFile()]),
      }, identity)).status).toBe(403)
      expect((await appRequest(`/api/import/runs/${own.body.runId}`, {}, identity)).status).toBe(403)
      expect((await appRequest(`/api/import/runs/${own.body.runId}/commit`, {
        method: 'POST', headers: { 'Idempotency-Key': `forbidden-${role.toLowerCase()}` },
        body: commitForm([templateFile()]),
      }, identity)).status).toBe(403)
    }
    expect((await appRequest('/api/import/preview', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    })).status).toBe(415)

    const tooLarge = new FormData()
    tooLarge.set('source', 'template')
    tooLarge.set('asOfDate', AS_OF)
    tooLarge.set('files', new Blob([new Uint8Array(api.IMPORT_LIMITS.fileBytes + 1)]), 'too-large.xlsx')
    const limited = await appRequest('/api/import/preview', { method: 'POST', body: tooLarge })
    expect(limited.status).toBe(413)
    expect((await limited.json() as { error: { message: string } }).error.message).toContain('5 MiB')

    const declaredLarge = await appRequest('/api/import/preview', {
      method: 'POST',
      headers: {
        'Content-Type': 'multipart/form-data; boundary=smoke',
        'Content-Length': String(api.IMPORT_LIMITS.requestBytes + 1),
      },
      body: '--smoke--\r\n',
    })
    expect(declaredLarge.status).toBe(413)
    expect((await declaredLarge.json() as { error: { message: string } }).error.message).toContain('10 MiB')
  }, 30_000)

  it('rejects changed files, commits through the ledger, serves reads, and replays idempotently', async () => {
    const db = await openDatabase()
    const file = templateFile()

    const changedRun = await preview('template', [file])
    const changed = { ...file, bytes: file.bytes.slice() }
    changed.bytes[changed.bytes.length - 1] = changed.bytes[changed.bytes.length - 1]! ^ 1
    const mismatch = await commit(changedRun.body.runId, [changed])
    expect(mismatch.response.status).toBe(422)
    expect(mismatch.body.error?.message).toContain('same files')
    const failed = await appRequest(`/api/import/runs/${changedRun.body.runId}`)
    expect(await failed.json()).toMatchObject({ status: 'failed', orgId: null })

    const dateRun = await preview('template', [file])
    const dateMismatch = await commit(dateRun.body.runId, [file], crypto.randomUUID(), '2026-10-26')
    expect(dateMismatch.response.status).toBe(422)
    expect(dateMismatch.body.error?.message).toContain('same as-of date')

    const emptyCompany = await appRequest('/api/orgs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        orgKey: 'empty-before-import', legalName: 'Empty Before Import, Inc.',
        displayName: 'Empty Before Import', timezone: 'UTC',
      }),
    })
    expect(emptyCompany.status).toBe(201)
    const emptyOrgId = (await emptyCompany.json() as { id: string }).id

    const ready = await preview('template', [file])
    const key = 'import-commit-replay-key'
    const imported = await commit(ready.body.runId, [file], key)
    expect(imported.response.status, JSON.stringify(imported.body)).toBe(200)
    expect(imported.body.counts).toMatchObject({ stakeholders: 1, shareClasses: 1, securities: 1 })
    const replay = await commit(ready.body.runId, [file], key)
    expect(replay.response.status).toBe(200)
    expect(replay.response.headers.get('Idempotent-Replay')).toBe('true')
    expect(replay.body).toEqual(imported.body)

    const run = await appRequest(`/api/import/runs/${ready.body.runId}`)
    expect(await run.json()).toMatchObject({ status: 'committed', orgId: imported.body.orgId, errorMessage: null })
    expect(await db.db.prepare('SELECT status FROM orgs WHERE id = ?').bind(emptyOrgId).first('status')).toBe('archived')
    const org = await appRequest(`/api/orgs/${imported.body.orgId}`)
    expect(org.status).toBe(200)
    expect(await org.json()).toMatchObject({ id: imported.body.orgId, importSource: 'template' })
    const me = await appRequest('/api/me')
    expect(me.status).toBe(200)
    expect(await me.json()).toMatchObject({ company: { id: imported.body.orgId, importSource: 'template' } })
    const capTable = await appRequest(`/api/orgs/${imported.body.orgId}/cap-table?asOf=${AS_OF}`)
    expect(capTable.status, await capTable.clone().text()).toBe(200)
    expect(await capTable.json()).toMatchObject({ totals: { fullyDiluted: '1', issuedAndOutstanding: '1' } })
    const holder = consoleHeaders({ role: 'USER', userId: 'imported-holder', email: 'holder.one@example.test', name: 'Holder One' })
    const portal = await appRequest('/api/portal/overview', {}, holder)
    expect(portal.status, await portal.clone().text()).toBe(200)
    expect(JSON.stringify(await portal.json())).toContain('CS-1')
    const verified = await appRequest(`/api/admin/orgs/${imported.body.orgId}/verify-ledger`, { method: 'POST' })
    expect(verified.status, await verified.clone().text()).toBe(200)
    expect(await verified.json()).toMatchObject({ ok: true })

    expect(await db.db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action IN ('import.previewed', 'import.committed', 'import.failed')").first('n')).toBe(6)
    expect(await db.db.prepare('SELECT pulley_id FROM stakeholders WHERE org_id = ?').bind(imported.body.orgId).first('pulley_id')).toBe('stakeholder_holder_1')

    const second = await preview('template', [file])
    const refused = await commit(second.body.runId, [file])
    expect(refused.response.status).toBe(409)
    expect(refused.body.error?.message).toContain('before the company has stakeholders')
  }, 30_000)

  it('lets setup replace a failed invisible import, then archives that setup on retry', async () => {
    const db = await openDatabase()
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const file = templateFile(300)
    const ready = await preview('template', [file])
    expect(ready.body.preview).toMatchObject({ canImport: true, counts: { stakeholders: 300, securities: 300 } })

    failImportBatchForTests((batchIndex) => batchIndex === 2 ? new Error('synthetic import batch failure') : null)
    const failed = await commit(ready.body.runId, [file], 'large-import-first-attempt')
    expect(failed.response.status).toBe(500)
    expect(failed.body.error?.message).toContain('retry')
    const failedRun = await db.db.prepare('SELECT status, org_id FROM import_runs WHERE id = ?').bind(ready.body.runId)
      .first<{ status: string; org_id: string }>()
    expect(failedRun?.status).toBe('failed')
    expect(await db.db.prepare("SELECT COUNT(*) AS n FROM orgs WHERE status = 'active'").first('n')).toBe(0)
    expect(await db.db.prepare('SELECT COUNT(*) AS n FROM transactions WHERE org_id = ?').bind(failedRun!.org_id).first('n')).toBeGreaterThan(0)
    expect((await appRequest(`/api/orgs/${failedRun!.org_id}`)).status).toBe(404)
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('"event":"import_failed"'))
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('synthetic import batch failure'))
    logged.mockRestore()

    const setup = await appRequest('/api/orgs', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orgKey: 'after-failed-import', legalName: 'After Failed Import, Inc.',
        displayName: 'After Failed Import', timezone: 'UTC' }),
    })
    expect(setup.status, await setup.clone().text()).toBe(201)
    expect(await db.db.prepare("SELECT COUNT(*) AS n FROM orgs WHERE status = 'active'").first('n')).toBe(1)
    expect(await db.db.prepare("SELECT COUNT(*) AS n FROM orgs WHERE status = 'importing'").first('n')).toBe(0)

    failImportBatchForTests(undefined)
    const retried = await commit(ready.body.runId, [file], 'large-import-retry-key')
    expect(retried.response.status, JSON.stringify(retried.body)).toBe(200)
    expect(retried.body.counts).toMatchObject({ stakeholders: 300, securities: 300 })
    expect(await db.db.prepare('SELECT status FROM orgs WHERE id = ?').bind(failedRun!.org_id).first('status')).toBe('archived')
    expect(await db.db.prepare('SELECT status FROM orgs WHERE id = ?').bind(retried.body.orgId).first('status')).toBe('active')
    expect(await db.db.prepare('SELECT COUNT(*) AS n FROM stakeholders WHERE org_id = ?').bind(retried.body.orgId).first('n')).toBe(300)
    expect(await db.db.prepare('SELECT COUNT(*) AS n FROM transactions WHERE org_id = ?').bind(retried.body.orgId).first('n')).toBeGreaterThanOrEqual(300)
  }, 60_000)

  it('uses and previews the source currency when replacing a placeholder in either direction', async () => {
    for (const scenario of [
      { placeholder: 'EUR', source: 'USD', expected: 'USD', orgKey: 'eur-placeholder' },
      { placeholder: 'USD', source: 'EUR', expected: 'EUR', orgKey: 'usd-placeholder' },
      { placeholder: 'EUR', source: '', expected: 'EUR', orgKey: 'blank-source-currency' },
    ] as const) {
      const db = await openDatabase()
      const created = await appRequest('/api/orgs', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          orgKey: scenario.orgKey,
          legalName: 'Currency Placeholder, Inc.',
          displayName: 'Currency Placeholder',
          timezone: 'UTC',
          currency: scenario.placeholder,
        }),
      })
      expect(created.status, await created.clone().text()).toBe(201)

      const file = templateFile(1, { currency: scenario.source })
      const checked = await preview('template', [file])
      expect(checked.response.status, JSON.stringify(checked.body)).toBe(201)
      expect(checked.body.preview).toMatchObject({ canImport: true, currency: scenario.expected })
      const imported = await commit(checked.body.runId, [file])
      expect(imported.response.status, JSON.stringify(imported.body)).toBe(200)
      expect(await db.db.prepare('SELECT currency FROM orgs WHERE id = ?').bind(imported.body.orgId).first('currency'))
        .toBe(scenario.expected)
      expect(await db.db.prepare('SELECT currency FROM stock_classes WHERE org_id = ?').bind(imported.body.orgId).first('currency'))
        .toBe(scenario.expected)

      await db.close()
      testDb = undefined
    }
  }, 60_000)

  it('blocks database-invalid rows and empty imports in preview without creating hidden companies', async () => {
    const db = await openDatabase()
    for (const [file, expected] of [
      [templateFile(1, { firstEmail: 'not-an-email' }), 'e-mail'],
      [templateFile(1, { companyName: 'X'.repeat(201) }), '200'],
      [templateFile(1, { holderName: 'H'.repeat(201) }), 'stakeholder'],
      [templateFile(1, { className: 'C'.repeat(101) }), 'share class'],
      [templateFile(1, { certificateId: 'S'.repeat(41) }), '40'],
      [templateFile(1, { noSecurities: true }), 'share'],
    ] as const) {
      const checked = await preview('template', [file])
      expect(checked.response.status).toBe(201)
      expect(checked.body.preview.canImport).toBe(false)
      expect(checked.body.preview.problems.some((problem) => problem.severity === 'error'
        && problem.message.toLowerCase().includes(expected))).toBe(true)
      const refused = await commit(checked.body.runId, [file])
      expect(refused.response.status).toBe(422)
    }
    expect(await db.db.prepare("SELECT COUNT(*) AS n FROM orgs WHERE status <> 'active'").first('n')).toBe(0)
  })

  it('uses the reviewed local date and carries an empty company profile and settings into the import', async () => {
    const db = await openDatabase()
    const future = await preview('template', [templateFile()], '2031-06-30')
    expect(future.body.preview.canImport).toBe(false)
    expect(future.body.preview.problems.some((problem) => problem.message.includes('after today'))).toBe(true)

    const created = await appRequest('/api/orgs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        orgKey: 'profile-before-import', legalName: 'Profile Before Import, Inc.', displayName: 'Profile Before Import',
        timezone: 'Pacific/Auckland', jurisdiction: 'NZ', incorporationDate: '2020-01-02', currency: 'NZD',
        fiscalYearEnd: '03-31', shareUnit: '0.01', ein: '12-3456789', address: { line1: '1 Example Way', city: 'Auckland',
          postalCode: '1010', country: 'NZ' },
        settings: { companyContact: { name: 'Finance Team', email: 'finance@example.test' } },
      }),
    })
    expect(created.status, await created.clone().text()).toBe(201)
    const oldOrgId = (await created.json() as { id: string }).id

    const checked = await preview('template', [templateFile()])
    const imported = await commit(checked.body.runId, [templateFile()])
    expect(imported.response.status, JSON.stringify(imported.body)).toBe(200)
    const row = await db.db.prepare(
      `SELECT org_key, legal_name, display_name, timezone, jurisdiction, incorporation_date, currency,
              fiscal_year_end, share_unit, ein, address, settings, pulley_id
       FROM orgs WHERE id = ?`,
    ).bind(imported.body.orgId).first<Record<string, unknown>>()
    expect(row).toMatchObject({
      org_key: 'profile-before-import', legal_name: 'Profile Before Import, Inc.', display_name: 'Profile Before Import',
      timezone: 'Pacific/Auckland', jurisdiction: 'NZ', incorporation_date: '2020-01-02', currency: 'USD',
      fiscal_year_end: '03-31', share_unit: '1', ein: '12-3456789', pulley_id: null,
    })
    expect(JSON.parse(String(row?.settings))).toMatchObject({ companyContact: { name: 'Finance Team', email: 'finance@example.test' } })
    expect(JSON.parse(String(row?.address))).toMatchObject({ city: 'Auckland', country: 'NZ' })
    expect(await db.db.prepare('SELECT status FROM orgs WHERE id = ?').bind(oldOrgId).first('status')).toBe('archived')
  }, 30_000)

  it('refuses to replace a company with non-transferable setup data', async () => {
    const db = await openDatabase()
    const created = await appRequest('/api/orgs', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orgKey: 'configured-company', legalName: 'Configured Company, Inc.',
        displayName: 'Configured Company', timezone: 'UTC' }),
    })
    const orgId = (await created.json() as { id: string }).id
    await db.db.prepare(
      `INSERT INTO payment_instructions (org_id, details, updated_by, updated_at)
       VALUES (?, '{}', 'console-user-1', ?)`,
    ).bind(orgId, NOW).run()

    const checked = await preview('template', [templateFile()])
    const refused = await commit(checked.body.runId, [templateFile()])
    expect(refused.response.status).toBe(409)
    expect(refused.body.error?.message).toContain('payment instructions')
    expect(await db.db.prepare('SELECT status FROM orgs WHERE id = ?').bind(orgId).first('status')).toBe('active')
    expect(await db.db.prepare('SELECT COUNT(*) AS n FROM orgs').first('n')).toBe(1)
  })

  it('commits a Pulley preview and resumes the same invisible company after an interrupted write', async () => {
    const db = await openDatabase()
    const pulleyFiles = acmeExportFiles()
    const pulleyReady = await preview('pulley', pulleyFiles)
    const pulleyImported = await commit(pulleyReady.body.runId, pulleyFiles)
    expect(pulleyImported.response.status, JSON.stringify(pulleyImported.body)).toBe(200)
    const company = await appRequest(`/api/orgs/${pulleyImported.body.orgId}`)
    expect(company.status).toBe(200)
    expect(await company.json()).toMatchObject({ id: pulleyImported.body.orgId, importSource: 'pulley' })
    expect(await db.db.prepare('SELECT COUNT(*) AS n FROM vesting_terms WHERE org_id = ?').bind(pulleyImported.body.orgId).first('n')).toBeGreaterThan(0)
    expect((await appRequest(`/api/admin/orgs/${pulleyImported.body.orgId}/verify-ledger`, { method: 'POST' })).status).toBe(200)

    await db.close()
    testDb = undefined
    const resumedDb = await openDatabase()
    const file = templateFile(300)
    const ready = await preview('template', [file])
    failImportBatchForTests((batchIndex) => batchIndex === 2 ? new Error('synthetic interrupted request') : null)
    const first = await commit(ready.body.runId, [file], 'interrupted-attempt')
    expect(first.response.status).toBe(500)
    const firstOrgId = await resumedDb.db.prepare('SELECT org_id FROM import_runs WHERE id = ?').bind(ready.body.runId).first<string>('org_id')
    await resumedDb.db.prepare(
      "UPDATE import_runs SET status = 'previewed', error_message = NULL WHERE id = ?",
    ).bind(ready.body.runId).run()
    failImportBatchForTests(undefined)
    const resumed = await commit(ready.body.runId, [file], 'resumed-attempt')
    expect(resumed.response.status, JSON.stringify(resumed.body)).toBe(200)
    expect(resumed.body.orgId).toBe(firstOrgId)
    expect(await resumedDb.db.prepare('SELECT COUNT(*) AS n FROM orgs').first('n')).toBe(1)
  }, 90_000)

  it('keeps setup from disturbing an in-flight invisible import', async () => {
    const db = await openDatabase()
    const file = templateFile(300)
    const ready = await preview('template', [file])
    let release!: () => void
    let reached!: () => void
    const paused = new Promise<void>((resolve) => { release = resolve })
    const entered = new Promise<void>((resolve) => { reached = resolve })
    let held = false
    pauseImportBatchForTests(async (batchIndex) => {
      if (batchIndex === 0 && !held) {
        held = true
        reached()
        await paused
      }
    })
    const winner = commit(ready.body.runId, [file], 'overlap-winner')
    await entered
    const refused = await commit(ready.body.runId, [file], 'overlap-refused')
    expect(refused.response.status).toBe(409)
    expect(refused.body.error?.message).toContain('already running')
    const setupDuringImport = await appRequest('/api/orgs', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orgKey: 'racing-setup', legalName: 'Racing Setup, Inc.',
        displayName: 'Racing Setup', timezone: 'UTC' }),
    })
    release()
    const completed = await winner
    expect(setupDuringImport.status, await setupDuringImport.clone().text()).toBe(409)
    expect(await setupDuringImport.json()).toMatchObject({
      error: { message: expect.stringContaining('import is already running') },
    })
    expect(completed.response.status).toBe(200)
    expect(await db.db.prepare('SELECT status FROM import_runs WHERE id = ?').bind(ready.body.runId).first('status')).toBe('committed')
    expect(await db.db.prepare("SELECT COUNT(*) AS n FROM orgs WHERE status = 'active'").first('n')).toBe(1)
    expect(await db.db.prepare("SELECT COUNT(*) AS n FROM orgs WHERE status = 'importing'").first('n')).toBe(0)
    expect(await db.db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action = 'import.failed' AND target_id = ?")
      .bind(ready.body.runId).first('n')).toBe(0)
  }, 60_000)

  it('reports a concurrent second import as a company race', async () => {
    await openDatabase()
    const file = templateFile(300)
    const firstRun = await preview('template', [file])
    const secondRun = await preview('template', [file])
    let release!: () => void
    let reached!: () => void
    const paused = new Promise<void>((resolve) => { release = resolve })
    const entered = new Promise<void>((resolve) => { reached = resolve })
    let held = false
    pauseImportBatchForTests(async (batchIndex) => {
      if (batchIndex === 0 && !held) {
        held = true
        reached()
        await paused
      }
    })
    const first = commit(firstRun.body.runId, [file], 'concurrent-first-import')
    await entered
    const second = await commit(secondRun.body.runId, [file], 'concurrent-second-import')
    expect(second.response.status).toBe(409)
    expect(second.body.error?.message).toBe('Another import or setup changed the company. Check it and try again.')
    release()
    expect((await first).response.status).toBe(200)
  }, 60_000)
})
