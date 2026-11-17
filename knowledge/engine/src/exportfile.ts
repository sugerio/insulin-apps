// Reading a Knowledge export (the zip src/exporter.ts writes) to start an empty collection from it
// (POST /v1/collections/:cid/import-export). What answers depend on comes back: each document's redacted text and
// page map, notes, which sources are stopped, and corrections with their outdated marks. Facts and History don't:
// the container finds facts again as it learns, and History starts afresh.

import type { DocumentInfo, HiddenSpan } from './contract.ts'
import { type ZipEntry, unzipEntry, zipEntries } from './zip.ts'
import { isSha256 } from './util.ts'

const DOCUMENT_ID = /^[dn]_[0-9a-f]{24}$/
// What one entry may inflate to. The engine reads 2 MiB of text from a file, and hiding can lengthen it a little;
// with the zip itself (at most 32 MiB, SETTINGS.maxExportImportBytes) and one entry at a time, a collection's
// Durable Object stays well inside its isolate's 128 MB.
const METADATA_BYTES = 4 * 1024 * 1024 // a document's .json (page map, hidden spans), notes.json, corrections.json
const TEXT_BYTES = 3 * 1024 * 1024 // one document's redacted text
const HIDDEN_KINDS = new Set(['email', 'phone', 'card', 'api_key', 'secret', 'word'])

/** One document of the export. Its page map and hidden spans stay in the zip (`meta`) until its text is read. */
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
  marks: { documentId: string; textHash: string; noteDocumentId: string; needsCheck: boolean }[]
}

/** What a stored text (the container's /data/text/<id>.json, kept in R2) holds. */
export interface StoredText {
  documentId: string
  kind: 'file' | 'note'
  name: string
  type: string
  text: string
  pages: { page: number; start: number; end: number }[]
  hidden: HiddenSpan[]
  pageCount: number | null
  truncated: boolean
  note: null
}

const isInt = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0

async function jsonOf(entries: Map<string, ZipEntry>, name: string): Promise<any> {
  const entry = entries.get(name)
  const bytes = entry ? await unzipEntry(entry, METADATA_BYTES) : null
  if (!bytes) throw new Error(`${name} is missing or damaged`)
  return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes))
}

/**
 * The export's contents, the documents' texts left in the zip until each is needed. Null when the bytes aren't a
 * Knowledge export (or one this engine can read).
 */
