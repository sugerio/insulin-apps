import { deflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { inspect } from '../../src/app/server/uploads.ts'
import { pdfOf } from '../support/pdf.ts'

// The upload's check for a PDF without text (a scanned image), which preflight's verdict can't see (plan IMP-01): what
// its pages draw is read as the file passes on to the engine, its compressed content inflated within a budget.

/** Whether inspect() finds no text in `bytes`, sent in pieces of `size` bytes. */
async function noTextIn(bytes: Uint8Array, size = 1024): Promise<boolean> {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let at = 0; at < bytes.length; at += size) controller.enqueue(bytes.slice(at, at + size))
      controller.close()
    },
  })
  const watched = inspect(body, Number.MAX_SAFE_INTEGER, true)
  const reader = watched.stream.getReader()
  while (!(await reader.read()).done) { /* passed on, as to the engine */ }
  return watched.result().scannedPdf
}

describe('a PDF without text', () => {
  const FONT = '3 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj\n'
  const stream = (dictionary: string, data: Buffer) => Buffer.concat([Buffer.from(`5 0 obj\n<< /Length ${data.length} ${dictionary}>>\nstream\r\n`, 'latin1'), data, Buffer.from('\r\nendstream\nendobj\n', 'latin1')])
  const pdf = (...parts: (string | Buffer)[]) => new Uint8Array(Buffer.concat([Buffer.from('%PDF-1.5\n'), ...parts.map((part) => (typeof part === 'string' ? Buffer.from(part, 'latin1') : part)), Buffer.from('%%EOF\n')]))
  const flate = (content: string, dictionary = '') => stream(`/Filter /FlateDecode ${dictionary}`, deflateSync(Buffer.from(content, 'latin1')))

  it('IMP-01 is found by what its pages draw: images only, though it declares a font (make_fixtures.py\'s scanned.pdf)', async () => {
    for (const size of [1, 7, 1024, 1 << 20]) {
      // Must catch: a font declared but no text drawn passed as a PDF with text.
      expect(await noTextIn(pdfOf(['', ''], { imageOnly: true }), size)).toBe(true)
      expect(await noTextIn(pdfOf(['', ''], { imageOnly: true, compress: true }), size)).toBe(true)
      expect(await noTextIn(pdfOf(['Partner discounts stop at 20 percent.', 'Gold partners get a named contact.']), size)).toBe(false)
      expect(await noTextIn(pdfOf(['Partner discounts stop at 20 percent.'], { compress: true }), size)).toBe(false)
    }
  })

  it('reads every way of showing text, compressed or not, and passes over images that happen to hold the same bytes', async () => {
    for (const content of ['BT /F1 12 Tf [(Part) -20 (ner)] TJ ET', "BT /F1 12 Tf 14 TL (Partner)' ET", 'BT /F1 12 Tf 1 2 (Partner)" ET', 'BT /F1 12 Tf <0041> Tj ET']) {
      expect(await noTextIn(pdf(FONT, flate(content)), 3)).toBe(false)
      expect(await noTextIn(pdf(FONT, stream('', Buffer.from(content, 'latin1'))), 3)).toBe(false)
    }
    // The last operator of a stream, with nothing after it.
    expect(await noTextIn(pdf(FONT, flate('BT /F1 12 Tf (Partner) Tj')), 2)).toBe(false)
    // Text operators inside an image's bytes, or a page that only draws: no text.
    expect(await noTextIn(pdf(FONT, flate('BT (x) Tj ET', '/Type /XObject /Subtype /Image'), flate('q 1 0 0 1 0 0 cm /Im1 Do Q')), 5)).toBe(true)
    expect(await noTextIn(pdf(FONT, flate('BT /F1 12 Tf ET 0 0 m 10 10 l S')), 5)).toBe(true)
  })

  it('a PDF whose content can\'t be read here is accepted, unless it has no font at all: the engine reads it', async () => {
    const unknownFilter = stream('/Filter [/ASCII85Decode /FlateDecode] ', Buffer.from('<~87cURD]i,"Ebo80~>', 'latin1'))
    const broken = stream('/Filter /FlateDecode ', Buffer.from('not compressed at all', 'latin1'))
    expect(await noTextIn(pdf(FONT, unknownFilter))).toBe(false)
    expect(await noTextIn(pdf(FONT, broken))).toBe(false)
    expect(await noTextIn(pdf(unknownFilter))).toBe(true)
    // Fonts may hide in object streams: with one, a PDF it can't read through is accepted too.
    expect(await noTextIn(pdf(stream('/Type /ObjStm /N 1 /First 4 /Filter /FlateDecode ', deflateSync('3 0 << /Type /Font >>')), unknownFilter))).toBe(false)
    // Cut short inside a stream: what is left isn't known.
    const whole = pdfOf(['Partner'], { compress: true })
    expect(await noTextIn(whole.slice(0, Buffer.from(whole).indexOf('stream\n', Buffer.from(whole).indexOf('/FlateDecode')) + 10))).toBe(false)
  })

  it('a stream too large to inflate here, or inflating past the budget, counts as perhaps text', async () => {
    const zeros = deflateSync(Buffer.alloc(40 * 1024 * 1024))
    expect(zeros.length).toBeLessThan(1024 * 1024)
    const started = Date.now()
    expect(await noTextIn(pdf(FONT, stream('/Filter /FlateDecode ', zeros)), 65536)).toBe(false)
    expect(Date.now() - started).toBeLessThan(5_000)
  })
})
