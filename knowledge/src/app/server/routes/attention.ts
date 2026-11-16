import { Hono } from 'hono'
import { authorize, capped, HAS_ROLE_SQL, ROLE_RANK, roleIn, type CollectionRole, type CollectionRow } from '../access.ts'
import type { AppEnv } from '../env.ts'
import { forbidden, logError } from '../http.ts'
import { can, type Caller } from '../identity.ts'
import { callerOf, engineFor, iso, json, now, type Ctx } from './common.ts'

/**
 * Needs attention (design J6, LAUNCH scope): what only a person can settle, in the collections the caller can change
 * (collection Editor, Admin or Owner, with permission to change content). At launch three kinds of items:
 *
 * - `unreadable`: an import that failed (a file Insulin couldn't read after three tries) or a file refused at upload (a
 *   scanned PDF with no text), from the last 30 days, until a file with the same name is learned in that collection;
 * - `hidden`: a file or note added in the last 30 days in which values were hidden before learning, with how many
 *   (the engine counts them in its list of documents: one call per collection);
 * - `reported`: answers reported as wrong and still open;
 * - `needs_check`: a correction whose file was read again and now reads differently where the correction applied (the
 *   engine's outbox), until the correction is written again.
 *
 * Read only: reports are settled with their own route; the other items settle themselves. Nothing here shows a hidden
 * value or a file's text.
 */
const WINDOW_MS = 30 * 24 * 60 * 60 * 1000
const MAX_COLLECTIONS = 20

export type AttentionItem =
  | { kind: 'unreadable'; id: string; at: string; files: { name: string; reason: string }[]; message: string }
  | { kind: 'hidden'; id: string; at: string; documentId: string; documentName: string; total: number }
  | { kind: 'needs_check'; id: string; at: string; correctionId: string | null; text: string | null; documentId: string; documentName: string | null }
  | { kind: 'reported'; id: string; at: string; question: string; note: string; answer: string; reportedBy: { id: string; name: string | null } }

/** Collections the caller can change, by name: their own, general access and shares, after the Viewer cap. */
async function changeable(db: D1Database, caller: Caller, only: string | null): Promise<{ collection: CollectionRow; role: CollectionRole }[]> {
  const { results } = await db.prepare(
    `SELECT c.* FROM collections c WHERE c.org_id = ?1 AND c.state = 'active' AND ${HAS_ROLE_SQL} AND (?4 IS NULL OR c.id = ?4) ORDER BY lower(c.name), c.created_at`,
  ).bind(caller.organizationId, caller.kind, caller.id, only).all<CollectionRow>()
  const found: { collection: CollectionRow; role: CollectionRole }[] = []
  for (const collection of results) {
    if (caller.via !== 'browser' && !collection.assistants) continue
    const { granted } = await roleIn(db, caller, collection)
    const role = capped(caller, granted)
    if (role && ROLE_RANK[role] >= ROLE_RANK.EDITOR) found.push({ collection, role })
    if (found.length >= MAX_COLLECTIONS) break
  }
  return found
}

/** Learned file names per collection since a time: what settles an unreadable item. */
async function learnedNames(db: D1Database, org: string, collectionId: string, since: number): Promise<{ name: string; at: number }[]> {
  const { results } = await db.prepare(
    `SELECT detail, created_at FROM imports WHERE org_id = ? AND collection_id = ? AND state = 'committed' AND created_at >= ?`,
  ).bind(org, collectionId, since).all<{ detail: string; created_at: number }>()
  return results.flatMap((row) => {
    try {
      const names = (JSON.parse(row.detail) as { files?: unknown }).files
      return Array.isArray(names) ? names.filter((name): name is string => typeof name === 'string').map((name) => ({ name, at: row.created_at })) : []
    } catch {
      return []
    }
  })
}

