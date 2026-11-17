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
const ENCRYPT = bytesOf('/Encrypt')
const EMPTY = new Uint8Array(0)
/** Each byte's kind in PDF syntax, looked up (content is read byte by byte): 1 white space, 2 a delimiter, 0 other. */
const KIND = new Uint8Array(256)
for (const byte of [0x20, 0x0a, 0x0d, 0x09, 0x0c, 0x00]) KIND[byte] = 1
for (const character of '()<>[]{}/%') KIND[character.charCodeAt(0)] = 2
/** PDF white space, and the bytes that end a name or an operator (white space too). */
const isWhite = (byte: number | undefined) => byte !== undefined && KIND[byte] === 1
const isDelimiter = (byte: number | undefined) => byte === undefined || KIND[byte] !== 0
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
 * Bytes kept as they pass, in one buffer that doubles as it fills, so pieces of any size (one byte each, say) cost no
 * allocation of their own and the heap holds about what is kept; at most `max` bytes, add() is false past it.
 */
class Kept {
  private buffer = EMPTY
  private length = 0

  constructor(private readonly max: number) {}

  add(bytes: Uint8Array): boolean {
    const length = this.length + bytes.byteLength
    if (length > this.max) return false
    if (length > this.buffer.byteLength) {
      const grown = new Uint8Array(Math.min(this.max, Math.max(length, this.buffer.byteLength * 2, 4096)))
      grown.set(this.buffer.subarray(0, this.length))
      this.buffer = grown
    }
    this.buffer.set(bytes, this.length)
    this.length = length
    return true
  }

  get bytes(): Uint8Array {
    return this.buffer.subarray(0, this.length)
  }
}

/** The last `size` to 2 × `size` bytes passed, in one buffer: each byte is copied in once, and moved at most once. */
class Tail {
  private readonly buffer: Uint8Array
  private length = 0

  constructor(private readonly size: number) {
    this.buffer = new Uint8Array(size * 2)
  }

  add(bytes: Uint8Array): void {
    if (bytes.byteLength >= this.size) {
      this.buffer.set(bytes.subarray(bytes.byteLength - this.size))
      this.length = this.size
      return
    }
    if (this.length + bytes.byteLength > this.buffer.byteLength) {
      this.buffer.copyWithin(0, this.length - this.size, this.length)
      this.length = this.size
    }
    this.buffer.set(bytes, this.length)
    this.length += bytes.byteLength
  }

  /** The byte `back` bytes before the end (1 is the last), if kept. */
  before(back: number): number | undefined {
    return back > this.length ? undefined : this.buffer[this.length - back]
  }

  last(count: number): Uint8Array {
    return this.buffer.subarray(Math.max(0, this.length - count), this.length)
  }

  get bytes(): Uint8Array {
    return this.buffer.subarray(0, this.length)
  }

  clear(): void {
    this.length = 0
  }
}

// Byte values the readers below name.
const LEFT_PAREN = 0x28
const RIGHT_PAREN = 0x29
const LESS = 0x3c
const GREATER = 0x3e
const RIGHT_BRACKET = 0x5d
const BACKSLASH = 0x5c
const PERCENT = 0x25
const SLASH = 0x2f
const CR = 0x0d
const LF = 0x0a
/** Operators, as their two bytes (or one) read into a number. */
const BT = 0x4254
const TJ_LOWER = 0x546a // Tj
const TJ_UPPER = 0x544a // TJ
const QUOTE = 0x27 // '
const DOUBLE_QUOTE = 0x22 // "
const ID = 0x4944 // an inline image's data follows
/** What the first reading is in: tokens, a comment, a string `(…)`, a string `<…>` (or `<<`), an inline image's data. */
const TOKENS = 0
const COMMENT = 1
const STRING = 2
const HEX = 3
const ANGLE = 4
const IMAGE = 5

