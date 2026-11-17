// The Knowledge export's format, shared by the exporter (src/exporter.ts) and the import that starts an empty
// collection from an export (POST /v1/collections/:cid/import-export). One set of bounds holds for both: everything
// the engine stores fits them (the container cuts a text past EXPORT_LIMITS.textBytes and a page map past
// EXPORT_LIMITS.pages), the exporter writes nothing past them, and the import refuses anything past them, inflating no
// entry beyond them, so a hostile zip stays small in memory.
//
// What answers depend on comes back: each document's redacted text and page map, where its values are hidden, notes
// (their ids are in each note's own .json), which sources are stopped, and corrections with their outdated marks (in
// the correcting note's .json). notes.json and corrections.json are for people and aren't read back. Facts and
// History don't come back: the container finds facts again as it learns, and History starts afresh.

import type { DocumentInfo, HiddenSpan } from './contract.ts'
import { type ZipEntry, unzipEntry, zipEntries } from './zip.ts'
import { isSha256 } from './util.ts'

export const EXPORT_FORMAT = 2

export const EXPORT_LIMITS = {
  textBytes: 3 * 1024 * 1024, // a stored text (container/ops.py STORED_TEXT_BYTES)
  pages: 20_000, // page-map entries of a document (container/extract.py MAX_PAGES)
  // documents/<id>.json: the details, the page map ([page, start, end] each) and the hidden values' starts by kind.
  // A text of textBytes holds at most textBytes / 8 values ("[hidden]" is 8 long), each start at most 7 digits and
  // a comma: 3 MiB of starts and under 0.5 MiB of page map at the most.
  documentBytes: 4 * 1024 * 1024,
  collectionBytes: 64 * 1024, // collection.json
}

const MARK_LENGTH = '[hidden]'.length
const DOCUMENT_ID = /^[dn]_[0-9a-f]{24}$/
const HIDDEN_KINDS: HiddenSpan['kind'][] = ['email', 'phone', 'card', 'api_key', 'secret', 'word']

type Page = { page: number; start: number; end: number }

/** A document's page map and hidden values as an export holds them: compact, so the largest ones fit the bounds. */
export interface Layout {
  pages: [number, number, number][]
  hidden: Partial<Record<HiddenSpan['kind'], number[]>> // where each "[hidden]" starts, by kind
}

/** What an export's documents/<id>.json holds. */
export interface ExportedDocument {
  document: DocumentInfo
  noteId: string | null
  truncated: boolean
  pages: Layout['pages']
  hidden: Layout['hidden']
  outdated: { documentId: string; textHash: string; needsCheck: boolean; seq: number }[] // a correcting note's marks, with the correction's number in the order they were made
}

/** One document of the export. Its page map and hidden values stay in the zip (`meta`) until its text is read. */
export interface ExportDocument {
  info: Pick<DocumentInfo, 'documentId' | 'kind' | 'name' | 'type' | 'bytes' | 'pages' | 'sha256' | 'active'>
  noteId: string | null
  hiddenCount: number
  truncated: boolean
  meta: ZipEntry
  text: ZipEntry
}

export interface ExportContents {
  from: { collectionId: string; version: number }
  documents: ExportDocument[]
  marks: { documentId: string; textHash: string; noteDocumentId: string; needsCheck: boolean; seq: number }[]
}

/** What a stored text (the container's /data/text/<id>.json, kept in R2) holds. */
export interface StoredText {
  documentId: string
  kind: 'file' | 'note'
  name: string
  type: string
  text: string
  pages: Page[]
  hidden: HiddenSpan[]
  pageCount: number | null
  truncated: boolean
  note: null
}

const isInt = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0
const utf8 = new TextEncoder()

// ==================================================================== writing (the exporter)

/** A stored text's page map and hidden values in the export's form; null when they don't fit the bounds. */
export function layoutOf(pages: Page[], hidden: HiddenSpan[]): Layout | null {
  if (pages.length > EXPORT_LIMITS.pages) return null
  const out: Layout = { pages: pages.map((p) => [p.page, p.start, p.end]), hidden: {} }
  for (const span of hidden) {
    if (span.end - span.start !== MARK_LENGTH) return null
    ;(out.hidden[span.kind] ??= []).push(span.start)
  }
  return out
}

