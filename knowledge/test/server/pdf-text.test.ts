import { createCipheriv } from 'node:crypto'
import { deflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { inspect, PdfTextCheck } from '../../src/app/server/uploads.ts'
import { fixturePdfs, pdfFrom, pdfOf, type PdfObject } from '../support/pdf.ts'

// The upload's check for a PDF without text (a scanned image), which preflight's verdict can't see (plan IMP-01): what
// its pages draw is read as the file passes on to the engine, its compressed content inflated within a budget. It
// refuses a PDF only when it is sure there is no text; whatever it can't read for certain makes it unsure, and unsure
// accepts (unless the PDF has no font at all). Every case is read in pieces of every size below, one byte included,
// and must give the same answer for each.

const SIZES = [1, 2, 7, 64, 1024, 1 << 20]

/** Whether inspect() finds no text in `bytes`, sent in pieces of `size` bytes. */
async function noTextIn(bytes: Uint8Array, size: number): Promise<boolean> {
  // One piece at a time, as a request's body arrives (a queue of them all at once costs Node's streams quadratic time).
  let at = 0
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (at >= bytes.length) controller.close()
      else controller.enqueue(bytes.slice(at, (at += size)))
    },
  })
  const watched = inspect(body, Number.MAX_SAFE_INTEGER, true)
  const reader = watched.stream.getReader()
  while (!(await reader.read()).done) { /* passed on, as to the engine */ }
  return watched.result().scannedPdf
}

/** Whether inspect() finds no text in `bytes`, sent in pieces of each of `sizes` bytes: the same answer for each. */
async function noText(bytes: Uint8Array, sizes = SIZES): Promise<boolean> {
  const answers: boolean[] = []
  for (const size of sizes) answers.push(await noTextIn(bytes, size))
  // Must catch: an answer that depends on where the file's pieces break.
  expect(new Set(answers).size, `the same answer in pieces of ${sizes.join(', ')} bytes: ${answers.join(', ')}`).toBe(1)
  return answers[0]!
}