/**
 * Whether content shows text: a BT, then a string shown with Tj, TJ, ' or " right after a string (`(…)` or `<…>`) or
 * an array of them (`[…]`), with only white space or comments between. Read byte by byte, so the answer doesn't depend
 * on where the file's pieces break, and for the whole file: a page's content may be split between streams anywhere
 * between two tokens (ISO 32000-1 §7.8.2), so a BT in one stream and its `(…) Tj` in the next count, as does a string
 * at one stream's end and its Tj at the next one's start. Two readings, either finding text being enough: one that knows
 * strings, comments and inline images, and one that only passes over white space (the older reading), in case the
 * first is misled (by an inline image's bytes, say). Finding text where there is none only ever accepts a PDF.
 */
class TextOperators {
  shown = false
  private began = false
  // The first reading.
  private mode = TOKENS
  private depth = 0
  private escaped = false
  private token = 0
  private tokenLength = 0
  /** The last token was a string, or the end of an array. */
  private afterString = false
  /** In an inline image's data: 1 after white space, 2 after its E, 3 after its EI. */
  private imageEnd = 0
  // The second reading: runs of bytes between white space and delimiters.
  private run = 0
  private runLength = 0
  /** The last byte other than white space before the run. */
  private runAfter = 0
  private last = 0

  feed(bytes: Uint8Array): boolean {
    for (let at = 0; at < bytes.length && !this.shown; at += 1) {
      const byte = bytes[at]!
      this.read(byte)
      this.readRaw(byte)
    }
    return this.shown
  }

  /** A stream ends: a token ends with it, and nothing else spans two streams. */
  end(): boolean {
    this.endToken()
    this.endRun()
    this.mode = TOKENS
    this.depth = 0
    this.escaped = false
    this.imageEnd = 0
    return this.shown
  }

  private operator(code: number, length: number, afterString: boolean): void {
    if (length === 2 && code === BT) this.began = true
    else if (this.began && afterString && ((length === 2 && (code === TJ_LOWER || code === TJ_UPPER)) || (length === 1 && (code === QUOTE || code === DOUBLE_QUOTE)))) this.shown = true
  }

  private endToken(): void {
    if (!this.tokenLength) return
    this.operator(this.token, this.tokenLength, this.afterString)
    if (this.tokenLength === 2 && this.token === ID) {
      this.mode = IMAGE
      this.imageEnd = 0
    }
    this.tokenLength = 0
    this.afterString = false
  }

  private read(byte: number): void {
    switch (this.mode) {
      case COMMENT:
        if (byte === CR || byte === LF) this.mode = TOKENS
        return
      case STRING:
        if (this.escaped) this.escaped = false
        else if (byte === BACKSLASH) this.escaped = true
        else if (byte === LEFT_PAREN) this.depth += 1
        else if (byte === RIGHT_PAREN && --this.depth === 0) {
          this.mode = TOKENS
          this.afterString = true
        }
        return
      case ANGLE:
      case HEX:
        // After `<`: a second `<` opens a dictionary; anything else is inside a string `<…>`, which `>` ends.
        if (this.mode === ANGLE && byte === LESS) {
          this.mode = TOKENS
          this.afterString = false
        } else if (byte === GREATER) {
          this.mode = TOKENS
          this.afterString = true
        } else this.mode = HEX
        return
      case IMAGE:
        // The data ends at EI after white space, before white space or a delimiter.
        if (this.imageEnd === 3 && isDelimiter(byte)) {
          this.mode = TOKENS
          this.imageEnd = 0
          this.afterString = false
          break
        }
        this.imageEnd = isWhite(byte) ? 1 : byte === 0x45 && this.imageEnd === 1 ? 2 : byte === 0x49 && this.imageEnd === 2 ? 3 : 0
        return
    }
    if (isWhite(byte)) {
      this.endToken()
      return
    }
    if (!isDelimiter(byte)) {
      if (this.tokenLength < 2) this.token = this.tokenLength ? this.token * 256 + byte : byte
      this.tokenLength += 1
      return
    }
    this.endToken()
    switch (byte) {
      case PERCENT:
        this.mode = COMMENT
        break
      case LEFT_PAREN:
        this.mode = STRING
        this.depth = 1
        break
      case LESS:
        this.mode = ANGLE
        break
      case RIGHT_PAREN:
      case RIGHT_BRACKET:
        this.afterString = true
        break
      case SLASH:
        // A name: a token that is never an operator.
        this.token = -1
        this.tokenLength = 3
        break
      default:
        this.afterString = false
    }
  }

