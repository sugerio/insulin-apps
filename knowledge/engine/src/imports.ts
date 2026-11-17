// Imports: staging files, the per-collection queue, the capacity guard, one container job per import, the
// all-or-nothing commit and three tries. Also the other changes that make a restore point: stop using / use again,
// corrections, remove for good, and reading old files again under stricter hiding rules.

import type {
  ChangeCounts,
  DocRecord,
  ImportKind,
  ImportRecord,
  Manifest,
  Meta,
  OutdatedMark,
  PendingEvent,
  RestorePointRecord,
  Runtime,
  AnswerState,
  SnapshotHandle,
  SnapshotRecord,
  StagedFile,
} from './types.ts'
import type { CollectionCounts, HidingRules, ImportFile, ImportFileStatus, ImportNote, ImportStatus, RemoveResult } from './contract.ts'
import type { CollectionEngine } from './collection.ts'
import { EMPTY_STATE, isHeld, OnHold } from './collection.ts'
import { CAPACITY_NAME, callObject } from './env.ts'
import { EngineFailure, fail, failWithStatus, requireId } from './http.ts'
import { SETTINGS, instances } from './settings.ts'
import type { SlotAnswer } from './capacity.ts'
import { clock, documentIdFor, errorText, iso, isSha256, plural, randomId } from './util.ts'
import * as backup from './backup.ts'
import * as exporter from './exporter.ts'
import { Sha256 } from './sha256.ts'
import { R2Sink } from './r2sink.ts'
import { type ExportContents, openExport, storedText } from './exportfile.ts'

export const inboxKey = (meta: Meta, fileId: string) => `inbox/${meta.org}/${meta.collectionId}/${fileId}`
export const textKey = (meta: Meta, documentId: string) => `text/${meta.org}/${meta.collectionId}/docs/${documentId}.json`
export const factsKey = (meta: Meta, importId: string) => `text/${meta.org}/${meta.collectionId}/facts/${importId}.json`

/** A try that failed: the container is discarded. `permanent` failures (a scanned PDF) aren't tried again. */
export class AttemptFailure extends Error {
  failedFileId: string | null
  permanent: boolean
  code: 'unsupported_type' | 'too_large' | 'bad_request' | 'internal'
  constructor(message: string, failedFileId: string | null = null, permanent = false, code: AttemptFailure['code'] = 'internal') {
    super(message)
    this.failedFileId = failedFileId
    this.permanent = permanent
    this.code = code
  }
}

/** The import must wait (a repair or a wake from the backup comes first); nothing failed. */
class Deferred extends Error {}

// ==================================================================== staging and submitting

export async function stage(e: CollectionEngine, fileId: string, request: Request): Promise<{ fileId: string; bytes: number; sha256: string }> {
  const meta = await e.meta()
  // The SHA-256 is checked when the app sends it, and worked out here when it streams a file it hasn't hashed.
  const declaredSha = request.headers.get('x-file-sha256')?.trim().toLowerCase() || null
  if (declaredSha !== null && !isSha256(declaredSha)) return fail('bad_request', 'x-file-sha256 must be the SHA-256 of the file, in hex.')
  let name: string
  try {
    name = decodeURIComponent(request.headers.get('x-file-name') ?? '')
  } catch {
    return fail('bad_request', 'x-file-name must be URI-encoded.')
  }
  if (!name || name.length > 255) return fail('bad_request', 'x-file-name must name the file (up to 255 characters).')
  const type = (request.headers.get('content-type') ?? 'application/octet-stream').split(';')[0].trim().toLowerCase()
  const declared = Number(request.headers.get('content-length') ?? NaN)
  const tooLarge = `Files can be at most ${SETTINGS.maxFileBytes / 1024 / 1024} MB.`
  if (declared > SETTINGS.maxFileBytes) return fail('too_large', tooLarge)
  // Streamed to R2 in parts and hashed on the way, so no more than a part is held in memory.
  const sink = new R2Sink(e.env.FILES, inboxKey(meta, fileId), SETTINGS.uploadPartBytes, {
    httpMetadata: { contentType: type },
    customMetadata: { name: encodeURIComponent(name) },
  })
  const hash = new Sha256()
  const reader = request.body?.getReader()
  try {
    for (;;) {
      const chunk = reader ? await reader.read() : { done: true as const, value: undefined }
      if (chunk.done) break
      hash.update(chunk.value)
      if (hash.length > SETTINGS.maxFileBytes) {
        await reader?.cancel()
        await sink.abort()
        return fail('too_large', tooLarge)
      }
      await sink.write(chunk.value)
    }
  } catch (error) {
    await sink.abort()
    throw error
  }
  const bytes = hash.length
  const sha256 = hash.hex()
  if (declaredSha !== null && declaredSha !== sha256) {
    await sink.abort()
    return fail('bad_request', "The file's content doesn't match x-file-sha256.")
  }
  await sink.close(sha256)
  // The upload took time: if the collection was deleted meanwhile, nothing of it may stay.
  const now = await e.store.getMeta()
  if (!now || now.deleting) {
    await e.env.FILES.delete(inboxKey(meta, fileId))
    return fail('deleting', 'This collection was deleted.')
  }
  const staged: StagedFile = { fileId, name, type, bytes, sha256, stagedAt: iso() }
  await e.store.putStaged(staged)
  await e.scheduleSoon(stagedExpiry(staged)) // cleared after a day if no import names it
  return { fileId, bytes, sha256 }
}

/** Keeps staged files for an import that waits (the documents-learned limit resets on the 1st), up to 45 days. */
export async function keepStaged(e: CollectionEngine, body: { fileIds?: unknown; until?: unknown }): Promise<{ kept: string[] }> {
  if (!Array.isArray(body.fileIds) || body.fileIds.length > 1000) return fail('bad_request', 'fileIds must be a list of at most 1000 file ids.')
  const fileIds = body.fileIds.map((id) => requireId(id, 'Each file id'))
  const until = typeof body.until === 'string' ? Date.parse(body.until) : NaN
  if (!Number.isFinite(until)) return fail('bad_request', 'until must be a date and time, such as 2026-12-01T00:00:00Z.')
  if (until > clock.now() + SETTINGS.maxKeepStagedMs) return fail('bad_request', 'Staged files can be kept at most 45 days.')
  const kept: string[] = []
  for (const fileId of fileIds) {
    const staged = await e.store.getStaged(fileId)
    if (!staged) continue
    if (!staged.keepUntil || Date.parse(staged.keepUntil) < until) {
      staged.keepUntil = iso(until)
      await e.store.putStaged(staged)
    }
    kept.push(fileId)
  }
  await e.scheduleSoon()
  return { kept }
}

/** When an unimported staged file is deleted: a day after it was staged, or the date it is kept until. */
export function stagedExpiry(staged: StagedFile): number {
  return Math.max(Date.parse(staged.stagedAt) + SETTINGS.stagedKeepMs, staged.keepUntil ? Date.parse(staged.keepUntil) : 0)
}

interface ImportBody {
  importId?: unknown
  files?: unknown
  notes?: unknown
  small?: unknown
  note?: unknown
}

export function submit(e: CollectionEngine, body: ImportBody): Promise<{ status: number; record: ImportRecord }> {
  return sameIdFirst(e, body.importId, () => submitOnce(e, body))
}

async function submitOnce(e: CollectionEngine, body: ImportBody): Promise<{ status: number; record: ImportRecord }> {
  const importId = requireId(body.importId, 'importId')
  const existing = await e.store.getImport(importId)
  if (existing) return { status: 200, record: existing }
  if (await e.state.storage.get(tombstoneKey(importId))) return claim(e, cancelledSubmission(importId, 'import', body.files))
  const files = parseFiles(body.files)
  const notes = parseNotes(body.notes)
  if (!files.length && !notes.length) return fail('bad_request', 'An import needs at least one file or note.')
  const small = body.small === true
  const kind: ImportKind = notes.some((n) => n.outdated.length) && !files.length ? 'correction' : 'import'
  return create(e, importId, kind, small || (!files.length && notes.length > 0), files, notes)
}

/** A correction: a small import of a note, with the passages it corrects marked outdated. */
export function submitCorrection(e: CollectionEngine, body: ImportBody): Promise<{ status: number; record: ImportRecord }> {
  return sameIdFirst(e, body.importId, () => submitCorrectionOnce(e, body))
}

async function submitCorrectionOnce(e: CollectionEngine, body: ImportBody): Promise<{ status: number; record: ImportRecord }> {
  const importId = requireId(body.importId, 'importId')
  const existing = await e.store.getImport(importId)
  if (existing) return { status: 200, record: existing }
  if (await e.state.storage.get(tombstoneKey(importId))) return claim(e, cancelledSubmission(importId, 'correction', undefined))
  const notes = parseNotes(body.notes ?? (body.note ? [body.note] : undefined))
  if (!notes.length) return fail('bad_request', 'A correction needs a note.')
  const state = await e.currentState()
  for (const ref of notes.flatMap((n) => n.outdated)) {
    if (!state.documents.some((d) => d.documentId === ref.documentId)) return fail('bad_request', 'A corrected passage names a document this collection does not have.')
  }
  return create(e, importId, 'correction', true, [], notes)
}

async function create(
  e: CollectionEngine,
  importId: string,
  kind: ImportKind,
  small: boolean,
  files: ImportFile[],
  notes: ImportNote[],
): Promise<{ status: number; record: ImportRecord }> {
  const meta = await e.meta()
  for (const file of files) {
    const staged = await e.store.getStaged(file.fileId)
    if (!staged) return fail('bad_request', `“${file.name}” was not staged; upload it to the inbox first.`)
    if (staged.sha256 !== file.sha256) return fail('bad_request', `“${file.name}” doesn't match the file staged under its id.`)
    file.bytes = staged.bytes
  }
  const state = await e.currentState(meta)
  const removing = new Set(meta.removals.map((r) => r.documentId))
  const bySha = new Map(state.documents.filter((d) => d.kind === 'file' && !removing.has(d.documentId)).map((d) => [d.sha256, d.documentId]))
  const notesHere = new Set(state.documents.map((d) => d.noteId).filter(Boolean))

  const recordFiles: ImportRecord['files'] = []
  for (const file of files) {
    const duplicateOf = bySha.get(file.sha256) ?? null
    const documentId = duplicateOf ?? (await documentIdFor('file', importId, file.fileId))
    if (!duplicateOf) bySha.set(file.sha256, documentId) // the same content twice in one import is learned once
    recordFiles.push({ ...file, documentId, duplicateOf: duplicateOf ?? (recordFiles.some((f) => f.documentId === documentId) ? documentId : null) })
  }
  const recordNotes: ImportRecord['notes'] = []
  for (const note of notes) {
    if (notesHere.has(note.noteId) && !note.outdated.length) continue
    recordNotes.push({ ...note, documentId: await documentIdFor('note', importId, note.noteId) })
  }

  const test = (await e.state.storage.get<ImportRecord['test']>('testNextImport')) ?? null
  if (test) await e.state.storage.delete('testNextImport')
  const record: ImportRecord = {
    status: {
      importId,
      state: 'queued',
      attempt: 1,
      queuePosition: null,
      waitingFor: null,
      files: recordFiles.map((f) => fileStatus(f)),
      notes: recordNotes.length,
      version: null,
      newFacts: null,
      failedFileId: null,
      error: null,
      etaSeconds: null,
      createdAt: iso(),
      finishedAt: null,
    },
    kind,
    small,
    phase: 'queued',
    files: recordFiles,
    notes: recordNotes,
    hiding: meta.settings.hiding,
    jobId: null,
    capacity: 'none',
    reserveVersion: null,
    removeDocumentIds: [],
    rereadDocumentIds: [],
    snapshotTaken: false,
    learningStartedAt: null,
    retryAt: null,
    jobStartedAt: null,
    textsSaved: false,
    rebuild: false,
    restoreFrom: null,
    result: null,
    test,
  }

  // Everything was already here: nothing changes and no restore point is made.
  if (!recordFiles.some((f) => !f.duplicateOf) && !recordNotes.length) {
    record.status.state = 'duplicate'
    record.status.finishedAt = iso()
    record.phase = 'done'
  }
  return claim(e, record)
}

// ==================================================================== claiming an import id, and cancelling

/**
 * "The same id answers the existing import" comes before anything else a submission finds wrong: one that gave up
 * after an await (its staged zip learned and deleted meanwhile, say) answers the import another submission with the
 * id made, or `cancelled` when the id was cancelled.
 */
