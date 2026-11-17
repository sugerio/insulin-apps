import { formatBytes } from './limits.ts'

/**
 * Files, before anything is learned (design section 11, "Import path"). Preflight checks each file's type and size
 * against the organization's limits and names the ones that can't be learned, with the reason, before anything
 * starts; the person confirms the rest. Each accepted file then streams to the engine's inbox (which buffers it, up to
 * 64 MB, and computes its SHA-256), and on the way the app reads whether a PDF has any text (PdfTextCheck): one
 * without is a scanned image, named before learning too.
 */
export const LEARNABLE: { extensions: string[]; type: string; label: string }[] = [
  { extensions: ['pdf'], type: 'application/pdf', label: 'PDF' },
  { extensions: ['docx'], type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', label: 'Word' },
  { extensions: ['pptx'], type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', label: 'PowerPoint' },
  { extensions: ['xlsx'], type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', label: 'Excel' },
  { extensions: ['md', 'markdown'], type: 'text/markdown', label: 'Markdown' },
  { extensions: ['txt'], type: 'text/plain', label: 'plain text' },
  { extensions: ['html', 'htm'], type: 'text/html', label: 'web page' },
]

/** What to save a file as instead, for the types people often have. */
const INSTEAD: Record<string, string> = {
  xlsm: 'Save it as an Excel workbook (.xlsx) without macros',
  xls: 'Save it as an Excel workbook (.xlsx)',
  doc: 'Save it as a Word document (.docx)',
  ppt: 'Save it as a PowerPoint presentation (.pptx)',
  rtf: 'Save it as a Word document (.docx)',
  png: 'Upload a PDF with text instead of an image',
  jpg: 'Upload a PDF with text instead of an image',
  jpeg: 'Upload a PDF with text instead of an image',
}

export function extensionOf(name: string): string {
  return name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? ''
}

export type Verdict = { ok: true; type: string } | { ok: false; reason: string }

/**
 * Whether a file can be learned, from its name, its size and the largest file the organization may add; `support` is
 * the sentence naming Insulin Apps support (limits.ts supportSentence), which a limit's refusal ends with.
 */
export function verdictOf(name: string, bytes: number, fileLimit: number | null, support: string): Verdict {
  const extension = extensionOf(name)
  const kind = LEARNABLE.find((entry) => entry.extensions.includes(extension))
  if (!kind) {
    const instead = INSTEAD[extension]
    return { ok: false, reason: `“${name}” is a type Insulin can't read.${instead ? ` ${instead} and add it again.` : ' Add PDFs with text, Word, PowerPoint, Excel, Markdown, plain text or web pages.'}` }
  }
  if (bytes <= 0) return { ok: false, reason: `“${name}” is empty.` }
  if (fileLimit !== null && bytes > fileLimit) {
    return { ok: false, reason: `“${name}” is ${formatBytes(bytes)}; the largest file your organization can add is ${formatBytes(fileLimit)}. Split it, or save it in a smaller format. ${support}` }
  }
  return { ok: true, type: kind.type }
}

export class TooLargeError extends Error {
  override name = 'TooLargeError'
}

const bytesOf = (text: string) => Uint8Array.from(text, (character) => character.charCodeAt(0))
const STREAM = bytesOf('stream')
const END_STREAM = bytesOf('endstream')
const FONT = bytesOf('/Font')
const OBJECT_STREAM = bytesOf('/ObjStm')
/** PDF white space, and the bytes that end a name or an operator. */
const isWhite = (byte: number | undefined) => byte === 0x20 || byte === 0x0a || byte === 0x0d || byte === 0x09 || byte === 0x0c || byte === 0x00
const isDelimiter = (byte: number | undefined) => byte === undefined || isWhite(byte) || '()<>[]{}/%'.includes(String.fromCharCode(byte))
const isLetter = (byte: number | undefined) => byte !== undefined && ((byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a))

function indexOfBytes(haystack: Uint8Array, needle: Uint8Array, from = 0): number {
  for (let at = haystack.indexOf(needle[0]!, from); at !== -1 && at <= haystack.length - needle.length; at = haystack.indexOf(needle[0]!, at + 1)) {
    let matched = 1
    while (matched < needle.length && haystack[at + matched] === needle[matched]) matched += 1
    if (matched === needle.length) return at
  }
  return -1
}

function joined(first: Uint8Array, second: Uint8Array): Uint8Array {
  if (!first.byteLength) return second
  const all = new Uint8Array(first.byteLength + second.byteLength)
  all.set(first)
  all.set(second, first.byteLength)
  return all
}

function latin1(bytes: Uint8Array): string {
  let text = ''
  for (let at = 0; at < bytes.length; at += 8192) text += String.fromCharCode(...bytes.subarray(at, at + 8192))
  return text
}

/**
 * Whether a content stream shows text: a BT, then a string shown with Tj, TJ, ' or " (after `)`, `>` or `]`, the end
 * of a string or an array of them). Fed a stream's decoded bytes in pieces; the last few are kept to read across them.
 */
class TextOperators {
  private carry = new Uint8Array(0)
  private began = false

  feed(piece: Uint8Array): boolean {
    const data = joined(this.carry, piece)
    let from = 0
    if (!this.began) {
      from = this.token(data, 0x42, 0x54) // BT
      if (from === -1) {
        this.carry = data.slice(Math.max(0, data.length - 64))
        return false
      }
      this.began = true
    }
    for (let at = from; at < data.length - 1; at += 1) {
      const byte = data[at]!
      const next = data[at + 1]
      const shown = (byte === 0x54 && (next === 0x6a || next === 0x4a) && isDelimiter(data[at + 2]) && at + 2 < data.length) // Tj, TJ
        || ((byte === 0x27 || byte === 0x22) && isDelimiter(next)) // ' and "
      if (!shown) continue
      let before = at - 1
      while (before >= 0 && isWhite(data[before])) before -= 1
      if (data[before] === 0x29 || data[before] === 0x3e || data[before] === 0x5d) return true // ) > ]
    }
    this.carry = data.slice(Math.max(0, data.length - 64))
    return false
  }

  /** The stream's end: an operator in its last bytes is read too. */
  end(): boolean {
    return this.feed(Uint8Array.of(0x20))
  }

  /** Where the two-letter operator `first second` stands as a token in `data`, or -1. */
  private token(data: Uint8Array, first: number, second: number): number {
    for (let at = data.indexOf(first); at !== -1 && at < data.length - 2; at = data.indexOf(first, at + 1)) {
      if (data[at + 1] === second && isDelimiter(data[at + 2]) && (at === 0 || isDelimiter(data[at - 1]))) return at + 2
    }
    return -1
  }
}

/** At most this much of one compressed stream is kept to inflate, and at most this much comes out of it, or of all. */
const FLATE_STREAM_BYTES = 8 * 1024 * 1024
const INFLATED_STREAM_BYTES = 8 * 1024 * 1024
const INFLATED_FILE_BYTES = 32 * 1024 * 1024

/**
 * Whether a PDF has any text, read as its bytes pass on to the engine (design section 11: a scanned PDF is named
 * before learning). Its content streams (a page's, or a form's that a page draws) are read for text-showing
 * operators: as they are, or inflated when FlateDecode-compressed, within the budgets above. Images, fonts, object
 * and cross-reference streams and metadata are passed over. When some content can't be read here (another filter, a
 * broken or encrypted stream, a budget spent, a stream cut short), it may have text, so only the older, certain sign
 * of no text counts: no /Font and no /ObjStm (where fonts can hide) anywhere.
 */
export class PdfTextCheck {
  /** A content stream shows text. */
  private shown = false
  /** Some content couldn't be read here. */
  private unsure = false
  private fonts = false
  private objectStreams = false
  /** Bytes not read yet: the end of the last piece, which a keyword may continue in the next. */
  private carry = new Uint8Array(0)
  /** The last bytes outside any stream (at most 4 KB): the dictionary of the stream that follows. */
  private before = new Uint8Array(0)
  private stream: { kind: 'content' | 'flate' | 'skip'; length: number | null; parts: Uint8Array[]; size: number; text: TextOperators } | null = null
  private inflated = 0

  /** True when the PDF has no text to learn (a scanned image), as far as what passed shows. */
  get noText(): boolean {
    if (this.shown) return false
    const unsure = this.unsure || this.stream !== null
    return !unsure || (!this.fonts && !this.objectStreams)
  }

  async push(piece: Uint8Array): Promise<void> {
    if (this.shown) return
    const data = joined(this.carry, piece)
    this.carry = new Uint8Array(0)
    let at = 0
    while (at < data.length && !this.shown) {
      if (!this.stream) {
        const start = this.streamKeyword(data, at)
        if (start === -1) {
          // Up to the last 16 bytes, which may begin a keyword: read with the next piece.
          const upto = Math.max(at, data.length - 16)
          this.outside(data.subarray(at, upto))
          this.carry = data.slice(upto)
          return
        }
        const eol = data[start + 6] === 0x0d ? (data[start + 7] === 0x0a ? 2 : start + 7 < data.length ? 1 : 0) : 1
        if (eol === 0) {
          // "stream\r" at the very end: whether "\n" follows is in the next piece.
          this.outside(data.subarray(at, start))
          this.carry = data.slice(start)
          return
        }
        this.outside(data.subarray(at, start))
        this.open()
        at = start + 6 + eol
      } else {
        const end = indexOfBytes(data, END_STREAM, at)
        if (end === -1) {
          const upto = Math.max(at, data.length - (END_STREAM.length - 1))
          this.take(data.subarray(at, upto))
          this.carry = data.slice(upto)
          return
        }
        this.take(data.subarray(at, end))
        await this.close()
        at = end + END_STREAM.length
      }
    }
  }

  /** The end of the file: anything kept back is read, and a stream still open was cut short. */
  async end(): Promise<void> {
    if (this.shown) return
    if (!this.stream) this.outside(this.carry)
    else this.unsure = true
    this.carry = new Uint8Array(0)
  }

  /** The next `stream` keyword after a dictionary (`>>`) and before an end of line, outside stream data; -1 if none. */
  private streamKeyword(data: Uint8Array, from: number): number {
    // A byte before `from` is one read outside streams before (the end of `before`), if any.
    const byteAt = (index: number) => (index >= from ? data[index] : this.before[this.before.length - (from - index)])
    for (let at = indexOfBytes(data, STREAM, from); at !== -1; at = indexOfBytes(data, STREAM, at + 1)) {
      if (at + 6 >= data.length) return -1
      if (isLetter(byteAt(at - 1)) || (data[at + 6] !== 0x0a && data[at + 6] !== 0x0d)) continue
      let before = at - 1
      while (before > from - this.before.length && isWhite(byteAt(before))) before -= 1
      if (byteAt(before) === 0x3e && byteAt(before - 1) === 0x3e) return at
    }
    return -1
  }

  /** Bytes between streams: dictionaries and the like, kept for the next stream's dictionary and read for fonts. */
  private outside(bytes: Uint8Array): void {
    if (!bytes.byteLength) return
    const window = joined(this.before, bytes)
    if (!this.fonts && indexOfBytes(window, FONT, Math.max(0, this.before.length - FONT.length)) !== -1) this.fonts = true
    if (!this.objectStreams && indexOfBytes(window, OBJECT_STREAM, Math.max(0, this.before.length - OBJECT_STREAM.length)) !== -1) this.objectStreams = true
    this.before = window.slice(Math.max(0, window.length - 4096))
  }

  /** A stream begins: what it is, from its dictionary. */
  private open(): void {
    const text = latin1(this.before)
    this.before = new Uint8Array(0)
    const headers = [...text.matchAll(/\d+\s+\d+\s+obj\b/g)]
    const header = headers[headers.length - 1]
    // Without its object's start the dictionary may be another object's too: what it is can't be told for sure.
    if (!header) this.unsure = true
    const dictionary = header ? text.slice(header.index) : text
    const length = Number(dictionary.match(/\/Length\s+(\d+)(?!\s+\d+\s+R)/)?.[1] ?? NaN)
    const stream = { kind: 'content' as 'content' | 'flate' | 'skip', length: Number.isFinite(length) ? length : null, parts: [], size: 0, text: new TextOperators() }
    this.stream = stream
    if (/\/Subtype\s*\/(Image|Type1C|CIDFontType0C|OpenType|XML)\b|\/Type\s*\/(XRef|ObjStm|Metadata|EmbeddedFile)\b|\/Length[123]\b/.test(dictionary)) {
      stream.kind = 'skip'
      return
    }
    const filter = dictionary.match(/\/Filter\s*(\[[^\]]*\]|\/[A-Za-z0-9]+)/)?.[1]
    if (!filter) return
    const names = [...filter.matchAll(/\/([A-Za-z0-9]+)/g)].map((match) => match[1])
    const predictor = Number(dictionary.match(/\/Predictor\s+(\d+)/)?.[1] ?? 1)
    if (names.length === 1 && (names[0] === 'FlateDecode' || names[0] === 'Fl') && predictor <= 1) stream.kind = 'flate'
    else {
      stream.kind = 'skip'
      this.unsure = true
    }
  }

  private take(bytes: Uint8Array): void {
    const stream = this.stream!
    if (!bytes.byteLength || stream.kind === 'skip') return
    if (stream.kind === 'content') {
      if (stream.text.feed(bytes)) this.shown = true
      return
    }
    stream.size += bytes.byteLength
    if (stream.size > FLATE_STREAM_BYTES) {
      stream.kind = 'skip'
      stream.parts = []
      this.unsure = true
      return
    }
    stream.parts.push(bytes.slice())
  }

  /** A stream ends: a compressed one is inflated and read now, within the budgets. */
  private async close(): Promise<void> {
    const stream = this.stream!
    this.stream = null
    if (stream.kind === 'content' && stream.text.end()) this.shown = true
    if (stream.kind !== 'flate' || this.shown) return
    let data = new Uint8Array(stream.size)
    let at = 0
    for (const part of stream.parts) {
      data.set(part, at)
      at += part.byteLength
    }
    // Its data ends where its length says, or before the end of line that comes before "endstream".
    if (stream.length !== null && stream.length <= data.length) data = data.subarray(0, stream.length)
    else while (data.length && isWhite(data[data.length - 1])) data = data.subarray(0, data.length - 1)
    const room = Math.min(INFLATED_STREAM_BYTES, INFLATED_FILE_BYTES - this.inflated)
    if (room <= 0) {
      this.unsure = true
      return
    }
    const reader = new Response(data).body!.pipeThrough(new DecompressionStream('deflate')).getReader()
    let out = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) {
          if (stream.text.end()) this.shown = true
          break
        }
        out += value.byteLength
        if (stream.text.feed(value)) {
          this.shown = true
          break
        }
        if (out >= room) {
          this.unsure = true
          break
        }
      }
    } catch {
      this.unsure = true
    } finally {
      this.inflated += out
      await reader.cancel().catch(() => undefined)
    }
  }
}