  private endRun(): void {
    if (!this.runLength) return
    this.operator(this.run, this.runLength, this.runAfter === RIGHT_PAREN || this.runAfter === GREATER || this.runAfter === RIGHT_BRACKET)
    this.runLength = 0
  }

  private readRaw(byte: number): void {
    if (isWhite(byte)) {
      this.endRun()
      return
    }
    if (isDelimiter(byte)) this.endRun()
    else {
      if (!this.runLength) this.runAfter = this.last
      if (this.runLength < 2) this.run = this.runLength ? this.run * 256 + byte : byte
      this.runLength += 1
    }
    this.last = byte
  }
}

/** At most this much of one compressed stream is kept to inflate, and at most this much comes out of it, or of all. */
const FLATE_STREAM_BYTES = 8 * 1024 * 1024
const INFLATED_STREAM_BYTES = 8 * 1024 * 1024
const INFLATED_FILE_BYTES = 32 * 1024 * 1024
/** At most this many streams are inflated in one file (each costs about 40 µs to set up, whatever its size). */
const INFLATED_STREAMS = 4000

/** The tokens of PDF objects in `text` from `from`, comments left out; null when a string isn't closed. */
function tokensOf(text: string, from: number): string[] | null {
  const tokens: string[] = []
  let at = from
  while (at < text.length) {
    const character = text[at]!
    const code = text.charCodeAt(at)
    if (isWhite(code)) at += 1
    else if (character === '%') {
      while (at < text.length && text[at] !== '\n' && text[at] !== '\r') at += 1
    } else if ((character === '<' || character === '>') && text[at + 1] === character) {
      tokens.push(character + character)
      at += 2
    } else if ('[]{}'.includes(character)) {
      tokens.push(character)
      at += 1
    } else if (character === '(') {
      let depth = 0
      let end = at
      for (; end < text.length; end += 1) {
        if (text[end] === '\\') end += 1
        else if (text[end] === '(') depth += 1
        else if (text[end] === ')' && --depth === 0) break
      }
      if (end >= text.length) return null
      tokens.push(text.slice(at, end + 1))
      at = end + 1
    } else if (character === '<') {
      const end = text.indexOf('>', at)
      if (end === -1) return null
      tokens.push(text.slice(at, end + 1))
      at = end + 1
    } else if (character === ')' || character === '>') return null
    else {
      // A name (its slash included), a number, a reference's R, true, false or null.
      let end = at + 1
      while (end < text.length && !isDelimiter(text.charCodeAt(end))) end += 1
      tokens.push(text.slice(at, end))
      at = end
    }
  }
  return tokens
}

/**
 * The entries of the dictionary a stream's data follows, from the bytes before its `stream` keyword: from its object's
 * header (`5 0 obj`) to its end, each value as written (a dictionary or an array whole, a reference as `6 0 R`). Only
 * its own entries: a dictionary inside it (its resources, say) is a value. Null when the bytes aren't one whole
 * dictionary from a header, so what the stream is can't be told.
 */