async function sameIdFirst(
  e: CollectionEngine,
  importId: unknown,
  submission: () => Promise<{ status: number; record: ImportRecord }>,
): Promise<{ status: number; record: ImportRecord }> {
  try {
    return await submission()
  } catch (error) {
    if (typeof importId !== 'string' || !(error instanceof EngineFailure)) throw error
    const existing = await e.store.getImport(importId)
    if (existing) return { status: 200, record: existing }
    if (await e.state.storage.get(tombstoneKey(importId))) return claim(e, cancelledSubmission(importId, 'import', undefined))
    throw error
  }
}

interface Tombstone {
  at: string // when the id was cancelled before the engine saw it
}

const tombstoneKey = (importId: string) => `cancelled:${importId}`

/** A submission of an id that was cancelled first: what it answers, and the staged files it named go. */
function cancelledSubmission(importId: string, kind: ImportKind, files: unknown): ImportRecord {
  const record = baseRecord(importId, kind, cancelledStatus(importId, iso()))
  const named = Array.isArray(files) ? files.filter((f) => typeof f?.fileId === 'string').map((f) => String(f.fileId)) : []
  record.files = named.map((fileId) => ({ fileId, name: '', type: '', bytes: 0, sha256: '', documentId: '', duplicateOf: null }))
  return record
}

function cancelledStatus(importId: string, at: string): ImportStatus {
  return {
    importId,
    state: 'cancelled',
    attempt: 1,
    queuePosition: null,
    waitingFor: null,
    files: [],
    notes: 0,
    version: null,
    newFacts: null,
    failedFileId: null,
    error: null,
    etaSeconds: null,
    createdAt: at,
    finishedAt: at,
  }
}

/**
 * The last step of every submission (imports, corrections, import-export), after all its reads: in one storage
 * transaction, an import another submission already made under the id wins (its record is the answer), a cancel of
 * the id wins (the submission answers `cancelled` and learns nothing), and otherwise the record and its place in the
 * queue are written together. No request can come between the check and the claim.
 */
async function claim(e: CollectionEngine, record: ImportRecord): Promise<{ status: number; record: ImportRecord }> {
  const importId = record.status.importId
  const outcome = await e.state.storage.transaction(async (txn) => {
    const existing = await e.store.getImport(importId, txn)
    if (existing) return { won: 'other' as const, record: existing }
    if (record.status.state === 'cancelled' || (await txn.get<Tombstone>(tombstoneKey(importId)))) {
      const cancelled: ImportRecord = {
        ...record,
        phase: 'done',
        notes: scrubbed(record.notes),
        status: { ...record.status, state: 'cancelled', queuePosition: null, waitingFor: null, etaSeconds: null, finishedAt: iso() },
      }
      await e.store.putImport(cancelled, txn)
      await txn.delete(tombstoneKey(importId))
      return { won: 'cancel' as const, record: cancelled }
    }
    await e.store.putImport(record, txn)
    if (record.phase === 'queued') {
      const meta = (await txn.get<Meta>('meta'))!
      meta.queue = await placed(e, meta.queue, importId, rankOf(record), txn)
      await txn.put('meta', meta)
    }
    return { won: 'this' as const, record }
  })
  if (outcome.won === 'other') return { status: 200, record: outcome.record }
  const files = record.files.map((f) => f.fileId)
  if (outcome.won === 'cancel') {
    await deleteOriginals(e, files)
    await e.event(`import:${importId}:cancelled`, { type: 'import', import: outcome.record.status })
    await e.store.log('import-cancelled', { importId, when: 'submitted after its cancel' })
    await e.scheduleSoon() // the event goes out from the alarm
    return { status: 200, record: outcome.record }
  }
  if (record.phase === 'done') {
    await deleteOriginals(e, files)
    await e.event(`import:${importId}:duplicate`, { type: 'import', import: record.status })
    await e.store.log('import-duplicate', { importId, files: files.length })
    return { status: 202, record }
  }
  await e.store.log('import-queued', { importId, kind: record.kind, small: record.small, files: record.files.length, notes: record.notes.length })
  await e.state.storage.setAlarm(clock.now())
  return { status: 202, record }
}

/**
 * DELETE .../imports/:importId: a queued import that hasn't started learning is cancelled; an id the engine has no
 * import with is remembered as cancelled (SETTINGS.cancelledKeepMs), so a submission with it still in flight learns
 * nothing. One that started or finished answers 409 busy_learning. The check and the change are one transaction.
 */
export async function cancel(e: CollectionEngine, importId: string): Promise<ImportRecord> {
  const outcome = await e.state.storage.transaction(async (txn) => {
    const record = await e.store.getImport(importId, txn)
    if (!record) {
      const at = iso()
      await txn.put(tombstoneKey(importId), { at } satisfies Tombstone)
      return { done: 'remembered' as const, record: baseRecord(importId, 'import', cancelledStatus(importId, at)) }
    }
    if (record.status.state === 'cancelled') return { done: 'already' as const, record }
    const meta = (await txn.get<Meta>('meta'))!
    const cancellable = ['import', 'correction', 'export'].includes(record.kind) && record.phase === 'queued' && meta.active !== importId
    if (!cancellable) return { done: 'busy' as const, record }
    record.phase = 'done'
    record.capacity = 'none'
    record.notes = scrubbed(record.notes)
    record.status = { ...record.status, state: 'cancelled', queuePosition: null, waitingFor: null, etaSeconds: null, finishedAt: iso() }
    await e.store.putImport(record, txn)
    meta.queue = meta.queue.filter((id) => id !== importId)
    await txn.put('meta', meta)
    return { done: 'cancelled' as const, record }
  })
  if (outcome.done === 'busy') {
    const finished = outcome.record.phase === 'done'
    return fail('busy_learning', finished ? 'This import is finished; it can no longer be cancelled.' : 'This import is being learned; it can no longer be cancelled.')
  }
  if (outcome.done === 'cancelled') {
    const record = outcome.record
    // Always: the guard may hold a slot or a place in its waiting list for it whatever the record says (an answer to
    // the alarm's /acquire can be lost on its way back). The guard ignores a release of what it doesn't hold.
    await giveBack(e, record)
    await deleteOriginals(e, record.files.map((f) => f.fileId))
    if (record.textsSaved) {
      // Texts saved by an earlier try (stopped for a removal or a hold) that will never be learned.
      const meta = await e.meta()
      await deleteLater(e, [...record.files.filter((f) => !f.duplicateOf && f.documentId), ...record.notes].map((d) => textKey(meta, d.documentId)))
    }
    await e.event(`import:${importId}:cancelled`, { type: 'import', import: record.status })
    await e.store.log('import-cancelled', { importId, when: 'queued' })
    await e.scheduleSoon() // the event goes out from the alarm
  }
  if (outcome.done === 'remembered') await e.store.log('import-cancelled', { importId, when: 'before it was sent' })
  return outcome.record
}

const RETURNS_KEY = 'capacityReturns'

/**
 * Gives back what the capacity guard holds for an import that ended, was cancelled or stopped (its slot, or its place
 * in the guard's waiting list). When the guard can't be told now, the id is kept and told again from the alarm
 * (returnCapacity), so a slot never stays taken for an import that doesn't use it until its lease lapses.
 */
async function giveBack(e: CollectionEngine, record: Pick<ImportRecord, 'status' | 'small'>): Promise<void> {
  if (await e.releaseCapacity(record)) return
  await oweReturn(e, record.status.importId)
}

async function oweReturn(e: CollectionEngine, importId: string): Promise<void> {
  const owed = (await e.state.storage.get<string[]>(RETURNS_KEY)) ?? []
  if (!owed.includes(importId)) await e.state.storage.put(RETURNS_KEY, [...owed, importId])
}

/**
 * From the alarm: the guard is told again to give back what it holds for imports whose release didn't reach it, or
 * whose /acquire answer was lost. An id is settled only when the guard confirms, or when the import runs here with the
 * slot it was granted (it renews it and gives it back when it ends). One still queued that asks the guard again soon
 * (not held, or a removal for good, and not waiting to be tried again later) keeps its id and takes what the guard
 * holds for it when it asks; a held one can't ask, so the guard is told again on every alarm until it has.
 */
export async function returnCapacity(e: CollectionEngine): Promise<void> {
  const owed = (await e.state.storage.get<string[]>(RETURNS_KEY)) ?? []
  if (!owed.length) return
  const meta = await e.meta()
  const settled: string[] = []
  for (const importId of owed) {
    const record = await e.store.getImport(importId)
    const asksAgain = !!record && meta.queue.includes(importId) && (record.kind === 'remove' || !isHeld(meta)) && !(record.retryAt && record.retryAt > clock.now())
    if (meta.active === importId && record?.capacity === 'granted') settled.push(importId)
    else if (asksAgain) continue
    else if (await e.releaseCapacity({ status: { importId } as ImportStatus, small: false })) settled.push(importId)
  }
  // Ids added while the guard was being told stay owed.
  const left = ((await e.state.storage.get<string[]>(RETURNS_KEY)) ?? []).filter((id) => !settled.includes(id))
  if (left.length) await e.state.storage.put(RETURNS_KEY, left)
  else await e.state.storage.delete(RETURNS_KEY)
}

/**
 * While held: an import waiting in the guard's list gives up its place, so the guard never grants it a slot it can't
 * use (a removal for good keeps its place: it still runs). It asks again when the hold ends; a release the guard
 * doesn't confirm is told again from the alarm until it has.
 */
export async function leaveGuardWhileHeld(e: CollectionEngine): Promise<void> {
  for (const id of (await e.meta()).queue) {
    const record = await e.store.getImport(id)
    if (!record || record.kind === 'remove' || record.capacity !== 'waiting') continue
    await giveBack(e, record)
    // Read again: a cancel may have won while the guard answered.
    await e.state.storage.transaction(async (txn) => {
      const current = await e.store.getImport(id, txn)
      if (!current || current.capacity !== 'waiting') return
      current.capacity = 'none'
      current.status.waitingFor = null
      current.status.queuePosition = null
      await e.store.putImport(current, txn)
    })
  }
}

/** Whether the guard is still owed a release (the alarm then comes back soon). */
export async function owesCapacity(e: CollectionEngine): Promise<boolean> {
  return ((await e.state.storage.get<string[]>(RETURNS_KEY)) ?? []).length > 0
}

/** Cancelled ids are remembered for SETTINGS.cancelledKeepMs: no send stays in flight that long. */
export async function forgetCancelled(e: CollectionEngine): Promise<void> {
  const cutoff = clock.now() - SETTINGS.cancelledKeepMs
  const old = [...(await e.state.storage.list<Tombstone>({ prefix: 'cancelled:' })).entries()].filter(([, t]) => Date.parse(t.at) < cutoff).map(([key]) => key)
  if (old.length) await e.state.storage.delete(old)
}

/** A cancelled id the engine never had an import for (GET answers it as cancelled). */
export async function cancelledId(e: CollectionEngine, importId: string): Promise<ImportRecord | null> {
  const tombstone = await e.state.storage.get<Tombstone>(tombstoneKey(importId))
  return tombstone ? baseRecord(importId, 'import', cancelledStatus(importId, tombstone.at)) : null
}

/** Every file waiting again (a new try, or a stop). An export's import lists its documents, not its zip. */
function waitingFiles(record: ImportRecord): ImportFileStatus[] {
  if (record.kind !== 'export') return record.files.map((f) => fileStatus(f))
  return record.status.files.map((f) => ({ fileId: f.fileId, name: f.name, state: 'waiting', ...(f.documentId ? { documentId: f.documentId } : {}) }))
}

function fileStatus(f: ImportRecord['files'][number]): ImportFileStatus {
  if (f.duplicateOf) return { fileId: f.fileId, name: f.name, state: 'already_here', reason: 'The same content is already in this collection.', documentId: f.duplicateOf }
  // An export's zip is not a document of its own.
  return f.documentId ? { fileId: f.fileId, name: f.name, state: 'waiting', documentId: f.documentId } : { fileId: f.fileId, name: f.name, state: 'waiting' }
}

// ==================================================================== starting from an export

/**
 * POST .../import-export: an empty collection starts from a Knowledge export staged in its inbox. The zip is checked
 * now (409 `bad_request` when it isn't an export, or the collection isn't empty) and learned like any import: its
 * texts are hidden again with this collection's rules, and one restore point holds the documents, which of them are
 * stopped, the notes and the corrections with their outdated marks.
 */
