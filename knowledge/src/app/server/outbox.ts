import type { ImportStatus, OutboxEvent, RestorePoint } from '../../../engine/src/contract.ts'
import { EngineClient, SERVICE_ORG } from './engine/client.ts'
import type { Bindings } from './env.ts'
import { logError } from './http.ts'
import { consumeAwake, releaseStatements, reservationsOf, settleStatements } from './limits.ts'
import { eraseCollectionStatements } from './erase.ts'
import { appLink, MAIL, sendMail } from './mail.ts'
import { memberOf } from './members.ts'

/**
 * Keeping D1 in step with the engine (design section 11): the engine commits first and writes what happened to its
 * outbox; the tick pulls it (`GET /v1/outbox?since=`) and applies each event once (table `engine_events`, written in
 * the same batch as the event's effect, so a repeated page or an overlapping tick changes nothing):
 *
 * - `committed`: a history row per (collection, version), the collection's counts (ending the import's reservation of
 *   documents and stored bytes in the same batch), its monthly use settled, and "learned" mail to whoever started it.
 *   Changes within 5 minutes share one restore point in the engine (the earlier one folds into the new one and is no
 *   longer listed), and going back, undo, repairs and coming back from a backup commit with no import, so the history
 *   list is then reconciled with the engine's own (`GET /restore-points`), once per collection a page touched;
 * - `import`: the import's state; a failed, cancelled or duplicate import's reservations released, "import failed" mail;
 * - `usage`: running time counted against awake hours (and the collection's blocks used up);
 * - `state`, `backup`, `deleted`: what lists and Health show.
 */
const NAME = 'outbox'
const TERMINAL = new Set(['committed', 'duplicate', 'failed', 'cancelled'])

/**
 * Pulls the outbox and applies it, page after page, until `deadline`. The engine's event ids are ordered and each is
 * the cursor that continues after it, so the cursor is saved after every event: a page longer than the tick's time
 * still moves on. Engine calls give up at the deadline, their bodies included.
 */
export async function syncOutbox(input: Bindings, now: number, deadline: number): Promise<{ applied: number; pages: number }> {
  if (!input.ENGINE) return { applied: 0, pages: 0 }
  const env: Bindings = { ...input, DEADLINE: Math.min(input.DEADLINE ?? deadline, deadline) }
  const db = env.DB
  const engine = new EngineClient(env.ENGINE!, SERVICE_ORG, env.DEADLINE)
  const state = await db.prepare(`SELECT cursor FROM sync_state WHERE name = ?`).bind(NAME).first<{ cursor: string | null }>()
  let cursor = state?.cursor ?? null
  let applied = 0
  let pages = 0
  const save = (value: string) => db.prepare(
    `INSERT INTO sync_state (name, cursor, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT (name) DO UPDATE SET cursor = excluded.cursor, updated_at = excluded.updated_at`,
  ).bind(NAME, value, now).run()
  for (; pages < 20 && Date.now() < deadline; ) {
    const page = await engine.outbox(cursor, 200)
    pages += 1
    const committed = new Map<string, string>()
    let done = true
    for (const event of page.events) {
      if (Date.now() > deadline) {
        done = false
        break
      }
      if (await applyEngineEvent(env, event, now)) applied += 1
      if (event.type === 'committed') committed.set(`${event.org}\u0000${event.collectionId}`, event.org)
      if (/^\d{1,20}$/.test(event.id)) {
        cursor = event.id
        await save(cursor)
      }
    }
    for (const [key, org] of committed) {
      if (Date.now() > deadline) break
      await reconcileHistory(env, org, key.slice(org.length + 1)).catch((error) => logError('history_reconcile_failed', error, { org }))
    }
    if (!done) return { applied, pages }
    cursor = page.cursor || cursor
    if (cursor) await save(cursor)
    if (!page.more) break
  }
  return { applied, pages }
}

/**
 * The history list in D1 made to follow the engine's restore points: rows the engine no longer lists (folded into a
 * later one) go, listed ones are added or updated. `points`, when the caller already has them, saves the engine call.
 */