function streamDictionary(text: string): Map<string, string> | null {
  const headers = [...text.matchAll(/\d+\s+\d+\s+obj\b/g)]
  const header = headers[headers.length - 1]
  if (!header) return null
  const tokens = tokensOf(text, header.index + header[0].length)
  if (!tokens || tokens[0] !== '<<') return null
  const OPEN = new Set(['<<', '[', '{'])
  const CLOSE = new Set(['>>', ']', '}'])
  const valueEnd = (start: number): number => {
    const first = tokens[start]
    if (first === undefined || CLOSE.has(first)) return -1
    if (OPEN.has(first)) {
      let depth = 0
      for (let at = start; at < tokens.length; at += 1) {
        if (OPEN.has(tokens[at]!)) depth += 1
        else if (CLOSE.has(tokens[at]!) && --depth === 0) return at + 1
      }
      return -1
    }
    if (/^\d+$/.test(first) && /^\d+$/.test(tokens[start + 1] ?? '') && tokens[start + 2] === 'R') return start + 3
    return start + 1
  }
  const entries = new Map<string, string>()
  let at = 1
  while (at < tokens.length && tokens[at] !== '>>') {
    const key = tokens[at]!
    const end = valueEnd(at + 1)
    if (!key.startsWith('/') || end === -1) return null
    entries.set(key, tokens.slice(at + 1, end).join(' '))
    at = end
  }
  // It ends right before `stream`.
  return tokens[at] === '>>' && at === tokens.length - 1 ? entries : null
}

/** The names a filter value lists (`/FlateDecode`, `[/FlateDecode]`); null when it isn't names (a reference, say). */
function filterNames(value: string | undefined): string[] | null {
  if (value === undefined || value === 'null') return []
  const names = value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1).trim().split(/\s+/).filter(Boolean) : [value]
  return names.every((name) => /^\/[^\s]+$/.test(name)) ? names.map((name) => name.slice(1)) : null
}

/** Streams that are never content: images, fonts, colour profiles, shadings and functions, metadata, files. */
const NOT_CONTENT_TYPES = new Set(['/XRef', '/ObjStm', '/Metadata', '/EmbeddedFile', '/CMap'])
const NOT_CONTENT_SUBTYPES = new Set(['/Image', '/Type1C', '/CIDFontType0C', '/OpenType', '/XML'])
const NOT_CONTENT_KEYS = ['/Length1', '/Length2', '/Length3', '/N', '/BitsPerComponent', '/ShadingType', '/FunctionType']

/** How many bytes of end of line come last in `data` (the one before "endstream"): 2 for CR LF, 1, or 0. */
function endOfLine(data: Uint8Array): number {
  const last = data[data.length - 1]
  if (last === LF) return data[data.length - 2] === CR ? 2 : 1
  return last === CR ? 1 : 0
}

/** The stream being read: content as it is, compressed content kept to inflate, or bytes passed over. */
interface OpenStream {
  kind: 'content' | 'flate' | 'skip'
  length: number | null
  data: Kept | null
}

/**
 * Whether a PDF has any text, read as its bytes pass on to the engine (design section 11: a scanned PDF is named
 * before learning). Its content streams (a page's, or a form's, a pattern's or an annotation's that a page draws) are
 * read for text-showing operators: as they are, or inflated when FlateDecode-compressed, within the budgets above.
 * Images, fonts, object and cross-reference streams and metadata are passed over.
 *
 * It says "no text" only when it is sure: every content stream was read and none shows text. Whatever it can't read
 * for certain makes it unsure (another filter, or a filter or its parameters given by reference; a stream whose
 * dictionary can't be read, or that was missed, its "endstream" found outside a stream; an encrypted file; a broken
 * stream; a budget spent; a file cut short), and unsure, only the older, certain sign of no text counts: no /Font and
 * no /ObjStm (where fonts can hide) anywhere. A PDF with text is never refused; one this can't be sure of is learned.
 */
export class PdfTextCheck {
  private readonly text = new TextOperators()
  /** Some content couldn't be read here. */
  private unsure = false
  private fonts = false
  private objectStreams = false
  /** Bytes not read yet: the end of the last piece, which a keyword may continue in the next. */
  private carry = EMPTY
  /** The last bytes outside any stream (4 to 8 KB): the dictionary of the stream that follows. */
  private readonly before = new Tail(4096)
  private stream: OpenStream | null = null
  private inflated = 0
  private inflatedStreams = 0