export async function openExport(bytes: Uint8Array): Promise<ExportContents | null> {
  const entries = zipEntries(bytes)
  if (!entries || !entries.has('README.txt') || !entries.has('collection.json')) return null
  try {
    const collection = await jsonOf(entries, 'collection.json')
    if (typeof collection?.collectionId !== 'string' || !isInt(collection.version)) return null
    const notes = (await jsonOf(entries, 'notes.json'))?.notes
    const corrections = (await jsonOf(entries, 'corrections.json'))?.corrections
    if (!Array.isArray(notes) || !Array.isArray(corrections)) return null
    const noteIds = new Map<string, string>()
    for (const note of notes) {
      if (typeof note?.documentId !== 'string' || typeof note.noteId !== 'string' || !note.noteId) return null
      noteIds.set(note.documentId, note.noteId)
    }
    const documents: ExportDocument[] = []
    for (const name of entries.keys()) {
      if (!name.startsWith('documents/')) continue
      const match = /^documents\/(.+)\.(json|txt)$/.exec(name)
      if (!match || !DOCUMENT_ID.test(match[1]) || !entries.has(`documents/${match[1]}.json`) || !entries.has(`documents/${match[1]}.txt`)) return null
      if (match[2] === 'txt') continue
      const documentId = match[1]
      const metaEntry = entries.get(name)!
      const meta = await jsonOf(entries, name)
      const info = meta?.document
      if (info?.documentId !== documentId || (info.kind !== 'file' && info.kind !== 'note')) return null
      if (documentId[0] !== (info.kind === 'file' ? 'd' : 'n')) return null
      if (typeof info.name !== 'string' || typeof info.type !== 'string' || typeof info.active !== 'boolean') return null
      if (!isInt(info.bytes) || !(info.pages === null || isInt(info.pages))) return null
      // A file's checksum finds the same content when it is added again; a note has none.
      if (info.kind === 'file' ? !isSha256(info.sha256) : !(info.sha256 === '' || isSha256(info.sha256))) return null
      const spans = layout(meta)
      if (!spans) return null
      const noteId = info.kind === 'note' ? (noteIds.get(documentId) ?? null) : null
      if (info.kind === 'note' && !noteId) return null
      documents.push({
        info: { documentId, kind: info.kind, name: info.name, type: info.type, bytes: info.bytes, pages: info.pages, sha256: info.sha256, active: info.active },
        noteId,
        hiddenCount: spans.hidden.length,
        truncated: meta.truncated === true,
        meta: metaEntry,
        text: entries.get(`documents/${documentId}.txt`)!,
      })
    }
    const kinds = new Map(documents.map((d) => [d.info.documentId, d.info.kind]))
    const marks: ExportContents['marks'] = []
    for (const mark of corrections) {
      if (typeof mark?.documentId !== 'string' || !isSha256(mark.textHash) || typeof mark.noteDocumentId !== 'string') return null
      // A mark is on a passage of a document of the export, and comes from one of its notes.
      if (!kinds.has(mark.documentId) || kinds.get(mark.noteDocumentId) !== 'note') return null
      if (marks.some((m) => m.documentId === mark.documentId && m.textHash === mark.textHash)) continue
      marks.push({ documentId: mark.documentId, textHash: mark.textHash, noteDocumentId: mark.noteDocumentId, needsCheck: mark.needsCheck === true })
    }
    documents.sort((a, b) => (a.info.documentId < b.info.documentId ? -1 : 1))
    return { from: { collectionId: collection.collectionId, version: collection.version }, documents, marks }
  } catch {
    return null
  }
}

/** A document's page map and hidden spans from its .json, checked; null when they aren't well formed. */
function layout(meta: any): { pages: StoredText['pages']; hidden: HiddenSpan[] } | null {
  const pages = meta?.pages ?? []
  const hidden = meta?.hidden ?? []
  if (!Array.isArray(pages) || !pages.every((p: any) => isInt(p?.page) && isInt(p.start) && isInt(p.end) && p.start <= p.end)) return null
  if (!Array.isArray(hidden) || !hidden.every((h: any) => isInt(h?.start) && isInt(h.end) && h.start <= h.end && HIDDEN_KINDS.has(h.kind))) return null
  return {
    pages: pages.map((p: any) => ({ page: p.page, start: p.start, end: p.end })),
    hidden: hidden.map((h: any) => ({ start: h.start, end: h.end, kind: h.kind })),
  }
}

/** One document's text as stored, read from the zip and checked against its page map and hidden spans. */
export async function storedText(doc: ExportDocument): Promise<StoredText | null> {
  const metaBytes = await unzipEntry(doc.meta, METADATA_BYTES)
  const bytes = await unzipEntry(doc.text, TEXT_BYTES)
  if (!metaBytes || !bytes) return null
  let text: string
  let spans: ReturnType<typeof layout>
  try {
    const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false })
    text = decoder.decode(bytes)
    spans = layout(JSON.parse(decoder.decode(metaBytes)))
  } catch {
    return null
  }
  // Offsets count UTF-16 code units, as JavaScript strings do.
  if (!spans || spans.pages.some((p) => p.end > text.length) || spans.hidden.some((h) => h.end > text.length)) return null
  const { documentId, kind, name, type, pages } = doc.info
  return { documentId, kind, name, type, text, pages: spans.pages, hidden: spans.hidden, pageCount: pages, truncated: doc.truncated, note: null }
}
