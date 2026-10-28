import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildWorkbook, table, type WorkbookCell } from '../import/support/workbook.ts'
import type { UploadedImportFile } from '../../src/app/import/index.ts'
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

const HEADERS: Record<string, string[]> = {
  Company: ['Company name', 'As-of date', 'Currency'],
  Stakeholders: ['Stakeholder ID', 'Name', 'Type', 'Relationship', 'Email', 'Termination date', 'Termination type'],
  'Share classes': ['Class ID', 'Name', 'Type', 'Authorized shares', 'Conversion ratio', 'Original issue price'],
  'Equity plans': ['Plan ID', 'Name', 'Share class ID', 'Pool size', 'Effective date', 'Exercise window after termination (days)'],
  Shares: ['Certificate ID', 'Stakeholder ID', 'Share class ID', 'Plan ID', 'Shares', 'Issue date', 'Price per share'],
  Options: ['Grant ID', 'Stakeholder ID', 'Plan ID', 'Type', 'Options granted', 'Exercise price', 'Grant date', 'Expiration date', 'Vesting start date', 'Vesting months', 'Cliff months', 'Vest every (months)', 'Early exercise', 'FMV at grant', 'Exercised', 'Vested', 'Vested outstanding', 'Cancelled', 'Cancellation date', 'Cancellation reason'],
  Warrants: ['Warrant ID', 'Stakeholder ID', 'Share class ID', 'Shares', 'Exercise price', 'Issue date', 'Expiration date'],
  SAFEs: ['SAFE ID', 'Stakeholder ID', 'Principal', 'Issue date', 'Valuation cap', 'Discount %', 'Type'],
}

function templateFile(holders: number): UploadedImportFile {
  const data: Record<string, Array<Record<string, WorkbookCell>>> = {
    Company: [{ 'Company name': 'Import Example, Inc.', 'As-of date': { date: AS_OF }, Currency: 'USD' }],
    Stakeholders: Array.from({ length: holders }, (_, index) => ({
      'Stakeholder ID': `holder_${index + 1}`,
      Name: `Holder ${index + 1}`,
      Type: 'Individual',
      Relationship: 'Investor',
      Email: '',
      'Termination date': '',
      'Termination type': '',
    })),
    'Share classes': [{
      'Class ID': 'common',
      Name: 'Common Stock',
      Type: 'Common',
      'Authorized shares': { number: String(Math.max(1000, holders)) },
      'Conversion ratio': '',
      'Original issue price': { number: '0.01' },
    }],
    'Equity plans': [],
    Shares: Array.from({ length: holders }, (_, index) => ({
      'Certificate ID': `CS-${index + 1}`,
      'Stakeholder ID': `holder_${index + 1}`,
      'Share class ID': 'common',
      'Plan ID': '',
      Shares: { number: '1' },
      'Issue date': { date: '2024-01-02' },
      'Price per share': { number: '0.01' },
    })),
    Options: [],
    Warrants: [],
    SAFEs: [],
  }
  return {
    name: 'cap-table.xlsx',
    bytes: buildWorkbook([
      { name: 'Instructions', rows: [['Generated in the test']] },
      ...Object.entries(HEADERS).map(([name, headers]) => ({ name, rows: table(headers, data[name]!) })),
    ]),
  }
}

function blob(bytes: Uint8Array): Blob {
  return new Blob([bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer])
}

function form(file: UploadedImportFile, withSource: boolean): FormData {
  const data = new FormData()
  if (withSource) data.set('source', 'template')
  data.set('asOfDate', AS_OF)
  data.set('timezone', 'America/New_York')
  data.set('jurisdiction', 'US-NY')
  data.set('fiscalYearEnd', '09-30')
  data.append('files', blob(file.bytes), file.name)
  return data
}

async function setup(displayName: string, extra: Record<string, unknown> = {}) {
  return appRequest('/api/orgs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      orgKey: displayName.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
      legalName: `${displayName}, Inc.`,
      displayName,
      timezone: 'UTC',
      ...extra,
    }),
  })
}

async function previewAndCommit(file: UploadedImportFile, key: string) {
  const preview = await appRequest('/api/import/preview', { method: 'POST', body: form(file, true) })
  const runId = (await preview.json() as { runId: string }).runId
  const commit = appRequest(`/api/import/runs/${runId}/commit`, {
    method: 'POST',
    headers: { 'Idempotency-Key': key },
    body: form(file, false),
  })
  return { runId, commit }
}