export async function reconcileHistory(env: Bindings, org: string, collectionId: string, points?: RestorePoint[]): Promise<void> {
  if (!env.ENGINE && !points) return
  const db = env.DB
  const collection = await db.prepare(`SELECT id FROM collections WHERE id = ? AND org_id = ? AND state = 'active'`).bind(collectionId, org).first()
  if (!collection) return
  const listed = points ?? (await new EngineClient(env.ENGINE!, org, env.DEADLINE).restorePoints(collectionId)).restorePoints
  const versions = listed.map((point) => point.version)
  const statements = [
    db.prepare(`DELETE FROM history WHERE collection_id = ?1 AND org_id = ?2 AND version NOT IN (SELECT value FROM json_each(?3))`).bind(collectionId, org, JSON.stringify(versions)),
    ...listed.map((point) => db.prepare(
      `INSERT INTO history (collection_id, version, org_id, created_at, summary, documents, import_id) VALUES (?, ?, ?, ?, ?, ?, NULL)
       ON CONFLICT (collection_id, version) DO UPDATE SET created_at = excluded.created_at, summary = excluded.summary, documents = excluded.documents`,
    ).bind(collectionId, point.version, org, Date.parse(point.createdAt) || 0, point.summary.slice(0, 500), point.documents)),
  ]
  await db.batch(statements)
}

/** Runs an event's statements with its mark, once: false when it was applied before. */
async function once(db: D1Database, event: OutboxEvent, statements: D1PreparedStatement[], now: number): Promise<boolean> {
  try {
    await db.batch([db.prepare(`INSERT INTO engine_events (id, at) VALUES (?, ?)`).bind(event.id, now), ...statements])
    return true
  } catch (error) {
    const seen = await db.prepare(`SELECT 1 AS seen FROM engine_events WHERE id = ?`).bind(event.id).first()
    if (seen) return false
    throw error
  }
}