/**
 * The export's entries for one stored document, checked against the bounds the import holds them to. Null when a
 * bound is passed, which the container's own cuts don't let happen: the export then fails rather than write a zip
 * the import would refuse.
 */
export function documentEntries(doc: ExportedDocument, text: string): { text: string; json: string } | null {
  const json = JSON.stringify(doc)
  if (utf8.encode(text).length > EXPORT_LIMITS.textBytes || utf8.encode(json).length > EXPORT_LIMITS.documentBytes) return null
  return { text, json }
}

// ==================================================================== reading (the import)

async function jsonOf(entry: ZipEntry | undefined, maxBytes: number): Promise<any> {
  const bytes = entry ? await unzipEntry(entry, maxBytes) : null
  if (!bytes) throw new Error('an entry is missing, damaged or too large')
  return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes))
}

/** The most hidden values a stored text can hold: each is a "[hidden]". */
const MOST_HIDDEN = Math.floor(EXPORT_LIMITS.textBytes / MARK_LENGTH)

/**
 * Walks the hidden values in order of their starts, across kinds, checking as it goes that each start comes at least a
 * "[hidden]" after the one before (no duplicates, no overlaps, each kind's list in order). Nothing is built: `visit`
 * sees each value once. False when a check fails.
 */
function walkHidden(hidden: Record<string, number[]>, visit?: (start: number, kind: HiddenSpan['kind']) => void): boolean {
  const kinds = Object.keys(hidden) as HiddenSpan['kind'][]
  const at = kinds.map(() => 0)
  let previous = -MARK_LENGTH
  for (;;) {
    let next = -1
    for (let k = 0; k < kinds.length; k++) {
      const list = hidden[kinds[k]]
      if (at[k] < list.length && (next < 0 || list[at[k]] < hidden[kinds[next]][at[next]])) next = k
    }
    if (next < 0) return true
    const start = hidden[kinds[next]][at[next]]
    if (!isInt(start) || start < previous + MARK_LENGTH) return false
    // Within a kind, starts rise too: a later one smaller than this would have come first.
    const following = hidden[kinds[next]][at[next] + 1]
    if (following !== undefined && (!isInt(following) || following < start + MARK_LENGTH)) return false
    visit?.(start, kinds[next])
    previous = start
    at[next] += 1
  }
}

/**
 * A page map and hidden values read back, checked before anything is built from them (their number first, then
 * their order); null when they aren't well formed or pass the bounds. `build: false` only checks and counts.
 */
function readLayout(meta: any, build = true): { pages: Page[]; hidden: HiddenSpan[]; count: number } | null {
  const pages = meta?.pages
  const hidden = meta?.hidden
  if (!Array.isArray(pages) || pages.length > EXPORT_LIMITS.pages) return null
  if (!pages.every((p: unknown) => Array.isArray(p) && p.length === 3 && p.every(isInt) && p[1] <= p[2])) return null
  if (typeof hidden !== 'object' || hidden === null || Array.isArray(hidden)) return null
  let count = 0
  for (const [kind, starts] of Object.entries(hidden)) {
    if (!HIDDEN_KINDS.includes(kind as HiddenSpan['kind']) || !Array.isArray(starts)) return null
    count += starts.length
  }
  if (count > MOST_HIDDEN) return null
  const spans: HiddenSpan[] = []
  const ok = walkHidden(hidden as Record<string, number[]>, build ? (start, kind) => spans.push({ start, end: start + MARK_LENGTH, kind }) : undefined)
  if (!ok) return null
  return { pages: build ? pages.map(([page, start, end]: number[]) => ({ page, start, end })) : [], hidden: spans, count }
}

/**
 * The export's contents, the documents' texts left in the zip until each is needed. Null when the bytes aren't a
 * Knowledge export this engine wrote (or one it can read).
 */
