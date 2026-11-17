import { Hono } from 'hono'
import type { DocumentInfo } from '../../../../engine/src/contract.ts'
import { authorize, capped, HAS_ROLE_SQL, highest, ROLE_RANK, type CollectionRole, type CollectionRow } from '../access.ts'
import type { AppEnv } from '../env.ts'
import { forbidden, logError } from '../http.ts'
import { can, type Caller } from '../identity.ts'
import { callerOf, engineFor, iso, json, now } from './common.ts'

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
/**
 * Values hidden before learning are counted by the engine, one call per collection: at most this many collections'
 * are read in one request, those changed most recently first (any number when one collection is asked for). The
 * rest are marked `partial`, and the answer's `notice` says so. Everything kept in D1 is read for every collection, in
 * one batch of five queries.
 */
const ENGINE_READS = 50
/** Engine calls at once. */
const ENGINE_PARALLEL = 6

export type AttentionItem =
  | { kind: 'unreadable'; id: string; at: string; files: { name: string; reason: string }[]; message: string }
  | { kind: 'hidden'; id: string; at: string; documentId: string; documentName: string; total: number }
  | { kind: 'needs_check'; id: string; at: string; correctionId: string | null; text: string | null; documentId: string; documentName: string | null; noteId: string; textHash: string }
  | { kind: 'reported'; id: string; at: string; question: string; note: string; answer: string; reportedBy: { id: string; name: string | null } }

/**
 * Collections the caller can change, by name: their own, general access and shares, after the Viewer cap. One query:
 * the caller's own share comes with each collection (HAS_ROLE_SQL already leaves out someone a resync hasn't checked).
 */
async function changeable(db: D1Database, caller: Caller, only: string | null): Promise<{ collection: CollectionRow; role: CollectionRole }[]> {
  const { results } = await db.prepare(
    `SELECT c.*, (SELECT s.role FROM collection_shares s WHERE s.collection_id = c.id AND s.org_id = ?1 AND s.principal_type = ?2 AND s.principal_id = ?3 AND s.status = 'active') AS share_role
     FROM collections c WHERE c.org_id = ?1 AND c.state = 'active' AND ${HAS_ROLE_SQL} AND (?4 IS NULL OR c.id = ?4) ORDER BY lower(c.name), c.created_at`,
  ).bind(caller.organizationId, caller.kind, caller.id, only).all<CollectionRow & { share_role: CollectionRole | null }>()
  const found: { collection: CollectionRow; role: CollectionRole }[] = []
  for (const { share_role: share, ...collection } of results) {
    if (caller.via !== 'browser' && !collection.assistants) continue
    const granted = caller.kind === 'client' ? share : highest([collection.owner_id === caller.id ? 'OWNER' : null, collection.general_role, share])
    const role = capped(caller, granted)
    if (role && ROLE_RANK[role] >= ROLE_RANK.EDITOR) found.push({ collection, role })
  }
  return found
}

function fileNames(detail: string): string[] {
  try {
    const files = (JSON.parse(detail) as { files?: unknown }).files
    return Array.isArray(files) ? files.filter((name): name is string => typeof name === 'string') : []
  } catch {
    return []
  }
}

type Failed = { collection_id: string; id: string; created_at: number; finished_at: number | null; error: string | null; detail: string }
type Refused = { collection_id: string; id: string; name: string; reason: string | null; created_at: number }
type Reported = { collection_id: string; id: string; created_at: number; question: string; note: string; answer: string; reported_by: string; reporter: string | null }
type Check = { collection_id: string; note_id: string; document_id: string; text_hash: string; at: number; correction_id: string | null; text: string | null }

/**
 * What D1 holds for the collections, in one batch whatever their number: the imports learned and failed, the files
 * refused at upload (both from the last 30 days), the open reports and the corrections to check, each newest first and
 * at most 20 (50 reports) a collection.
 */
