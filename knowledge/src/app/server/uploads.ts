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

// Byte values the readers below name.
const LEFT_PAREN = 0x28
const RIGHT_PAREN = 0x29
const LESS = 0x3c
const GREATER = 0x3e
const LEFT_BRACKET = 0x5b
const RIGHT_BRACKET = 0x5d
const LEFT_BRACE = 0x7b
const RIGHT_BRACE = 0x7d
const BACKSLASH = 0x5c
const PERCENT = 0x25
const SLASH = 0x2f
const CR = 0x0d
const LF = 0x0a
const SPACE = 0x20
const TAB = 0x09
/** Operators, as their two bytes (or one) read into a number. */
const BT = 0x4254
const TJ_LOWER = 0x546a // Tj
const TJ_UPPER = 0x544a // TJ
const QUOTE = 0x27 // '
const DOUBLE_QUOTE = 0x22 // "
const ID = 0x4944 // an inline image's data follows
/** What a reading is in: tokens, a comment, a string `(…)`, a string `<…>` (or `<<`), an inline image's data. */
const TOKENS = 0
const COMMENT = 1
const STRING = 2
const HEX = 3
const ANGLE = 4
const IMAGE = 5
/** Between streams only: after a `>` (a second one ends a dictionary), after "stream" (its spaces, then its CR). */
const CLOSING = 6
const KEYWORD = 7
const KEYWORD_CR = 8

/**
 * Whether content shows text: a string (`(…)` or `<…>`) or an array of them (`[…]`) shown with Tj, TJ, ' or ", with
 * only white space or comments between, or one of those operators first in a stream (a page's content may be split
 * between streams anywhere between two tokens, ISO 32000-1 §7.8.2, so its string is then at the end of another). Text
 * shown anywhere is text, with or without a BT before it, and each stream is read on its own, so the order the file
 * stores a page's streams in never matters. Read byte by byte, so neither does where the file's pieces break. Two
 * readings, either finding text being enough: one that knows strings, comments and inline images, and one that only
 * passes over white space, after a BT in the same stream (the older reading), in case the first is misled (by an inline
 * image's bytes, say). Finding text where there is none only ever accepts a PDF.
 */
class TextOperators {
  shown = false
  // The first reading.
  private mode = TOKENS
  private depth = 0
  private escaped = false
  private token = 0
  private tokenLength = 0
  /** The last token was a string, or the end of an array. */
  private afterString = false
  /** No token yet in this stream: only white space and comments. */
  private first = true
  /** In an inline image's data: 1 after white space, 2 after its E, 3 after its EI. */
  private imageEnd = 0
  // The second reading: runs of bytes between white space and delimiters, after a BT.
  private began = false
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

  /** A stream ends: the next one is read afresh. */
  end(): boolean {
    this.endToken()
    this.endRun()
    this.mode = TOKENS
    this.depth = 0
    this.escaped = false
    this.imageEnd = 0
    this.afterString = false
    this.first = true
    this.began = false
    this.last = 0
    return this.shown
  }

  private operator(code: number, length: number, afterString: boolean): void {
    if (afterString && ((length === 2 && (code === TJ_LOWER || code === TJ_UPPER)) || (length === 1 && (code === QUOTE || code === DOUBLE_QUOTE)))) this.shown = true
  }