export async function applyEngineEvent(env: Bindings, event: OutboxEvent, now: number): Promise<boolean> {
  const db = env.DB
  // An event applied before (a page read again, an overlapping tick) costs one read and nothing else.
  if (await db.prepare(`SELECT 1 AS seen FROM engine_events WHERE id = ?`).bind(event.id).first()) return false
  const org = event.org
  const collection = await db.prepare(`SELECT id, name, state FROM collections WHERE id = ? AND org_id = ?`).bind(event.collectionId, org).first<{ id: string; name: string; state: string }>()
  if (!collection) return once(db, event, [], now)
  switch (event.type) {
    case 'committed': {
      const at = Date.parse(event.at) || now
      const applied = await once(db, event, [
        db.prepare(
          `INSERT INTO history (collection_id, version, org_id, created_at, summary, documents, import_id) VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (collection_id, version) DO NOTHING`,
        ).bind(collection.id, event.version, org, at, event.summary.slice(0, 500), event.counts.documents, event.importId),
        db.prepare(
          // A collection that has learned something is no longer empty; the engine's own `state` events say more.
          `UPDATE collections SET version = MAX(version, ?3), documents = ?4, active_documents = ?5, bytes = ?6, facts = ?7, last_restore_point_at = ?8, updated_at = ?9,
             engine_state = CASE WHEN engine_state = 'empty' THEN 'asleep' ELSE engine_state END
           WHERE id = ?1 AND org_id = ?2 AND version <= ?3`,
        ).bind(collection.id, org, event.version, event.counts.documents, event.counts.activeDocuments, event.counts.textBytes, event.counts.facts, at, now),
        // Documents and stored bytes are counted from the collections themselves: their reservation ends with the new counts.
        ...(event.importId ? [db.prepare(
          `UPDATE reservations SET state = 'settled', settled_at = ?3 WHERE org_id = ?1 AND ref = ?2 AND period = 'all' AND state = 'held'`,
        ).bind(org, `import:${event.importId}`, now)] : []),
      ], now)
      // What the import learned (and so its monthly use) comes with its own `import` event.
      return applied
    }
    case 'import': {
      // The import's state, reservations and report go in the same batch as the event's mark: all or nothing.
      const applied = await once(db, event, await finishImportStatements(db, org, collection, event.import.importId, event.import, now), now)
      if (applied) await notifyImport(env, org, collection, event.import.importId, event.import, now)
      return applied
    }
    case 'needs_check':
      return once(db, event, [db.prepare(
        `INSERT INTO correction_checks (collection_id, note_id, document_id, text_hash, org_id, at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
      ).bind(collection.id, event.noteId, event.documentId, event.textHash, org, Date.parse(event.at) || now)], now)
    case 'usage':
      return once(db, event, await consumeAwake(db, org, collection.id, Math.max(0, event.seconds), Date.parse(event.at) || now), now)
    case 'state':
      return once(db, event, [db.prepare(`UPDATE collections SET engine_state = ?3, updated_at = ?4 WHERE id = ?1 AND org_id = ?2`).bind(collection.id, org, event.state, now)], now)
    case 'backup':
      return once(db, event, [db.prepare(`UPDATE collections SET last_backup_at = ?3, updated_at = ?3 WHERE id = ?1 AND org_id = ?2`).bind(collection.id, org, Date.parse(event.at) || now)], now)
    case 'deleted': {
      if (collection.state !== 'deleting') return once(db, event, [], now)
      return once(db, event, [
        db.prepare(`UPDATE collections SET state = 'deleted', engine_state = 'deleted', updated_at = ?3 WHERE id = ?1 AND org_id = ?2 AND state = 'deleting'`).bind(collection.id, org, now),
        ...eraseCollectionStatements(db, org, collection.id, now),
      ], now)
    }
    default:
      return once(db, event, [], now)
  }
}

/**
 * An import's new state, from the outbox or from someone asking about it: recorded once it is final, its
 * reservations settled (committed) or released (anything else), a report its correction settles marked fixed, and its
 * starter told. Safe to call more than once.
 */
export async function finishImport(env: Bindings, org: string, collection: { id: string; name: string }, importId: string, status: Pick<ImportStatus, 'state'> & Partial<ImportStatus>, now: number): Promise<void> {
  const statements = await finishImportStatements(env.DB, org, collection, importId, status, now)
  if (statements.length) await env.DB.batch(statements)
  await notifyImport(env, org, collection, importId, status, now)
}

/** The statements that record an import's new state (see finishImport), for one batch. */
export async function finishImportStatements(db: D1Database, org: string, collection: { id: string }, importId: string, status: Pick<ImportStatus, 'state'> & Partial<ImportStatus>, now: number): Promise<D1PreparedStatement[]> {
  const row = await db.prepare(`SELECT id, detail, state FROM imports WHERE id = ? AND org_id = ? AND collection_id = ?`).bind(importId, org, collection.id).first<{ id: string; detail: string; state: string }>()
  // What an import's end does is done once: asked about again (polled, or its event read again), nothing changes.
  if (!row || TERMINAL.has(row.state)) return []
  const failure = status.state === 'failed' ? plainFailure(status) : null
  // The documents each file became, so a fix can tell the person who added a file.
  let detail = row.detail
  const documents = (status.files ?? []).filter((file) => file.documentId && file.state === 'learned').map((file) => ({ id: file.documentId!, name: file.name }))
  if (documents.length) {
    try {
      detail = JSON.stringify({ ...(JSON.parse(row.detail) as object), documents })
    } catch {
      detail = JSON.stringify({ documents })
    }
  }
  const statements = [db.prepare(
    `UPDATE imports SET state = ?3, version = COALESCE(?4, version), error = COALESCE(?5, error), detail = ?6,
       finished_at = CASE WHEN ?7 THEN COALESCE(finished_at, ?8) ELSE finished_at END, request = CASE WHEN ?7 THEN NULL ELSE request END
     WHERE id = ?1 AND org_id = ?2 AND state NOT IN ('committed', 'duplicate', 'failed', 'cancelled')`,
  ).bind(importId, org, status.state, status.version ?? null, failure, detail, TERMINAL.has(status.state) ? 1 : 0, now)]
  if (!TERMINAL.has(status.state)) return statements
  const held = await reservationsOf(db, org, `import:${importId}`)
  if (status.state === 'committed') {
    // Monthly use is what was learned: files learned (not those already here) and notes. Documents and stored bytes
    // stay reserved until the outbox's `committed` event brings the collection's new counts.
    const learned = (status.files ?? []).filter((file) => file.state === 'learned').length + (status.notes ?? 0)
    statements.push(...settleStatements(db, org, held.filter((reservation) => reservation.key === 'learned_month').map((reservation) => ({ id: reservation.id, used: learned })), now))
    // A report the correction answers is fixed now that new questions use it.
    statements.push(db.prepare(
      `UPDATE reports SET status = 'fixed', resolved_at = ?3, resolved_by = (SELECT created_by FROM corrections WHERE import_id = ?1 AND org_id = ?2),
         correction_id = (SELECT id FROM corrections WHERE import_id = ?1 AND org_id = ?2)
       WHERE org_id = ?2 AND status = 'open' AND id IN (SELECT report_id FROM corrections WHERE import_id = ?1 AND org_id = ?2 AND report_id IS NOT NULL)`,
    ).bind(importId, org, now))
    // A new correction of a file settles the checks earlier corrections of it asked for, in its collection: those that
    // came before it was learned, not one a later re-read asks for.
    const learnedAt = (status.finishedAt && Date.parse(status.finishedAt)) || now
    statements.push(db.prepare(
      `DELETE FROM correction_checks WHERE org_id = ?2 AND collection_id = ?3 AND at <= ?4 AND document_id IN (
         SELECT json_extract(o.value, '$.documentId') FROM corrections k, json_each(k.outdated) o WHERE k.import_id = ?1 AND k.org_id = ?2)`,
    ).bind(importId, org, collection.id, learnedAt))
  } else {
    statements.push(...releaseStatements(db, org, held.map((reservation) => reservation.id), now))
  }
  return statements
}

/** Mail about an import's end, once, whoever saw it first: "learned" or "couldn't learn" to whoever started it. */
async function notifyImport(env: Bindings, org: string, collection: { id: string; name: string }, importId: string, status: Pick<ImportStatus, 'state'> & Partial<ImportStatus>, now: number): Promise<void> {
  if (!TERMINAL.has(status.state)) return
  const db = env.DB
  const row = await db.prepare(`SELECT created_by, kind, files, detail FROM imports WHERE id = ? AND org_id = ? AND collection_id = ?`).bind(importId, org, collection.id).first<{ created_by: string; kind: string; files: number; detail: string }>()
  if (!row) return
  const claimed = await db.prepare(`UPDATE imports SET notified_at = ?3 WHERE id = ?1 AND org_id = ?2 AND notified_at IS NULL`).bind(importId, org, now).run()
  // A correction's starter sees it learned where they wrote it; only its failure is mailed.
  if (claimed.meta.changes !== 1 || (row.kind === 'correction' && status.state !== 'failed')) return
  const starter = await memberOf(db, org, 'person', row.created_by)
  if (!starter?.email) return
  const link = appLink(env, `/collections/${collection.id}/sources`)
  try {
    const fromExport = (() => {
      try {
        return (JSON.parse(row.detail) as { export?: boolean }).export === true
      } catch {
        return false
      }
    })()
    if (status.state === 'committed' && fromExport) {
      // A collection started from an export: every document it restored, files and notes.
      const documents = (status.files?.filter((file) => file.state === 'learned').length ?? 0) + (status.notes ?? 0)
      await sendMail(env, org, { to: starter.email, ...MAIL.restored(collection.name, documents, link) }, 'restored')
    } else if (status.state === 'committed') {
      const files = status.files?.filter((file) => file.state === 'learned').length ?? row.files
      await sendMail(env, org, { to: starter.email, ...MAIL.learned(collection.name, files, status.newFacts ?? null, link) }, 'learned')
    } else if (status.state === 'failed') {
      await sendMail(env, org, { to: starter.email, ...MAIL.importFailed(collection.name, plainFailure(status), link) }, 'import_failed')
    }
  } catch (error) {
    logError('import_mail_failed', error, { org })
  }
}

/** What went wrong with an import, in plain words, for a person: the engine's own words about the file, or a summary. */
export function plainFailure(status: Partial<ImportStatus>): string {
  const file = status.files?.find((candidate) => candidate.fileId === status.failedFileId) ?? status.files?.find((candidate) => candidate.state === 'failed')
  if (file?.reason) return file.reason
  if (file) return `Couldn't learn “${file.name}”.`
  return status.error?.message ?? 'The import failed.'
}
