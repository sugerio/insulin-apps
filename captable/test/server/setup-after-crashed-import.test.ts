import { afterEach, describe, expect, it } from 'vitest'
import { buildWorkbook, table, type WorkbookCell } from '../import/support/workbook.ts'
import type { UploadedImportFile } from '../../src/app/import/index.ts'
import { appRequest, createTestDatabase, pauseImportBatchForTests, useAppNowForTests, type TestDatabase } from '../support/server-harness.ts'

const AS_OF = '2026-10-27'
const NOW = Date.UTC(2026, 9, 27, 12)
let testDb: TestDatabase | undefined

afterEach(async () => {
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
    Company: [{ 'Company name': 'Crash Example, Inc.', 'As-of date': { date: AS_OF }, Currency: 'USD' }],
    Stakeholders: Array.from({ length: holders }, (_, index) => ({
      'Stakeholder ID': `holder_${index + 1}`, Name: `Holder ${index + 1}`, Type: 'Individual', Relationship: 'Investor',
      Email: '', 'Termination date': '', 'Termination type': '',
    })),
    'Share classes': [{ 'Class ID': 'common', Name: 'Common Stock', Type: 'Common', 'Authorized shares': { number: '1000' }, 'Conversion ratio': '', 'Original issue price': { number: '0.01' } }],
    'Equity plans': [],
    Shares: Array.from({ length: holders }, (_, index) => ({
      'Certificate ID': `CS-${index + 1}`, 'Stakeholder ID': `holder_${index + 1}`, 'Share class ID': 'common', 'Plan ID': '',
      Shares: { number: '1' }, 'Issue date': { date: '2024-01-02' }, 'Price per share': { number: '0.01' },
    })),
    Options: [], Warrants: [], SAFEs: [],
  }
  return {
    name: 'cap-table.xlsx',
    bytes: buildWorkbook([
      { name: 'Instructions', rows: [['Generated in the test']] },
      ...Object.entries(HEADERS).map(([name, headers]) => ({ name, rows: table(headers, data[name]!) })),
    ]),
  }
}

function form(file: UploadedImportFile, withSource: boolean): FormData {
  const data = new FormData()
  if (withSource) data.set('source', 'template')
  data.set('asOfDate', AS_OF)
  data.set('timezone', 'America/New_York')
  data.set('jurisdiction', 'US-NY')
  data.set('fiscalYearEnd', '09-30')
  data.append('files', new Blob([file.bytes.slice().buffer as ArrayBuffer]), file.name)
  return data
}

describe('an import that died mid-write', () => {
  it('does not block setup after its lease has expired', async () => {
    process.env.SUGER_ACCESS_MODE = 'console'
    useAppNowForTests(NOW)
    testDb = await createTestDatabase()
    const file = templateFile(300)
    const preview = await appRequest('/api/import/preview', { method: 'POST', body: form(file, true) })
    const runId = (await preview.json() as { runId: string }).runId
    let reached!: () => void
    const entered = new Promise<void>((resolve) => { reached = resolve })
    // The worker dies in its first write batch: the request never finishes and never marks the run failed.
    pauseImportBatchForTests(async () => { reached(); await new Promise<never>(() => {}) })
    void appRequest(`/api/import/runs/${runId}/commit`, { method: 'POST', headers: { 'Idempotency-Key': 'crashed-import' }, body: form(file, false) })
    await entered
    pauseImportBatchForTests(undefined)
    const run = await testDb.db.prepare('SELECT status, attempt_expires_at FROM import_runs WHERE id = ?').bind(runId).first<{ status: string; attempt_expires_at: number }>()
    useAppNowForTests(NOW + 11 * 60_000)
    const setup = await appRequest('/api/orgs', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orgKey: 'after-crash', legalName: 'After Crash, Inc.', displayName: 'After Crash', timezone: 'UTC' }),
    })
    const body = await setup.text()
    console.info(`[crashed] run ${JSON.stringify(run)} (lease expired 1 minute ago); setup -> ${setup.status} ${body}`)
    expect(setup.status).toBe(201)
  }, 60_000)
})