  private endToken(): void {
    if (!this.tokenLength) return
    this.operator(this.token, this.tokenLength, this.afterString || this.first)
    if (this.tokenLength === 2 && this.token === ID) {
      this.mode = IMAGE
      this.imageEnd = 0
    }
    this.tokenLength = 0
    this.afterString = false
    this.first = false
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
    if (byte === PERCENT) {
      this.mode = COMMENT
      return
    }
    this.first = false
    switch (byte) {
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
    if (this.runLength === 2 && this.run === BT) this.began = true
    else if (this.began) this.operator(this.run, this.runLength, this.runAfter === RIGHT_PAREN || this.runAfter === GREATER || this.runAfter === RIGHT_BRACKET)
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

/** At most this many tokens of a stream's dictionary are kept, each at most this long; past either it can't be read. */
const DICTIONARY_TOKENS = 4096
const TOKEN_BYTES = 256
/** The token Between is reading. */
const WORD = 1
const NAME = 2

/** A hexadecimal digit's value, or -1. */
const hexDigit = (code: number) => (code >= 0x30 && code <= 0x39 ? code - 0x30 : (code | 0x20) >= 0x61 && (code | 0x20) <= 0x66 ? (code | 0x20) - 0x57 : -1)

/** A name's characters with their #xx escapes decoded (ISO 32000-1 §7.3.5): `Fil#74er` is Filter. */
function decodeName(raw: string): string {
  if (!raw.includes('#')) return raw
  let name = ''
  for (let at = 0; at < raw.length; at += 1) {
    const high = raw[at] === '#' ? hexDigit(raw.charCodeAt(at + 1)) : -1
    const low = high === -1 ? -1 : hexDigit(raw.charCodeAt(at + 2))
    if (low === -1) name += raw[at]
    else {
      name += String.fromCharCode(high * 16 + low)
      at += 2
    }
  }
  return name
}

/**
 * The bytes between streams, read byte by byte in one pass (so where the file's pieces break never matters, and the
 * cost only grows with the bytes): PDF's tokens, names decoded, for each stream's dictionary and where its data starts,
 * and for a font, an object stream or encryption named anywhere.
 */
class Between {
  /** Something here can't be read for certain: encryption, "stream" out of place, a stream missed ("endstream" here). */
  unsure = false
  /** A font named somewhere, or an object stream, where fonts can hide. */
  fonts = false
  /** The tokens of the dictionary of the stream whose data read() stopped at; null when they can't be told. */
  dictionary: string[] | null = null
  private mode = TOKENS
  private depth = 0
  private escaped = false
  /** The token being read (WORD: a number or a keyword; NAME, its escapes still in), its first TOKEN_BYTES bytes. */
  private kind = 0
  private word = ''
  private length = 0
  private digits = false
  /** Integers right before (at most 2), and whether the last token was the "obj" of an object's header (`5 0 obj`). */
  private integers = 0
  private header = false
  /** Arrays and dictionaries open; the outermost dictionary's tokens as it is read (null: too many, or no header). */
  private nesting = 0
  private outermost = false
  private tokens: string[] | null = null
  /** The outermost dictionary just ended, with only white space since (its "stream" may follow), and its tokens. */
  private ended = false
  private endedTokens: string[] | null = null
  private spaces = 0
  /** The last 16 bytes, to find the names looked for wherever they are (in a string, a comment, a stream missed). */
  private readonly recent = new Uint8Array(16)
  private recentAt = 0

  /** Reads data[from, to): where the data of a stream starts (its dictionary then in `dictionary`), or -1 for none. */
  read(data: Uint8Array, from: number, to: number): number {
    for (let at = from; at < to; at += 1) {
      const byte = data[at]!
      this.watch(byte)
      switch (this.mode) {
        case COMMENT:
          if (byte === CR || byte === LF) this.mode = TOKENS
          continue
        case STRING:
          if (this.escaped) this.escaped = false
          else if (byte === BACKSLASH) this.escaped = true
          else if (byte === LEFT_PAREN) this.depth += 1
          else if (byte === RIGHT_PAREN && --this.depth === 0) {
            this.mode = TOKENS
            this.value('()')
          }
          continue
        case ANGLE:
          // After `<`: a second one opens a dictionary; anything else is in a string `<…>`.
          if (byte === LESS) {
            this.mode = TOKENS
            this.open('<<')
          } else if (byte === GREATER) {
            this.mode = TOKENS
            this.value('<>')
          } else this.mode = HEX
          continue
        case HEX:
          if (byte === GREATER) {
            this.mode = TOKENS
            this.value('<>')
          }
          continue
        case CLOSING:
          // After `>`: a second one ends a dictionary; one alone is nothing.
          this.mode = TOKENS
          if (byte === GREATER) {
            this.close('>>')
            continue
          }
          break
        case KEYWORD:
          // After "stream": spaces (some writers leave them), then its end of line.
          if ((byte === SPACE || byte === TAB) && ++this.spaces <= 64) continue
          this.mode = TOKENS
          if (byte === LF) return this.begin(at + 1)
          if (byte === CR) {
            this.mode = KEYWORD_CR
            continue
          }
          this.unsure = true
          break
        case KEYWORD_CR:
          this.mode = TOKENS
          return this.begin(byte === LF ? at + 1 : at)
      }
      const kind = KIND[byte]
      if (kind === 0) {
        if (!this.kind) this.start(WORD)
        if (this.length < TOKEN_BYTES) this.word += String.fromCharCode(byte)
        this.length += 1
        if (byte < 0x30 || byte > 0x39) this.digits = false
        continue
      }
      if (this.kind && this.endToken()) {
        // "stream" after a dictionary: its data starts after the end of line.
        if (byte === LF) return this.begin(at + 1)
        if (byte === CR) {
          this.mode = KEYWORD_CR
          continue
        }
        if (byte === SPACE || byte === TAB) {
          this.mode = KEYWORD
          this.spaces = 1
          continue
        }
        this.unsure = true
      }
      if (kind === 1) continue
      switch (byte) {
        case PERCENT:
          this.mode = COMMENT
          this.ended = false
          break
        case LEFT_PAREN:
          this.mode = STRING
          this.depth = 1
          break
        case LESS:
          this.mode = ANGLE
          break
        case GREATER:
          this.mode = CLOSING
          break
        case SLASH:
          this.start(NAME)
          break
        case LEFT_BRACKET:
        case LEFT_BRACE:
          this.open(String.fromCharCode(byte))
          break
        case RIGHT_BRACKET:
        case RIGHT_BRACE:
          this.close(String.fromCharCode(byte))
          break
        // A `)` alone: nothing.
      }
    }
    return -1
  }

  /** The end of the file: anything left open (a string, a dictionary, "stream" without its data) makes it unsure. */
  end(): void {
    if (this.kind && this.endToken()) this.unsure = true
    if (this.nesting > 0 || [STRING, HEX, ANGLE, KEYWORD, KEYWORD_CR].includes(this.mode)) this.unsure = true
  }

  private start(kind: number): void {
    this.kind = kind
    this.word = ''
    this.length = 0
    this.digits = true
  }

  /** The token being read ends: true when it is "stream" right after a dictionary, so the stream's data follows. */
  private endToken(): boolean {
    const { kind, word } = this
    const long = this.length > TOKEN_BYTES
    this.kind = 0
    if (kind === NAME) {
      const name = decodeName(word)
      if (name.startsWith('Font') || name === 'ObjStm') this.fonts = true
      if (name === 'Encrypt') this.unsure = true
      this.value(`/${name}`, long)
      return false
    }
    if (word === 'stream' && !long) {
      const stream = this.ended
      this.value(word)
      // Anywhere but after a dictionary, it can't be a stream's: what follows isn't known.
      if (!stream) this.unsure = true
      return stream
    }
    const integers = this.digits && !long ? Math.min(2, this.integers + 1) : 0
    const header = word === 'obj' && this.integers === 2
    this.value(word, long)
    this.integers = integers
    this.header = header
    return false
  }

  /** A token: kept when in a stream's dictionary; past it, its "stream" can't follow, nor an object's header. */
  private value(token: string, long = false): void {
    this.ended = false
    this.integers = 0
    this.header = false
    if (!this.tokens) return
    if (long || this.tokens.length >= DICTIONARY_TOKENS) this.tokens = null
    else this.tokens.push(token)
  }

  private open(token: string): void {
    if (this.nesting === 0 && token === '<<') {
      this.outermost = true
      // Only an object's own dictionary (`5 0 obj <<`) can be a stream's.
      this.tokens = this.header ? [] : null
    }
    this.nesting += 1
    this.value(token)
  }

  private close(token: string): void {
    if (this.nesting === 0) {
      // Nothing is open: a closer alone.
      this.value(token)
      return
    }
    this.nesting -= 1
    this.value(token)
    if (this.nesting > 0 || !this.outermost) return
    this.outermost = false
    this.ended = true
    this.endedTokens = token === '>>' ? this.tokens : null
    this.tokens = null
  }

  /** A stream's data starts at `start`: its dictionary is the one that just ended. */
  private begin(start: number): number {
    this.dictionary = this.endedTokens
    this.endedTokens = null
    this.recent.fill(0)
    return start
  }

  private watch(byte: number): void {
    this.recent[this.recentAt] = byte
    this.recentAt = (this.recentAt + 1) & 15
    if (byte === 0x74) {
      // The t of /Font or /Encrypt.
      if (this.ends(FONT)) this.fonts = true
      else if (this.ends(ENCRYPT)) this.unsure = true
    } else if (byte === 0x6d) {
      // The m of /ObjStm or endstream.
      if (this.ends(OBJECT_STREAM)) this.fonts = true
      else if (this.ends(END_STREAM)) this.unsure = true
    }
  }

  /** The last bytes read are `needle`. */
  private ends(needle: Uint8Array): boolean {
    for (let back = 1; back <= needle.length; back += 1) {
      if (this.recent[(this.recentAt - back) & 15] !== needle[needle.length - back]) return false
    }
    return true
  }
}

const OPENERS = new Set(['<<', '[', '{'])
const CLOSERS = new Set(['>>', ']', '}'])

/** Digits only: a PDF integer as offsets, lengths and object numbers are written. */
function isInteger(token: string | undefined): boolean {
  if (!token) return false
  for (let at = 0; at < token.length; at += 1) {
    const code = token.charCodeAt(at)
    if (code < 0x30 || code > 0x39) return false
  }
  return true
}

/**
 * A stream's dictionary, from its tokens (Between): each of its own entries' value as tokens (a dictionary or an array
 * whole, a reference as `6 0 R`); a dictionary inside it (its resources, say) is a value. Null when they aren't one.
 */
function entriesOf(tokens: string[]): Map<string, string[]> | null {
  const last = tokens.length - 1
  if (tokens[0] !== '<<' || tokens[last] !== '>>') return null
  const entries = new Map<string, string[]>()
  let at = 1
  while (at < last) {
    const key = tokens[at]!
    const end = valueEnd(tokens, at + 1, last)
    if (!key.startsWith('/') || end === -1) return null
    entries.set(key, tokens.slice(at + 1, end))
    at = end
  }
  return entries
}

/** Where the value from `start` ends, before `last` (its dictionary's `>>`); -1 when there is no whole value. */
function valueEnd(tokens: string[], start: number, last: number): number {
  const first = tokens[start]
  if (start >= last || first === undefined || CLOSERS.has(first)) return -1
  if (OPENERS.has(first)) {
    let depth = 0
    for (let at = start; at < last; at += 1) {
      if (OPENERS.has(tokens[at]!)) depth += 1
      else if (CLOSERS.has(tokens[at]!) && --depth === 0) return at + 1
    }
    return -1
  }
  if (start + 2 < last && isInteger(first) && isInteger(tokens[start + 1]) && tokens[start + 2] === 'R') return start + 3
  return start + 1
}

/** A value that is one name (`/Image`), or undefined. */
const nameOf = (value: string[] | undefined) => (value?.length === 1 && value[0]!.startsWith('/') ? value[0] : undefined)

/** A value that is one integer, or null (a reference, say). */
const integerOf = (value: string[] | undefined) => (value?.length === 1 && isInteger(value[0]) ? Number(value[0]) : null)

/** The filters a value names (`/FlateDecode`, `[/FlateDecode]`, none); null when it isn't names (a reference, say). */
function filterNames(value: string[] | undefined): string[] | null {
  if (value === undefined || (value.length === 1 && value[0] === 'null')) return []
  const names = value[0] === '[' && value[value.length - 1] === ']' ? value.slice(1, -1) : value
  return names.every((name) => name.startsWith('/')) ? names.map((name) => name.slice(1)) : null
}

/** Parameters that leave FlateDecode's output as it is: none, or no predictor but 1, and nothing given by reference. */
function plainParameters(value: string[] | undefined): boolean {
  return value === undefined || value.every((token, at) => token !== 'R' && (token !== '/Predictor' || (isInteger(value[at + 1]) && Number(value[at + 1]) <= 1)))
}

/** Streams that are never content: images, fonts, colour profiles, shadings and functions, metadata, files. */
const NOT_CONTENT_TYPES = new Set(['/XRef', '/ObjStm', '/Metadata', '/EmbeddedFile', '/CMap'])
const NOT_CONTENT_SUBTYPES = new Set(['/Image', '/Type1C', '/CIDFontType0C', '/OpenType', '/XML'])
const NOT_CONTENT_KEYS = ['/Length1', '/Length2', '/Length3', '/N', '/BitsPerComponent', '/ShadingType', '/FunctionType']

/** At most this much of one compressed stream is kept to inflate, and at most this much comes out of it, or of all. */
const FLATE_STREAM_BYTES = 8 * 1024 * 1024
const INFLATED_STREAM_BYTES = 8 * 1024 * 1024
const INFLATED_FILE_BYTES = 32 * 1024 * 1024
/** At most this many streams are inflated in one file (each costs about 40 µs to set up, whatever its size). */
const INFLATED_STREAMS = 4000
/**
 * The budget for all of the reading (a Worker's CPU): at most this many bytes read byte by byte (between streams,
 * content, inflated content) and this many streams in one file. Past either, the check stops, and can't be sure of
 * anything. A file's images are passed over without reading their bytes, so a scan of any size stays well within.
 */
const READ_BYTES = 64 * 1024 * 1024
const STREAMS = 100_000

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
 * read for text-showing operators: as they are, or inflated when FlateDecode-compressed. Images, fonts, object and
 * cross-reference streams and metadata are passed over.
 *
 * It says "no text" only when it is sure: every stream found (its data ending at its "endstream") and its dictionary
 * read, names decoded; every content stream read, with no filter or FlateDecode given directly; no encryption; all
 * within the budgets above; and no text shown in any of them, in any order (TextOperators). Anything else makes it
 * unsure, and unsure, only the older, certain sign of no text counts: no font and no object stream (where fonts can
 * hide) named anywhere. Past READ_BYTES or STREAMS it stops reading, and can't be sure even of that. A PDF with text
 * is never refused; one this can't be sure of is learned.
 */
export class PdfTextCheck {
  private readonly text = new TextOperators()
  private readonly between = new Between()
  /** Some content couldn't be read here. */
  private unsure = false
  /** The budget is spent: nothing more is read, and nothing can be said for sure. */
  private stopped = false
  /** The last bytes of an open stream, which may begin its "endstream": read with the next piece. */
  private carry = EMPTY
  private stream: OpenStream | null = null
  private spent = 0
  private streams = 0
  private inflated = 0
  private inflatedStreams = 0

  /** `budget`: the bytes read byte by byte at most (READ_BYTES; smaller in tests). */
  constructor(private readonly budget = READ_BYTES) {}

  /** True when the PDF has no text to learn (a scanned image), as far as what passed shows. */
  get noText(): boolean {
    if (this.text.shown || this.stopped) return false
    if (!this.unsure && !this.between.unsure && this.stream === null) return true
    return !this.between.fonts
  }

  private get done(): boolean {
    return this.text.shown || this.stopped
  }

  async push(piece: Uint8Array): Promise<void> {
    if (this.done) return
    const data = joined(this.carry, piece)
    this.carry = EMPTY
    let at = 0
    while (at < data.length && !this.done) {
      if (!this.stream) {
        const to = Math.min(data.length, at + this.budget - this.spent)
        const start = this.between.read(data, at, to)
        this.spent += (start === -1 ? to : start) - at
        if (start === -1) {
          if (to < data.length) this.stopped = true
          return
        }
        this.open(this.between.dictionary)
        at = start
        continue
      }
      const end = indexOfBytes(data, END_STREAM, at)
      if (end === -1) {
        // Up to the last few bytes, which may begin "endstream": read with the next piece.
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

  /** The end of the file: a stream still open was cut short. */
  async end(): Promise<void> {
    if (this.done) return
    if (this.stream) this.unsure = true
    else this.between.end()
    this.carry = EMPTY
  }

  /** A stream begins: what it is, from its own dictionary's entries. */
  private open(tokens: string[] | null): void {
    const stream: OpenStream = { kind: 'content', length: null, data: null }
    this.stream = stream
    if (++this.streams > STREAMS) {
      this.stopped = true
      return
    }
    const dictionary = tokens && entriesOf(tokens)
    if (!dictionary) {
      // Read as it is, in case it shows text; what it is can't be told.
      this.unsure = true
      return
    }
    const type = nameOf(dictionary.get('/Type'))
    const subtype = dictionary.get('/Subtype')
    const subtypeName = nameOf(subtype)
    if ((type && NOT_CONTENT_TYPES.has(type)) || (subtypeName && NOT_CONTENT_SUBTYPES.has(subtypeName)) || NOT_CONTENT_KEYS.some((key) => dictionary.has(key))) {
      stream.kind = 'skip'
      return
    }
    // Its subtype by reference, or its data in another file (/F): what it holds can't be told.
    if ((subtype && !subtypeName) || dictionary.has('/F')) this.unsure = true
    stream.length = integerOf(dictionary.get('/Length'))
    const filters = filterNames(dictionary.get('/Filter'))
    if (filters && !filters.length) return
    if (filters?.length === 1 && (filters[0] === 'FlateDecode' || filters[0] === 'Fl') && plainParameters(dictionary.get('/DecodeParms')) && this.inflatedStreams < INFLATED_STREAMS && this.inflated < INFLATED_FILE_BYTES) {
      stream.kind = 'flate'
      stream.data = new Kept(FLATE_STREAM_BYTES)
      return
    }
    // Another filter, a filter or its parameters by reference, or the budget for inflating spent.
    stream.kind = 'skip'
    this.unsure = true
  }

  /** As much of `bytes` as the budget leaves to read; past it, the check stops. */
  private allowed(bytes: Uint8Array): Uint8Array {
    const room = this.budget - this.spent
    if (bytes.byteLength <= room) {
      this.spent += bytes.byteLength
      return bytes
    }
    this.stopped = true
    this.spent = this.budget
    return bytes.subarray(0, Math.max(0, room))
  }

  private take(bytes: Uint8Array): void {
    const stream = this.stream!
    if (!bytes.byteLength || stream.kind === 'skip') return
    if (stream.kind === 'content') {
      this.text.feed(this.allowed(bytes))
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
    if (stream.kind !== 'flate' || this.done) return
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
        // Only its first `room` bytes are read, whatever the pieces they come out in: more than that, and it is unsure.
        const part = value.subarray(0, room - out)
        out += part.byteLength
        if (this.text.feed(this.allowed(part)) || this.stopped) break
        if (part.byteLength < value.byteLength) {
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
