// Reading files, cutting their text into passages and searching it, for the in-memory engine. Deliberately simple:
// plain text, Markdown and HTML are read; a PDF's text operators are read and a PDF without any is refused as a
// scanned image; any other type the real engine accepts is read as its UTF-8 text. Search is by keywords, with a
// fixed "covered" threshold standing in for the real engine's calibrated one.

/** At most this much text is learned from one file; the rest is left out and the file says so. */
export const MAX_TEXT_BYTES = 2 * 1024 * 1024
/** At most this many passages per document. */
export const MAX_PASSAGES = 2000
/** A passage at or above this score covers the question; below it the answer is "I won't guess". */
export const COVERED_THRESHOLD = 0.6

/** The types the engine learns, by media type and by file extension. */
export const LEARNABLE_TYPES: Record<string, string> = {
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'text/markdown': 'md',
  'text/x-markdown': 'md',
  'text/plain': 'txt',
  'text/html': 'html',
}

export class ReadError extends Error {
  constructor(readonly reason: string, readonly code: 'unsupported_type' | 'too_large' | 'bad_request' = 'bad_request') {
    super(reason)
  }
}

export interface ExtractedText {
  text: string
  pages: { page: number; start: number; end: number }[]
  /** True when the file had more text than is learned from one file. */
  truncated: boolean
}

const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false })

