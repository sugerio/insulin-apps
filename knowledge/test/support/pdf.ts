import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'

/**
 * A PDF as engine/test/python/make_fixtures.py writes one: a catalog, its pages, a declared Helvetica font, and per
 * page either text (BT … Tj … ET) or only an image; its content streams FlateDecode-compressed when `compress`.
 */
export function pdfOf(pages: string[], options: { imageOnly?: boolean; compress?: boolean } = {}): Uint8Array {
  const objects: Uint8Array[] = []
  const add = (body: string | Uint8Array) => objects.push(typeof body === 'string' ? Buffer.from(body, 'latin1') : body)
  add('')
  add('')
  add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>')
  const kids: number[] = []
  for (const text of pages) {
    let content: string
    let resources: string
    if (options.imageOnly) {
      add(Buffer.concat([Buffer.from('<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8 /Length 1 >>\nstream\n', 'latin1'), Buffer.from([0x80]), Buffer.from('\nendstream', 'latin1')]))
      content = `q 200 0 0 200 100 500 cm /Im${objects.length} Do Q`
      resources = `<< /XObject << /Im${objects.length} ${objects.length} 0 R >> >>`
    } else {
      content = `BT /F1 11 Tf 14 TL 50 780 Td (${text}) Tj ET`
      resources = '<< /Font << /F1 3 0 R >> >>'
    }
    const data = options.compress ? deflateSync(Buffer.from(content, 'latin1')) : Buffer.from(content, 'latin1')
    add(Buffer.concat([Buffer.from(`<< /Length ${data.length}${options.compress ? ' /Filter /FlateDecode' : ''} >>\nstream\n`, 'latin1'), data, Buffer.from('\nendstream', 'latin1')]))
    add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 842] /Resources ${resources} /Contents ${objects.length} 0 R >>`)
    kids.push(objects.length)
  }
  objects[0] = Buffer.from('<< /Type /Catalog /Pages 2 0 R >>')
  objects[1] = Buffer.from(`<< /Type /Pages /Kids [${kids.map((kid) => `${kid} 0 R`).join(' ')}] /Count ${kids.length} >>`)
  const parts: Uint8Array[] = [Buffer.from('%PDF-1.4\n')]
  objects.forEach((body, index) => parts.push(Buffer.from(`${index + 1} 0 obj\n`), body, Buffer.from('\nendobj\n')))
  parts.push(Buffer.from('trailer\n<< /Root 1 0 R >>\n%%EOF\n'))
  return new Uint8Array(Buffer.concat(parts))
}

/** One object of pdfFrom(): its dictionary (LEN stands for its data's length) and, for a stream, its data. */
export interface PdfObject {
  num: number
  dict: string
  data?: Uint8Array | string
  /** What comes between the dictionary and the data ("\nstream\n" when not given). */
  keyword?: string
  /** The end of line between the data and "endstream" ("\n" when not given). */
  eol?: string
}

/**
 * A PDF of exactly these objects (catalog, pages and the rest are the caller's), then a trailer with `trailer` added:
 * for the shapes real writers produce that pdfOf() doesn't (indirect lengths, split content, encryption…).
 */
export function pdfFrom(objects: PdfObject[], trailer = ''): Uint8Array {
  const parts: Buffer[] = [Buffer.from('%PDF-1.5\n%\xe2\xe3\xcf\xd3\n', 'latin1')]
  for (const object of objects) {
    if (object.data === undefined) {
      parts.push(Buffer.from(`${object.num} 0 obj\n${object.dict}\nendobj\n`, 'latin1'))
      continue
    }
    const data = typeof object.data === 'string' ? Buffer.from(object.data, 'latin1') : Buffer.from(object.data)
    parts.push(Buffer.from(`${object.num} 0 obj\n${object.dict.replace('LEN', String(data.length))}${object.keyword ?? '\nstream\n'}`, 'latin1'), data, Buffer.from(`${object.eol ?? '\n'}endstream\nendobj\n`, 'latin1'))
  }
  parts.push(Buffer.from(`trailer\n<< /Root 1 0 R ${trailer}>>\n%%EOF\n`, 'latin1'))
  return new Uint8Array(Buffer.concat(parts))
}

/**
 * The PDFs engine/test/python/make_fixtures.py writes (the corpus as PDFs with text, and scanned.pdf), made in a new
 * temporary directory; null when Python 3 isn't here to run it.
 */
export function fixturePdfs(): { withText: { name: string; bytes: Uint8Array }[]; scanned: Uint8Array } | null {
  if (spawnSync('python3', ['--version']).status !== 0) return null
  const out = mkdtempSync(join(tmpdir(), 'knowledge-fixtures-'))
  try {
    const made = spawnSync('python3', [fileURLToPath(new URL('../../engine/test/python/make_fixtures.py', import.meta.url)), out], { encoding: 'utf8' })
    if (made.status !== 0) throw new Error(`make_fixtures.py failed: ${made.stderr}`)
    const withText = readdirSync(join(out, 'pdf')).sort().map((name) => ({ name, bytes: new Uint8Array(readFileSync(join(out, 'pdf', name))) }))
    return { withText, scanned: new Uint8Array(readFileSync(join(out, 'scanned.pdf'))) }
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
}