async function keptItems(db: D1Database, org: string, ids: string[], since: number) {
  const within = `org_id = ?1 AND collection_id IN (SELECT value FROM json_each(?2))`
  const newest = (sql: string, limit: number) => `SELECT * FROM (SELECT *, ROW_NUMBER() OVER (PARTITION BY collection_id ORDER BY created_at DESC) AS n FROM (${sql})) WHERE n <= ${limit}`
  const list = JSON.stringify(ids)
  const [learned, failed, refused, reports, checks] = await db.batch([
    // Learned since: what settles an unreadable item, and which collections may hold values hidden recently.
    db.prepare(`SELECT collection_id, detail, created_at, finished_at FROM imports WHERE ${within} AND state = 'committed' AND (created_at >= ?3 OR finished_at >= ?3)`).bind(org, list, since),
    db.prepare(newest(`SELECT collection_id, id, created_at, finished_at, error, detail FROM imports WHERE ${within} AND state = 'failed' AND created_at >= ?3`, 20)).bind(org, list, since),
    db.prepare(newest(`SELECT collection_id, id, name, reason, created_at FROM staged_files WHERE ${within} AND state = 'refused' AND created_at >= ?3`, 20)).bind(org, list, since),
    db.prepare(newest(
      `SELECT r.collection_id, r.id, r.created_at, r.question, r.note, r.answer, r.reported_by, COALESCE(m.name, m.email) AS reporter FROM reports r
       LEFT JOIN members m ON m.org_id = r.org_id AND m.principal_type = 'person' AND m.principal_id = r.reported_by
       WHERE r.org_id = ?1 AND r.collection_id IN (SELECT value FROM json_each(?2)) AND r.status = 'open'`, 50)).bind(org, list),
    db.prepare(newest(
      `SELECT k.collection_id, k.note_id, k.document_id, k.text_hash, k.at, k.at AS created_at, c.id AS correction_id, c.text FROM correction_checks k
       LEFT JOIN corrections c ON c.org_id = k.org_id AND c.collection_id = k.collection_id AND replace(c.id, '-', '') = k.note_id
       WHERE k.org_id = ?1 AND k.collection_id IN (SELECT value FROM json_each(?2))`, 20)).bind(org, list),
  ])
  const byCollection = <T extends { collection_id: string }>(rows: T[] | undefined) => {
    const grouped = new Map<string, T[]>()
    for (const row of rows ?? []) {
      const list = grouped.get(row.collection_id)
      if (list) list.push(row)
      else grouped.set(row.collection_id, [row])
    }
    return grouped
  }
  return {
    learned: byCollection(learned?.results as { collection_id: string; detail: string; created_at: number; finished_at: number | null }[]),
    failed: byCollection(failed?.results as Failed[]),
    refused: byCollection(refused?.results as Refused[]),
    reports: byCollection(reports?.results as Reported[]),
    checks: byCollection(checks?.results as Check[]),
  }
}

type Kept = Awaited<ReturnType<typeof keptItems>>