export function submitExportImport(e: CollectionEngine, body: { importId?: unknown; fileId?: unknown; sha256?: unknown }): Promise<{ status: number; record: ImportRecord }> {
  return sameIdFirst(e, body.importId, () => submitExportImportOnce(e, body))
}

async function submitExportImportOnce(e: CollectionEngine, body: { importId?: unknown; fileId?: unknown; sha256?: unknown }): Promise<{ status: number; record: ImportRecord }> {
  const importId = requireId(body.importId, 'importId')
  const existing = await e.store.getImport(importId)
  if (existing) return { status: 200, record: existing }
  if (await e.state.storage.get(tombstoneKey(importId))) return claim(e, cancelledSubmission(importId, 'export', [{ fileId: body.fileId }]))
  const fileId = requireId(body.fileId, 'fileId')
  if (!isSha256(body.sha256)) return fail('bad_request', "sha256 must be the staged export's SHA-256, in hex.")
  const sha256 = body.sha256
  const meta = await e.meta()
  if (meta.version > 0 || meta.queue.length || meta.active || meta.removals.length || meta.op) {
    return failWithStatus(409, 'bad_request', 'An export starts an empty collection only: this one already has something in it.')
  }
  const staged = await e.store.getStaged(fileId)
  if (!staged) return fail('bad_request', 'The export was not staged; upload it to the inbox first.')
  // The app reserved what it read from this very file: another one staged under the id since isn't learned.
  if (staged.sha256 !== sha256) return failWithStatus(409, 'bad_request', "The staged file isn't the export that was checked. Add it again.")
  if (staged.bytes > SETTINGS.maxExportImportBytes) return fail('too_large', 'That export is too large to start a collection from.')
  const contents = await readStagedExport(e, meta, fileId, sha256)
  if (contents === 'replaced') return failWithStatus(409, 'bad_request', "The staged file isn't the export that was checked. Add it again.")
  if (!contents) return failWithStatus(409, 'bad_request', "That file isn't a Knowledge export.")
  const record = baseRecord(importId, 'export', {
    importId,
    state: 'queued',
    attempt: 1,
    queuePosition: null,
    waitingFor: null,
    files: [],
    notes: 0,
    version: null,
    newFacts: null,
    failedFileId: null,
    error: null,
    etaSeconds: null,
    createdAt: iso(),
    finishedAt: null,
  })
  // The zip is the import's only staged file (kept until the commit, then deleted). What the import says it learns
  // are the export's files and notes, as an import of them would, so the app counts and names them.
  record.files = [{ fileId, name: staged.name, type: staged.type, bytes: staged.bytes, sha256: staged.sha256, documentId: '', duplicateOf: null }]
  record.status.files = contents.documents
    .filter((d) => d.info.kind === 'file')
    .map((d) => ({ fileId: d.info.documentId, name: d.info.name, state: 'waiting', documentId: d.info.documentId }))
  record.status.notes = contents.documents.filter((d) => d.info.kind === 'note').length
  record.rereadDocumentIds = contents.documents.map((d) => d.info.documentId) // its time limit counts them
  record.hiding = meta.settings.hiding
  record.fromExport = contents.from
  // The zip was read meanwhile: another submission with this id, or a cancel of it, may have come first.
  return claim(e, record)
}

/** The staged export, read whole; 'replaced' when its bytes aren't the ones whose checksum was given. */
async function readStagedExport(e: CollectionEngine, meta: Meta, fileId: string, sha256: string): Promise<ExportContents | 'replaced' | null> {
  const object = await e.env.FILES.get(inboxKey(meta, fileId))
  if (!object) return null
  const bytes = new Uint8Array(await object.arrayBuffer())
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  if ([...digest].map((b) => b.toString(16).padStart(2, '0')).join('') !== sha256) return 'replaced'
  return openExport(bytes)
}

/** The export's documents and marks, as this collection's records (version and sizes are set at the commit). */
async function exportedState(e: CollectionEngine, meta: Meta, record: ImportRecord): Promise<{ contents: ExportContents; state: AnswerState }> {
  const zip = record.files[0]
  const contents = zip ? await readStagedExport(e, meta, zip.fileId, zip.sha256) : null
  if (contents === 'replaced') throw new AttemptFailure('The export was replaced after it was checked, so it was not learned; add it again.', zip.fileId, true, 'bad_request')
  if (!contents) throw new AttemptFailure('The export is no longer waiting to be learned; add it again.', zip?.fileId ?? null, true, 'bad_request')
  const importId = record.status.importId
  const documents: DocRecord[] = contents.documents.map((d) => ({
    ...d.info,
    textBytes: 0,
    addedAt: iso(),
    version: 0,
    importId,
    textKey: textKey(meta, d.info.documentId),
    truncated: d.truncated,
    noteId: d.noteId,
    hiddenCount: d.hiddenCount,
  }))
  const marks: OutdatedMark[] = contents.marks.map((m) => ({ ...m, correctionImportId: importId }))
  return { contents, state: { ...EMPTY_STATE, documents, marks } }
}

/** Queue order: removals for good and re-learning first, then small imports (notes, corrections), then the rest. */
export function rankOf(record: Pick<ImportRecord, 'kind' | 'small'>): number {
  return record.kind === 'remove' || record.kind === 'relearn' ? 0 : record.small ? 1 : 2
}

/** The queue with `importId` placed after every import of the same or a higher rank, in order of arrival. */
async function placed(
  e: CollectionEngine,
  queue: string[],
  importId: string,
  rank: number,
  reader: Pick<DurableObjectStorage, 'get'> | DurableObjectTransaction = e.state.storage,
): Promise<string[]> {
  const rest = queue.filter((id) => id !== importId)
  const ranks: number[] = []
  for (const id of rest) {
    const record = await e.store.getImport(id, reader)
    ranks.push(record ? rankOf(record) : 2)
  }
  const at = ranks.findIndex((r) => r > rank)
  return at < 0 ? [...rest, importId] : [...rest.slice(0, at), importId, ...rest.slice(at)]
}

/** Puts an import in the queue. Only storage calls happen in between, so no request can interleave. */
async function enqueue(e: CollectionEngine, record: ImportRecord, front = false): Promise<void> {
  const meta = await e.meta()
  const importId = record.status.importId
  // An import that gave way goes back ahead of everything but removals and re-learning (rank 0).
  meta.queue = await placed(e, meta.queue, importId, front ? 0 : rankOf(record))
  await e.store.putMeta(meta)
}

function parseFiles(value: unknown): ImportFile[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > SETTINGS.maxFilesPerImport) {
    return fail('bad_request', `files must be a list of at most ${SETTINGS.maxFilesPerImport} files.`)
  }
  const seen = new Set<string>()
  return value.map((f: Partial<ImportFile>) => {
    const fileId = requireId(f?.fileId, 'fileId')
    if (seen.has(fileId)) return fail('bad_request', 'Each file may appear once in an import.')
    seen.add(fileId)
    if (typeof f.name !== 'string' || !f.name || f.name.length > 255) return fail('bad_request', 'Each file needs a name.')
    if (!isSha256(f.sha256)) return fail('bad_request', 'Each file needs its SHA-256 in hex.')
    return { fileId, name: f.name, type: typeof f.type === 'string' ? f.type : 'application/octet-stream', bytes: Number(f.bytes) || 0, sha256: f.sha256 }
  })
}

function parseNotes(value: unknown): ImportNote[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > SETTINGS.maxNotesPerImport) {
    return fail('bad_request', `notes must be a list of at most ${SETTINGS.maxNotesPerImport} notes.`)
  }
  return value.map((n: Partial<ImportNote>) => {
    const noteId = requireId(n?.noteId, 'noteId')
    if (typeof n.text !== 'string' || !n.text.trim() || n.text.length > SETTINGS.maxNoteChars) {
      return fail('bad_request', `A note needs text of up to ${SETTINGS.maxNoteChars} characters.`)
    }
    const title = typeof n.title === 'string' && n.title.trim() ? n.title.trim().slice(0, 200) : 'Note'
    const outdated = Array.isArray(n.outdated) ? n.outdated : []
    for (const ref of outdated) {
      requireId(ref?.documentId, 'outdated.documentId')
      if (!isSha256(ref?.textHash)) return fail('bad_request', 'outdated.textHash must be a SHA-256 in hex.')
    }
    return { noteId, title, text: n.text, outdated: outdated.map((r) => ({ documentId: r.documentId, textHash: r.textHash })) }
  })
}

// ==================================================================== the contract's view

export function etaSeconds(record: ImportRecord): number {
  // An export's import counts its documents (rereadDocumentIds), not its zip.
  const left = record.kind === 'export' ? 0 : record.files.filter((f, i) => !f.duplicateOf && !['learned', 'already_here'].includes(record.status.files[i]?.state)).length
  const items = left + record.notes.length + record.removeDocumentIds.length + record.rereadDocumentIds.length
  let seconds = SETTINGS.importBaseSeconds + SETTINGS.perDocumentSeconds * items
  if (record.learningStartedAt) seconds = Math.max(5, seconds - (clock.now() - record.learningStartedAt) / 1000)
  return Math.round(seconds)
}

export async function view(e: CollectionEngine, record: ImportRecord): Promise<ImportStatus> {
  const status: ImportStatus = structuredClone(record.status)
  const terminal = ['committed', 'duplicate', 'failed', 'cancelled'].includes(status.state)
  if (terminal) {
    status.etaSeconds = null
    status.queuePosition = null
    status.waitingFor = null
    return status
  }
  status.etaSeconds = etaSeconds(record)
  if (record.phase === 'queued') {
    const meta = await e.meta()
    const index = meta.queue.indexOf(status.importId)
    if (record.capacity !== 'waiting' && index > 0) {
      status.queuePosition = index
      status.waitingFor = 'organization'
    }
    // Imports ahead in this collection's own queue: add their time.
    for (const id of meta.queue.slice(0, Math.max(0, index))) {
      const ahead = await e.store.getImport(id)
      if (ahead) status.etaSeconds += etaSeconds(ahead)
    }
    if (meta.active && meta.active !== status.importId) {
      const running = await e.store.getImport(meta.active)
      if (running) status.etaSeconds += etaSeconds(running)
    }
  }
  return status
}

// ==================================================================== state-only changes

/** Stop using / use again: a change with its own restore point, using the same snapshot (no data changes). */
export async function setActive(e: CollectionEngine, documentId: string, body: { active?: unknown }): Promise<ImportStatus> {
  if (typeof body.active !== 'boolean') return fail('bad_request', 'active must be true or false.')
  const meta = await e.meta()
  if (meta.removals.length) return fail('busy_learning', 'A file is being removed for good; try again in a minute.')
  // While held a pending wake from a backup or repair waits for the hold to end; this needs no container, so it doesn't.
  if (meta.op && !isHeld(meta)) return fail('busy_learning', 'The collection is going back to an earlier version; try again in a minute.')
  const current = await e.currentState(meta)
  const doc = current.documents.find((d) => d.documentId === documentId)
  if (!doc) return fail('not_found', 'No such document.')
  const importId = randomId('chg')
  const status: ImportStatus = {
    importId,
    state: 'duplicate',
    attempt: 1,
    queuePosition: null,
    waitingFor: null,
    files: [],
    notes: 0,
    version: meta.version,
    newFacts: 0,
    failedFileId: null,
    error: null,
    etaSeconds: null,
    createdAt: iso(),
    finishedAt: iso(),
  }
  if (doc.active === body.active) return status
  const point = (await e.store.getPoint(meta.version))!
  const next: AnswerState = { ...current, documents: current.documents.map((d) => (d.documentId === documentId ? { ...d, active: body.active as boolean } : d)) }
  const changes = emptyChanges()
  if (body.active) changes.resumed = 1
  else changes.stopped = 1
  const record = baseRecord(importId, 'change', status)
  await commitPoint(e, {
    record,
    kind: 'change',
    changes,
    state: next,
    snapshot: null,
    snapshotId: point.snapshotId,
    newFacts: 0,
  })
  return view(e, (await e.store.getImport(importId))!)
}

/**
 * Remove for good: the document and its text are deleted, every restore point that holds it is marked not
 * restorable, and the container learns without it at once (ahead of every other import). The version is the
 * restore point that will hold the collection without it; no other change commits before it.
 */
