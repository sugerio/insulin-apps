import { Hono } from 'hono'
import { z } from 'zod'
import type { ImportFile, ImportStatus } from '../../../../engine/src/contract.ts'
import { authorize, ownerName, type CollectionRow } from '../access.ts'
import type { EngineClient } from '../engine/client.ts'
import type { AppEnv, Bindings } from '../env.ts'
import { badRequest, notFound, readJson } from '../http.ts'
import { idempotent } from '../idempotency.ts'
import type { Caller } from '../identity.ts'
import { effectiveLimit, quotaExceeded, release, reserve, usageOf, type LimitKey } from '../limits.ts'
import { finishImport } from '../outbox.ts'
import { FILE_ID, inspect, sha256Hex, TooLargeError, verdictOf } from '../uploads.ts'
import { fetchWebPage } from '../web-pages.ts'
import { callerOf, engineFor, json, now, param } from './common.ts'

/** At most this much text is learned from one file, so a file reserves at most this much of the stored bytes. */
const MAX_TEXT_BYTES = 2 * 1024 * 1024

/**
 * Starts an import in the engine with its use reserved first (documents, stored bytes, documents learned this month),
 * all or nothing: refused at a limit with nothing started, released if the engine refuses. The reservations are
 * settled when the import commits and released when it fails (outbox.ts).
 */
export async function startImport(
  env: Bindings,
  engine: EngineClient,
  caller: Caller,
  collection: CollectionRow,
  kind: 'files' | 'web_page' | 'note' | 'correction',
  request: { files: ImportFile[]; notes: { noteId: string; title: string; text: string; outdated: { documentId: string; textHash: string }[] }[] },
  at: number,
  importId = crypto.randomUUID(),
): Promise<ImportStatus> {
  const db = env.DB
  const documents = request.files.length + request.notes.length
  const textBytes = request.files.reduce((sum, file) => sum + Math.min(file.bytes, MAX_TEXT_BYTES), 0)
    + request.notes.reduce((sum, note) => sum + new TextEncoder().encode(`${note.title}\n\n${note.text}`).byteLength, 0)
  const reservations = await reserve(env, caller.organizationId, [
    { key: 'documents', amount: documents },
    { key: 'storage_bytes', amount: textBytes },
    { key: 'learned_month', amount: documents },
  ], `import:${importId}`, at)
  await db.prepare(
    `INSERT INTO imports (id, org_id, collection_id, kind, created_by, created_at, state, files, detail) VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
  ).bind(importId, caller.organizationId, collection.id, kind, caller.id, at, request.files.length, JSON.stringify({ files: request.files.map((file) => file.name) })).run()
  let status: ImportStatus
  try {
    const small = kind === 'note' || kind === 'correction'
    status = kind === 'correction'
      ? await engine.correct(collection.id, { importId, note: request.notes[0]! })
      : await engine.startImport(collection.id, { importId, files: request.files, notes: request.notes, small })
  } catch (error) {
    await release(db, caller.organizationId, reservations.map((reservation) => reservation.id), at)
    await db.prepare(`DELETE FROM imports WHERE id = ? AND org_id = ?`).bind(importId, caller.organizationId).run()
    throw error
  }
  await finishImport(env, caller.organizationId, collection, importId, status, at)
  return status
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
    const verdicts = body.files.map((file) => ({ file, verdict: verdictOf(file.name, file.bytes, fileLimit) }))
    const accepted = verdicts.filter((entry) => entry.verdict.ok)
    // The rest must fit the organization's limits: documents, stored bytes, documents learned this month.
    const usage = await usageOf(db, caller.organizationId, at)
    const need: [LimitKey, number][] = [
      ['documents', accepted.length],
      ['storage_bytes', accepted.reduce((sum, entry) => sum + Math.min(entry.file.bytes, MAX_TEXT_BYTES), 0)],
      ['learned_month', accepted.length],
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
      const { results } = await db.prepare(
        `SELECT id, name, type, bytes, sha256, state, reason FROM staged_files WHERE org_id = ?1 AND collection_id = ?2 AND id IN (${ids.map((_, index) => `?${index + 3}`).join(', ')})`,
      ).bind(caller.organizationId, collection.id, ...ids).all<{ id: string; name: string; type: string; bytes: number; sha256: string | null; state: string; reason: string | null }>()
      for (const id of ids) {
        const file = results.find((row) => row.id === id)
        if (!file) throw notFound('One of these files was never uploaded. Run preflight and upload it first.')
        if (file.state === 'refused') throw badRequest(file.reason ?? `“${file.name}” can't be learned.`, { fileId: id })
        if (file.state === 'expected') throw badRequest(`“${file.name}” hasn't been uploaded yet.`, { fileId: id })
        if (file.state === 'used') throw badRequest(`“${file.name}” was already added. Upload it again to add it again.`, { fileId: id })
      }
      const engine = engineFor(c)
      const importId = crypto.randomUUID()
      const files: ImportFile[] = results.map((file) => ({ fileId: file.id, name: file.name, type: file.type, bytes: file.bytes, sha256: file.sha256 ?? '' }))
      const status = await startImport(c.env, engine, caller, collection, 'files', { files, notes: [] }, at, importId)
      await db.prepare(`UPDATE staged_files SET state = 'used', import_id = ?1 WHERE org_id = ?2 AND collection_id = ?3 AND id IN (${ids.map((_, index) => `?${index + 4}`).join(', ')})`)
        .bind(importId, caller.organizationId, collection.id, ...ids).run()
      return json(c, { import: status }, 202)
    })
  })

  app.get('/:id/imports/:importId', async (c) => {
    const caller = callerOf(c)
    const { collection } = await authorize(c.env.DB, caller, param(c, 'id'), 'read')
    const importId = param(c, 'importId')
    const row = await c.env.DB.prepare(`SELECT id FROM imports WHERE id = ? AND org_id = ? AND collection_id = ?`).bind(importId, caller.organizationId, collection.id).first()
    if (!row) throw notFound('There is no such import in this collection.')
    const status = await engineFor(c).getImport(collection.id, importId)
    await finishImport(c.env, caller.organizationId, collection, importId, status, now(c))
    return json(c, { import: status })
  })

  // A note: learned like a file, ahead of normal imports.
  app.post('/:id/notes', async (c) => {
    const caller = callerOf(c)
    const body = await readJson(c, z.object({ title: z.string().trim().max(200).optional(), text: z.string().trim().min(1, 'write the note').max(100_000) }).strict())
    const { collection } = await authorize(c.env.DB, caller, param(c, 'id'), 'change')
    return idempotent(c, body, true, async () => {
      const note = { noteId: crypto.randomUUID().replace(/-/g, ''), title: body.title ?? '', text: body.text, outdated: [] }
      const status = await startImport(c.env, engineFor(c), caller, collection, 'note', { files: [], notes: [note] }, now(c))
      return json(c, { import: status }, 202)
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
      const status = await startImport(c.env, engine, caller, collection, 'web_page', { files: [{ fileId, name, type: page.type, bytes: staged.bytes, sha256: staged.sha256 }], notes: [] }, at)
      return json(c, { import: status, page: { url: page.url, title: page.title } }, 202)
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
    const result = await engineFor(c).removeDocument(collection.id, param(c, 'docId'))
    return json(c, { removed: result })
  })

  return app
}

