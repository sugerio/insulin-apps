import { afterEach, describe, expect, it } from 'vitest'
import { api } from '../../src/app/shared/index.ts'
import { ACME_NOW, addStakeholder, holderIdentity, readHarness, recordCommittedImport, type ReadHarness } from '../support/read-helpers.ts'

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

/** One sheet of a workbook the app wrote (stored entries, shared strings), as rows of cell text; blank cells are "". */
function sheetRows(files: Map<string, string>, sheet: number): string[][] {
  const decode = (text: string) => text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
  const strings = [...(files.get('xl/sharedStrings.xml') ?? '').matchAll(/<si><t[^>]*>([\s\S]*?)<\/t><\/si>/g)].map((match) => decode(match[1]!))
  return [...files.get(`xl/worksheets/sheet${sheet}.xml`)!.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)].map((row) => (
    [...row[1]!.matchAll(/<c r="[A-Z]+\d+"([^>]*?)(?:\/>|>(?:<v>([\s\S]*?)<\/v>)?<\/c>)/g)].map((cell) => {
      if (cell[2] === undefined) return ''
      return /t="s"/.test(cell[1]!) ? strings[Number(cell[2])]! : cell[2]
    })
  ))
}

async function ownershipSheet(): Promise<string[][]> {
  const response = await harness!.api('GET', harness!.path('/reports/cap-table?format=xlsx'), harness!.owner)
  expect(response.status).toBe(200)
  return sheetRows(storedZipEntries(new Uint8Array(await response.arrayBuffer())), 1)
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

  it('lists a stakeholder who never held a security on the Ownership sheet, with zeros', async () => {
    harness = await readHarness()
    await addStakeholder(harness.db, harness.orgId, 'S41', 'employee')
    const rows = await ownershipSheet()
    const row = rows.find((cells) => cells[1] === 'Synthetic Holder S41')!
    expect(row.slice(0, 3)).toEqual(['', 'Synthetic Holder S41', 'employee'])
    expect(row.slice(3).every((cell) => cell === '0')).toBe(true)
    expect(rows.find((cells) => cells[1] === 'Totals')).toContain('24312120')
  })

  it("orders the workbook's class columns as the cap table read does, whatever order the classes were added in", async () => {
    harness = await readHarness()
    const add = (id: string, name: string, classType: 'COMMON' | 'PREFERRED') => harness!.db.prepare(
      `INSERT INTO stock_classes (id, org_id, name, class_type, default_id_prefix, par_value, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, '0.0001', ?, ?)`,
    ).bind(id, harness!.orgId, name, classType, classType === 'COMMON' ? 'CB' : 'PX', ACME_NOW, ACME_NOW).run()
    await add('00000000-0000-4000-8000-000000000001', 'Series A-10 Preferred', 'PREFERRED')
    await add('ffffffff-0000-4000-8000-000000000003', 'Class B Common Stock', 'COMMON')
    expect((await ownershipSheet())[0]!.slice(3, 9)).toEqual([
      'Class B Common Stock', 'Common Stock', 'Series A-1 Preferred', 'Series A-2 Preferred', 'Series A-10 Preferred', 'Series Seed Preferred',
    ])
  })

  it('exports the 83(b) record in force by supersession, whatever order the records were written in', async () => {
    harness = await readHarness()
    const election = (id: string, status: string, createdAt: number, supersedesId: string | null, filedDate: string | null = null) => harness!.db.prepare(
      `INSERT INTO election_83b_records (id, org_id, security_id, status, transfer_date, filed_date, supersedes_id, created_at)
       VALUES (?, ?, ?, ?, '2024-09-01', ?, ?, ?)`,
    ).bind(id, harness!.orgId, harness!.id('CS-4'), status, filedDate, supersedesId, createdAt).run()
    // The correction (FILED) supersedes the imported record but carries an earlier timestamp and a smaller id.
    await election('ffffffff-0000-4000-8000-0000000000e1', 'UNCONFIRMED_DEADLINE_PASSED', ACME_NOW, null)
    await election('00000000-0000-4000-8000-0000000000e2', 'FILED', ACME_NOW - 60_000, 'ffffffff-0000-4000-8000-0000000000e1', '2024-09-20')
    const rows = csvRows(await (await harness.api('GET', harness.path('/reports/raw-cap-table?format=csv'), harness.owner)).text())
    const column = rows[0]!.indexOf('83(b) Status')
    expect(column).toBeGreaterThan(-1)
    expect(rows.find((row) => row[0] === 'CS-4')![column]).toBe('FILED')
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
    // Leading spaces don't smuggle a formula past the guard, and a leading tab is neutralized too.
    await harness.db.prepare("UPDATE stakeholders SET display_name = '  @SUM(A1)', version = version + 1 WHERE id = ?").bind(harness.id('S05')).run()
    await harness.db.prepare("UPDATE stakeholders SET display_name = '\tTabbed', version = version + 1 WHERE id = ?").bind(harness.id('S01')).run()
    const guarded = csvRows(await (await harness.api('GET', harness.path('/reports/raw-cap-table?format=csv'), harness.owner)).text())
    expect(guarded.find((row) => row[3] === "'  @SUM(A1)")).toBeDefined()
    expect(guarded.find((row) => row[3] === "'\tTabbed")).toBeDefined()
    expect(option[47]).toBe('syn-OPT-1')
    const editorRows = csvRows(await (await harness.api('GET', harness.path('/reports/raw-cap-table?format=csv'), harness.reader)).text())
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
    const full = csvRows(await (await harness.api('GET', harness.path('/reports/stakeholders?format=csv'), harness.reader)).text())
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