  /** True when the PDF has no text to learn (a scanned image), as far as what passed shows. */
  get noText(): boolean {
    if (this.text.shown) return false
    const unsure = this.unsure || this.stream !== null
    return !unsure || (!this.fonts && !this.objectStreams)
  }

  async push(piece: Uint8Array): Promise<void> {
    if (this.text.shown) return
    const data = joined(this.carry, piece)
    this.carry = EMPTY
    let at = 0
    while (at < data.length && !this.text.shown) {
      if (!this.stream) {
        const keyword = this.streamKeyword(data, at)
        if (keyword === null) {
          // Up to the last few bytes, which may begin a keyword: read with the next piece.
          const upto = Math.max(at, data.length - (STREAM.length - 1))
          this.outside(data.subarray(at, upto))
          this.carry = data.slice(upto)
          return
        }
        if ('wait' in keyword) {
          // Whether an end of line follows the keyword is in the next piece.
          this.outside(data.subarray(at, keyword.wait))
          this.carry = data.slice(keyword.wait)
          return
        }
        this.outside(data.subarray(at, keyword.start))
        this.open()
        at = keyword.data
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
    if (this.text.shown) return
    if (!this.stream) this.outside(this.carry)
    else this.unsure = true
    this.carry = EMPTY
  }

  /**
   * The next `stream` keyword after a dictionary (`>>`) and before an end of line (after spaces, which some writers
   * leave), outside stream data: where it starts and where its data does; `wait` when that is in the next piece; null
   * when there is none. A `stream` without its end of line isn't read as one: its "endstream" then makes this unsure.
   */
  private streamKeyword(data: Uint8Array, from: number): { start: number; data: number } | { wait: number } | null {
    // A byte before `from` is one read outside streams before (the end of `before`), if any.
    const byteAt = (index: number) => (index >= from ? data[index] : this.before.before(from - index))
    for (let at = indexOfBytes(data, STREAM, from); at !== -1; at = indexOfBytes(data, STREAM, at + 1)) {
      if (isLetter(byteAt(at - 1))) continue
      let before = at - 1
      while (isWhite(byteAt(before))) before -= 1
      if (byteAt(before) !== GREATER || byteAt(before - 1) !== GREATER) continue
      let eol = at + STREAM.length
      while (eol < data.length && eol < at + STREAM.length + 64 && (data[eol] === 0x20 || data[eol] === 0x09)) eol += 1
      if (eol >= data.length) return { wait: at }
      if (data[eol] === LF) return { start: at, data: eol + 1 }
      if (data[eol] === CR) return eol + 1 < data.length ? { start: at, data: eol + (data[eol + 1] === LF ? 2 : 1) } : { wait: at }
    }
    return null
  }

  /**
   * Bytes between streams: dictionaries and the like, kept for the next stream's dictionary and read for fonts, for
   * encryption (its content is then only bytes here) and for a stream missed ("endstream" outside one).
   */
  private outside(bytes: Uint8Array): void {
    if (!bytes.byteLength) return
    // A keyword may begin in the bytes read before.
    const seam = joined(this.before.last(END_STREAM.length - 1), bytes)
    if (!this.fonts && indexOfBytes(seam, FONT) !== -1) this.fonts = true
    if (!this.objectStreams && indexOfBytes(seam, OBJECT_STREAM) !== -1) this.objectStreams = true
    if (!this.unsure && (indexOfBytes(seam, ENCRYPT) !== -1 || indexOfBytes(seam, END_STREAM) !== -1)) this.unsure = true
    this.before.add(bytes)
  }

  /** A stream begins: what it is, from its own dictionary's entries. */
  private open(): void {
    const dictionary = streamDictionary(latin1(this.before.bytes))
    this.before.clear()
    const stream: OpenStream = { kind: 'content', length: null, data: null }
    this.stream = stream
    if (!dictionary) {
      // Read as it is, in case it shows text; what it is can't be told.
      this.unsure = true
      return
    }
    const type = dictionary.get('/Type')
    const subtype = dictionary.get('/Subtype')
    if ((type && NOT_CONTENT_TYPES.has(type)) || (subtype && NOT_CONTENT_SUBTYPES.has(subtype)) || NOT_CONTENT_KEYS.some((key) => dictionary.has(key))) {
      stream.kind = 'skip'
      return
    }
    // Its subtype by reference, or its data in another file (/F): what it holds can't be told.
    if ((subtype && !subtype.startsWith('/')) || dictionary.has('/F')) this.unsure = true
    const length = dictionary.get('/Length')
    stream.length = length && /^\d+$/.test(length) ? Number(length) : null
    const filters = filterNames(dictionary.get('/Filter'))
    if (filters && !filters.length) return
    const parameters = dictionary.get('/DecodeParms')
    const predictor = parameters?.match(/\/Predictor\s+([^\s/<>[\]()]+)/)?.[1]
    const plain = parameters === undefined || parameters === 'null' || (!/\d+\s+\d+\s+R\b/.test(parameters) && (predictor === undefined || Number(predictor) <= 1))
    if (filters?.length === 1 && (filters[0] === 'FlateDecode' || filters[0] === 'Fl') && plain && this.inflatedStreams < INFLATED_STREAMS && this.inflated < INFLATED_FILE_BYTES) {
      stream.kind = 'flate'
      stream.data = new Kept(FLATE_STREAM_BYTES)
      return
    }
    // Another filter, a filter or its parameters by reference, or a budget spent.
    stream.kind = 'skip'
    this.unsure = true
  }

  private take(bytes: Uint8Array): void {
    const stream = this.stream!
    if (!bytes.byteLength || stream.kind === 'skip') return
    if (stream.kind === 'content') {
      this.text.feed(bytes)
      return
    }
    if (!stream.data!.add(bytes)) {
      stream.kind = 'skip'
      stream.data = null
      this.unsure = true
    }
  }

  /** A stream ends: a compressed one is inflated and read now, within the budgets. */
  private async close(): Promise<void> {
    const stream = this.stream!
    this.stream = null
    if (stream.kind === 'content') this.text.end()
    if (stream.kind !== 'flate' || this.text.shown) return
    let data = stream.data!.bytes
    // Its data ends where its length says or, when that is by reference (or wrong), before the end of line that comes
    // before "endstream".
    data = stream.length !== null && stream.length <= data.length ? data.subarray(0, stream.length) : data.subarray(0, data.length - endOfLine(data))
    this.inflatedStreams += 1
    const room = Math.min(INFLATED_STREAM_BYTES, INFLATED_FILE_BYTES - this.inflated)
    const reader = new Response(data as Uint8Array<ArrayBuffer>).body!.pipeThrough(new DecompressionStream('deflate')).getReader()
    let out = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        out += value.byteLength
        if (this.text.feed(value)) break
        if (out >= room) {
          this.unsure = true
          break
        }
      }
    } catch {
      this.unsure = true
    } finally {
      this.inflated += out
      this.text.end()
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
  // A Knowledge export is read here too (its zip's directory), so its bytes are kept as they pass (it is a few MB), in
  // one buffer, not one per piece.
  const kept = keep ? new Kept(maxBytes) : null
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
      kept?.add(chunk)
      controller.enqueue(chunk)
      await read(() => check!.push(chunk))
    },
    async flush() {
      await read(() => check!.end())
    },
  }))
  return { stream, result: () => ({ bytes, scannedPdf: check !== null && checked && check.noText, kept: kept?.bytes ?? null }) }
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>)
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** A file id: from preflight, 8 to 64 of [A-Za-z0-9_-]. */
export const FILE_ID = /^[A-Za-z0-9_-]{8,64}$/