function utf8(bytes: Uint8Array, what: string): string {
  try {
    return decoder.decode(bytes)
  } catch {
    throw new ReadError(`${what} isn't text Insulin can read. Save it as a PDF with text, a Word file or plain text and add it again.`)
  }
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

/** The visible text of an HTML page: scripts, styles and tags removed, block elements as line breaks. */
export function htmlText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript|template)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<(br|hr)\b[^>]*>/gi, '\n')
    .replace(/<\/(p|div|section|article|li|h[1-6]|tr|table|ul|ol|header|footer|main|blockquote|pre)\s*>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, name: string) => {
      if (name[0] === '#') {
        const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10)
        return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : ''
      }
      return ENTITIES[name.toLowerCase()] ?? entity
    })
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** A PDF's text, from its text-showing operators, one page per page object; null when it has none. */
function pdfText(source: string): string | null {
  const pages = source.split(/\/Type\s*\/Page(?!s)/).slice(1)
  const bodies = pages.length ? pages : [source]
  const texts = bodies.map((body) => {
    const parts: string[] = []
    for (const match of body.matchAll(/\(((?:[^()\\]|\\.)*)\)\s*T[jJ']/g)) parts.push((match[1] ?? '').replace(/\\(.)/g, '$1'))
    return parts.join(' ').trim()
  })
  return texts.some((text) => text.length > 0) ? texts.join('\f') : null
}

/** The text of a file the engine learns, with its page map. */
export function extractText(bytes: Uint8Array, type: string, name: string): ExtractedText {
  const kind = LEARNABLE_TYPES[type.split(';')[0]?.trim().toLowerCase() ?? ''] ?? kindFromName(name)
  if (!kind) throw new ReadError(`“${name}” is a type Insulin can't read.`, 'unsupported_type')
  let text: string
  if (kind === 'pdf') {
    const source = latin1(bytes)
    if (!source.startsWith('%PDF-')) throw new ReadError(`“${name}” isn't a PDF Insulin can read.`)
    const found = pdfText(source)
    if (found === null) {
      throw new ReadError(`“${name}” is a scanned image with no text. Upload a PDF with text, or a Word file.`)
    }
    text = found
  } else if (kind === 'html') {
    text = htmlText(utf8(bytes, `“${name}”`))
  } else {
    text = utf8(bytes, `“${name}”`)
  }
  text = text.replace(/\r\n?/g, '\n')
  let truncated = false
  const encoded = new TextEncoder().encode(text)
  if (encoded.byteLength > MAX_TEXT_BYTES) {
    truncated = true
    text = new TextDecoder().decode(encoded.subarray(0, MAX_TEXT_BYTES)).replace(/�+$/, '')
  }
  if (!text.trim()) throw new ReadError(`“${name}” has no text to learn.`)
  return { text, pages: pageMap(text), truncated }
}

/** Bytes as Latin-1 text, one character per byte, whatever the runtime's TextDecoder supports. */
function latin1(bytes: Uint8Array): string {
  let out = ''
  for (let start = 0; start < bytes.length; start += 8192) out += String.fromCharCode(...bytes.subarray(start, start + 8192))
  return out
}

function kindFromName(name: string): string | null {
  const extension = name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? ''
  const byExtension: Record<string, string> = { pdf: 'pdf', docx: 'docx', pptx: 'pptx', xlsx: 'xlsx', md: 'md', markdown: 'md', txt: 'txt', html: 'html', htm: 'html' }
  return byExtension[extension] ?? null
}

/** Pages split at form feeds; a text without any has no page map. */
export function pageMap(text: string): { page: number; start: number; end: number }[] {
  if (!text.includes('\f')) return []
  const pages: { page: number; start: number; end: number }[] = []
  let start = 0
  for (const part of text.split('\f')) {
    pages.push({ page: pages.length + 1, start, end: start + part.length })
    start += part.length + 1
  }
  return pages
}

export interface PassageSpan {
  start: number
  end: number
  text: string
  page: number | null
  pageEnd: number | null // the last page it runs over (here always its page: a passage never crosses a form feed)
}

/** The text cut into passages at blank lines: one paragraph each, a heading (short, no closing stop) joined to the next. */
export function passagesOf(text: string, pages: { page: number; start: number; end: number }[]): PassageSpan[] {
  const spans: PassageSpan[] = []
  const pageAt = (offset: number) => pages.find((page) => offset >= page.start && offset <= page.end)?.page ?? null
  let current: { start: number; end: number } | null = null
  const flush = () => {
    if (current && spans.length < MAX_PASSAGES) {
      const passage = text.slice(current.start, current.end)
      if (passage.trim()) spans.push({ start: current.start, end: current.end, text: passage, page: pageAt(current.start), pageEnd: pageAt(Math.max(current.start, current.end - 1)) })
    }
    current = null
  }
  for (const match of text.matchAll(/[^\n\f]+(?:\n[^\n\f]+)*/g)) {
    const start = match.index ?? 0
    const end = start + match[0].length
    const heading = current !== null && current.end - current.start < 60 && !/[.!?:;]\s*$/.test(text.slice(current.start, current.end))
    const joins = current && heading && pageAt(start) === pageAt(current.start) && end - current.start <= 2000
    if (current && !joins) flush()
    if (current) current.end = end
    else current = { start, end }
  }
  flush()
  return spans
}

const STOPWORDS = new Set(
  ('a an and are as at be by can do does for from has have how i if in into is it its of on or our so that the their them then there these they this to was we what when where which who whom why will with you your ' +
    'about above after again all am any because been before being below between both did doing down during each few further had having he her here hers herself him himself his ' +
    'me more most my myself no nor not now off once only other ours ourselves out over own same she should some such than theirs themselves those through too under until up very were while would yours yourself yourselves')
    .split(' '),
)

/** The words of a text that carry meaning: lower case, without stopwords; numbers kept. */
export function keywords(text: string): Set<string> {
  const words = new Set<string>()
  for (const match of text.toLowerCase().matchAll(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu)) {
    const word = match[0].replace(/['’]s$/, '').replace(/[-'’]+$/, '')
    if (STOPWORDS.has(word)) continue
    if (word.length < 3 && !/^\d+$/.test(word)) continue
    words.add(stem(word))
  }
  return words
}

/** A light stemmer: enough that "discounts" finds "discount". */
function stem(word: string): string {
  if (word.length > 4 && word.endsWith('ies')) return `${word.slice(0, -3)}y`
  if (word.length > 4 && word.endsWith('es') && /(s|x|z|ch|sh)es$/.test(word)) return word.slice(0, -2)
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1)
  return word
}

/** How much of the question a passage covers: the share of the question's keywords it holds. */
export function score(question: Set<string>, passage: Set<string>): number {
  if (question.size === 0) return 0
  let matched = 0
  for (const word of question) if (passage.has(word)) matched += 1
  return matched / question.size
}

/** The sentences of a passage, without Markdown heading marks. */
export function sentencesOf(text: string): string[] {
  const flat = text.replace(/^#+\s*/gm, '').replace(/\s+/g, ' ').trim()
  return flat.match(/[^.!?]+(?:[.!?]+(?=\s|$)|$)/g)?.map((sentence) => sentence.trim()).filter(Boolean) ?? []
}

/** The sentence of a passage that shares the most words with a question: what the in-memory writer quotes. */
export function bestSentence(text: string, question: string): string {
  const wanted = keywords(question)
  const sentences = sentencesOf(text)
  let best = sentences[0] ?? text
  let top = -1
  for (const sentence of sentences) {
    const value = score(wanted, keywords(sentence))
    if (value > top) {
      top = value
      best = sentence
    }
  }
  return best.length > 300 ? `${best.slice(0, 297)}…` : best
}

/** The first sentence of a passage, at most 300 characters: what the in-memory engine shows as a fact. */
export function firstSentence(text: string): string {
  const flat = text.replace(/^#+\s*/gm, '').replace(/\s+/g, ' ').trim()
  const end = flat.search(/[.!?](\s|$)/)
  const sentence = end >= 0 ? flat.slice(0, end + 1) : flat
  return sentence.length > 300 ? `${sentence.slice(0, 297)}…` : sentence
}

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])

/**
 * SHA-256 as lowercase hex, computed synchronously (Web Crypto's digest is asynchronous), so a passage's text hash is
 * known the moment the passage is cut. Checked against Web Crypto in the stub's tests.
 */
export function sha256Hex(data: string | Uint8Array): string {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data
  const length = bytes.length
  const padded = new Uint8Array(((length + 9 + 63) >> 6) << 6)
  padded.set(bytes)
  padded[length] = 0x80
  const view = new DataView(padded.buffer)
  view.setUint32(padded.length - 8, Math.floor(length / 0x20000000), false)
  view.setUint32(padded.length - 4, (length << 3) >>> 0, false)
  const hash = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19])
  const w = new Uint32Array(64)
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i += 1) w[i] = view.getUint32(offset + i * 4, false)
    for (let i = 16; i < 64; i += 1) {
      const a = w[i - 15]!, b = w[i - 2]!
      const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3)
      const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10)
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0
    }
    let a = hash[0]!, b = hash[1]!, c = hash[2]!, d = hash[3]!, e = hash[4]!, f = hash[5]!, g = hash[6]!, h = hash[7]!
    for (let i = 0; i < 64; i += 1) {
      const s1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7))
      const choice = (e & f) ^ (~e & g)
      const t1 = (h + s1 + choice + K[i]! + w[i]!) >>> 0
      const s0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10))
      const majority = (a & b) ^ (a & c) ^ (b & c)
      const t2 = (s0 + majority) >>> 0
      h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0
    }
    hash[0] = (hash[0]! + a) >>> 0; hash[1] = (hash[1]! + b) >>> 0; hash[2] = (hash[2]! + c) >>> 0; hash[3] = (hash[3]! + d) >>> 0
    hash[4] = (hash[4]! + e) >>> 0; hash[5] = (hash[5]! + f) >>> 0; hash[6] = (hash[6]! + g) >>> 0; hash[7] = (hash[7]! + h) >>> 0
  }
  return Array.from(hash, (word) => word.toString(16).padStart(8, '0')).join('')
}