export async function removeForGood(e: CollectionEngine, documentId: string): Promise<RemoveResult> {
  const meta = await e.meta()
  const pending = meta.removals.find((r) => r.documentId === documentId)
  if (pending) {
    const blocked = (await e.store.listPoints()).filter((p) => p.blocked === 'removed_for_good').map((p) => p.version)
    return { version: pending.version, blockedRestorePoints: blocked }
  }
  // While held the removal goes ahead of a pending wake from a backup or repair (it brings the files back itself).
  if (meta.op && !isHeld(meta)) return fail('busy_learning', 'The collection is going back to an earlier version; try again in a minute.')
  const current = await e.currentState(meta)
  const doc = current.documents.find((d) => d.documentId === documentId)
  if (!doc) return fail('not_found', 'No such document.')

  const version = meta.nextVersion + meta.removals.length
  const importId = `rm-v${version}` // never the document id: it ends up in file names that outlive the document
  const record = baseRecord(importId, 'remove', {
    importId,
    state: 'queued',
    attempt: 1,
    queuePosition: null,
    waitingFor: null,
    files: [],
    notes: 0,
    version: null,
    newFacts: null,
    failedFileId: null,
    error: null,
    etaSeconds: null,
    createdAt: iso(),
    finishedAt: null,
  })
  record.small = true
  record.reserveVersion = version
  record.removeDocumentIds = [documentId]

  // Every restore point that holds the document can no longer be brought back.
  const blocked: number[] = []
  for (const point of await e.store.listPoints()) {
    const state = await e.store.getState(point.version)
    if (!state?.documents.some((d) => d.documentId === documentId)) continue
    if (point.blocked !== 'removed_for_good') {
      point.blocked = 'removed_for_good'
      await e.store.putPoint(point)
    }
    if (!point.folded) blocked.push(point.version)
  }
  await e.store.putImport(record)
  await e.updateMeta((m) => {
    m.removals.push({ documentId, importId, version })
  })
  await enqueue(e, record)
  // Its text goes at once; stored exports that hold it are deleted too.
  await e.env.FILES.delete(doc.textKey)
  await dropFacts(e, [documentId])
  await exporter.dropContaining(e, documentId)
  await e.store.log('remove-for-good', { documentId, version, blocked: blocked.length })
  await e.state.storage.setAlarm(clock.now())
  return { version, blockedRestorePoints: blocked.sort((a, b) => a - b) }
}

/** Stricter hiding rules: every learned file is read again with them, in the background. */
export async function queueReread(e: CollectionEngine, hiding: HidingRules): Promise<void> {
  const meta = await e.meta()
  for (const id of meta.queue) {
    const queued = await e.store.getImport(id)
    if (queued?.kind === 'reread' && queued.phase === 'queued') {
      queued.hiding = hiding
      await e.store.putImport(queued)
      return
    }
  }
  const state = await e.currentState(meta)
  const importId = randomId('reread')
  const record = baseRecord(importId, 'reread', {
    importId,
    state: 'queued',
    attempt: 1,
    queuePosition: null,
    waitingFor: null,
    files: [],
    notes: 0,
    version: null,
    newFacts: null,
    failedFileId: null,
    error: null,
    etaSeconds: null,
    createdAt: iso(),
    finishedAt: null,
  })
  record.hiding = hiding
  record.rereadDocumentIds = state.documents.map((d) => d.documentId)
  await e.store.putImport(record)
  await enqueue(e, record)
  await e.store.log('reread-queued', { importId, documents: record.rereadDocumentIds.length })
}

/**
 * Learns every document again from its stored text, in a fresh database (after an engine change, or to repair).
 * `restoreFrom`: also bring back the documents of that version, which failed its check.
 */
export async function queueRelearn(e: CollectionEngine, reason: string, restoreFrom: number | null = null): Promise<void> {
  const meta = await e.meta()
  for (const id of [...meta.queue, ...(meta.active ? [meta.active] : [])]) {
    const queued = await e.store.getImport(id)
    if (queued?.kind !== 'relearn') continue
    if (restoreFrom !== null && queued.phase === 'queued') {
      queued.restoreFrom = restoreFrom
      await e.store.putImport(queued)
    }
    return
  }
  const importId = randomId('relearn')
  const state = await e.currentState(meta)
  const record = baseRecord(importId, 'relearn', {
    importId,
    state: 'queued',
    attempt: 1,
    queuePosition: null,
    waitingFor: null,
    files: [],
    notes: 0,
    version: null,
    newFacts: null,
    failedFileId: null,
    error: null,
    etaSeconds: null,
    createdAt: iso(),
    finishedAt: null,
  })
  record.small = true
  record.restoreFrom = restoreFrom
  record.rereadDocumentIds = state.documents.map((d) => d.documentId)
  await e.store.putImport(record)
  await enqueue(e, record)
  await e.store.log('relearn-queued', { importId, reason, restoreFrom })
}

function baseRecord(importId: string, kind: ImportKind, status: ImportStatus): ImportRecord {
  return {
    status,
    kind,
    small: false,
    phase: 'queued',
    files: [],
    notes: [],
    hiding: { emails: true, phones: true, cards: true, apiKeys: true, secrets: true, words: [] },
    jobId: null,
    capacity: 'none',
    reserveVersion: null,
    removeDocumentIds: [],
    rereadDocumentIds: [],
    snapshotTaken: false,
    learningStartedAt: null,
    retryAt: null,
    jobStartedAt: null,
    textsSaved: false,
    rebuild: false,
    restoreFrom: null,
    result: null,
    test: null,
  }
}

// ==================================================================== the queue and the capacity guard

/** Starts the import at the head of the queue (or the one named) when the capacity guard gives it a slot. True if it started. */
export async function startNext(e: CollectionEngine, importId?: string): Promise<boolean> {
  const meta = await e.meta()
  importId ??= meta.queue[0]
  const record = await e.store.getImport(importId)
  if (!record || record.phase === 'done') {
    await e.updateMeta((m) => {
      m.queue = m.queue.filter((id) => id !== importId)
    })
    return true
  }
  if (record.retryAt && record.retryAt > clock.now()) return false
  let answer: SlotAnswer
  try {
    answer = await callObject<SlotAnswer>(e.env.CAPACITY, CAPACITY_NAME, '/acquire', {
      body: { org: meta.org, collectionId: meta.collectionId, importId, small: record.small },
    })
  } catch (error) {
    // The guard may have granted a slot or a place whose answer was lost. If the import is cancelled meanwhile (or
    // was already), or held, what the guard holds for it is given back from the alarm; one still queued asks again
    // and gets the same slot.
    await oweReturn(e, importId)
    await e.store.log('capacity-unreachable', { importId, error: errorText(error) })
    return false
  }
  // The guard answered after an await: a cancel or the organization's hold may have won meanwhile. The import is
  // claimed only if it is still the one waiting and the organization isn't held (a removal for good still starts),
  // read again and written with meta.active in one transaction; otherwise what the guard gave goes back.
  const id = importId
  const claimed = await e.state.storage.transaction(async (txn) => {
    const current = await e.store.getImport(id, txn)
    const latest = (await txn.get<Meta>('meta'))!
    if (!current || current.phase !== 'queued' || !latest.queue.includes(id) || latest.active) return null
    if (isHeld(latest) && current.kind !== 'remove') return null
    if (!answer.granted) {
      current.capacity = 'waiting'
      current.status.waitingFor = answer.waitingFor
      current.status.queuePosition = answer.position
      await e.store.putImport(current, txn)
      return { started: false, record: current }
    }
    current.capacity = 'granted'
    current.phase = 'staging'
    current.status.state = 'reading'
    current.status.waitingFor = null
    current.status.queuePosition = null
    current.turns = (current.turns ?? 0) + 1
    await e.store.putImport(current, txn)
    latest.queue = latest.queue.filter((q) => q !== id)
    latest.active = id
    await txn.put('meta', latest)
    // The app hears that it started: from now on it can't be cancelled.
    if (APP_KINDS.has(current.kind)) await e.store.addEvents([stateEvent(latest, current, `started:${current.turns}`)], txn)
    return { started: true, record: current }
  })
  if (!claimed) {
    await giveBack(e, record) // the slot just given, or the place in the waiting list
    await e.store.log('capacity-claim-lost', { importId: id, granted: answer.granted, held: isHeld(await e.meta()) })
    return false
  }
  if (!claimed.started) return false
  await e.store.log('import-started', { importId: id, kind: claimed.record.kind, attempt: claimed.record.status.attempt })
  await advance(e, claimed.record)
  return true
}

/** Imports the app sent (not the engine's own re-reads, re-learning and removals): the app follows their state. */
const APP_KINDS = new Set<ImportKind>(['import', 'correction', 'export'])

/**
 * An `import` event for a change of state the app follows besides the end: started, back in the queue (a removal for
 * good or the hold went first), interrupted and tried again. `what` makes each one's key its own.
 */
function stateEvent(meta: Meta, record: ImportRecord, what: string): PendingEvent {
  return {
    key: `${meta.org}:${meta.collectionId}:import:${record.status.importId}:${what}`,
    event: { at: iso(), org: meta.org, collectionId: meta.collectionId, type: 'import', import: structuredClone(record.status) },
  }
}

async function tellApp(e: CollectionEngine, record: ImportRecord, what: string): Promise<void> {
  if (APP_KINDS.has(record.kind)) await e.store.addEvents([stateEvent(await e.meta(), record, what)])
}

/** The organization's hold landed during an earlier await: nothing but a removal for good starts a container now. */
async function heldNow(e: CollectionEngine, record: ImportRecord): Promise<boolean> {
  return record.kind !== 'remove' && isHeld(await e.meta())
}

/** One step of the active import. */
export async function advance(e: CollectionEngine, record: ImportRecord): Promise<void> {
  const meta = await e.meta()
  if (meta.removals.length && record.kind !== 'remove' && !record.snapshotTaken) return preempt(e, record)
  if (record.retryAt && record.retryAt > clock.now()) return
  if (record.capacity === 'granted') {
    // A slot that lapsed may have gone to another import: this one stops, keeps nothing and waits for a new one.
    // Only the guard's answer that the slot is gone counts: a call that failed (the guard unreachable for a moment)
    // is tried again on the next step.
    const renewed = await callObject<{ renewed: boolean }>(e.env.CAPACITY, CAPACITY_NAME, '/renew', {
      body: { org: meta.org, collectionId: meta.collectionId, importId: record.status.importId, small: record.small },
    }).catch(async (error) => {
      await e.store.log('lease-renew-unreachable', { importId: record.status.importId, error: errorText(error) })
      return { renewed: true }
    })
    if (!renewed.renewed && !record.snapshotTaken) {
      await e.store.log('lease-lost', { importId: record.status.importId })
      return preempt(e, record)
    }
  }
  // The hold may have landed while the guard answered: nothing more starts (an import saving finds it as it commits).
  if (!record.snapshotTaken && (await heldNow(e, record))) return stopForHold(e, record)
  try {
    if (record.phase === 'staging') await startJob(e, record)
    else if (record.phase === 'running') await poll(e, record)
    else if (record.phase === 'saving') await save(e, record)
  } catch (error) {
    if (error instanceof Deferred) return
    // The hold landed while the old container stopped for this one: it stops, keeps nothing and waits.
    if (error instanceof OnHold) return stopForHold(e, record)
    // A failure after the commit (tidying up) never turns a committed import into a failed try.
    if ((await e.store.getImport(record.status.importId))?.phase === 'done') {
      await e.store.log('after-commit-failed', { importId: record.status.importId, error: errorText(error) })
      return
    }
    if (error instanceof AttemptFailure) return attemptFailed(e, record, error)
    return attemptFailed(e, record, new AttemptFailure(errorText(error)))
  }
}

/** The organization was put on hold: a running import stops, keeps nothing and waits, its try not counted. */
export async function stopForHold(e: CollectionEngine, record: ImportRecord): Promise<void> {
  await e.store.log('import-held', { importId: record.status.importId })
  await preempt(e, record)
  await e.box.destroy('the organization is on hold')
  await e.store.deleteRuntime()
  await e.chargeUsage(null)
}

/** A removal for good goes first: the running import starts over after it, and the try isn't counted. */
async function preempt(e: CollectionEngine, record: ImportRecord): Promise<void> {
  const runtime = await e.store.getRuntime()
  if (runtime?.dirty) {
    await e.box.destroy('an import gave way to a removal')
    await e.store.deleteRuntime()
  }
  // Owed and told again from the alarm when the guard can't be told now: held, it can't ask for its slot again.
  await giveBack(e, record)
  record.phase = 'queued'
  record.capacity = 'none'
  record.jobId = null
  record.snapshotTaken = false
  record.status.state = 'queued'
  record.status.files = waitingFiles(record)
  await e.store.putImport(record)
  await e.updateMeta((m) => {
    m.active = null
  })
  await enqueue(e, record, true)
  await tellApp(e, record, `requeued:${record.turns ?? 0}`)
  await e.store.log('import-preempted', { importId: record.status.importId })
}