/** A collection's items from D1, and from the engine's list of its documents when `documents` is given. */
function itemsOf(collectionId: string, kept: Kept, since: number, documents: DocumentInfo[] | null): AttentionItem[] {
  const items: AttentionItem[] = []
  const learned = (kept.learned.get(collectionId) ?? []).filter((row) => row.created_at >= since)
    .flatMap((row) => fileNames(row.detail).map((name) => ({ name, at: row.created_at })))
  const settled = (name: string, after: number) => learned.some((entry) => entry.name === name && entry.at >= after)

  for (const row of kept.failed.get(collectionId) ?? []) {
    const names = fileNames(row.detail)
    const message = row.error ?? 'The import failed.'
    // The file the engine named, else every file of the import.
    const named = names.filter((name) => message.includes(name))
    const files = (named.length ? named : names).map((name) => ({ name, reason: message }))
    if (files.length && files.every((file) => settled(file.name, row.created_at))) continue
    items.push({ kind: 'unreadable', id: `import:${row.id}`, at: iso(row.finished_at ?? row.created_at)!, files, message })
  }

  for (const row of kept.refused.get(collectionId) ?? []) {
    if (settled(row.name, row.created_at)) continue
    const reason = row.reason ?? `“${row.name}” can't be learned.`
    items.push({ kind: 'unreadable', id: `upload:${row.id}`, at: iso(row.created_at)!, files: [{ name: row.name, reason }], message: reason })
  }

  for (const row of kept.reports.get(collectionId) ?? []) {
    items.push({ kind: 'reported', id: `report:${row.id}`, at: iso(row.created_at)!, question: row.question, note: row.note, answer: row.answer, reportedBy: { id: row.reported_by, name: row.reporter } })
  }

  // Values hidden before learning in recent files and notes, and corrections to check: from the engine's list.
  if (documents) {
    for (const document of documents) {
      if (Date.parse(document.addedAt) < since || !(document.hiddenValues > 0)) continue
      items.push({ kind: 'hidden', id: `hidden:${document.documentId}`, at: document.addedAt, documentId: document.documentId, documentName: document.name, total: document.hiddenValues })
    }
  }
  // A correction to check is listed with or without the engine; its file's name only with it.
  for (const row of kept.checks.get(collectionId) ?? []) {
    items.push({
      kind: 'needs_check', id: `check:${row.note_id}:${row.document_id}:${row.text_hash}`, at: iso(row.at)!, correctionId: row.correction_id, text: row.text,
      noteId: row.note_id, textHash: row.text_hash,
      documentId: row.document_id, documentName: documents?.find((document) => document.documentId === row.document_id)?.name ?? null,
    })
  }
  return items.sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
}

/** Runs `work` for each of `list`, at most `parallel` at once. */
async function inTurn<T>(list: T[], parallel: number, work: (entry: T) => Promise<void>): Promise<void> {
  let next = 0
  await Promise.all(Array.from({ length: Math.min(parallel, list.length) }, async () => {
    while (next < list.length) await work(list[next++]!)
  }))
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
    const since = at - WINDOW_MS
    const collections = await changeable(c.env.DB, caller, only)
    const kept = collections.length ? await keptItems(c.env.DB, caller.organizationId, collections.map(({ collection }) => collection.id), since) : null
    // The engine is read for the collections that may list something from it: a document learned in the last 30 days
    // (perhaps with values hidden) or a correction to check (its file's name). Most recently changed first.
    const latest = (id: string) => Math.max(0, ...(kept?.learned.get(id) ?? []).map((row) => row.finished_at ?? row.created_at), ...(kept?.checks.get(id) ?? []).map((row) => row.at))
    const wanted = c.env.ENGINE && kept
      ? collections.filter(({ collection }) => kept.learned.has(collection.id) || kept.checks.has(collection.id)).sort((a, b) => latest(b.collection.id) - latest(a.collection.id))
      : []
    const read = only ? wanted : wanted.slice(0, ENGINE_READS)
    const documents = new Map<string, DocumentInfo[]>()
    await inTurn(read, ENGINE_PARALLEL, async ({ collection }) => {
      try {
        documents.set(collection.id, (await engineFor(c, collection.org_id).documents(collection.id)).documents)
      } catch (error) {
        logError('attention_engine_failed', error, { org: collection.org_id })
      }
    })
    const unread = new Set(wanted.filter(({ collection }) => !documents.has(collection.id)).map(({ collection }) => collection.id))
    const result = collections.map(({ collection, role }) => ({
      id: collection.id,
      name: collection.name,
      role,
      items: itemsOf(collection.id, kept!, since, documents.get(collection.id) ?? null),
      // Values hidden before learning (and the file names of corrections to check) weren't read for it this time.
      partial: unread.has(collection.id),
    }))
    const notice = unread.size === 0 ? null
      : `Values hidden before learning aren't listed here for ${unread.size === 1 ? '1 collection' : `${unread.size} collections`}: Knowledge reads them for the ${ENGINE_READS} collections changed most recently, or couldn't read them just now. To see everything for one collection, open it: its Overview lists what needs attention there.`
    return json(c, { collections: result, notice })
  })

  return app
}