/**
 * Passes a file through on its way to the engine, counting its bytes (and stopping past `maxBytes`) and, for a PDF,
 * reading whether it has any text (PdfTextCheck): a PDF without is a scanned image, with nothing to learn.
 */
export function inspect(body: ReadableStream<Uint8Array>, maxBytes: number, pdf: boolean, keep = false): { stream: ReadableStream<Uint8Array>; result: () => { bytes: number; scannedPdf: boolean; kept: Uint8Array | null } } {
  let bytes = 0
  // A Knowledge export is read here too (its zip's directory), so its bytes are kept as they pass (it is a few MB).
  const chunks: Uint8Array[] = []
  const check = pdf ? new PdfTextCheck() : null
  // Reading for text never stops an upload: a check that fails says nothing about the file.
  let checked = true
  const read = async (work: () => Promise<void>) => {
    if (!check || !checked) return
    try {
      await work()
    } catch {
      checked = false
    }
  }
  const stream = body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    async transform(chunk, controller) {
      bytes += chunk.byteLength
      if (bytes > maxBytes) {
        controller.error(new TooLargeError())
        return
      }
      if (keep) chunks.push(chunk.slice())
      controller.enqueue(chunk)
      await read(() => check!.push(chunk))
    },
    async flush() {
      await read(() => check!.end())
    },
  }))
  const kept = () => {
    if (!keep) return null
    const all = new Uint8Array(bytes)
    let at = 0
    for (const chunk of chunks) {
      all.set(chunk, at)
      at += chunk.byteLength
    }
    return all
  }
  return { stream, result: () => ({ bytes, scannedPdf: check !== null && checked && check.noText, kept: kept() }) }
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>)
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** A file id: from preflight, 8 to 64 of [A-Za-z0-9_-]. */
export const FILE_ID = /^[A-Za-z0-9_-]{8,64}$/
