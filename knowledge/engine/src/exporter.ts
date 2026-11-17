// Exports: a zip of what the collection knows, in open formats: the redacted text of every document with its page
// map and the positions of hidden values, notes, facts, corrections and history. Never the original files, and
// never a hidden value (the texts were redacted before they were stored; the organization's own hidden words are
// left out of the settings too). Built in the alarm, stored in R2 for 7 days.

import type { ExportStatus, HiddenSpan } from './contract.ts'
import { EXPORT_FORMAT, documentEntries, layoutOf } from './exportfile.ts'
import type { CollectionEngine } from './collection.ts'
import { factFilter, publicDocument, publicFact, type StoredFact } from './collection.ts'
import { fail, json, requireId } from './http.ts'
import { SETTINGS } from './settings.ts'
import type { ExportRecord } from './types.ts'
import { clock, errorText, iso } from './util.ts'
import { R2Sink } from './r2sink.ts'
import { ZipWriter } from './zip.ts'
import * as history from './history.ts'

const README = `This file is an export of an Insulin Knowledge collection.

documents/<id>.txt   the text Knowledge learned from each file or note, with sensitive values shown as [hidden]
documents/<id>.json  the document's details, its page map ([page, start, end] in the text) and where each
                     [hidden] value starts, by kind; for a note, its id and the passages it corrects
notes.json           the notes people wrote
facts.json           the facts Knowledge found, each with the sentence it came from
corrections.json     passages marked outdated by a correction, and the note that corrects each
history.json         the restore points
collection.json      the collection's settings and counts

Original files are not part of an export: Knowledge never keeps them after reading them.
`

export async function start(e: CollectionEngine, body: { exportId?: unknown }): Promise<ExportStatus> {
  const exportId = requireId(body.exportId, 'exportId')
  const existing = await e.store.getExport(exportId)
  if (existing) return existing.status
  const meta = await e.meta()
  e.refuseWhileHeld(meta)
  const record: ExportRecord = {
    status: { exportId, state: 'queued', bytes: null, readyAt: null, expiresAt: null },
    key: `exports/${meta.org}/${meta.collectionId}/${exportId}.zip`,
    documentIds: [],
    startedAt: null,
  }
  await e.store.putExport(record)
  await e.scheduleSoon()
  return record.status
}

export async function get(e: CollectionEngine, exportId: string, download: boolean): Promise<Response> {
  const record = await e.store.getExport(exportId)
  if (!record) return fail('not_found', 'No such export.')
  if (!download || record.status.state !== 'ready') return json(record.status)
  const meta = await e.meta()
  const object = await e.env.FILES.get(record.key)
  if (!object) return fail('not_found', 'This export is no longer available.')
  return new Response(object.body, {
    headers: {
      'content-type': 'application/zip',
      'content-length': String(object.size),
      'content-disposition': `attachment; filename="${meta.collectionId}-${exportId}.zip"`,
    },
  })
}

/** Builds every queued export. Called from the alarm; needs no container. */
export async function runPending(e: CollectionEngine): Promise<void> {
  for (const record of await e.store.listExports()) {
    if (record.status.state === 'queued' || (record.status.state === 'running' && record.startedAt !== null)) await build(e, record)
  }
}