const z = (content: string | Buffer) => deflateSync(typeof content === 'string' ? Buffer.from(content, 'latin1') : content)
/** A catalog, one page (object 4), and a declared font: what the cases below add a page's content to. */
const BASE: PdfObject[] = [
  { num: 1, dict: '<< /Type /Catalog /Pages 2 0 R >>' },
  { num: 2, dict: '<< /Type /Pages /Kids [4 0 R] /Count 1 >>' },
  { num: 3, dict: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>' },
]
const page = (contents: string, resources = '<< /Font << /F1 3 0 R >> /XObject << /Im0 7 0 R >> >>'): PdfObject => ({ num: 4, dict: `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources ${resources} /Contents ${contents} >>` })
const IMAGE: PdfObject = { num: 7, dict: '<< /Type /XObject /Subtype /Image /Width 10 /Height 30 /ColorSpace /DeviceGray /BitsPerComponent 8 /Length LEN >>', data: Buffer.alloc(300, 0x55) }
/** What a scanned page draws: one image, over the whole page. */
const DRAW = 'q 612 0 0 792 0 0 cm /Im0 Do Q'
const TEXT = 'BT /F1 12 Tf 50 700 Td (Partner discounts stop at 20 percent.) Tj ET'
/** A page whose content (object 5) is `content`, compressed or not. */
const onePage = (content: string, compress: boolean, extra: PdfObject[] = []) => pdfFrom([...BASE, page('5 0 R'), IMAGE, { num: 5, dict: `<< /Length LEN${compress ? ' /Filter /FlateDecode' : ''} >>`, data: compress ? z(content) : content }, ...extra])

describe('a PDF without text', () => {
  const FONT = '3 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj\n'
  const stream = (dictionary: string, data: Buffer) => Buffer.concat([Buffer.from(`5 0 obj\n<< /Length ${data.length} ${dictionary}>>\nstream\r\n`, 'latin1'), data, Buffer.from('\r\nendstream\nendobj\n', 'latin1')])
  const pdf = (...parts: (string | Buffer)[]) => new Uint8Array(Buffer.concat([Buffer.from('%PDF-1.5\n'), ...parts.map((part) => (typeof part === 'string' ? Buffer.from(part, 'latin1') : part)), Buffer.from('%%EOF\n')]))
  const flate = (content: string, dictionary = '') => stream(`/Filter /FlateDecode ${dictionary}`, deflateSync(Buffer.from(content, 'latin1')))

  it('IMP-01 is found by what its pages draw: images only, though it declares a font (make_fixtures.py\'s scanned.pdf)', async () => {
    // Must catch: a font declared but no text drawn passed as a PDF with text.
    expect(await noText(pdfOf(['', ''], { imageOnly: true }))).toBe(true)
    expect(await noText(pdfOf(['', ''], { imageOnly: true, compress: true }))).toBe(true)
    expect(await noText(pdfOf(['Partner discounts stop at 20 percent.', 'Gold partners get a named contact.']))).toBe(false)
    expect(await noText(pdfOf(['Partner discounts stop at 20 percent.'], { compress: true }))).toBe(false)
  })

  it('reads every way of showing text, compressed or not, and passes over images that happen to hold the same bytes', async () => {
    for (const content of ['BT /F1 12 Tf [(Part) -20 (ner)] TJ ET', "BT /F1 12 Tf 14 TL (Partner)' ET", 'BT /F1 12 Tf 1 2 (Partner)" ET', 'BT /F1 12 Tf <0041> Tj ET']) {
      expect(await noText(pdf(FONT, flate(content)))).toBe(false)
      expect(await noText(pdf(FONT, stream('', Buffer.from(content, 'latin1'))))).toBe(false)
    }
    // The last operator of a stream, with nothing after it.
    expect(await noText(pdf(FONT, flate('BT /F1 12 Tf (Partner) Tj')))).toBe(false)
    // Text operators inside an image's bytes, or a page that only draws: no text.
    expect(await noText(pdf(FONT, flate('BT (x) Tj ET', '/Type /XObject /Subtype /Image'), flate('q 1 0 0 1 0 0 cm /Im1 Do Q')))).toBe(true)
    expect(await noText(pdf(FONT, flate('BT /F1 12 Tf ET 0 0 m 10 10 l S')))).toBe(true)
  })

  it('reads text wherever a page draws it: a form, an annotation\'s appearance, a pattern, a Type 3 font, inside a form with an image among its resources', async () => {
    const form = (dict: string, content: string): PdfObject => ({ num: 8, dict: `<< /Type /XObject /Subtype /Form /BBox [0 0 100 100] ${dict} /Length LEN /Filter /FlateDecode >>`, data: z(content) })
    const cases: Uint8Array[] = [
      pdfFrom([...BASE, page('5 0 R', '<< /XObject << /Fm1 8 0 R >> >>'), { num: 5, dict: '<< /Length LEN >>', data: '/Fm1 Do' }, form('/Resources << /Font << /F1 3 0 R >> >>', 'BT /F1 12 Tf (Partner) Tj ET')]),
      // Its own resources name an image (/Subtype /Image inside): the form is still read.
      pdfFrom([...BASE, page('5 0 R', '<< /XObject << /Fm1 8 0 R >> >>'), { num: 5, dict: '<< /Length LEN >>', data: '/Fm1 Do' }, form('/Resources << /Font << /F1 3 0 R >> /XObject << /Im1 << /Subtype /Image >> >> >>', 'BT /F1 12 Tf (Partner) Tj ET')]),
      pdfFrom([...BASE, { num: 4, dict: '<< /Type /Page /Parent 2 0 R /Annots [9 0 R] /Contents 5 0 R >>' }, { num: 5, dict: '<< /Length LEN /Filter /FlateDecode >>', data: z('q 0 0 m 10 10 l S Q') }, { num: 9, dict: '<< /Type /Annot /Subtype /FreeText /Rect [0 0 100 100] /AP << /N 8 0 R >> >>' }, form('/Resources << /Font << /F1 3 0 R >> >>', 'BT /F1 12 Tf (Note) Tj ET')]),
      pdfFrom([...BASE, page('5 0 R', '<< /Pattern << /P1 8 0 R >> >>'), { num: 5, dict: '<< /Length LEN >>', data: '/Pattern cs /P1 scn 0 0 100 100 re f' }, { num: 8, dict: '<< /PatternType 1 /PaintType 1 /TilingType 1 /BBox [0 0 100 100] /XStep 100 /YStep 100 /Resources << /Font << /F1 3 0 R >> >> /Length LEN >>', data: 'BT /F1 12 Tf (Partner) Tj ET' }]),
      pdfFrom([...BASE, page('5 0 R', '<< /Font << /T3 9 0 R >> >>'), { num: 5, dict: '<< /Length LEN >>', data: 'BT\n/T3 1 Tf\n(ab)\nTj\nET' }, { num: 9, dict: '<< /Type /Font /Subtype /Type3 /FontBBox [0 0 1 1] /FontMatrix [1 0 0 1 0 0] /CharProcs << /a 10 0 R >> /Encoding << /Differences [97 /a] >> /FirstChar 97 /LastChar 97 /Widths [1] >>' }, { num: 10, dict: '<< /Length LEN >>', data: '1 0 0 0 1 1 d1 0 0 1 1 re f' }]),
      pdfFrom([...BASE, page('5 0 R'), { num: 5, dict: '<< /Length LEN /Filter [/FlateDecode] >>', data: z(TEXT) }]),
    ]
    for (const bytes of cases) expect(await noText(bytes)).toBe(false)
  })

  it('passes over a colour profile, which a scanner\'s PDF often has, whatever its bytes', async () => {
    // Bytes that would read as text if they were content.
    const profile = Buffer.concat([Buffer.from('BT /F1 1 Tf (not text) Tj ET '), Buffer.from(Array.from({ length: 2048 }, (_, index) => (index * 37) % 256))])
    const extra: PdfObject[] = [{ num: 9, dict: '<< /N 3 /Alternate /DeviceRGB /Length LEN /Filter /FlateDecode >>', data: z(profile) }, { num: 11, dict: '<< /Type /OutputIntent /S /GTS_PDFA1 /DestOutputProfile 9 0 R >>' }]
    expect(await noText(onePage(DRAW, true, extra))).toBe(true)
  })

  it('a PDF whose content can\'t be read here is accepted, unless it has no font at all: the engine reads it', async () => {
    const unknownFilter = stream('/Filter [/ASCII85Decode /FlateDecode] ', Buffer.from('<~87cURD]i,"Ebo80~>', 'latin1'))
    const broken = stream('/Filter /FlateDecode ', Buffer.from('not compressed at all', 'latin1'))
    expect(await noText(pdf(FONT, unknownFilter))).toBe(false)
    expect(await noText(pdf(FONT, broken))).toBe(false)
    expect(await noText(pdf(unknownFilter))).toBe(true)
    expect(await noText(pdfFrom([...BASE, page('5 0 R'), { num: 5, dict: '<< /Length LEN /Filter /ASCIIHexDecode >>', data: `${Buffer.from(TEXT).toString('hex')}>` }]))).toBe(false)
    // Fonts may hide in object streams: with one, a PDF it can't read through is accepted too.
    expect(await noText(pdf(stream('/Type /ObjStm /N 1 /First 4 /Filter /FlateDecode ', deflateSync('3 0 << /Type /Font >>')), unknownFilter))).toBe(false)
    // Cut short inside a stream: what is left isn't known.
    const whole = pdfOf(['Partner'], { compress: true })
    expect(await noText(whole.slice(0, Buffer.from(whole).indexOf('stream\n', Buffer.from(whole).indexOf('/FlateDecode')) + 10))).toBe(false)
  })

  it('a stream too large to inflate here, or inflating past the budget, counts as perhaps text', async () => {
    const zeros = deflateSync(Buffer.alloc(40 * 1024 * 1024))
    expect(zeros.length).toBeLessThan(1024 * 1024)
    const started = Date.now()
    expect(await noTextIn(pdf(FONT, stream('/Filter /FlateDecode ', zeros)), 65536)).toBe(false)
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(await noText(pdf(FONT, stream('/Filter /FlateDecode ', zeros)), [1, 1024, 1 << 20])).toBe(false)
  })
})

describe('F181 a length given by reference', () => {
  const laidOut = (content: string, object: number) => pdfFrom([...BASE, page(`${object} 0 R`), IMAGE, { num: object, dict: `<</Length ${object + 1} 0 R/Filter /FlateDecode>>`, data: z(content) }, { num: object + 1, dict: String(z(content).length) }])

  it('is read as one, whatever its object number (Ghostscript, Quartz, LibreOffice and Cairo write them): a scanned page stays refused', async () => {
    for (const object of [5, 16, 124]) {
      // Must catch: `/Length 16 0 R` read as a length of 1, the stream cut, the check unsure, the scan accepted.
      expect(await noText(laidOut(DRAW, object))).toBe(true)
      expect(await noText(laidOut(TEXT, object))).toBe(false)
    }
  })

  it('ends the data at the end of line before "endstream" (CR LF, LF or CR), though the compressed bytes end in white space', async () => {
    let content = DRAW
    for (let n = 0; ![0x0a, 0x0d, 0x20, 0x09, 0x0c, 0x00].includes(z(content).at(-1)!); n += 1) content = `${DRAW} % ${n}`
    for (const eol of ['\r\n', '\n', '\r']) {
      const bytes = pdfFrom([...BASE, page('15 0 R'), IMAGE, { num: 15, dict: '<< /Length 16 0 R /Filter /FlateDecode >>', data: z(content), eol }, { num: 16, dict: String(z(content).length) }])
      // Must catch: every white space byte taken off, the compressed data cut, the check unsure.
      expect(await noText(bytes)).toBe(true)
    }
  })
})

describe('F177 text split between a page\'s content streams', () => {
  it('a BT in one stream and its string and Tj in the next, or a string at one stream\'s end and its Tj at the next one\'s start', async () => {
    const split = [
      ['BT /F1 12 Tf 50 700 Td', '(Partner discounts stop at 20 percent.) Tj ET'],
      ['BT /F1 12 Tf 50 700 Td (Partner discounts stop at 20 percent.)', 'Tj ET'],
      ['BT /F1 12 Tf [(Part) -20 (ner)]', 'TJ ET'],
    ]
    for (const [first, second] of split) {
      for (const compress of [false, true]) {
        const filter = compress ? ' /Filter /FlateDecode' : ''
        const bytes = pdfFrom([...BASE, page('[5 0 R 6 0 R]'), { num: 5, dict: `<< /Length LEN${filter} >>`, data: compress ? z(first!) : first! }, { num: 6, dict: `<< /Length LEN${filter} >>`, data: compress ? z(second!) : second! }])
        // Must catch: each stream read alone, neither showing text, the PDF refused.
        expect(await noText(bytes)).toBe(false)
      }
    }
    // Two streams that only draw an image between them: still no text.
    expect(await noText(pdfFrom([...BASE, page('[5 0 R 6 0 R]'), IMAGE, { num: 5, dict: '<< /Length LEN >>', data: 'q 612 0 0 792 0 0 cm' }, { num: 6, dict: '<< /Length LEN /Filter /FlateDecode >>', data: z('/Im0 Do Q') }]))).toBe(true)
  })
})

describe('F178 the same answer however the file is cut', () => {
  it('reads a string, then white space and comments, then Tj, TJ, \' or ", across pieces of any size', async () => {
    const contents = [
      `BT /F1 12 Tf (Gold partners renew in June.)${' '.repeat(100)}Tj ET`,
      'BT /F1 12 Tf (Gold partners renew in June.) % shown just below\n Tj ET',
      'BT /F1 12 Tf (Discounts stop at 20%) Tj ET',
      'BT /F1 12 Tf (Discounts stop at 20%) % a comment\r\n\r\n  Tj ET',
      `BT /F1 12 Tf [(Gold) -250 (partners)]\n\n${' '.repeat(200)}TJ ET`,
      "BT /F1 12 Tf 14 TL (Gold \\) partners \\( renew (in June)) ' ET",
      'BT /F1 12 Tf 1 2 <476F6C64>\n % gold\n " ET',
    ]
    for (const content of contents) {
      for (const compress of [false, true]) expect(await noText(onePage(content, compress)), content).toBe(false)
    }
  })

  it('passes over an inline image\'s bytes, whatever they hold, and reads the text after them', async () => {
    const image = 'BI /W 4 /H 2 /BPC 8 /CS /G ID \x28\x28\x28\x00\xff(x) Tj\x29 EI'
    expect(await noText(onePage(`q 100 0 0 100 0 0 cm ${image} Q BT /F1 12 Tf (Partner) Tj ET`, false))).toBe(false)
    expect(await noText(onePage(`q 100 0 0 100 0 0 cm ${image} Q BT /F1 12 Tf (Partner) Tj ET`, true))).toBe(false)
    // A scanned page drawn as an inline image: no text, though its bytes look like some.
    expect(await noText(onePage(`q 612 0 0 792 0 0 cm ${image} Q`, true))).toBe(true)
  })
})

describe('F179 a filter given by reference', () => {
  it('is never read as no filter: a PDF with text is accepted, and so is one laid out so that can\'t be told', async () => {
    const dictionaries = [
      '<< /Length LEN /Filter 6 0 R >>',
      '<< /Length LEN /Filter [6 0 R] >>',
      '<< /Length LEN /Filter [/FlateDecode 6 0 R] >>',
      '<< /Length LEN /Filter /FlateDecode /DecodeParms 8 0 R >>',
      '<< /Length LEN /Filter /FlateDecode /DecodeParms << /Predictor 8 0 R >> >>',
    ]
    for (const dict of dictionaries) {
      const laidOut = (content: string) => pdfFrom([...BASE, page('5 0 R'), IMAGE, { num: 5, dict, data: z(content) }, { num: 6, dict: '/FlateDecode' }, { num: 8, dict: '<< /Predictor 1 >>' }])
      // Must catch: compressed bytes read as content, found to show nothing, and a PDF with text refused.
      expect(await noText(laidOut(TEXT)), dict).toBe(false)
      // Unsure, and it declares a font: accepted, as any PDF it can't be sure of (the engine reads it).
      expect(await noText(laidOut(DRAW)), dict).toBe(false)
    }
  })
})

describe('F180 an encrypted PDF, and a stream the parser misses', () => {
  const ENCRYPT = '<< /Filter /Standard /V 4 /R 4 /Length 128 /CF << /StdCF << /AuthEvent /DocOpen /CFM /AESV2 /Length 16 >> >> /StmF /StdCF /StrF /StdCF /O <00> /U <00> /P -1340 >>'

  it('encrypted content is only bytes here: unsure, so accepted when it declares a font', async () => {
    const cipher = createCipheriv('aes-128-cbc', Buffer.alloc(16, 7), Buffer.alloc(16, 9))
    const encrypted = Buffer.concat([Buffer.alloc(16, 9), cipher.update(Buffer.from(TEXT)), cipher.final()])
    const objects: PdfObject[] = [...BASE, page('5 0 R'), { num: 5, dict: '<< /Length LEN >>', data: encrypted }]
    // The same bytes without /Encrypt show no text, for sure.
    expect(await noText(pdfFrom(objects))).toBe(true)
    // Must catch: the ciphertext read as content and the PDF refused.
    expect(await noText(pdfFrom([...objects, { num: 9, dict: ENCRYPT }], '/Encrypt 9 0 R /ID [<00> <00>]'))).toBe(false)
  })

  it('reads a stream whose keyword has spaces before its end of line, as other readers do', async () => {
    for (const keyword of ['\nstream \n', '\nstream   \r\n', '\nstream\t\r']) {
      const laidOut = (content: string) => pdfFrom([...BASE, page('5 0 R'), IMAGE, { num: 5, dict: '<< /Length LEN /Filter /FlateDecode >>', data: z(content), keyword }])
      expect(await noText(laidOut(TEXT)), JSON.stringify(keyword)).toBe(false)
      // Read for sure: a scanned page laid out so is still refused.
      expect(await noText(laidOut(DRAW)), JSON.stringify(keyword)).toBe(true)
    }
  })

  it('a stream it doesn\'t recognise ("endstream" outside a stream) makes it unsure', async () => {
    for (const keyword of ['\n% a comment\nstream\n', '\nstream']) {
      const laidOut = (content: string) => pdfFrom([...BASE, page('5 0 R'), IMAGE, { num: 5, dict: '<< /Length LEN /Filter /FlateDecode >>', data: z(content), keyword }])
      // Must catch: the compressed bytes read as if between objects, and the PDF refused.
      expect(await noText(laidOut(TEXT)), JSON.stringify(keyword)).toBe(false)
    }
  })
})

describe('F173 memory', () => {
  it('a compressed stream sent a byte at a time is kept in one buffer, not one allocation a piece', async () => {
    const check = new PdfTextCheck()
    const bytes = (text: string) => new Uint8Array(Buffer.from(text, 'latin1'))
    await check.push(bytes('%PDF-1.5\n3 0 obj << /Type /Font >> endobj\n5 0 obj\n<< /Length 700000 /Filter /FlateDecode >>\nstream\n'))
    const data = new Uint8Array(700_000).map((_, index) => (index * 2_654_435_761) >>> 24)
    const before = process.memoryUsage().heapUsed
    for (let at = 0; at < data.length; at += 1) await check.push(data.subarray(at, at + 1))
    // Must catch: 700,000 pieces kept as 700,000 arrays, over 100 MB of heap (a Worker has 128 MB).
    expect(process.memoryUsage().heapUsed - before).toBeLessThan(32 * 1024 * 1024)
    await check.push(bytes('\nendstream\nendobj\n%%EOF\n'))
    await check.end()
    // Not compressed data after all: unsure, and a font is declared.
    expect(check.noText).toBe(false)
  })
})

describe('F182 cost', () => {
  const streams = (count: number) => pdfFrom([...BASE, ...Array.from({ length: count }, (_, index): PdfObject => ({ num: 10 + index, dict: '<< /Length LEN /Filter /FlateDecode >>', data: z('q 1 0 0 1 0 0 cm 0 0 m 1 1 l S Q') }))])

  it('inflates at most a few thousand streams in a file, then counts it unsure', async () => {
    const sizes = [1, 1024, 1 << 20]
    expect(await noText(streams(3_900), sizes)).toBe(true)
    // Must catch: every one of 200,000 tiny streams inflated, about 10 s of CPU for one upload.
    const started = Date.now()
    expect(await noText(streams(4_100), sizes)).toBe(false)
    expect(await noTextIn(streams(50_000), 1 << 16)).toBe(false)
    expect(Date.now() - started).toBeLessThan(10_000)
  })
})

describe('the repository\'s own PDFs (engine/test/python/make_fixtures.py)', () => {
  const fixtures = fixturePdfs()

  // Python 3 is on every CI runner; on a machine without it, this runs in CI only.
  it.skipIf(!fixtures && !process.env.CI)('scanned.pdf is refused and every PDF of the corpus, all with text, accepted', async () => {
    expect(fixtures, 'make_fixtures.py ran (Python 3)').not.toBeNull()
    expect(await noText(fixtures!.scanned)).toBe(true)
    expect(fixtures!.withText.length).toBeGreaterThan(20)
    for (const { name, bytes } of fixtures!.withText) expect(await noText(bytes, [1, 7, 1024, 1 << 20]), name).toBe(false)
  })
})