export async function openExport(bytes: Uint8Array): Promise<ExportContents | null> {
  const entries = zipEntries(bytes)
  if (!entries || !entries.has('README.txt') || !entries.has('collection.json')) return null
  try {
    const collection = await jsonOf(entries.get('collection.json'), EXPORT_LIMITS.collectionBytes)
    if (collection?.format !== EXPORT_FORMAT || typeof collection.collectionId !== 'string' || !isInt(collection.version)) return null
    const documents: ExportDocument[] = []
    const outdated: ExportContents['marks'] = []
    for (const name of entries.keys()) {
      if (!name.startsWith('documents/')) continue
      const match = /^documents\/(.+)\.(json|txt)$/.exec(name)
      if (!match || !DOCUMENT_ID.test(match[1]) || !entries.has(`documents/${match[1]}.json`) || !entries.has(`documents/${match[1]}.txt`)) return null
      if (match[2] === 'txt') continue
      const documentId = match[1]
      const metaEntry = entries.get(name)!
      const meta = await jsonOf(metaEntry, EXPORT_LIMITS.documentBytes)
      const info = meta?.document
      if (info?.documentId !== documentId || (info.kind !== 'file' && info.kind !== 'note')) return null
      if (documentId[0] !== (info.kind === 'file' ? 'd' : 'n')) return null
      if (typeof info.name !== 'string' || typeof info.type !== 'string' || typeof info.active !== 'boolean') return null
      if (!isInt(info.bytes) || !(info.pages === null || isInt(info.pages))) return null
      // A file's checksum finds the same content when it is added again; a note has none.
      if (info.kind === 'file' ? !isSha256(info.sha256) : !(info.sha256 === '' || isSha256(info.sha256))) return null
      const layout = readLayout(meta, false)
      if (!layout) return null
      const noteId = info.kind === 'note' ? meta.noteId : null
      if (info.kind === 'note' && (typeof noteId !== 'string' || !noteId)) return null
      const marks = meta.outdated ?? []
      if (!Array.isArray(marks) || (marks.length && info.kind !== 'note')) return null
      for (const mark of marks) {
        if (typeof mark?.documentId !== 'string' || !isSha256(mark.textHash) || !isInt(mark.seq ?? 0)) return null
        outdated.push({ documentId: mark.documentId, textHash: mark.textHash, noteDocumentId: documentId, needsCheck: mark.needsCheck === true, seq: mark.seq ?? 0 })
      }
      documents.push({
        info: { documentId, kind: info.kind, name: info.name, type: info.type, bytes: info.bytes, pages: info.pages, sha256: info.sha256, active: info.active },
        noteId,
        hiddenCount: layout.count,
        truncated: meta.truncated === true,
        meta: metaEntry,
        text: entries.get(`documents/${documentId}.txt`)!,
      })
    }
    // A mark is on a passage of a document of the export; one passage has one correction.
    const here = new Set(documents.map((d) => d.info.documentId))
    const marks: ExportContents['marks'] = []
    for (const mark of outdated) {
      if (!here.has(mark.documentId)) return null
      if (marks.some((m) => m.documentId === mark.documentId && m.textHash === mark.textHash)) return null
      marks.push(mark)
    }
    documents.sort((a, b) => (a.info.documentId < b.info.documentId ? -1 : 1))
    return { from: { collectionId: collection.collectionId, version: collection.version }, documents, marks }
  } catch {
    return null
  }
}

/** One document's text as stored, read from the zip and checked against its page map and hidden values. */
export async function storedText(doc: ExportDocument): Promise<StoredText | null> {
  const metaBytes = await unzipEntry(doc.meta, EXPORT_LIMITS.documentBytes)
  const bytes = await unzipEntry(doc.text, EXPORT_LIMITS.textBytes)
  if (!metaBytes || !bytes) return null
  let text: string
  let layout: ReturnType<typeof readLayout>
  try {
    const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false })
    text = decoder.decode(bytes)
    layout = readLayout(JSON.parse(decoder.decode(metaBytes)))
  } catch {
    return null
  }
  // Offsets count UTF-16 code units, as JavaScript strings do; each hidden value is a "[hidden]" in the text.
  if (!layout || layout.pages.some((p) => p.end > text.length) || layout.hidden.some((h) => text.slice(h.start, h.end) !== '[hidden]')) return null
  const { documentId, kind, name, type, pages } = doc.info
  return { documentId, kind, name, type, text, pages: layout.pages, hidden: layout.hidden, pageCount: pages, truncated: doc.truncated, note: null }
}