// ==================================================================== the container side

/**
 * A clean container on the learning instance holding the current restore point, with the query process stopped.
 * When the restore point's snapshot can't be started (expired, an engine change, damaged), its files come back from
 * the latest backup if that holds the same files in this image's database format. Otherwise a removal for good learns
 * the other documents again in an empty container, and any other import waits behind re-learning everything.
 */
async function learningContainer(e: CollectionEngine, record: ImportRecord): Promise<Runtime> {
  await stopIfHeld(e, record)
  const meta = await e.meta()
  // Only a removal for good starts its container while held; startContainer reads the hold last (OnHold).
  const removal = record.kind === 'remove'
  if (record.kind === 'relearn' || record.kind === 'export' || record.rebuild) return e.startContainer(null, 'learning', { removal })
  const current = await e.currentSnapshot(meta)
  if (current.unusable) {
    await stopIfHeld(e, record)
    const runtime = await e.startContainer(null, 'learning', { fromBackup: true, removal })
    const latest = await backup.latestIndex(e)
    if (current.snapshot && latest && backup.holds(latest, current.snapshot, runtime.dataFormat) && (await backup.restoreFiles(e, latest))) {
      runtime.snapshotId = current.snapshot.handle.id
      await e.store.putRuntime(runtime)
      await e.store.log('restored-for-learning', { backup: latest.day })
      return runtime
    }
    if (record.kind === 'remove') {
      record.rebuild = true
      await e.store.putImport(record)
      await e.store.log('removal-rebuilds', { reason: current.unusable })
      return runtime
    }
    await e.box.destroy('waiting for re-learning')
    await e.store.deleteRuntime()
    await preempt(e, record)
    await queueRelearn(e, current.unusable)
    throw new Deferred()
  }
  const snapshot = current.snapshot
  const wanted = snapshot?.handle.id ?? null
  const runtime = await e.store.getRuntime()
  const learning = instances(e.env).learning
  // Reused only once its files passed their check: a wake still starting or checking is not.
  const checked = runtime && (runtime.phase === 'opening' || runtime.phase === 'ready' || runtime.phase === 'busy')
  if (e.box.running && runtime && checked && !runtime.dirty && runtime.snapshotId === wanted && runtime.instance === learning) {
    if (runtime.queryStarted) await e.box.queryStop()
    runtime.queryStarted = false
    runtime.phase = 'busy'
    await e.store.putRuntime(runtime)
    return runtime
  }
  await stopIfHeld(e, record)
  const started = await e.startContainer(snapshot, 'learning', { removal })
  if (snapshot) {
    const manifest = await e.box.manifest()
    const expected = await e.store.getManifest(snapshot.handle.id)
    if (expected && manifest.digest !== expected.digest) {
      await e.integrityFailure(started, 'mismatch before learning')
      throw new Deferred()
    }
    await e.store.log('checksum-ok', { snapshot: snapshot.handle.id, purpose: 'learning' })
  }
  return started
}

/** Checked before each container start and job: a hold that landed meanwhile stops the import, which keeps nothing and waits. */
async function stopIfHeld(e: CollectionEngine, record: ImportRecord): Promise<void> {
  if (!(await heldNow(e, record))) return
  await stopForHold(e, record)
  throw new Deferred()
}

/** The documents a re-learning holds: the current ones, and after a repair those of the version that failed too. */
async function relearnDocuments(e: CollectionEngine, record: ImportRecord, meta: Meta): Promise<{ current: AnswerState; extra: DocRecord[]; marks: OutdatedMark[] }> {
  const current = await e.currentState(meta)
  if (record.restoreFrom === null) return { current, extra: [], marks: [] }
  const failed = await e.store.getState(record.restoreFrom)
  const here = new Set(current.documents.map((d) => d.documentId))
  const removing = new Set(meta.removals.map((r) => r.documentId))
  const extra: DocRecord[] = []
  for (const doc of failed?.documents ?? []) {
    if (here.has(doc.documentId) || removing.has(doc.documentId)) continue
    if (await e.env.FILES.head(doc.textKey)) extra.push(doc)
  }
  const kept = new Set([...here, ...extra.map((d) => d.documentId)])
  const marks = (failed?.marks ?? []).filter((m) => kept.has(m.documentId) && kept.has(m.noteDocumentId) && !current.marks.some((c) => c.documentId === m.documentId && c.textHash === m.textHash))
  return { current, extra, marks }
}

async function startJob(e: CollectionEngine, record: ImportRecord): Promise<void> {
  const importId = record.status.importId
  // An interrupted try is tried again in place, as the active import: the app hears when it starts again.
  const retrying = record.status.state === 'interrupted'
  const before = await e.meta()
  if (record.kind === 'import' || record.kind === 'correction') {
    // Content learned since this import was queued is already here: never learn it twice.
    const state = await e.currentState(before)
    const here = new Map(state.documents.filter((d) => d.kind === 'file').map((d) => [d.sha256, d.documentId]))
    record.files.forEach((f, i) => {
      if (!f.duplicateOf && here.has(f.sha256)) {
        f.duplicateOf = here.get(f.sha256)!
        record.status.files[i] = fileStatus(f)
      }
    })
    if (!record.files.some((f) => !f.duplicateOf) && !record.notes.length) return finishUnchanged(e, record)
  }
  if (record.kind === 'relearn' && record.restoreFrom === null && !(await e.currentSnapshot(before)).unusable) {
    return finishUnchanged(e, record) // something else brought the restore point back meanwhile
  }
  if (record.kind === 'export' && before.version > 0) {
    throw new AttemptFailure("Something was added to the collection first, so the export can't start it.", null, true, 'bad_request')
  }
  const runtime = await learningContainer(e, record)
  const meta = await e.meta()
  // Hidden with the rules in force now, not those of when the import was queued.
  record.hiding = meta.settings.hiding
  record.status.state = 'reading'
  await e.box.deleteInbox(importId)

  const stageTexts = async (docs: Pick<DocRecord, 'documentId' | 'name' | 'textKey'>[]) => {
    for (const doc of docs) {
      const object = await e.env.FILES.get(doc.textKey)
      if (!object) throw new AttemptFailure(`The saved text of “${doc.name}” is missing; add it again.`, null, true, 'bad_request')
      await e.box.putInbox(importId, `${doc.documentId}.json`, await object.text())
    }
  }
  let batch: Record<string, unknown>
  let op = 'ingest'
  if (record.kind === 'remove' && record.rebuild) {
    // Learned again without every document waiting to be removed for good: their texts are already gone.
    const state = await e.currentState(meta)
    const removing = new Set([...record.removeDocumentIds, ...meta.removals.map((r) => r.documentId)])
    const kept = state.documents.filter((d) => !removing.has(d.documentId))
    record.rereadDocumentIds = kept.map((d) => d.documentId) // its time limit counts them
    await stageTexts(kept)
    batch = { importId, kind: 'relearn', hiding: record.hiding, documents: kept.map((d) => ({ documentId: d.documentId, kind: d.kind, name: d.name })) }
  } else if (record.kind === 'remove') {
    op = 'remove'
    batch = { importId, kind: 'remove', documentIds: record.removeDocumentIds }
  } else if (record.kind === 'reread') {
    op = 'reread'
    const state = await e.currentState(meta)
    batch = {
      importId,
      kind: 'reread',
      hiding: record.hiding,
      documentIds: state.documents.map((d) => d.documentId),
      marks: state.marks.map((m) => ({ documentId: m.documentId, textHash: m.textHash })),
    }
  } else if (record.kind === 'export') {
    // Each text as the export holds it, hidden again with this collection's rules as it is learned.
    const { contents } = await exportedState(e, meta, record)
    for (const doc of contents.documents) {
      const stored = await storedText(doc)
      if (!stored) throw new AttemptFailure(`The export's text of “${doc.info.name}” is damaged.`, record.files[0].fileId, true, 'bad_request')
      await e.box.putInbox(importId, `${doc.info.documentId}.json`, JSON.stringify(stored))
    }
    batch = {
      importId,
      kind: 'relearn',
      hiding: record.hiding,
      documents: contents.documents.map((d) => ({ documentId: d.info.documentId, kind: d.info.kind, name: d.info.name })),
      // Hiding again can change a corrected passage: its mark follows it, as after a re-read.
      marks: contents.marks.map((m) => ({ documentId: m.documentId, textHash: m.textHash })),
    }
  } else if (record.kind === 'relearn') {
    const { current, extra } = await relearnDocuments(e, record, meta)
    const docs = [...current.documents, ...extra]
    record.rereadDocumentIds = docs.map((d) => d.documentId) // its time limit counts them
    await stageTexts(docs)
    batch = { importId, kind: 'relearn', hiding: record.hiding, documents: docs.map((d) => ({ documentId: d.documentId, kind: d.kind, name: d.name })) }
  } else {
    const fresh = record.files.filter((f) => !f.duplicateOf)
    if (record.textsSaved) {
      // An earlier try read everything: learn from the redacted text it saved (the originals are gone).
      await stageTexts([
        ...fresh.map((f) => ({ documentId: f.documentId, name: f.name, textKey: textKey(meta, f.documentId) })),
        ...record.notes.map((n) => ({ documentId: n.documentId, name: n.title, textKey: textKey(meta, n.documentId) })),
      ])
    } else {
      for (const file of fresh) {
        const object = await e.env.FILES.get(inboxKey(meta, file.fileId))
        if (!object) throw new AttemptFailure(`“${file.name}” is no longer waiting to be learned; add it again.`, file.fileId, true, 'bad_request')
        await e.box.putInbox(importId, file.fileId, object.body)
      }
    }
    batch = {
      importId,
      kind: 'import',
      files: fresh.map((f) => ({ fileId: f.fileId, documentId: f.documentId, name: f.name, type: f.type, sha256: f.sha256, stored: record.textsSaved })),
      notes: record.notes.map((n) => ({ noteId: n.noteId, documentId: n.documentId, title: n.title, outdated: n.outdated, ...(record.textsSaved ? { stored: true } : { text: n.text }) })),
      hiding: record.hiding,
      test: record.test ?? undefined,
    }
  }
  await e.box.putInbox(importId, 'batch.json', JSON.stringify(batch))
  await stopIfHeld(e, record)
  // From here the container holds an uncommitted import: it is never reused if this import doesn't commit.
  runtime.dirty = true
  await e.store.putRuntime(runtime)
  const job = await e.box.startJob(op, { batchId: importId })
  record.jobId = job.id
  record.phase = 'running'
  record.jobStartedAt = clock.now()
  record.learningStartedAt ??= clock.now()
  record.status.files = record.status.files.map((f) => (f.state === 'waiting' ? { ...f, state: 'reading' } : f))
  await e.store.putImport(record)
  if (retrying) await tellApp(e, record, `retried:${record.status.attempt}`)
  await e.chargeUsage('learning')
  await e.store.log('job-started', { importId, op, job: job.id, attempt: record.status.attempt })
}

/** An import that turned out to change nothing (everything already here): no container work, no restore point. */
async function finishUnchanged(e: CollectionEngine, record: ImportRecord): Promise<void> {
  record.status.state = 'duplicate'
  record.status.finishedAt = iso()
  record.phase = 'done'
  record.jobId = null
  record.notes = scrubbed(record.notes)
  await e.store.putImport(record)
  await e.updateMeta((m) => {
    if (m.active === record.status.importId) m.active = null
  })
  await e.event(`import:${record.status.importId}:duplicate`, { type: 'import', import: record.status })
  if (record.capacity === 'granted') await giveBack(e, record)
  await deleteOriginals(e, record.files.map((f) => f.fileId))
  await e.store.log('import-duplicate', { importId: record.status.importId })
}

/** Notes as written are kept only until they are read and hidden. */
function scrubbed(notes: ImportRecord['notes']): ImportRecord['notes'] {
  return notes.map((n) => ({ ...n, text: '' }))
}