async function build(e: CollectionEngine, record: ExportRecord): Promise<void> {
  const started = clock.now()
  record.status.state = 'running'
  record.startedAt = started
  await e.store.putExport(record)
  const sink = new R2Sink(e.env.FILES, record.key)
  const zip = new ZipWriter(sink.write)
  try {
    const meta = await e.meta()
    const state = await e.currentState(meta)
    const removing = new Set(meta.removals.map((r) => r.documentId))
    const documents = state.documents.filter((d) => !removing.has(d.documentId))
    await zip.add('README.txt', README)
    const { words: _words, ...hiding } = meta.settings.hiding
    await zip.add(
      'collection.json',
      JSON.stringify(
        {
          format: EXPORT_FORMAT,
          collectionId: meta.collectionId,
          version: meta.version,
          exportedAt: iso(),
          settings: { hiding: { ...hiding, words: meta.settings.hiding.words.length }, awakeMinutes: meta.settings.awakeMinutes },
          counts: (await e.store.getPoint(meta.version))?.counts ?? null,
        },
        null,
        2,
      ),
    )
    const notes: unknown[] = []
    for (const doc of documents) {
      const object = await e.env.FILES.get(doc.textKey)
      if (!object) continue
      const stored = (await object.json()) as { text: string; pages: { page: number; start: number; end: number }[]; hidden: HiddenSpan[] }
      // Within the bounds the import holds an export to, so every export can start a collection again.
      const layout = layoutOf(stored.pages ?? [], stored.hidden ?? [])
      const outdated = state.marks.filter((m) => m.noteDocumentId === doc.documentId).map((m) => ({ documentId: m.documentId, textHash: m.textHash, needsCheck: m.needsCheck }))
      const entries = layout && documentEntries({ document: publicDocument(doc), noteId: doc.noteId, truncated: doc.truncated, ...layout, outdated }, stored.text)
      if (!entries) throw new Error(`“${doc.name}” is larger than an export can hold`)
      await zip.add(`documents/${doc.documentId}.txt`, entries.text)
      await zip.add(`documents/${doc.documentId}.json`, entries.json)
      if (doc.kind === 'note') notes.push({ documentId: doc.documentId, noteId: doc.noteId, title: doc.name, text: stored.text })
    }
    await zip.add('notes.json', JSON.stringify({ notes }, null, 2))
    let facts: unknown[] = []
    if (state.factsKey) {
      const object = await e.env.FILES.get(state.factsKey)
      if (object) {
        const usable = factFilter(state, meta)
        facts = ((await object.json()) as { facts: StoredFact[] }).facts.filter(usable).map(publicFact)
      }
    }
    await zip.add('facts.json', JSON.stringify({ facts }, null, 2))
    await zip.add(
      'corrections.json',
      JSON.stringify({ corrections: state.marks.map(({ correctionImportId: _id, ...mark }) => mark) }, null, 2),
    )
    await zip.add('history.json', JSON.stringify({ restorePoints: await history.list(e) }, null, 2))
    const bytes = await zip.finish()
    await sink.close()
    // A removal for good that arrived while the export was written: build it again without the file.
    const after = await e.meta()
    const removed = after.removals.map((r) => r.documentId)
    const stillHere = new Set((await e.currentState(after)).documents.map((d) => d.documentId))
    if (documents.some((d) => removed.includes(d.documentId) || !stillHere.has(d.documentId))) {
      await e.env.FILES.delete(record.key)
      record.status.state = 'queued'
      record.startedAt = null
      await e.store.putExport(record)
      await e.store.log('export-rebuilt', { exportId: record.status.exportId })
      return
    }
    const now = clock.now()
    record.status = { exportId: record.status.exportId, state: 'ready', bytes, readyAt: iso(now), expiresAt: iso(now + SETTINGS.exportKeepMs) }
    record.documentIds = documents.map((d) => d.documentId)
    await e.store.putExport(record)
    await e.chargeUsage(await e.usageKind(), { kind: 'export', ms: now - started })
    await e.store.log('export-ready', { exportId: record.status.exportId, bytes, documents: documents.length })
  } catch (error) {
    await sink.abort()
    record.status.state = 'failed'
    await e.store.putExport(record)
    await e.store.log('export-failed', { exportId: record.status.exportId, error: errorText(error) })
  }
}

/** Exports past their 7 days are deleted. */
export async function expire(e: CollectionEngine): Promise<void> {
  const now = iso()
  for (const record of await e.store.listExports()) {
    if (record.status.expiresAt && record.status.expiresAt <= now) {
      await e.env.FILES.delete(record.key)
      await e.state.storage.delete(`exp:${record.status.exportId}`)
    }
  }
}

/**
 * Remove for good, or stricter hiding: a stored export that holds the document is deleted (with `before`, only one
 * made before then: a later one holds its text as it is now).
 */
export async function dropContaining(e: CollectionEngine, documentId: string, before?: string): Promise<void> {
  for (const record of await e.store.listExports()) {
    if (before && record.status.readyAt && record.status.readyAt >= before) continue
    if (record.status.state === 'ready' && record.documentIds.includes(documentId)) {
      await e.env.FILES.delete(record.key)
      record.status = { ...record.status, state: 'failed', bytes: null }
      await e.store.putExport(record)
    }
  }
}