async function itemsOf(c: Ctx, collection: CollectionRow, at: number): Promise<AttentionItem[]> {
  const db = c.env.DB
  const org = collection.org_id
  const since = at - WINDOW_MS
  const items: AttentionItem[] = []
  const learned = await learnedNames(db, org, collection.id, since)
  const settled = (name: string, after: number) => learned.some((entry) => entry.name === name && entry.at >= after)

  const failed = await db.prepare(
    `SELECT id, created_at, finished_at, error, detail FROM imports WHERE org_id = ? AND collection_id = ? AND state = 'failed' AND created_at >= ? ORDER BY created_at DESC LIMIT 20`,
  ).bind(org, collection.id, since).all<{ id: string; created_at: number; finished_at: number | null; error: string | null; detail: string }>()
  for (const row of failed.results) {
    let names: string[] = []
    try {
      const files = (JSON.parse(row.detail) as { files?: unknown }).files
      names = Array.isArray(files) ? files.filter((name): name is string => typeof name === 'string') : []
    } catch {
      names = []
    }
    const message = row.error ?? 'The import failed.'
    // The file the engine named, else every file of the import.
    const named = names.filter((name) => message.includes(name))
    const files = (named.length ? named : names).map((name) => ({ name, reason: message }))
    if (files.length && files.every((file) => settled(file.name, row.created_at))) continue
    items.push({ kind: 'unreadable', id: `import:${row.id}`, at: iso(row.finished_at ?? row.created_at)!, files, message })
  }

  const refused = await db.prepare(
    `SELECT id, name, reason, created_at FROM staged_files WHERE org_id = ? AND collection_id = ? AND state = 'refused' AND created_at >= ? ORDER BY created_at DESC LIMIT 20`,
  ).bind(org, collection.id, since).all<{ id: string; name: string; reason: string | null; created_at: number }>()
  for (const row of refused.results) {
    if (settled(row.name, row.created_at)) continue
    const reason = row.reason ?? `“${row.name}” can't be learned.`
    items.push({ kind: 'unreadable', id: `upload:${row.id}`, at: iso(row.created_at)!, files: [{ name: row.name, reason }], message: reason })
  }

  const reports = await db.prepare(
    `SELECT r.id, r.created_at, r.question, r.note, r.answer, r.reported_by, COALESCE(m.name, m.email) AS reporter FROM reports r
     LEFT JOIN members m ON m.org_id = r.org_id AND m.principal_type = 'person' AND m.principal_id = r.reported_by
     WHERE r.org_id = ? AND r.collection_id = ? AND r.status = 'open' ORDER BY r.created_at DESC LIMIT 50`,
  ).bind(org, collection.id).all<{ id: string; created_at: number; question: string; note: string; answer: string; reported_by: string; reporter: string | null }>()
  for (const row of reports.results) {
    items.push({ kind: 'reported', id: `report:${row.id}`, at: iso(row.created_at)!, question: row.question, note: row.note, answer: row.answer, reportedBy: { id: row.reported_by, name: row.reporter } })
  }

  // Values hidden before learning in recent files and notes, and corrections to check: one read of the engine's list.
  const checks = await db.prepare(
    `SELECT k.note_id, k.document_id, k.text_hash, k.at, c.id AS correction_id, c.text FROM correction_checks k
     LEFT JOIN corrections c ON c.org_id = k.org_id AND c.collection_id = k.collection_id AND replace(c.id, '-', '') = k.note_id
     WHERE k.org_id = ? AND k.collection_id = ? ORDER BY k.at DESC LIMIT 20`,
  ).bind(org, collection.id).all<{ note_id: string; document_id: string; text_hash: string; at: number; correction_id: string | null; text: string | null }>()
  if (c.env.ENGINE && (collection.documents > 0 || checks.results.length)) {
    try {
      const { documents } = await engineFor(c, org).documents(collection.id)
      for (const document of documents) {
        if (Date.parse(document.addedAt) < since || !(document.hiddenValues > 0)) continue
        items.push({ kind: 'hidden', id: `hidden:${document.documentId}`, at: document.addedAt, documentId: document.documentId, documentName: document.name, total: document.hiddenValues })
      }
      for (const row of checks.results) {
        items.push({
          kind: 'needs_check', id: `check:${row.note_id}:${row.document_id}:${row.text_hash}`, at: iso(row.at)!, correctionId: row.correction_id, text: row.text,
          documentId: row.document_id, documentName: documents.find((document) => document.documentId === row.document_id)?.name ?? null,
        })
      }
    } catch (error) {
      logError('attention_engine_failed', error, { org })
    }
  }
  return items.sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
}

export function attentionRoutes() {
  const app = new Hono<AppEnv>()

  app.get('/attention', async (c) => {
    const caller = callerOf(c)
    if (!can(caller, 'knowledge.collections.edit')) throw forbidden('Needs attention is for people who can change collections. Your role in Knowledge can only read.')
    const only = c.req.query('collection') ?? null
    // A collection named in the address is checked the way every collection route checks it (404, 403, assistants off).
    if (only) await authorize(c.env.DB, caller, only, 'change')
    const at = now(c)
    const collections = await changeable(c.env.DB, caller, only)
    const result = []
    for (const { collection, role } of collections) {
      result.push({ id: collection.id, name: collection.name, role, items: await itemsOf(c, collection, at) })
    }
    return json(c, { collections: result })
  })

  return app
}