async function poll(e: CollectionEngine, record: ImportRecord): Promise<void> {
  if (!e.box.running) throw new AttemptFailure('The container stopped while learning.')
  const job = await e.box.getJob(record.jobId ?? '')
  const progress = job.progress?.files ?? job.result?.files
  if (progress) {
    record.status.files = record.status.files.map((f) => {
      const state = progress[f.fileId]
      return state && f.state !== 'already_here' ? { ...f, state: state === 'failed' ? 'reading' : state } : f
    })
  }
  if (record.status.files.some((f) => f.state === 'understanding' || f.state === 'learned') || ((!record.files.length || record.kind === 'export') && job.progress?.done)) {
    record.status.state = 'learning'
  }
  if (job.state === 'running' && job.progress?.read && !record.textsSaved && (record.kind === 'import' || record.kind === 'correction')) {
    await saveReadTexts(e, record)
  }
  if (job.state === 'running') {
    const limit = Math.max(SETTINGS.jobTimeoutMs, 3 * etaSeconds({ ...record, learningStartedAt: null }) * 1000)
    if (record.jobStartedAt && clock.now() - record.jobStartedAt > limit) {
      throw new AttemptFailure('Learning took far longer than it should, so it was stopped.')
    }
    await e.store.putImport(record)
    return
  }
  if (job.state === 'failed') {
    const r = job.result ?? {}
    // A crash leaves no result: the file being read or learned when it stopped is the one that failed.
    const current = job.progress?.current
    const crashed = typeof current === 'string' && record.files.some((f) => f.fileId === current) ? current : null
    throw new AttemptFailure(
      typeof r.reason === 'string' ? r.reason : 'Learning stopped unexpectedly.',
      typeof r.failedFileId === 'string' ? r.failedFileId : crashed,
      r.permanent === true,
      r.code === 'unsupported_type' || r.code === 'too_large' ? r.code : 'internal',
    )
  }
  record.result = job.result ?? {}
  record.phase = 'saving'
  record.status.state = 'saving'
  await e.store.putImport(record)
  await save(e, record)
}

/**
 * Every file and note was read and hidden: their redacted texts go to R2, the originals and the notes as written are
 * deleted, and any later try learns from the saved texts.
 */
async function saveReadTexts(e: CollectionEngine, record: ImportRecord): Promise<void> {
  const meta = await e.meta()
  const docs = [...record.files.filter((f) => !f.duplicateOf).map((f) => f.documentId), ...record.notes.map((n) => n.documentId)]
  for (const documentId of docs) {
    const response = await e.box.fetch(`/text/${encodeURIComponent(documentId)}`)
    if (!response.ok) {
      await response.body?.cancel()
      return // not all read yet; asked again on the next poll
    }
    await e.env.FILES.put(textKey(meta, documentId), await response.text(), { httpMetadata: { contentType: 'application/json' } })
  }
  record.textsSaved = true
  record.notes = scrubbed(record.notes)
  await e.store.putImport(record)
  await deleteOriginals(e, record.files.map((f) => f.fileId))
  await e.store.log('read', { importId: record.status.importId, documents: docs.length })
}

/** Quiesce, record counts and the full checksum manifest, copy texts out, snapshot, commit. */
async function save(e: CollectionEngine, record: ImportRecord): Promise<void> {
  const meta = await e.meta()
  const importId = record.status.importId
  const result = (record.result ?? {}) as IngestResult
  if (record.kind === 'reread' && !(result.changed ?? []).length) {
    // The stricter rules found nothing new to hide: no restore point. The container ran the job, so it isn't reused.
    await e.box.destroy('re-read changed nothing')
    await e.store.deleteRuntime()
    return finishUnchanged(e, record)
  }
  await e.box.deleteInbox(importId)
  await e.box.cleanup()
  await e.box.waitQuiescent()
  const stats = (await e.box.runJob('stats')).result as Stats
  const manifest: Manifest = await e.box.manifest()

  // The redacted text of every new or changed document, and this version's facts, go to R2.
  for (const doc of result.documents ?? []) {
    if (!doc.changed && record.kind !== 'import' && record.kind !== 'correction') continue
    const response = await e.box.fetch(`/text/${encodeURIComponent(doc.documentId)}`)
    if (!response.ok) throw new AttemptFailure('A learned text could not be read back.')
    await e.env.FILES.put(textKey(meta, doc.documentId), await response.text(), { httpMetadata: { contentType: 'application/json' } })
  }
  // A removal for good that arrived while these texts were copied must not get its text back.
  const removing = (await e.meta()).removals.map((r) => r.documentId)
  const resurrected = (result.documents ?? []).filter((d) => removing.includes(d.documentId)).map((d) => textKey(meta, d.documentId))
  if (resurrected.length) await e.env.FILES.delete(resurrected)
  let facts: string | null = null
  const factsResponse = await e.box.getFile('facts.json')
  if (factsResponse.ok) {
    facts = factsKey(meta, importId)
    await e.env.FILES.put(facts, await factsResponse.text(), { httpMetadata: { contentType: 'application/json' } })
  } else {
    await factsResponse.body?.cancel()
  }
  await e.box.waitQuiescent()

  const latest = await e.meta()
  if (latest.deleting) return
  if (latest.removals.length && record.kind !== 'remove') return preempt(e, record)
  if (isHeld(latest) && record.kind !== 'remove') return stopForHold(e, record)
  const snapshot = await e.box.snapshot(`${meta.collectionId}-${importId}-a${record.status.attempt}`)
  record.snapshotTaken = true
  await e.store.putImport(record)
  const committed = await commitImport(e, record, snapshot, manifest, stats, facts)
  if (committed) return
  // Not committed: a removal for good came first, or the hold arrived meanwhile. The snapshot goes unused.
  if (isHeld(await e.meta()) && record.kind !== 'remove') return stopForHold(e, record)
  return preempt(e, record)
}

interface IngestDocument {
  documentId: string
  fileId?: string
  noteId?: string
  kind: 'file' | 'note'
  textBytes: number
  pages: number | null
  hidden: number
  truncated?: boolean
  reason?: string
  changed?: boolean
}

interface IngestResult {
  documents?: IngestDocument[]
  marks?: { documentId: string; textHash: string; newTextHash?: string | null; changed?: boolean }[]
  facts?: number
  newFacts?: number
  passages?: number
  changed?: string[]
}

interface Stats {
  passages?: number
  documents?: number
  relational?: { documents: number; integrity: string }
}

async function commitImport(
  e: CollectionEngine,
  record: ImportRecord,
  snapshot: SnapshotHandle,
  manifest: Manifest,
  stats: Stats,
  facts: string | null,
): Promise<boolean> {
  const meta = await e.meta()
  const current = await e.currentState(meta)
  const result = (record.result ?? {}) as IngestResult
  const version = Math.max(meta.nextVersion, record.reserveVersion ?? 0)
  const extra =
    record.kind === 'relearn' && record.restoreFrom !== null
      ? ((await e.store.getState(record.restoreFrom)) ?? null)
      : record.kind === 'export'
        ? (await exportedState(e, meta, record)).state
        : null
  const dropped: DroppedMark[] = []
  const next = applyResult(meta, current, record, result, version, facts, stats, extra, dropped)
  const before = record.kind === 'export' ? (extra?.marks ?? []) : current.marks
  // Each moved mark with the correction it belonged to before (another than its owner now when passages merged).
  const moves = (result.marks ?? [])
    .filter((m) => m.changed || m.newTextHash === null)
    .map((m) => ({ ...m, noteDocumentId: before.find((b) => b.documentId === m.documentId && b.textHash === m.textHash)?.noteDocumentId ?? null }))
  const changes = emptyChanges()
  changes.files = record.files.filter((f) => !f.duplicateOf).length
  changes.notes = record.kind === 'correction' ? 0 : record.notes.length
  changes.corrections = record.kind === 'correction' ? record.notes.length : 0
  if (record.kind === 'export') {
    const corrections = new Set(next.marks.map((m) => m.noteDocumentId))
    changes.files = next.documents.filter((d) => d.kind === 'file').length
    changes.notes = next.documents.filter((d) => d.kind === 'note' && !corrections.has(d.documentId)).length
    changes.corrections = corrections.size
  }
  changes.removed = record.removeDocumentIds.length
  changes.reread = record.kind === 'reread' ? (result.changed ?? []).length : 0
  const pointKind = record.kind === 'remove' ? 'remove' : record.kind === 'reread' ? 'reread' : record.kind === 'relearn' ? 'from_backup' : 'import'
  return commitPoint(e, {
    record,
    kind: pointKind,
    changes,
    state: next,
    snapshot: { handle: snapshot, manifest },
    snapshotId: snapshot.id,
    newFacts: result.newFacts ?? null,
    changedDocumentIds: result.changed ?? [],
    ...(record.kind === 'relearn' ? { summary: 'Learned everything again from its saved text' } : {}),
    ...(record.kind === 'export' ? { summary: `Started from an export (${describe(changes).toLowerCase()})` } : {}),
    // And each mark a merge dropped without moving it (its passage went to a newer correction): its earlier check goes.
    needsCheck: [...moves, ...dropped.filter((d) => !moves.some((m) => m.documentId === d.documentId && m.textHash === d.textHash))],
  })
}

/** A mark that lost its passage to a newer correction when passages merged: where it was, where it is, and its correction. */
interface DroppedMark {
  documentId: string
  textHash: string
  newTextHash: string
  noteDocumentId: string
}

function applyResult(
  meta: Meta,
  current: AnswerState,
  record: ImportRecord,
  result: IngestResult,
  version: number,
  facts: string | null,
  stats: Stats,
  extra: AnswerState | null = null,
  dropped: DroppedMark[] = [],
): AnswerState {
  const now = iso()
  const byId = new Map((result.documents ?? []).map((d) => [d.documentId, d]))
  let documents = current.documents.slice()
  let marks = current.marks.slice()
  const superseded = new Set<string>()
  // Each correction gets the next number in the order corrections were made (exports carry it), so a later one wins.
  let seq = marks.reduce((most, m) => Math.max(most, m.seq ?? 0), 0)
  if (record.kind === 'import' || record.kind === 'correction') {
    for (const file of record.files) {
      if (file.duplicateOf) continue
      const learned = byId.get(file.documentId)
      documents.push({
        documentId: file.documentId,
        kind: 'file',
        name: file.name,
        type: file.type,
        bytes: file.bytes,
        textBytes: learned?.textBytes ?? 0,
        pages: learned?.pages ?? null,
        sha256: file.sha256,
        active: true,
        addedAt: now,
        version,
        importId: record.status.importId,
        textKey: textKey(meta, file.documentId),
        truncated: learned?.truncated === true,
        noteId: null,
        hiddenCount: learned?.hidden ?? 0,
      })
    }
    for (const note of record.notes) {
      const learned = byId.get(note.documentId)
      const bytes = new TextEncoder().encode(note.text).length
      documents.push({
        documentId: note.documentId,
        kind: 'note',
        name: note.title,
        type: 'text/markdown',
        bytes,
        textBytes: learned?.textBytes ?? bytes,
        pages: null,
        sha256: '',
        active: true,
        addedAt: now,
        version,
        importId: record.status.importId,
        textKey: textKey(meta, note.documentId),
        truncated: false,
        noteId: note.noteId,
        hiddenCount: learned?.hidden ?? 0,
      })
      if (note.outdated.length) seq += 1
      for (const ref of note.outdated) {
        // The newest correction of a passage wins ("Write it again"): it takes the passage over from an earlier one.
        const same = (m: OutdatedMark) => m.documentId === ref.documentId && m.textHash === ref.textHash
        const earlier = marks.find(same)
        if (earlier?.noteDocumentId === note.documentId) continue
        if (earlier) superseded.add(earlier.noteDocumentId)
        marks = marks.filter((m) => !same(m))
        marks.push({ ...ref, noteDocumentId: note.documentId, correctionImportId: record.status.importId, needsCheck: false, seq })
      }
    }
    // An earlier correction left correcting nothing is kept but no longer used, so it can't answer instead.
    documents = retireCorrections(documents, marks, superseded)
  } else if (record.kind === 'remove') {
    const gone = new Set(record.removeDocumentIds)
    documents = documents.filter((d) => !gone.has(d.documentId))
    marks = marks.filter((m) => !gone.has(m.documentId) && !gone.has(m.noteDocumentId))
  } else if (record.kind === 'reread') {
    documents = documents.map((d) => {
      const learned = byId.get(d.documentId)
      return learned?.changed ? { ...d, textBytes: learned.textBytes, hiddenCount: learned.hidden } : d
    })
    marks = followMarks(marks, result.marks ?? [], superseded, dropped)
    documents = retireCorrections(documents, marks, superseded)
  } else if (record.kind === 'export') {
    // An empty collection started from an export: its documents as learned now, stopped ones still stopped, and the
    // corrections' marks on them.
    documents = (extra?.documents ?? [])
      .filter((d) => byId.has(d.documentId))
      .map((d) => {
        const learned = byId.get(d.documentId)!
        return { ...d, textBytes: learned.textBytes, hiddenCount: learned.hidden ?? d.hiddenCount, pages: learned.pages ?? d.pages, addedAt: now, version }
      })
    const kept = new Set(documents.map((d) => d.documentId))
    marks = followMarks((extra?.marks ?? []).filter((m) => kept.has(m.documentId) && kept.has(m.noteDocumentId)), result.marks ?? [], superseded, dropped)
    documents = retireCorrections(documents, marks, superseded)
  } else if (record.kind === 'relearn' && record.restoreFrom !== null) {
    // A repair's re-learning also brings back the documents of the version that failed its check.
    const learned = new Set((result.documents ?? []).map((d) => d.documentId))
    const here = new Set(documents.map((d) => d.documentId))
    documents = [...documents, ...(extra?.documents ?? []).filter((d) => learned.has(d.documentId) && !here.has(d.documentId))]
    const kept = new Set(documents.map((d) => d.documentId))
    marks = [...marks, ...(extra?.marks ?? []).filter((m) => kept.has(m.documentId) && kept.has(m.noteDocumentId) && !marks.some((c) => c.documentId === m.documentId && c.textHash === m.textHash))]
  }
  return {
    documents,
    marks,
    factsKey: facts ?? current.factsKey,
    facts: result.facts ?? current.facts,
    passages: stats.passages ?? result.passages ?? current.passages,
    textBytes: documents.reduce((sum, d) => sum + d.textBytes, 0),
  }
}

