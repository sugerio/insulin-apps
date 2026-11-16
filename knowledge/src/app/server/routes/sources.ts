import { Hono } from 'hono'
import { z } from 'zod'
import type { HidingRules, ImportFile, ImportStatus } from '../../../../engine/src/contract.ts'
import { authorize, ownerName, type CollectionRow } from '../access.ts'
import { EngineCallError, type EngineClient } from '../engine/client.ts'
import type { AppEnv, Bindings } from '../env.ts'
import { ApiError, badRequest, notFound, readJson } from '../http.ts'
import { idempotent, stableId } from '../idempotency.ts'
import type { Caller } from '../identity.ts'
import { effectiveLimit, ensureAwakeBlock, quotaExceeded, release, reservationsOf, reserve, resetsAt, supportSentence, usageOf, type LimitKey } from '../limits.ts'
import { finishImport } from '../outbox.ts'
import { hiddenNote } from '../kept.ts'
import { readOrgSettings } from '../settings.ts'
import { FILE_ID, inspect, sha256Hex, TooLargeError, verdictOf } from '../uploads.ts'
import { fetchWebPage } from '../web-pages.ts'
import { callerOf, engineFor, json, now, param } from './common.ts'

/** At most this much text is learned from one file. */
const MAX_TEXT_BYTES = 2 * 1024 * 1024
/** Notes the engine takes, in characters. */
export const MAX_NOTE_CHARS = 20_000
/** Files whose text can be far larger than the file itself (compressed formats): they reserve the most one file keeps. */
const COMPRESSED = new Set(['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.openxmlformats-officedocument.presentationml.presentation', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'])
/** Reading a file's text can make it longer than the file: a byte that isn't valid UTF-8 becomes "�", 3 bytes. */
const DECODE_GROWTH = 3
/** What hiding puts in place of each value it finds: "[hidden]". */
const HIDDEN_BYTES = 8
/** The built-in kinds hide values that, with what labels them, take at least half as many bytes as "[hidden]". */
const BUILT_IN_GROWTH = 2

/**
 * How many times longer hiding can make a text, at most. Each value hidden becomes "[hidden]" (8 bytes): the built-in
 * kinds (addresses, phone numbers, cards, keys, labelled secrets) at most double a text; the organization's own words
 * grow it by 8 bytes over the shortest word's length (a two-letter word, four times).
 */
export function hidingGrowth(rules: Pick<HidingRules, 'words'>): number {
  const lengths = (rules.words ?? []).map((word) => new TextEncoder().encode(word.trim()).byteLength).filter((length) => length > 0)
  return lengths.length ? Math.max(BUILT_IN_GROWTH, Math.ceil(HIDDEN_BYTES / Math.min(...lengths))) : BUILT_IN_GROWTH
}

/**
 * The most stored text a file can come to, after reading and hiding with the organization's rules: what an import
 * reserves of stored bytes. The engine learns at most 2 MB of a file's text before hiding.
 */
export function storedBound(file: { type: string; bytes: number }, rules: Pick<HidingRules, 'words'>): number {
  return hidingGrowth(rules) * (COMPRESSED.has(file.type) ? MAX_TEXT_BYTES : Math.min(DECODE_GROWTH * file.bytes, MAX_TEXT_BYTES))
}

/** The same bound for a note: its title and text, hidden. */
export function noteBound(note: { title: string; text: string }, rules: Pick<HidingRules, 'words'>): number {
  return hidingGrowth(rules) * new TextEncoder().encode(`${note.title}\n\n${note.text}`).byteLength
}

export type ImportRequestBody = { files: ImportFile[]; notes: { noteId: string; title: string; text: string; outdated: { documentId: string; textHash: string }[] }[] }
export type ImportKind = 'files' | 'web_page' | 'note' | 'correction'

/**
 * An import waiting for the 1st, as kept in D1 (`imports.request`): what it sends then, the 1st it waits for, and the
 * files the engine no longer had when asked to keep them, taken out of it to be added again. Its notes are kept with
 * the organization's hidden values hidden (`hidden`: an older row without it is hidden by the tick).
 */
export type WaitingRequest = ImportRequestBody & { waitsFor?: string; lost?: { fileId: string; name: string }[]; hidden?: boolean }

/** An import kept for the 1st of next month, when the organization has used this month's documents learned. */
export interface Waiting {
  until: string
  message: string
}

const DAY_MS = 24 * 60 * 60 * 1000
/** A waiting import, its files and its reservations are kept this long past the 1st, so a late start loses nothing. */
const KEPT_PAST_FIRST_MS = 2 * DAY_MS
/** The engine keeps staged files for a waiting import at most 45 days; a day less leaves room for clocks that differ. */
const MAX_KEEP_MS = 44 * DAY_MS

/** Until when a waiting import, its files and its reservations are kept: a little past the 1st it waits for. */
export function keptUntil(at: number): number {
  return Math.min(Date.parse(resetsAt(at)) + KEPT_PAST_FIRST_MS, at + MAX_KEEP_MS)
}

/**
 * Puts an import to wait for the next 1st. The engine clears staged files after a day, so it is asked to keep the
 * import's files until a little past the 1st; files it no longer had are taken out of the import, as `lost`.
 */
export async function waitForNextMonth(engine: EngineClient, collectionId: string, request: WaitingRequest, at: number): Promise<WaitingRequest> {
  const waiting: WaitingRequest = { files: request.files, notes: request.notes, waitsFor: resetsAt(at), lost: request.lost ?? [] }
  if (!request.files.length) return waiting
  const { kept } = await engine.keepStaged(collectionId, { fileIds: request.files.map((file) => file.fileId), until: new Date(keptUntil(at)).toISOString() })
  const held = new Set(kept)
  waiting.files = request.files.filter((file) => held.has(file.fileId))
  waiting.lost = [...waiting.lost!, ...request.files.filter((file) => !held.has(file.fileId)).map(({ fileId, name }) => ({ fileId, name }))]
  return waiting
}

/** "“Old.md”", "“Old.md” and “Older.md”", "3 files". */
function namesOf(files: { name: string }[]): string {
  if (files.length === 1) return `“${files[0]!.name}”`
  if (files.length === 2) return `“${files[0]!.name}” and “${files[1]!.name}”`
  return `${files.length} files`
}

/** Why a file isn't in a waiting import any more, in plain words. */
const LOST_REASON = 'Insulin couldn\'t keep this file until then. Add it again.'

/** Whether an engine failure says the engine didn't take the work (a refusal), as opposed to not knowing. */
export function refused(error: unknown): boolean {
  return error instanceof EngineCallError && error.status >= 400 && error.status < 500
}

/** What a waiting import looks like to the screens and to API clients: an import that hasn't started yet. */
export function waitingStatus(importId: string, request: WaitingRequest, createdAt: number): Record<string, unknown> {
  return {
    importId, state: 'waiting', attempt: 0, queuePosition: null, waitingFor: 'month',
    files: [
      ...request.files.map((file) => ({ fileId: file.fileId, name: file.name, state: 'waiting' })),
      ...(request.lost ?? []).map((file) => ({ fileId: file.fileId, name: file.name, state: 'failed', reason: LOST_REASON })),
    ],
    notes: request.notes.length,
    version: null, newFacts: null, failedFileId: null, error: null, etaSeconds: null, createdAt: new Date(createdAt).toISOString(), finishedAt: null,
  }
}

function waitingFor(env: Bindings, at: number, lost: { name: string }[] = []): Waiting {
  const until = resetsAt(at)
  const day = new Date(until).toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' })
  const gone = lost.length ? ` Insulin couldn't keep ${namesOf(lost)} until then: add ${lost.length === 1 ? 'it' : 'them'} again.` : ''
  return { until, message: `Your organization has learned this month's documents, so these wait and are learned on ${day}, by themselves. Everything already learned keeps answering.${gone} ${supportSentence(env)}` }
}

/**
 * Starts an import in the engine, its use reserved first: the awake-hours stop and a block of awake time, then
 * documents and stored bytes (refused at their limit, nothing started), then documents learned this month. At that
 * monthly limit the import isn't refused: it waits, kept with its reservations, and the tick starts it on the 1st.
 *
 * `importId` is the request's stable id (idempotency.ts): sent again after an answer that was lost, the same import
 * is found, in D1 and in the engine, and nothing is reserved or learned twice. Reservations are released only when
 * the engine refused the import; when it can't be known whether the engine took it, they stay for the outbox (or the
 * retry) to settle. They are settled when the import commits and released when it fails (outbox.ts).
 */
export async function startImport(
  env: Bindings,
  engine: EngineClient,
  caller: Caller,
  collection: CollectionRow,
  kind: ImportKind,
  request: ImportRequestBody,
  at: number,
  importId: string = crypto.randomUUID(),
): Promise<{ status: ImportStatus | ReturnType<typeof waitingStatus>; waiting: Waiting | null }> {
  const db = env.DB
  const org = caller.organizationId
  const existing = await db.prepare(`SELECT state, created_at, request FROM imports WHERE id = ? AND org_id = ? AND collection_id = ?`).bind(importId, org, collection.id).first<{ state: string; created_at: number; request: string | null }>()
  if (existing?.state === 'waiting') {
    const waiting = JSON.parse(existing.request ?? '{"files":[],"notes":[]}') as WaitingRequest
    return { status: waitingStatus(importId, waiting, existing.created_at), waiting: waitingFor(env, at, waiting.lost) }
  }
  if (!existing) {
    await ensureAwakeBlock(env, org, collection.id, at)
    const documents = request.files.length + request.notes.length
    const { hiding } = await readOrgSettings(db, org, at)
    const stored = request.files.reduce((sum, file) => sum + storedBound(file, hiding), 0) + request.notes.reduce((sum, note) => sum + noteBound(note, hiding), 0)
    const ref = `import:${importId}`
    const standing = await reserve(env, org, [{ key: 'documents', amount: documents }, { key: 'storage_bytes', amount: stored }], ref, at)
    const detail = JSON.stringify({ files: request.files.map((file) => file.name) })
    try {
      await reserve(env, org, [{ key: 'learned_month', amount: documents }], ref, at)
    } catch (error) {
      if (!(error instanceof ApiError && error.code === 'quota_exceeded')) {
        await release(db, org, standing.map((reservation) => reservation.id), at)
        throw error
      }
      // This month's documents learned are used up: the import waits for the 1st, keeping its place, and the engine
      // keeps its files until then. Files it no longer has are named, to be added again; with none left, nothing waits.
      let waiting: WaitingRequest
      try {
        // Its notes are kept hidden, as the engine would learn them: Knowledge keeps no hidden value.
        waiting = { ...(await waitForNextMonth(engine, collection.id, request, at)), hidden: true }
        waiting.notes = waiting.notes.map((note) => hiddenNote(note, hiding))
      } catch (failure) {
        await release(db, org, standing.map((reservation) => reservation.id), at)
        throw failure
      }
      if (!waiting.files.length && !waiting.notes.length) {
        await release(db, org, standing.map((reservation) => reservation.id), at)
        throw badRequest(`Insulin no longer has ${namesOf(waiting.lost!)}. Add ${waiting.lost!.length === 1 ? 'it' : 'them'} again.`)
      }
      await db.batch([
        db.prepare(`UPDATE reservations SET expires_at = ? WHERE org_id = ? AND ref = ? AND state = 'held'`).bind(keptUntil(at), org, ref),
        db.prepare(`INSERT INTO imports (id, org_id, collection_id, kind, created_by, created_at, state, files, detail, request) VALUES (?, ?, ?, ?, ?, ?, 'waiting', ?, ?, ?)`)
          .bind(importId, org, collection.id, kind, caller.id, at, request.files.length, detail, JSON.stringify(waiting)),
      ])
      return { status: waitingStatus(importId, waiting, at), waiting: waitingFor(env, at, waiting.lost) }
    }
    await db.prepare(
      `INSERT INTO imports (id, org_id, collection_id, kind, created_by, created_at, state, files, detail) VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
    ).bind(importId, org, collection.id, kind, caller.id, at, request.files.length, detail).run()
  }
  return { status: await submitImport(env, engine, org, collection, kind, request, importId, at), waiting: null }
}

/**
 * Sends a reserved import to the engine (see startImport). When the engine refuses it, its reservations are freed and
 * the import is forgotten (`delete`: the person sees the refusal) or recorded as failed and its starter told (`fail`:
 * an import that waited for the 1st, when nobody is there to see it).
 */
export async function submitImport(env: Bindings, engine: EngineClient, org: string, collection: CollectionRow, kind: ImportKind, request: ImportRequestBody, importId: string, at: number, options: { onRefused: 'delete' | 'fail' } = { onRefused: 'delete' }): Promise<ImportStatus> {
  const db = env.DB
  let status: ImportStatus
  try {
    const small = kind === 'note' || kind === 'correction'
    status = kind === 'correction'
      ? await engine.correct(collection.id, { importId, note: request.notes[0]! })
      : await engine.startImport(collection.id, { importId, files: request.files, notes: request.notes, small })
  } catch (error) {
    if (refused(error) && options.onRefused === 'fail') {
      await failWaiting(env, org, collection, importId, request.files, at)
    } else if (refused(error)) {
      const held = await reservationsOf(db, org, `import:${importId}`)
      await release(db, org, held.map((reservation) => reservation.id), at)
      await db.prepare(`DELETE FROM imports WHERE id = ? AND org_id = ?`).bind(importId, org).run()
    }
    throw error
  }
  await finishImport(env, org, collection, importId, status, at)
  return status
}

/** A waiting import that can't be learned now (the engine no longer has its files) fails, and its starter is told. */
export async function failWaiting(env: Bindings, org: string, collection: CollectionRow, importId: string, files: { fileId: string; name: string }[], at: number): Promise<void> {
  const message = files.length ? `Insulin no longer has ${namesOf(files)}. Add ${files.length === 1 ? 'it' : 'them'} again.` : 'Insulin couldn\'t learn this note. Write it again.'
  await finishImport(env, org, collection, importId, { state: 'failed', error: { error: 'bad_request', message }, files: files.map((file) => ({ fileId: file.fileId, name: file.name, state: 'failed', reason: message })) }, at)
}

export function sourceRoutes() {
  const app = new Hono<AppEnv>()

  // Before adding files: which can be learned, and whether they fit the organization's limits. Nothing is reserved yet.
  app.post('/:id/preflight', async (c) => {
    const caller = callerOf(c)
    const body = await readJson(c, z.object({
      files: z.array(z.object({ name: z.string().trim().min(1).max(255), bytes: z.number().int().min(0), type: z.string().max(200).optional() })).min(1).max(100),
    }))
    const db = c.env.DB
    const at = now(c)
    const { collection } = await authorize(db, caller, param(c, 'id'), 'change')
    const fileLimit = await effectiveLimit(db, caller.organizationId, 'file_bytes', at)
    const { hiding } = await readOrgSettings(db, caller.organizationId, at)
    const verdicts = body.files.map((file) => ({ file, verdict: verdictOf(file.name, file.bytes, fileLimit) }))
    const accepted = verdicts.filter((entry) => entry.verdict.ok)
    // The rest must fit the organization's limits: documents and stored bytes. Past this month's documents learned
    // they are still taken: their import waits for the 1st (startImport).
    const usage = await usageOf(db, caller.organizationId, at)
    const need: [LimitKey, number][] = [
      ['documents', accepted.length],
      ['storage_bytes', accepted.reduce((sum, entry) => sum + storedBound({ type: entry.verdict.ok ? entry.verdict.type : '', bytes: entry.file.bytes }, hiding), 0)],
    ]
    for (const [key, amount] of need) {
      const limit = await effectiveLimit(db, caller.organizationId, key, at)
      const entry = usage[key]
      if (limit !== null && amount > 0 && entry && entry.used + entry.reserved + amount > limit) throw quotaExceeded(c.env, key, limit, at)
    }
    const files = []
    const statements: D1PreparedStatement[] = []
    for (const { file, verdict } of verdicts) {
      if (!verdict.ok) {
        files.push({ name: file.name, bytes: file.bytes, accepted: false, reason: verdict.reason })
        continue
      }
      const fileId = crypto.randomUUID().replace(/-/g, '')
      statements.push(db.prepare(
        `INSERT INTO staged_files (id, org_id, collection_id, name, type, bytes, state, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, 'expected', ?, ?)`,
      ).bind(fileId, caller.organizationId, collection.id, file.name, verdict.type, file.bytes, caller.id, at))
      files.push({ name: file.name, bytes: file.bytes, accepted: true, fileId })
    }
    if (statements.length) await db.batch(statements)
    return json(c, { files, accepted: accepted.length, refused: verdicts.length - accepted.length })
  })

  // A file preflight accepted, streamed to the engine's inbox (its optional x-file-sha256 is checked there). A PDF with
  // no text at all is named here, before learning.
  app.put('/:id/uploads/:fileId', async (c) => {
    const caller = callerOf(c)
    const db = c.env.DB
    const at = now(c)
    const { collection } = await authorize(db, caller, param(c, 'id'), 'change')
    const fileId = param(c, 'fileId')
    if (!FILE_ID.test(fileId)) throw notFound('There is no such file. Run preflight first.')
    const staged = await db.prepare(`SELECT * FROM staged_files WHERE id = ? AND org_id = ? AND collection_id = ? AND state IN ('expected', 'staged')`)
      .bind(fileId, caller.organizationId, collection.id).first<{ name: string; type: string; bytes: number }>()
    if (!staged) throw notFound('There is no such file waiting to be uploaded. Run preflight first.')
    const fileLimit = (await effectiveLimit(db, caller.organizationId, 'file_bytes', at)) ?? Number.MAX_SAFE_INTEGER
    if (!c.req.raw.body) throw badRequest('Send the file as the request body.')
    if (Number(c.req.header('content-length') ?? 0) > fileLimit) throw quotaExceeded(c.env, 'file_bytes', fileLimit, at)
    const engine = engineFor(c)
    const pdf = staged.type === 'application/pdf'
    const declared = c.req.header('x-file-sha256')?.trim().toLowerCase()
    let result: { fileId: string; bytes: number; sha256: string }
    let scannedPdf = false
    // Streamed on to the engine, which computes the SHA-256 (and checks the one sent, when there is one).
    const watched = inspect(c.req.raw.body, fileLimit, pdf)
    try {
      result = await engine.stage(collection.id, fileId, watched.stream, { name: staged.name, type: staged.type, ...(declared && /^[0-9a-f]{64}$/.test(declared) ? { sha256: declared } : {}) })
      scannedPdf = watched.result().scannedPdf
    } catch (error) {
      // Past the limit the stream stops on its way, and the engine sees a broken body: the limit is what to say.
      if (error instanceof TooLargeError || watched.result().bytes > fileLimit) throw quotaExceeded(c.env, 'file_bytes', fileLimit, at)
      throw error
    }
    const reason = scannedPdf ? `“${staged.name}” is a scanned image with no text. Upload a PDF with text, or a Word file.` : null
    await db.prepare(`UPDATE staged_files SET state = ?, reason = ?, sha256 = ?, bytes = ? WHERE id = ? AND org_id = ?`)
      .bind(reason ? 'refused' : 'staged', reason, result.sha256, result.bytes, fileId, caller.organizationId).run()
    return json(c, { fileId, bytes: result.bytes, sha256: result.sha256, accepted: !reason, reason })
  })

  // Learn uploaded files, all or nothing.
  app.post('/:id/imports', async (c) => {
    const caller = callerOf(c)
    const body = await readJson(c, z.object({ fileIds: z.array(z.string().regex(FILE_ID)).min(1).max(100) }).strict())
    const { collection } = await authorize(c.env.DB, caller, param(c, 'id'), 'change')
    return idempotent(c, body, true, async () => {
      const db = c.env.DB
      const at = now(c)
      const ids = [...new Set(body.fileIds)]
      const importId = await stableId(c)
      // One parameter for every file id (D1 binds at most 100 per statement).
      const { results } = await db.prepare(
        `SELECT id, name, type, bytes, sha256, state, reason, import_id FROM staged_files WHERE org_id = ?1 AND collection_id = ?2 AND id IN (SELECT value FROM json_each(?3))`,
      ).bind(caller.organizationId, collection.id, JSON.stringify(ids)).all<{ id: string; name: string; type: string; bytes: number; sha256: string | null; state: string; reason: string | null; import_id: string | null }>()
      for (const id of ids) {
        const file = results.find((row) => row.id === id)
        if (!file) throw notFound('One of these files was never uploaded. Run preflight and upload it first.')
        if (file.state === 'refused') throw badRequest(file.reason ?? `“${file.name}” can't be learned.`, { fileId: id })
        if (file.state === 'expected') throw badRequest(`“${file.name}” hasn't been uploaded yet.`, { fileId: id })
        if (file.state === 'used' && file.import_id !== importId) throw badRequest(`“${file.name}” was already added. Upload it again to add it again.`, { fileId: id })
      }
      const engine = engineFor(c)
      const files: ImportFile[] = results.map((file) => ({ fileId: file.id, name: file.name, type: file.type, bytes: file.bytes, sha256: file.sha256 ?? '' }))
      const { status, waiting } = await startImport(c.env, engine, caller, collection, 'files', { files, notes: [] }, at, importId)
      await db.prepare(`UPDATE staged_files SET state = 'used', import_id = ?1 WHERE org_id = ?2 AND collection_id = ?3 AND id IN (SELECT value FROM json_each(?4))`)
        .bind(importId, caller.organizationId, collection.id, JSON.stringify(ids)).run()
      return json(c, { import: status, waiting }, 202)
    })
  })

  app.get('/:id/imports/:importId', async (c) => {
    const caller = callerOf(c)
    const { collection } = await authorize(c.env.DB, caller, param(c, 'id'), 'read')
    const importId = param(c, 'importId')
    const row = await c.env.DB.prepare(`SELECT id, state, request, error, created_at, finished_at FROM imports WHERE id = ? AND org_id = ? AND collection_id = ?`).bind(importId, caller.organizationId, collection.id)
      .first<{ id: string; state: string; request: string | null; error: string | null; created_at: number; finished_at: number | null }>()
    if (!row) throw notFound('There is no such import in this collection.')
    if (row.state === 'waiting') {
      const waiting = JSON.parse(row.request ?? '{"files":[],"notes":[]}') as WaitingRequest
      return json(c, { import: waitingStatus(importId, waiting, row.created_at), waiting: waitingFor(c.env, now(c), waiting.lost) })
    }
    // A waiting import that failed or was cancelled before the engine had it is answered from what Knowledge recorded.
    const status = await engineFor(c).getImport(collection.id, importId)
      .catch((error) => (error instanceof EngineCallError && error.status === 404 && (row.state === 'failed' || row.state === 'cancelled') ? null : Promise.reject(error)))
    if (!status) {
      return json(c, {
        import: {
          importId, state: row.state, attempt: 0, queuePosition: null, waitingFor: null, files: [], notes: 0, version: null, newFacts: null, failedFileId: null,
          error: row.error ? { error: 'bad_request', message: row.error } : null, etaSeconds: null, createdAt: new Date(row.created_at).toISOString(), finishedAt: row.finished_at === null ? null : new Date(row.finished_at).toISOString(),
        },
      })
    }
    await finishImport(c.env, caller.organizationId, collection, importId, status, now(c))
    return json(c, { import: status })
  })

  // A note: learned like a file, ahead of normal imports.
  app.post('/:id/notes', async (c) => {
    const caller = callerOf(c)
    const body = await readJson(c, z.object({ title: z.string().trim().max(200).optional(), text: z.string().trim().min(1, 'write the note').max(MAX_NOTE_CHARS, 'a note can be up to 20,000 characters; split a longer one, or add it as a file') }).strict())
    const { collection } = await authorize(c.env.DB, caller, param(c, 'id'), 'change')
    return idempotent(c, body, true, async () => {
      const importId = await stableId(c)
      const note = { noteId: importId.replace(/-/g, ''), title: body.title ?? '', text: body.text, outdated: [] }
      const { status, waiting } = await startImport(c.env, engineFor(c), caller, collection, 'note', { files: [], notes: [note] }, now(c), importId)
      return json(c, { import: status, waiting }, 202)
    })
  })

  // A public web page, fetched by the app and learned as an HTML file. Adding it again reads it again.
  app.post('/:id/web-pages', async (c) => {
    const caller = callerOf(c)
    const body = await readJson(c, z.object({ url: z.string().trim().min(1).max(2000) }).strict())
    const { collection } = await authorize(c.env.DB, caller, param(c, 'id'), 'change')
    return idempotent(c, body, true, async () => {
      const at = now(c)
      const engine = engineFor(c)
      const page = await fetchWebPage(body.url, c.env.WEB_FETCH ?? fetch)
      const fileLimit = await effectiveLimit(c.env.DB, caller.organizationId, 'file_bytes', at)
      if (fileLimit !== null && page.html.byteLength > fileLimit) throw quotaExceeded(c.env, 'file_bytes', fileLimit, at)
      const fileId = crypto.randomUUID().replace(/-/g, '')
      const name = `${page.title.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').trim().slice(0, 150) || 'Web page'}.html`
      const staged = await engine.stage(collection.id, fileId, page.html, { name, type: page.type, sha256: await sha256Hex(page.html), bytes: page.html.byteLength })
      const { status, waiting } = await startImport(c.env, engine, caller, collection, 'web_page', { files: [{ fileId, name, type: page.type, bytes: staged.bytes, sha256: staged.sha256 }], notes: [] }, at, await stableId(c))
      return json(c, { import: status, waiting, page: { url: page.url, title: page.title } }, 202)
    })
  })

  app.get('/:id/sources', async (c) => {
    const caller = callerOf(c)
    const { collection } = await authorize(c.env.DB, caller, param(c, 'id'), 'read')
    const { documents } = await engineFor(c).documents(collection.id)
    return json(c, { sources: documents })
  })

  // One source's text at the exact words: redacted, with its pages, its owner (the collection's) and when it was added.
  app.get('/:id/sources/:docId', async (c) => {
    const caller = callerOf(c)
    const { collection } = await authorize(c.env.DB, caller, param(c, 'id'), 'read')
    const source = await engineFor(c).document(collection.id, param(c, 'docId'))
    return json(c, { source, owner: { id: collection.owner_id, name: await ownerName(c.env.DB, collection) }, lastEdit: source.document.addedAt, collection: { id: collection.id, name: collection.name } })
  })

  // Stop using a file (kept, not used for answers) or use it again.
  app.patch('/:id/sources/:docId', async (c) => {
    const caller = callerOf(c)
    const body = await readJson(c, z.object({ active: z.boolean() }).strict())
    const { collection } = await authorize(c.env.DB, caller, param(c, 'id'), 'change')
    return json(c, { import: await engineFor(c).setDocumentActive(collection.id, param(c, 'docId'), body.active) })
  })

  // Remove for good: the collection's Owner or an Admin.
  app.delete('/:id/sources/:docId', async (c) => {
    const caller = callerOf(c)
    const { collection } = await authorize(c.env.DB, caller, param(c, 'id'), 'remove')
    // The engine learns the collection again without it: awake time like any import, counted from the engine's
    // ledger. It isn't refused at the awake-hours stop: removing what shouldn't be kept always goes ahead.
    await ensureAwakeBlock(c.env, caller.organizationId, collection.id, now(c), { allowAtStop: true })
    const result = await engineFor(c).removeDocument(collection.id, param(c, 'docId'))
    return json(c, { removed: result })
  })

  return app
}