async function me(identity = consoleHeaders()) {
  return await (await appRequest('/api/me', {}, identity)).json() as { company: { id: string } | null }
}

describe('the placeholder company and an import', () => {
  it('keeps the placeholder visible after the import fails midway', async () => {
    process.env.SUGER_ACCESS_MODE = 'console'
    useAppNowForTests(NOW)
    testDb = await createTestDatabase()
    const placeholder = await setup('Placeholder Example')
    expect(placeholder.status).toBe(201)
    const placeholderId = (await placeholder.json() as { id: string }).id
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    failImportBatchForTests((batchIndex) => batchIndex === 2 ? new Error('synthetic transient D1 failure') : null)
    const { commit } = await previewAndCommit(templateFile(300), 'placeholder-fail-key')
    expect((await commit).status).toBe(500)
    logged.mockRestore()
    expect(await testDb.db.prepare('SELECT status FROM orgs WHERE id = ?').bind(placeholderId).first('status')).toBe('active')
    expect((await me()).company?.id).toBe(placeholderId)
  }, 60_000)

  it('keeps the placeholder visible to the organization while an import is running', async () => {
    process.env.SUGER_ACCESS_MODE = 'console'
    useAppNowForTests(NOW)
    testDb = await createTestDatabase()
    const placeholderId = (await (await setup('Running Example')).json() as { id: string }).id
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
    const { commit } = await previewAndCommit(templateFile(300), 'placeholder-running-key')
    await entered
    const colleague = consoleHeaders({
      userId: 'colleague-admin', role: 'ADMIN', email: 'colleague@example.test', name: 'Colleague',
    })
    const during = (await me(colleague)).company
    const setupDuring = await setup('Colleague Company')
    release()
    const finished = await commit
    expect(during?.id).toBe(placeholderId)
    expect(setupDuring.status).toBe(409)
    expect(finished.status).toBe(200)
  }, 60_000)

  it('never answers "no company" and "already has a company" at once after a failed import', async () => {
    process.env.SUGER_ACCESS_MODE = 'console'
    useAppNowForTests(NOW)
    testDb = await createTestDatabase()
    expect((await setup('Acme Example')).status).toBe(201)
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    failImportBatchForTests((batchIndex) => batchIndex === 2 ? new Error('synthetic transient D1 failure') : null)
    const { commit } = await previewAndCommit(templateFile(300), 'placeholder-recreate-key')
    expect((await commit).status).toBe(500)
    logged.mockRestore()
    failImportBatchForTests(undefined)
    const company = (await me()).company
    const again = await setup('Acme Example')
    expect(company !== null || again.status === 201).toBe(true)
  }, 60_000)

  it('carries the placeholder profile into a retried import', async () => {
    process.env.SUGER_ACCESS_MODE = 'console'
    useAppNowForTests(NOW)
    testDb = await createTestDatabase()
    expect((await setup('Profile Example', {
      ein: '12-3456789',
      settings: { companyContact: { name: 'Finance Team', email: 'finance@example.test' } },
    })).status).toBe(201)
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    failImportBatchForTests((batchIndex) => batchIndex === 2 ? new Error('synthetic transient D1 failure') : null)
    const file = templateFile(300)
    const { runId, commit } = await previewAndCommit(file, 'profile-first-key')
    expect((await commit).status).toBe(500)
    logged.mockRestore()
    failImportBatchForTests(undefined)
    const retried = await appRequest(`/api/import/runs/${runId}/commit`, {
      method: 'POST',
      headers: { 'Idempotency-Key': 'profile-retry-key' },
      body: form(file, false),
    })
    expect(retried.status).toBe(200)
    const orgId = (await retried.json() as { orgId: string }).orgId
    const row = await testDb.db.prepare('SELECT org_key, ein, settings FROM orgs WHERE id = ?').bind(orgId)
      .first<{ org_key: string; ein: string | null; settings: string }>()
    expect(row?.org_key).toBe('profile-example')
    expect(row?.ein).toBe('12-3456789')
    expect(JSON.parse(row!.settings)).toMatchObject({ companyContact: { name: 'Finance Team' } })
  }, 90_000)
})
