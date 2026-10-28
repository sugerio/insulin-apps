import { afterEach, describe, expect, it } from 'vitest'
import { api } from '../../src/app/shared/index.ts'
import { holderIdentity, readHarness, recordCommittedImport, type ReadHarness } from '../support/read-helpers.ts'

let harness: ReadHarness | undefined
afterEach(async () => { await harness?.close(); harness = undefined })

function storedZipEntries(bytes: Uint8Array): Map<string, string> {
  const entries = new Map<string, string>()
  const decoder = new TextDecoder()
  let offset = 0
  while (offset + 30 <= bytes.length) {
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset)
    if (view.getUint32(0, true) !== 0x04034b50) break
    const size = view.getUint32(18, true)
    const nameLength = view.getUint16(26, true)
    const extraLength = view.getUint16(28, true)
    const nameStart = offset + 30
    const dataStart = nameStart + nameLength + extraLength
    const name = decoder.decode(bytes.subarray(nameStart, nameStart + nameLength))
    entries.set(name, decoder.decode(bytes.subarray(dataStart, dataStart + size)))
    offset = dataStart + size
  }
  return entries
}

function csvRows(value: string): string[][] {
  value = value.replace(/^\uFEFF/, '')
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!
    if (quoted) {
      if (character === '"' && value[index + 1] === '"') { cell += '"'; index += 1 }
      else if (character === '"') quoted = false
      else cell += character
    } else if (character === '"') quoted = true
    else if (character === ',') { row.push(cell); cell = '' }
    else if (character === '\r' && value[index + 1] === '\n') {
      row.push(cell); rows.push(row); row = []; cell = ''; index += 1
    } else cell += character
  }
  return rows
}

