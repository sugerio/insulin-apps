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
