import { describe, expect, it } from 'vitest'
import { csvCell, writeCsv } from '../../src/app/server/lib/reports/csv.ts'
import { writeXlsx, xlsxDate, xlsxDecimal } from '../../src/app/server/lib/reports/xlsx.ts'

export function storedZipEntries(bytes: Uint8Array): Map<string, string> {
  const entries = new Map<string, string>()
  const decoder = new TextDecoder()
  let offset = 0
  while (offset + 30 <= bytes.length) {
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset)
    if (view.getUint32(0, true) !== 0x04034b50) break
    expect(view.getUint16(8, true)).toBe(0)
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

describe('XLSX writer', () => {
  it('creates OOXML with strings, typed values, widths, headers and frozen panes', () => {
    const workbook = writeXlsx([{
      name: 'Ownership',
      columns: [{ header: 'Holder', width: 24 }, { header: 'Shares', width: 14 }, { header: 'Issue date', width: 12 }, { header: 'Price' }],
      rows: [
        ['Alex Example', 1200, xlsxDate('2026-01-15'), xlsxDecimal('0.000001')],
        ['Comma, Holder', 25.5, xlsxDate('2026-02-01'), xlsxDecimal('12345678901234567890.123')],
      ],
    }])
    expect(Array.from(workbook.subarray(0, 4))).toEqual([0x50, 0x4b, 0x03, 0x04])
    const files = storedZipEntries(workbook)
    expect([...files.keys()]).toEqual(expect.arrayContaining([
      '[Content_Types].xml', 'xl/workbook.xml', 'xl/styles.xml', 'xl/sharedStrings.xml', 'xl/worksheets/sheet1.xml',
    ]))
    expect(files.get('xl/workbook.xml')).toContain('sheet name="Ownership"')
    expect(files.get('xl/sharedStrings.xml')).toContain('Alex Example')
    const sheet = files.get('xl/worksheets/sheet1.xml')!
    expect(sheet).toContain('pane ySplit="1" topLeftCell="A2"')
    expect(sheet).toContain('<c r="B2" t="n"><v>1200</v></c>')
    expect(sheet).toContain('autoFilter ref="A1:D3"')
  })

  it('encodes XML-invalid controls and preserves literal OOXML escape text', () => {
    const strings = storedZipEntries(writeXlsx([{
      name: 'Controls', columns: [{ header: 'Text' }], rows: [['line\u0001one\u000bvt ref_x0041_end']],
    }])).get('xl/sharedStrings.xml')!
    expect(strings).toContain('line_x0001_one_x000B_vt ref_x005F__x0041_end')
  })

  it('rejects invalid workbook structures and typed values', () => {
    expect(() => writeXlsx([])).toThrow('at least one sheet')
    expect(() => writeXlsx([{ name: 'Bad/Name', columns: [{ header: 'A' }], rows: [] }])).toThrow('sheet name')
    expect(() => writeXlsx([
      { name: 'Data', columns: [{ header: 'A' }], rows: [] },
      { name: 'data', columns: [{ header: 'A' }], rows: [] },
    ])).toThrow('ignoring case')
    expect(() => xlsxDate('2026-02-30')).toThrow('Invalid XLSX date')
    expect(() => xlsxDecimal('1e5')).toThrow('Invalid XLSX decimal')
  })
})

describe('CSV writer', () => {
  it('uses RFC 4180 quoting and neutralizes spreadsheet formulas', () => {
    expect(writeCsv([
      ['Name', 'Comment', 'Value'],
      ['Example', 'comma, quote " and\nnewline', '=HYPERLINK("bad")'],
      ['At', '@SUM(A1:A2)', -12],
      ['Plus', '+cmd', xlsxDecimal('-0.125')],
    ])).toContain('"\'=HYPERLINK(""bad"")"')
    expect(['-cmd', '@cmd', '\tcmd', '\rcmd', '"=cmd', 'Acme;=cmd', ' =cmd'].map(csvCell)).toEqual([
      '"\'-cmd"', '"\'@cmd"', '"\'\tcmd"', '"\'\rcmd"', '"""=cmd"', '"Acme;=cmd"', '"\' =cmd"',
    ])
  })

  it('formats nulls, booleans, numeric strings, embedded CR and Unicode deterministically', () => {
    expect(writeCsv([[null, undefined, true, false, 12, '12', 'a\rb', 'Crème']]))
      .toBe('\uFEFF"","","true","false","12","12","a\rb","Crème"\r\n')
  })
})