describe('the six retained exports', () => {
  it('exports the cap table workbook with golden sheet order and filename', async () => {
    harness = await readHarness()
    const response = await harness.api('GET', harness.path('/reports/cap-table?format=xlsx&asOf=2025-12-31'), harness.owner)
    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Disposition')).toContain('AcmeRobotics_CapTable_2025-12-31.xlsx')
    const files = storedZipEntries(new Uint8Array(await response.arrayBuffer()))
    expect(files.get('xl/workbook.xml')).toMatch(/Ownership.*Shares.*Options.*SAFEs.*Warrants.*Plan Availability/)
    expect(files.get('xl/sharedStrings.xml')).toContain('24312120')
  })

  it('exports formula-safe raw cap table CSV and gates migration provenance by role', async () => {
    harness = await readHarness()
    await recordCommittedImport(harness.db, harness.orgId, 'template')
    await harness.db.prepare("UPDATE stakeholders SET display_name = '=FORMULA()', version = version + 1 WHERE id = ?")
      .bind(harness.id('S04')).run()
    const ownerRows = csvRows(await (await harness.api('GET', harness.path('/reports/raw-cap-table?format=csv'), harness.owner)).text())
    expect(ownerRows[0]!.slice(45, 48)).toEqual(['Source Object Type', 'Source SHA-256', 'Source ID'])
    const option = ownerRows.find((row) => row[0] === 'OPT-1')!
    expect(option.slice(9, 17)).toEqual(['300000', '250000', '268750', '31250', '50000', '0', '', '0.1'])
    expect(option[3]).toBe("'=FORMULA()")
    expect(option[47]).toBe('syn-OPT-1')
    const editorRows = csvRows(await (await harness.api('GET', harness.path('/reports/raw-cap-table?format=csv'), harness.editor)).text())
    expect(editorRows.find((row) => row[0] === 'OPT-1')![47]).toBe('')
  })

  it('uses the committed spreadsheet source in report labels', async () => {
    harness = await readHarness()
    await recordCommittedImport(harness.db, harness.orgId, 'template')
    const vestingResponse = await harness.api(
      'GET', harness.path('/reports/vesting-details?format=json'), harness.owner,
    )
    expect(vestingResponse.status).toBe(200)
    const vesting = api.reportJsonSchema.parse(await vestingResponse.json())
    expect(new Set(vesting.sheets[0]!.rows.map((row) => row[6]))).toContain('the spreadsheet')
    const exerciseResponse = await harness.api(
      'GET', harness.path('/reports/exercise-history?format=json'), harness.owner,
    )
    expect(exerciseResponse.status).toBe(200)
    const exercises = api.reportJsonSchema.parse(await exerciseResponse.json())
    expect(exercises.sheets[0]!.rows.some((row) => row[23] === 'Imported from the spreadsheet')).toBe(true)
  })

  it('includes stakeholder PII for every console administrator unless explicitly disabled', async () => {
    harness = await readHarness({ emails: { S04: 'holder04@example.test' } })
    await harness.db.prepare("UPDATE stakeholders SET phone = '+1 555 0100', version = version + 1 WHERE id = ?")
      .bind(harness.id('S04')).run()
    const full = csvRows(await (await harness.api('GET', harness.path('/reports/stakeholders?format=csv'), harness.editor)).text())
      .find((row) => row[0] === harness!.id('S04'))!
    expect(full[4]).toBe('holder04@example.test')
    expect(full[5]).toBe("'+1 555 0100")
    const redacted = csvRows(await (await harness.api(
      'GET', harness.path('/reports/stakeholders?format=csv&includePii=false'), harness.owner,
    )).text()).find((row) => row[0] === harness!.id('S04'))!
    expect(redacted.slice(5, 8)).toEqual(['', '', ''])
  })

  it('generates every retained report in every declared format', async () => {
    harness = await readHarness()
    for (const key of api.REPORT_KEYS) {
      for (const format of api.REPORT_FORMATS_BY_KEY[key]) {
        const response = await harness.api('GET', harness.path(`/reports/${key}?format=${format}`), harness.admin)
        expect.soft(response.status, `${key}.${format}`).toBe(200)
        expect.soft(response.headers.get('Content-Type'), `${key}.${format}`)
          .toContain(api.REPORT_CONTENT_TYPES[format].split(';')[0]!)
        expect.soft((await response.arrayBuffer()).byteLength, `${key}.${format}`).toBeGreaterThan(0)
      }
    }
    const actions = await harness.db.prepare("SELECT action FROM audit_events WHERE action LIKE 'export.%'").all<{ action: string }>()
    expect(new Set(actions.results.map((row) => row.action))).toEqual(new Set(api.REPORT_KEYS.map((key) => `export.${key}`)))
  }, 30_000)

  it('validates report names, formats, filters, date ranges and HEAD', async () => {
    harness = await readHarness()
    for (const path of [
      '/reports/not-a-report',
      '/reports/cap-table?format=csv',
      '/reports/audit-log?asOf=2026-10-21',
      '/reports/audit-log?from=2026-10-22&to=2026-10-21',
    ]) {
      expect((await harness.api('GET', harness.path(path), harness.owner)).status, path).toBe(path.includes('not-a-report') ? 404 : 400)
    }
    const head = await harness.api('HEAD', harness.path('/reports/raw-cap-table?format=csv'), harness.owner)
    expect(head.status).toBe(405)
    expect(head.headers.get('Allow')).toBe('GET')
    expect(await head.text()).toBe('')
  })

  it('refuses holders and audits delivered JSON parameters before returning', async () => {
    harness = await readHarness({ emails: { S04: 'holder@example.test' } })
    const holder = holderIdentity('holder@example.test')
    expect((await harness.api('GET', harness.path('/reports/stakeholders?format=json'), holder)).status).toBe(404)
    const response = await harness.api(
      'GET', harness.path('/reports/stakeholders?format=json&asOf=2025-12-31&includePii=false'), harness.admin,
    )
    const body = api.reportJsonSchema.parse(await response.json())
    expect(body).toMatchObject({ reportKey: 'stakeholders', asOf: '2025-12-31', includePii: false })
    const audit = await harness.db.prepare(
      "SELECT action, details FROM audit_events WHERE action = 'export.stakeholders' ORDER BY id DESC LIMIT 1",
    ).first<{ action: string; details: string }>()
    expect(audit!.action).toBe('export.stakeholders')
    expect(JSON.parse(audit!.details)).toMatchObject({
      format: 'json', asOf: '2025-12-31', requestedIncludePii: false, includePii: false,
      deliveryState: 'generated', rowCount: body.sheets[0]!.rows.length,
    })
  })
})