/**
 * Outdated marks follow their passage to its new text (a re-read, or an export hidden again): one whose passage
 * changed, or can't be found, asks to be checked. Marks a merge drops are added to `dropped`.
 */
function followMarks(marks: OutdatedMark[], moves: NonNullable<IngestResult['marks']>, superseded: Set<string>, dropped: DroppedMark[] = []): OutdatedMark[] {
  const remap = new Map(moves.map((m) => [`${m.documentId}:${m.textHash}`, m.newTextHash]))
  const changed = new Set(moves.filter((m) => m.changed).map((m) => `${m.documentId}:${m.textHash}`))
  const moved = marks.map((m): OutdatedMark => {
    const key = `${m.documentId}:${m.textHash}`
    if (!remap.has(key)) return m
    const to = remap.get(key)
    return to ? { ...m, textHash: to, needsCheck: m.needsCheck || changed.has(key) } : { ...m, needsCheck: true }
  })
  // Two passages that hiding made the same now carry two marks: one passage has one correction, the newer by its
  // number (an equal or missing number: the later in the list), as when a correction is written again.
  const winner = new Map<string, number>()
  moved.forEach((m, i) => {
    const key = `${m.documentId}:${m.textHash}`
    const best = winner.get(key)
    if (best === undefined || (m.seq ?? 0) >= (moved[best].seq ?? 0)) winner.set(key, i)
  })
  return moved.filter((m, i) => {
    if (winner.get(`${m.documentId}:${m.textHash}`) === i) return true
    superseded.add(m.noteDocumentId)
    dropped.push({ documentId: m.documentId, textHash: marks[i].textHash, newTextHash: m.textHash, noteDocumentId: m.noteDocumentId })
    return false
  })
}

/** Corrections another took every passage from are kept but no longer used, so they can't answer instead. */
function retireCorrections(documents: DocRecord[], marks: OutdatedMark[], superseded: Set<string>): DocRecord[] {
  const stillCorrecting = new Set(marks.map((m) => m.noteDocumentId))
  return documents.map((d) => (superseded.has(d.documentId) && !stillCorrecting.has(d.documentId) ? { ...d, active: false } : d))
}

export function countsOf(state: AnswerState): CollectionCounts {
  return {
    documents: state.documents.length,
    activeDocuments: state.documents.filter((d) => d.active).length,
    passages: state.passages,
    facts: state.facts,
    textBytes: state.textBytes,
  }
}

export function emptyChanges(): ChangeCounts {
  return { files: 0, notes: 0, corrections: 0, stopped: 0, resumed: 0, removed: 0, reread: 0 }
}

/** Plain words for History: "Added 5 files", "Correction", "Stopped using 1 file". */
export function describe(changes: ChangeCounts): string {
  const parts: string[] = []
  if (changes.files || changes.notes) {
    const added = [changes.files ? plural(changes.files, 'file') : '', changes.notes ? plural(changes.notes, 'note') : ''].filter(Boolean)
    parts.push(`Added ${added.join(' and ')}`)
  }
  if (changes.corrections) parts.push(changes.corrections === 1 ? 'Correction' : `${changes.corrections} corrections`)
  if (changes.stopped) parts.push(`Stopped using ${plural(changes.stopped, 'file')}`)
  if (changes.resumed) parts.push(`Used ${plural(changes.resumed, 'file')} again`)
  if (changes.removed) parts.push(`Removed ${plural(changes.removed, 'file')} for good`)
  if (changes.reread) parts.push(`Read ${plural(changes.reread, 'file')} again with stricter hiding`)
  return parts.join('; ') || 'No changes'
}

const FOLDABLE = new Set(['import', 'change'])

export interface PointCommit {
  record: ImportRecord
  kind: RestorePointRecord['kind']
  changes: ChangeCounts
  state: AnswerState
  snapshot: { handle: SnapshotHandle; manifest: Manifest } | null // a new snapshot, or null when the data didn't change
  snapshotId: string | null
  newFacts: number | null
  changedDocumentIds?: string[]
  summary?: string
  previous?: number | null
  importEvent?: boolean // false for going back, undo and repairs: no import of the app's is involved
  needsCheck?: { documentId: string; textHash: string; newTextHash?: string | null; noteDocumentId?: string | null }[] // corrected passages a re-read changed, and whose correction each mark was
}

/**
 * The commit: the snapshot, its manifest, the answer state, the restore point, the import and the meta in one
 * storage transaction. Changes within 5 minutes of the last one share its restore point (the earlier one folds into
 * the new one). Returns false, committing nothing, when a removal for good arrived first.
 */
export async function commitPoint(e: CollectionEngine, c: PointCommit): Promise<boolean> {
  const now = iso()
  const runtime = (await e.store.getRuntime()) ?? null
  let committedMeta: Meta | null = null
  let point: RestorePointRecord | null = null
  await e.state.storage.transaction(async (txn) => {
    const meta = (await txn.get<Meta>('meta'))!
    if (meta.deleting || (meta.removals.length && c.record.kind !== 'remove')) return
    // The organization's hold arrived while this was learned: only a removal for good and a stop using / use again
    // (no container) commit while held; anything else keeps nothing and waits for the hold to end.
    if (isHeld(meta) && c.kind !== 'remove' && c.kind !== 'change') return
    const version = Math.max(meta.nextVersion, c.record.reserveVersion ?? 0)
    const prev = meta.version ? await txn.get<RestorePointRecord>(`rp:${String(meta.version).padStart(10, '0')}`) : undefined
    const fold =
      !!prev &&
      !prev.folded &&
      !prev.blocked &&
      FOLDABLE.has(prev.kind) &&
      FOLDABLE.has(c.kind) &&
      Date.parse(now) - Date.parse(prev.createdAt) < SETTINGS.shareRestorePointMs
    const changes = fold ? addChanges(prev!.changes, c.changes) : c.changes
    const state = { ...c.state, documents: c.state.documents.map((d) => (d.importId === c.record.status.importId ? { ...d, version } : d)) }
    point = {
      version,
      createdAt: now,
      kind: fold ? (prev!.kind === 'import' || c.kind === 'import' ? 'import' : c.kind) : c.kind,
      summary: c.summary ?? describe(changes),
      changes,
      snapshotId: c.snapshotId,
      previous: c.previous !== undefined ? c.previous : fold ? prev!.previous : meta.version || null,
      importIds: fold ? [...prev!.importIds, c.record.status.importId] : [c.record.status.importId],
      counts: countsOf(state),
      blocked: null,
      folded: false,
    }
    if (c.snapshot) {
      const record: SnapshotRecord = {
        handle: c.snapshot.handle,
        image: runtime?.image ?? e.box.image,
        dataFormat: runtime?.dataFormat ?? '',
        manifest: { digest: c.snapshot.manifest.digest, files: c.snapshot.manifest.files, bytes: c.snapshot.manifest.bytes },
        createdAt: now,
        lastRestoredAt: null,
        expired: false,
      }
      await e.store.putSnapshot(record, txn)
      await e.store.putManifest(c.snapshot.handle.id, c.snapshot.manifest, txn)
    }
    await e.store.putState(version, state, txn)
    await e.store.putPoint(point, txn)
    if (fold) await e.store.putPoint({ ...prev!, folded: true }, txn)
    // Stricter hiding: earlier restore points that still hold the newly hidden text can't be brought back.
    if (c.changedDocumentIds?.length) {
      const changed = new Set(c.changedDocumentIds)
      const points = await txn.list<RestorePointRecord>({ prefix: 'rp:' })
      for (const [key, p] of points) {
        if (p.version === version || p.blocked) continue
        const held = await e.store.getState(p.version, txn)
        if (held?.documents.some((d) => changed.has(d.documentId))) await txn.put(key, { ...p, blocked: 'newly_hidden' })
      }
    }
    const status = c.record.status
    status.state = 'committed'
    status.version = version
    status.newFacts = c.newFacts
    status.finishedAt = now
    status.files = status.files.map((f) => (f.state === 'already_here' ? f : { ...f, state: 'learned', reason: learnedNote(c.record, f.fileId) }))
    c.record.phase = 'done'
    c.record.jobId = null
    c.record.retryAt = null
    c.record.notes = scrubbed(c.record.notes)
    await e.store.putImport(c.record, txn)
    if (c.snapshot && runtime) {
      await txn.put('runtime', { ...runtime, origin: version, snapshotId: c.snapshot.handle.id, dirty: false, phase: 'busy', checkJobId: null, queryStarted: false } satisfies Runtime)
    }
    meta.version = version
    meta.nextVersion = version + 1
    if (meta.active === status.importId) meta.active = null
    meta.queue = meta.queue.filter((id) => id !== status.importId)
    meta.lastRestorePointAt = now
    meta.lastActivityAt = now
    meta.backupDue = true
    meta.removals = meta.removals.filter((r) => !c.record.removeDocumentIds.includes(r.documentId))
    if (c.record.kind === 'reread') meta.hidingAppliedAt = now
    // A removal that ran during a hold, ahead of a pending wake from a backup or a repair, brought the files back
    // itself into a new snapshot: that operation has nothing left to do.
    if (c.record.kind === 'remove' && c.snapshot && meta.op && meta.op.kind !== 'go_back') meta.op = null
    await txn.put('meta', meta)
    if (c.record.kind === 'remove') {
      const owed = (await txn.get<string[]>('removalCleanup')) ?? []
      await txn.put('removalCleanup', [...new Set([...owed, ...c.record.removeDocumentIds])])
    }
    if (c.changedDocumentIds?.length) {
      // Texts hidden more than before: exports and backups of earlier versions still hold their words.
      const owed = await txn.get<HiddenCleanup>('hiddenCleanup')
      await txn.put('hiddenCleanup', {
        before: Math.max(owed?.before ?? 0, version),
        at: now,
        documentIds: [...new Set([...(owed?.documentIds ?? []), ...c.changedDocumentIds])],
      } satisfies HiddenCleanup)
    }
    const event = { at: now, org: meta.org, collectionId: meta.collectionId }
    const appImport = c.importEvent !== false
    await e.store.addEvents(
      [
        {
          key: `committed:${meta.org}:${meta.collectionId}:${version}`,
          event: { ...event, type: 'committed', version, summary: point.summary, counts: point.counts, importId: appImport ? status.importId : null },
        },
        ...(appImport ? [{ key: `${meta.org}:${meta.collectionId}:import:${status.importId}:committed`, event: { ...event, type: 'import' as const, import: status } }] : []),
        // A re-read changed a passage a correction marked outdated: the correction asks to be checked.
        ...(c.needsCheck ?? []).flatMap((m) => {
          // The mark that holds the passage now: this one where it went (or stayed), or the one that took it over.
          const mark = c.state.marks.find((x) => x.documentId === m.documentId && x.textHash === (m.newTextHash ?? m.textHash))
          const note = mark && c.state.documents.find((d) => d.documentId === mark.noteDocumentId)
          if (!mark || !note?.noteId) return []
          const moved = !!m.newTextHash && m.newTextHash !== m.textHash
          // Merged passages went to a newer correction: the mark's own correction changed, even where it didn't move.
          const handedOver = !!m.noteDocumentId && m.noteDocumentId !== mark.noteDocumentId
          const replaces = moved || handedOver
          const was = m.noteDocumentId ? c.state.documents.find((d) => d.documentId === m.noteDocumentId) : undefined
          return [
            {
              key: `${meta.org}:${meta.collectionId}:needs_check:${version}:${mark.noteDocumentId}:${m.documentId}:${m.textHash}`,
              event: {
                ...event,
                type: 'needs_check' as const,
                noteId: note.noteId,
                documentId: m.documentId,
                textHash: mark.textHash,
                // The hash the mark had before this re-read (none when it neither moved nor changed hands, or couldn't
                // follow its passage), and the correction it belonged to (the retired one when merged passages went to
                // a newer correction, whether or not the mark moved), so the app replaces that mark's earlier check:
                // one check per mark, none left over for a dropped one.
                previousTextHash: replaces ? m.textHash : null,
                previousNoteId: replaces ? (was?.noteId ?? note.noteId) : null,
              },
            },
          ]
        }),
      ],
      txn,
    )
    committedMeta = meta
  })
  if (!committedMeta || !point) return false
  const done = point as RestorePointRecord
  await e.store.log('committed', { version: done.version, importId: c.record.status.importId, kind: done.kind, documents: done.counts.documents })
  // The commit stands whatever happens from here: each step's failure is logged, and deletions are tried again later.
  const step = async (name: string, work: () => Promise<unknown>) => {
    try {
      await work()
    } catch (error) {
      await e.store.log('after-commit-failed', { step: name, error: errorText(error) })
    }
  }
  if (c.snapshot) await step('usage', async () => e.chargeUsage(await e.usageKind()))
  await step('outbox', () => e.flushOutbox())
  if (c.record.capacity === 'granted') await step('capacity', () => giveBack(e, c.record))
  await deleteOriginals(e, c.record.files.map((f) => f.fileId))
  if (c.changedDocumentIds?.length) await step('facts', () => dropUnusedFacts(e))
  if (c.record.kind === 'remove' || c.changedDocumentIds?.length) {
    // The new latest backup is written first, so the files it shares with the backups dropped next stay stored
    // (and aren't uploaded again).
    const runtime = await e.store.getRuntime()
    if (runtime && e.box.running) await step('backup', () => backup.run(e, runtime))
  }
  if (c.changedDocumentIds?.length) await retryHiddenCleanup(e)
  if (c.record.kind === 'remove') {
    // Facts files and backups written while the removal waited may still hold the file: they go too (tried again
    // from the alarm until they have).
    await retryRemovalCleanup(e)
  }
  return true
}

interface HiddenCleanup {
  before: number // the version whose texts are hidden more: backups of earlier ones hold the words
  at: string // when it committed: exports made before then hold the words
  documentIds: string[]
}

/**
 * Stricter hiding changed documents' texts: ready exports that hold one are deleted, and the backups of earlier
 * versions that hold one are dropped (as a removal drops those holding its file). Tried again from the alarm.
 */
export async function retryHiddenCleanup(e: CollectionEngine): Promise<void> {
  const owed = await e.state.storage.get<HiddenCleanup>('hiddenCleanup')
  if (!owed) return
  try {
    for (const documentId of owed.documentIds) await exporter.dropContaining(e, documentId, owed.at)
    await backup.dropOlder(e, owed.before, owed.documentIds)
    const now = await e.state.storage.get<HiddenCleanup>('hiddenCleanup')
    if (now && (now.before !== owed.before || now.documentIds.length !== owed.documentIds.length)) return // more came meanwhile
    await e.state.storage.delete('hiddenCleanup')
  } catch (error) {
    await e.store.log('after-commit-failed', { step: 'hidden clean-up', error: errorText(error) })
  }
}

/** The clean-up a committed removal still owes: its facts in older facts files, and backups that hold it. */
export async function retryRemovalCleanup(e: CollectionEngine): Promise<void> {
  const owed = (await e.state.storage.get<string[]>('removalCleanup')) ?? []
  if (!owed.length) return
  try {
    await dropFacts(e, owed)
    for (const documentId of owed) await backup.dropDocument(e, documentId)
    const now = (await e.state.storage.get<string[]>('removalCleanup')) ?? []
    const left = now.filter((id) => !owed.includes(id))
    if (left.length) await e.state.storage.put('removalCleanup', left)
    else await e.state.storage.delete('removalCleanup')
  } catch (error) {
    await e.store.log('after-commit-failed', { step: 'removal clean-up', error: errorText(error) })
  }
}

function learnedNote(record: ImportRecord, fileId: string): string | undefined {
  const doc = ((record.result ?? {}) as IngestResult).documents?.find((d) => d.fileId === fileId)
  return doc?.truncated ? doc.reason ?? 'Only the first 2 MB of text was learned.' : undefined
}

function addChanges(a: ChangeCounts, b: ChangeCounts): ChangeCounts {
  const out = emptyChanges()
  for (const key of Object.keys(out) as (keyof ChangeCounts)[]) out[key] = (a[key] ?? 0) + (b[key] ?? 0)
  return out
}

/** A failed try: the container is thrown away. Three tries, then the failing file is named. */
async function attemptFailed(e: CollectionEngine, record: ImportRecord, failure: AttemptFailure): Promise<void> {
  await e.box.destroy('discarded after a failed try')
  await e.store.deleteRuntime()
  record.jobId = null
  record.snapshotTaken = false
  record.result = null
  const lastTry = failure.permanent || record.status.attempt >= SETTINGS.maxAttempts
  await e.store.log('import-try-failed', {
    importId: record.status.importId,
    attempt: record.status.attempt,
    failedFileId: failure.failedFileId,
    permanent: failure.permanent,
    reason: failure.message,
  })
  if (!lastTry) {
    // Tried again in place, as the active import (it can't be cancelled): the app hears it was interrupted.
    record.status.state = 'interrupted'
    record.status.attempt += 1
    record.phase = 'staging'
    record.retryAt = clock.now() + 15_000 * (record.status.attempt - 1)
    record.status.files = waitingFiles(record)
    await e.store.putImport(record)
    await tellApp(e, record, `interrupted:${record.status.attempt}`)
    await e.chargeUsage(null)
    return
  }
  const name = record.files.find((f) => f.fileId === failure.failedFileId)?.name
  const message = failure.permanent
    ? failure.message
    : name
      ? `Couldn't learn “${name}” after ${SETTINGS.maxAttempts} tries. The other files can be learned without it.`
      : `Couldn't learn this import after ${SETTINGS.maxAttempts} tries. Nothing from it was kept.`
  record.status.state = 'failed'
  record.status.error = { error: failure.code, message }
  record.status.finishedAt = iso()
  if (record.kind === 'export') {
    // The export as a whole failed (its zip goes): none of its documents was learned.
    record.status.failedFileId = null
    record.status.files = record.status.files.map((f) => ({ ...f, state: 'failed', reason: failure.message }))
  } else {
    record.status.failedFileId = failure.failedFileId
    record.status.files = record.files.map((f) =>
      f.fileId === failure.failedFileId ? { fileId: f.fileId, name: f.name, state: 'failed', reason: failure.message } : fileStatus(f),
    )
  }
  record.phase = 'done'
  record.retryAt = null
  record.notes = scrubbed(record.notes)
  await e.store.putImport(record)
  await e.updateMeta((m) => {
    if (m.active === record.status.importId) m.active = null
    if (record.kind === 'remove') m.removals = m.removals.filter((r) => !record.removeDocumentIds.includes(r.documentId))
  })
  if (record.textsSaved) {
    // Texts saved for later tries of an import that will never commit.
    const meta = await e.meta()
    const unused = [...record.files.filter((f) => !f.duplicateOf), ...record.notes].map((d) => textKey(meta, d.documentId))
    await deleteLater(e, unused)
  }
  await e.event(`import:${record.status.importId}:failed`, { type: 'import', import: record.status })
  await giveBack(e, record)
  // The failing file's original goes now; the others stay staged a day, so they can be learned without it.
  if (failure.failedFileId) await deleteOriginals(e, [failure.failedFileId])
  await e.chargeUsage(null)
  if (record.kind === 'remove') {
    // A removal must not be dropped: try it again from the start.
    await requeueRemoval(e, record)
  }
}

async function requeueRemoval(e: CollectionEngine, failed: ImportRecord): Promise<void> {
  for (const documentId of failed.removeDocumentIds) {
    const meta = await e.meta()
    if (meta.removals.some((r) => r.documentId === documentId)) continue
    await e.updateMeta((m) => {
      m.removals.push({ documentId, importId: failed.status.importId, version: failed.reserveVersion ?? m.nextVersion })
    })
  }
  failed.phase = 'queued'
  failed.capacity = 'none'
  failed.status.state = 'queued'
  failed.status.attempt = 1
  failed.status.error = null
  failed.status.finishedAt = null
  // A removal must happen, so it is tried again, but each round waits longer (its failure was reported once).
  failed.rounds = (failed.rounds ?? 0) + 1
  failed.retryAt = clock.now() + REMOVAL_BACKOFF_MS[Math.min(failed.rounds, REMOVAL_BACKOFF_MS.length) - 1]
  await e.store.putImport(failed)
  await enqueue(e, failed)
}

const REMOVAL_BACKOFF_MS = [60_000, 10 * 60_000, 60 * 60_000, 6 * 60 * 60_000]

/** Deletes originals from the inbox. If R2 refuses, the keys are kept and deleted again on a later alarm. */
async function deleteOriginals(e: CollectionEngine, fileIds: string[]): Promise<void> {
  if (!fileIds.length) return
  const meta = await e.meta()
  await e.store.deleteStaged(fileIds)
  await deleteLater(e, fileIds.map((id) => inboxKey(meta, id)))
}

export async function deleteLater(e: CollectionEngine, keys: string[]): Promise<void> {
  const pending = [...new Set([...((await e.state.storage.get<string[]>('pendingDeletes')) ?? []), ...keys])]
  try {
    if (pending.length) await e.env.FILES.delete(pending)
    await e.state.storage.delete('pendingDeletes')
  } catch (error) {
    await e.state.storage.put('pendingDeletes', pending)
    await e.store.log('delete-failed', { keys: pending.length, error: errorText(error) })
  }
}

export { EngineFailure }

/** Remove for good: every stored facts file, of any version, is written again without the documents' facts. */
export async function dropFacts(e: CollectionEngine, documentIds: string[]): Promise<void> {
  const meta = await e.meta()
  const gone = new Set(documentIds)
  let cursor: string | undefined
  do {
    const listed = await e.env.FILES.list({ prefix: `text/${meta.org}/${meta.collectionId}/facts/`, cursor })
    for (const { key } of listed.objects) {
      const object = await e.env.FILES.get(key)
      if (!object) continue
      const stored = (await object.json()) as { facts?: { documentId: string }[] }
      const kept = (stored.facts ?? []).filter((f) => !gone.has(f.documentId))
      if (kept.length !== (stored.facts ?? []).length) {
        await e.env.FILES.put(key, JSON.stringify({ ...stored, facts: kept }), { httpMetadata: { contentType: 'application/json' } })
      }
    }
    cursor = listed.truncated ? listed.cursor : undefined
  } while (cursor)
}

/**
 * Stricter hiding: facts files that only restore points that can no longer be restored use hold text that is hidden
 * now. They are deleted; the current facts and those of restorable points stay.
 */
export async function dropUnusedFacts(e: CollectionEngine): Promise<void> {
  const meta = await e.meta()
  const used = new Set<string>()
  for (const point of await e.store.listPoints()) {
    if (point.version !== meta.version && (point.folded || point.blocked)) continue
    const state = await e.store.getState(point.version)
    if (state?.factsKey) used.add(state.factsKey)
  }
  let cursor: string | undefined
  do {
    const listed = await e.env.FILES.list({ prefix: `text/${meta.org}/${meta.collectionId}/facts/`, cursor })
    const unused = listed.objects.map((o) => o.key).filter((key) => !used.has(key))
    if (unused.length) await e.env.FILES.delete(unused)
    cursor = listed.truncated ? listed.cursor : undefined
  } while (cursor)
}
